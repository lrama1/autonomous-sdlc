import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  createDb,
  createRunFixture,
  interaction,
  previewRun,
  repositoryEntry,
  runMigrations,
  smokeRun,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import type { PreviewStartConfig } from '@sdlc/core';
import { PreviewStartError } from './docker-preview.js';
import type { PreviewHost } from './docker-preview.js';
import { PreviewService } from './previews.js';
import { SmokeService } from './smoke-service.js';

const CONFIG = (smoke: string) => `start: node server.js\nport: 3000\n${smoke}`;
const GOOD =
  'smoke:\n  - get: /health\n  - get: /items\n    contains: items\n  - run: npm run smoke\n';

/** A host that really listens, so the checks make real HTTP requests. Commands answer from a script. */
class ListeningHost implements PreviewHost {
  servers = new Map<string, http.Server>();
  stopped: string[] = [];
  execs: Array<{ id: string; command: string }> = [];
  failStart: Error | null = null;
  hold: Promise<void> | null = null;
  /** While set, stopping a preview waits for it. */
  stopHold: Promise<void> | null = null;
  stopping = false;
  healthy = true;
  exitCode = 0;
  async start(spec: { id: string; config: PreviewStartConfig; hostPort: number }) {
    if (this.hold) await this.hold;
    if (this.failStart) throw this.failStart;
    const server = http.createServer((req, res) => {
      if (req.url === '/health') return void res.writeHead(this.healthy ? 200 : 500).end('ok');
      if (req.url === '/items') return void res.end('{"items":[]}');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(spec.hostPort, '127.0.0.1', r));
    this.servers.set(spec.id, server);
    return { url: `http://127.0.0.1:${spec.hostPort}/` };
  }
  async exec(id: string, command: string) {
    this.execs.push({ id, command });
    return { exitCode: this.exitCode, output: this.exitCode ? 'it broke' : 'fine' };
  }
  async stop(id: string) {
    this.stopping = true;
    if (this.stopHold) await this.stopHold;
    this.stopped.push(id);
    const s = this.servers.get(id);
    this.servers.delete(id);
    s?.closeAllConnections();
    await new Promise((r) => (s ? s.close(r) : r(null)));
  }
  async reconcile() {}
}

const gh = { state: 'open', head: 'a'.repeat(40), config: CONFIG(GOOD) as string | null };
const github = {
  getPullRequest: async () => ({ state: gh.state, head: { sha: gh.head, ref: 'b' } }) as never,
  readFile: async () => gh.config,
  archive: async () => Buffer.from('tar'),
};

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let host: ListeningHost;
let previews: PreviewService;
let smoke: SmokeService;
let n = 0;
let basePort = 9500;

async function review(state = 'open') {
  const f = await createRunFixture(db);
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  const prNumber = 300 + ++n;
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: `Review PR #${prNumber}`,
      roleNeeded: 'backend_engineer',
      state,
      contextCard: {
        kind: 'pull_request',
        repository: repo!.fullName,
        prNumber,
        headSha: gh.head,
      },
    })
    .returning();
  return {
    id: row!.id,
    row: row!,
    personId: f.personId,
    initiativeId: f.initiativeId,
    prNumber,
    repository: repo!.fullName,
  };
}

const rowOf = async (id: string) =>
  (await db.select().from(smokeRun).where(eq(smokeRun.id, id)))[0]!;
const actions = async (initiativeId: string) =>
  (await db.select().from(activityEvent).where(eq(activityEvent.initiativeId, initiativeId)))
    .map((a) => a.action)
    .filter((a) => a.startsWith('smoke.'));

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-smoke-'));
  devDb = await startDevDb({ dataDir, port: 56353 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
}, 180_000);

beforeEach(async () => {
  host = new ListeningHost();
  gh.state = 'open';
  gh.head = String(++n).padStart(40, 'a');
  gh.config = CONFIG(GOOD);
  basePort += 10;
  await db.update(previewRun).set({ state: 'stopped' }).where(eq(previewRun.state, 'ready'));
  previews = new PreviewService({
    db,
    github,
    host,
    settings: { maxActive: 2, ttlMinutes: 30, portBase: basePort, portCount: 5 },
  });
  smoke = new SmokeService({ db, github, previews, host, pollMs: 20, getTimeoutMs: 2000 });
});

