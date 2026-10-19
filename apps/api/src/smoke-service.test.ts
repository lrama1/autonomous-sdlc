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
      contextCard: { kind: 'pull_request', repository: repo!.fullName, prNumber },
    })
    .returning();
  return { id: row!.id, initiativeId: f.initiativeId, prNumber, repository: repo!.fullName };
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