afterAll(async () => {
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('a smoke test of a pull request', () => {
  it('starts a preview, runs the checks, records them, and removes the preview', async () => {
    const r = await review();
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    expect(res.existing).toBe(false);
    expect(res.row.state).toBe('running');
    await smoke.idle();

    const row = await rowOf(res.row.id);
    expect(row.state).toBe('passed');
    expect(row.headSha).toBe(gh.head);
    expect(row.results.map((x) => [x.label, x.ok])).toEqual([
      ['GET /health', true],
      ['GET /items', true],
      ['run npm run smoke', true],
    ]);
    expect(row.finishedAt).not.toBeNull();
    expect(host.execs.map((e) => e.command)).toEqual(['npm run smoke']);
    // The preview this run started is gone as soon as the checks are done.
    const [prev] = await db.select().from(previewRun).where(eq(previewRun.prNumber, r.prNumber));
    expect(prev).toMatchObject({ state: 'stopped', detail: 'The smoke test finished.' });
    expect(host.stopped).toEqual([prev!.id]);
    expect(await actions(r.initiativeId)).toEqual(['smoke.started', 'smoke.passed']);
  });

  it('removes the preview before it records a result, so "passed" means nothing is left running', async () => {
    let release!: () => void;
    host.stopHold = new Promise((resolve) => (release = resolve));
    const r = await review();
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    for (let i = 0; i < 200 && !host.stopping; i++) await new Promise((x) => setTimeout(x, 20));
    expect(host.stopping).toBe(true);
    expect((await rowOf(res.row.id)).state).toBe('running');
    release();
    await smoke.idle();
    expect((await rowOf(res.row.id)).state).toBe('passed');
  });

  it('records a failure with every check, and still removes the preview', async () => {
    host.healthy = false;
    host.exitCode = 2;
    const r = await review();
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    await smoke.idle();
    const row = await rowOf(res.row.id);
    expect(row.state).toBe('failed');
    expect(row.results.map((x) => x.ok)).toEqual([false, true, false]);
    expect(row.results[0]!.detail).toBe('expected 200, got 500: ok');
    expect(row.results[2]!.detail).toBe('exit 2: it broke');
    expect(host.stopped).toHaveLength(1);
    expect(await actions(r.initiativeId)).toEqual(['smoke.started', 'smoke.failed']);
  });

  it('is an error, not a failure, when the preview does not start', async () => {
    host.failStart = new PreviewStartError('the preview stopped before it answered');
    const r = await review();
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    await smoke.idle();
    const row = await rowOf(res.row.id);
    expect(row).toMatchObject({ state: 'error', results: [] });
    expect(row.detail).toContain('the preview stopped before it answered');
    expect(await actions(r.initiativeId)).toEqual(['smoke.started', 'smoke.error']);
  });

  it('checks a preview that is already running and leaves it running', async () => {
    const r = await review();
    const first = await previews.start(r.id, null);
    if (!first.ok) throw new Error(first.message);
    await previews.idle();
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    await smoke.idle();
    expect((await rowOf(res.row.id)).state).toBe('passed');
    expect(host.stopped).toEqual([]);
    expect((await previews.get(first.row.id))!.state).toBe('ready');
    await previews.stop(first.row.id);
  });

  it('answers a second click on the same commit with the run already going', async () => {
    let release!: () => void;
    host.hold = new Promise((resolve) => (release = resolve));
    const r = await review();
    const a = await smoke.start(r.id, null);
    const b = await smoke.start(r.id, null);
    if (!a.ok || !b.ok) throw new Error('should start');
    expect(b.existing).toBe(true);
    expect(b.row.id).toBe(a.row.id);
    release();
    await smoke.idle();
    expect((await rowOf(a.row.id)).state).toBe('passed');
    // Once it is over, a new click makes a new run.
    const c = await smoke.start(r.id, null);
    if (!c.ok) throw new Error('should start');
    expect(c.existing).toBe(false);
    await smoke.idle();
  });

  it('refuses when there is nothing to run or check', async () => {
    const r = await review();
    gh.config = null;
    expect(await smoke.start(r.id, null)).toMatchObject({
      ok: false,
      status: 422,
      code: 'no_config',
    });
    gh.config = CONFIG('');
    expect(await smoke.start(r.id, null)).toMatchObject({
      ok: false,
      status: 422,
      code: 'no_smoke_checks',
    });
    gh.config = CONFIG('smoke:\n  - get: nope\n');
    expect(await smoke.start(r.id, null)).toMatchObject({
      ok: false,
      status: 422,
      code: 'bad_config',
    });
    expect(await db.select().from(smokeRun).where(eq(smokeRun.prNumber, r.prNumber))).toEqual([]);
  });

  it('refuses a review that is decided, a closed pull request, and something that is not a review', async () => {
    const decided = await review('approved');
    expect(await smoke.start(decided.id, null)).toMatchObject({
      ok: false,
      code: 'review_decided',
    });
    const open = await review();
    gh.state = 'closed';
    expect(await smoke.start(open.id, null)).toMatchObject({
      ok: false,
      code: 'pull_request_closed',
    });
    expect(await smoke.start('00000000-0000-4000-8000-000000000000', null)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('reads the newest result for a pull request', async () => {
    const r = await review();
    expect(await smoke.forPullRequest(r.repository, r.prNumber)).toBeNull();
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    await smoke.idle();
    expect((await smoke.forPullRequest(r.repository, r.prNumber))!.id).toBe(res.row.id);
  });
});

describe('what the smoke test means for approving', () => {
  it('asks nothing of a repository with no smoke checks or no preview file', async () => {
    const r = await review();
    gh.config = CONFIG('');
    expect(await smoke.blocks(r.row)).toBeNull();
    gh.config = null;
    const r2 = await review();
    expect(await smoke.blocks(r2.row)).toBeNull();
  });

  it('asks nothing of a change made only of documents, such as a spec or a design', async () => {
    const r = await review();
    const docs = {
      ...r.row,
      contextCard: {
        ...(r.row.contextCard as object),
        diff: { changedPaths: ['docs/spec/x.md', 'docs/design/x.md'] },
      },
    };
    expect(await smoke.blocks(docs)).toBeNull();
    const code = {
      ...r.row,
      contextCard: { ...(r.row.contextCard as object), diff: { changedPaths: ['src/a.js'] } },
    };
    expect(await smoke.blocks(code)).toContain('none has run on this commit');
  });

  it('holds a commit that has checks and no result, then lets it through when they pass', async () => {
    const r = await review();
    expect(await smoke.blocks(r.row)).toContain('3 smoke checks, and none has run on this commit');
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    expect(await smoke.blocks(r.row)).toContain('still running');
    await smoke.idle();
    expect(await smoke.blocks(r.row)).toBeNull();
    expect(await smoke.evidence(r.row)).toBe('Smoke test passed (3 checks).');
  });

  it('holds a failed run and a run that could not start, and asks for another try or an override', async () => {
    host.exitCode = 1;
    const r = await review();
    const a = await smoke.start(r.id, null);
    if (!a.ok) throw new Error(a.message);
    await smoke.idle();
    expect(await smoke.blocks(r.row)).toContain('failed on this commit');
    expect(await smoke.evidence(r.row)).toBeNull();

    host.exitCode = 0;
    host.failStart = new PreviewStartError('no room for it');
    const b = await smoke.start(r.id, null);
    if (!b.ok) throw new Error(b.message);
    await smoke.idle();
    expect(await smoke.blocks(r.row)).toContain('could not run (no room for it)');

    // The newest result decides: a pass after a failure lets it through.
    host.failStart = null;
    const c = await smoke.start(r.id, null);
    if (!c.ok) throw new Error(c.message);
    await smoke.idle();
    expect(await smoke.blocks(r.row)).toBeNull();
  });

  it('counts a file it cannot read as required, because the checks may be hidden in the mistake', async () => {
    gh.config = CONFIG('smoke:\n  - get: nope\n');
    const r = await review();
    expect(await smoke.blocks(r.row)).toContain('cannot be read');
    expect(await smoke.blocks(r.row)).toContain('get must be a path');
  });

  it('holds when GitHub cannot be asked, rather than letting a change through unchecked', async () => {
    const r = await review();
    const broken = new SmokeService({
      db,
      github: {
        ...github,
        readFile: async () => {
          throw new Error('GitHub is down');
        },
      },
      previews,
      host,
    });
    expect(await broken.blocks(r.row)).toContain('GitHub is down');
  });

  it('lets a person override with a reason that stays, and records it', async () => {
    const r = await review();
    const out = await smoke.override(r.id, r.personId, 'The login page is behind a feature flag.');
    if (!out.ok) throw new Error(out.message);
    expect(out.row).toMatchObject({
      state: 'overridden',
      headSha: gh.head,
      startedBy: r.personId,
      detail: 'The login page is behind a feature flag.',
    });
    expect(await smoke.blocks(r.row)).toBeNull();
    expect(await smoke.evidence(r.row)).toMatch(
      /^Smoke test overridden by .+: The login page is behind a feature flag\.$/,
    );
    expect(await actions(r.initiativeId)).toEqual(['smoke.overridden']);
    const [event] = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.interactionId, r.id));
    expect(event!.detail).toMatchObject({
      reason: 'The login page is behind a feature flag.',
      was: 'not run',
    });
  });

  it('refuses an override that makes no sense', async () => {
    const r = await review();
    gh.config = CONFIG('');
    expect(await smoke.override(r.id, r.personId, 'because I said so')).toMatchObject({
      ok: false,
      code: 'not_required',
    });
    gh.config = CONFIG(GOOD);
    const r2 = await review();
    const first = await smoke.override(r2.id, r2.personId, 'a good enough reason');
    expect(first.ok).toBe(true);
    expect(await smoke.override(r2.id, r2.personId, 'again, for luck')).toMatchObject({
      ok: false,
      code: 'not_needed',
    });
    const decided = await review('approved');
    expect(
      await smoke.override(decided.id, decided.personId, 'a good enough reason'),
    ).toMatchObject({
      ok: false,
      code: 'review_decided',
    });
    expect(
      await smoke.override('00000000-0000-4000-8000-000000000000', r.personId, 'x'.repeat(12)),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('does not let an override carry over to a new commit', async () => {
    const r = await review();
    await smoke.override(r.id, r.personId, 'a good enough reason');
    const next = {
      ...r.row,
      contextCard: { ...(r.row.contextCard as object), headSha: 'f'.repeat(40) },
    };
    expect(await smoke.blocks(next)).toContain('none has run on this commit');
  });

  it('marks a test that was running when the platform stopped', async () => {
    const r = await review();
    const [row] = await db
      .insert(smokeRun)
      .values({ repository: r.repository, prNumber: r.prNumber, headSha: gh.head })
      .returning();
    expect(await smoke.blocks(r.row)).toContain('still running');
    await smoke.recover();
    expect((await rowOf(row!.id)).state).toBe('error');
    expect(await smoke.blocks(r.row)).toContain('restarted during the smoke test');
  });
});

describe('when the Gate merges the base branch into the pull request', () => {
  const sha2 = () => 'd'.repeat(40);

  it('carries a pass over to the new commit, and says so', async () => {
    const r = await review();
    const res = await smoke.start(r.id, null);
    if (!res.ok) throw new Error(res.message);
    await smoke.idle();
    expect(await smoke.blocks(r.row)).toBeNull();
    const next = { ...r.row, contextCard: { ...(r.row.contextCard as object), headSha: sha2() } };
    expect(await smoke.blocks(next)).toContain('none has run on this commit');

    await smoke.carryOver(r.row, gh.head, sha2());
    expect(await smoke.blocks(next)).toBeNull();
    expect(await smoke.evidence(next)).toBe('Smoke test passed (3 checks).');
    const moved = await smoke.forCommit(r.repository, r.prNumber, sha2());
    expect(moved!.detail).toContain('carried over from');
    expect(await actions(r.initiativeId)).toContain('smoke.carried_over');
  });

  it('carries an override over too, with the reason and the person', async () => {
    const r = await review();
    await smoke.override(r.id, r.personId, 'The login page is behind a feature flag.');
    await smoke.carryOver(r.row, gh.head, sha2());
    const moved = await smoke.forCommit(r.repository, r.prNumber, sha2());
    expect(moved).toMatchObject({ state: 'overridden', startedBy: r.personId });
    expect(moved!.detail).toContain('The login page is behind a feature flag.');
    expect(moved!.detail).toContain('carried over');
  });

  it('does not carry over a failure, a missing result, or something that is not a pull request', async () => {
    host.exitCode = 1;
    const failed = await review();
    const a = await smoke.start(failed.id, null);
    if (!a.ok) throw new Error(a.message);
    await smoke.idle();
    await smoke.carryOver(failed.row, gh.head, sha2());
    expect(await smoke.forCommit(failed.repository, failed.prNumber, sha2())).toBeNull();

    host.exitCode = 0;
    const none = await review();
    await smoke.carryOver(none.row, gh.head, sha2());
    expect(await smoke.forCommit(none.repository, none.prNumber, sha2())).toBeNull();

    await smoke.carryOver({ ...none.row, contextCard: {} }, gh.head, sha2());
  });
});
