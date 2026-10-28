import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  createDb,
  createRunFixture,
  githubApp,
  hat,
  initiative,
  interaction,
  person,
  previewRun,
  repositoryEntry,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import type { PreviewConfig } from '@sdlc/core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PreviewStartError } from './docker-preview.js';
import type { PreviewHost } from './docker-preview.js';
import { GitHubClient, secretName } from './github-app.js';
import { MemorySecrets } from './secrets.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CONFIG = 'install: npm ci\nstart: npm run preview\nport: 4173\n';

/** A GitHub that has pull requests (each at a commit), a preview file or none, and a tarball. */
const gh = {
  headOf: new Map<number, string>(),
  state: 'open',
  config: CONFIG as string | null,
  calls: [] as string[],
  mainSha: null as string | null,
};

class FakeHost implements PreviewHost {
  started: Array<{ id: string; config: PreviewConfig; hostPort: number; bytes: number }> = [];
  stopped: string[] = [];
  reconciled = 0;
  failWith: Error | null = null;
  busyPorts = new Set<number>();
  hold: Promise<void> | null = null;
  async start(spec: { id: string; archive: Buffer; config: PreviewConfig; hostPort: number }) {
    this.started.push({
      id: spec.id,
      config: spec.config,
      hostPort: spec.hostPort,
      bytes: spec.archive.length,
    });
    if (this.hold) await this.hold;
    if (this.busyPorts.has(spec.hostPort))
      throw new PreviewStartError('could not publish the port', true);
    if (this.failWith) throw this.failWith;
    return { url: `http://127.0.0.1:${spec.hostPort}/` };
  }
  async stop(id: string) {
    this.stopped.push(id);
  }
  async reconcile() {
    this.reconciled++;
  }
}
const host = new FakeHost();

let server: http.Server;
let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;
const sha = (k: number) => `c0ffee${String(k).padStart(34, '0')}`;

async function newPerson(roles: string[] = ['backend_engineer']) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `v${k}@example.test`, oidcSubject: `v${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    headers: {
      cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
    },
  };
}

/** An open pull request review, on its own pull request number. */
async function review(o: { mode?: string; kind?: string } = {}) {
  const f = await createRunFixture(db);
  await db
    .update(initiative)
    .set({ autonomyMode: o.mode ?? 'balanced' })
    .where(eq(initiative.id, f.initiativeId));
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  await db.delete(githubApp);
  for (const k of ['agent', 'gate'])
    await db.insert(githubApp).values({
      kind: k,
      appId: 9,
      slug: k,
      name: k,
      ownerLogin: 'me',
      htmlUrl: 'https://x',
      installationId: 5,
      installedOn: (await db.select().from(repositoryEntry)).map((x) => x.fullName),
    });
  const prNumber = 200 + ++n;
  gh.headOf.set(prNumber, sha(prNumber));
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: `Review PR #${prNumber}`,
      roleNeeded: 'backend_engineer',
      contextCard: {
        kind: o.kind ?? 'pull_request',
        repository: repo!.fullName,
        prNumber,
        prUrl: 'https://github.com/o/r/pull/7',
        headSha: sha(prNumber),
      },
    })
    .returning();
  return { ...f, row: row!, prNumber, repository: repo!.fullName };
}

const start = (headers: Record<string, string>, id: string) =>
  app.inject({ method: 'POST', url: `/api/interactions/${id}/preview/start`, headers });
const stopIt = (headers: Record<string, string>, id: string) =>
  app.inject({ method: 'POST', url: `/api/previews/${id}/stop`, headers });
const view = (headers: Record<string, string>, id: string) =>
  app.inject({ method: 'GET', url: `/api/interactions/${id}/preview`, headers });
const rowOf = async (id: string) =>
  (await db.select().from(previewRun).where(eq(previewRun.id, id)))[0]!;
const settle = () => app.previews()!.idle();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    gh.calls.push(`${req.method} ${url}`);
    const json = (status: number, b: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b));
    };
    if (url.endsWith('/access_tokens'))
      return json(201, { token: 'ghs_fake', expires_at: '2026-10-19T00:00:00Z', permissions: {} });
    const pr = /\/pulls\/(\d+)$/.exec(url);
    if (pr)
      return json(200, {
        number: Number(pr[1]),
        html_url: 'https://github.com/o/r/pull/7',
        state: gh.state,
        merged: false,
        head: { sha: gh.headOf.get(Number(pr[1])) ?? sha(0), ref: 'agent/run/change' },
        base: { ref: 'main' },
      });
    if (/\/git\/ref\/heads\/main$/.test(url)) {
      if (gh.mainSha === null) return json(404, { message: 'Not Found' });
      return json(200, { object: { sha: gh.mainSha } });
    }
    if (url.includes('/contents/.sdlc/preview.yaml')) {
      if (gh.config === null) return json(404, { message: 'Not Found' });
      return json(200, {
        encoding: 'base64',
        content: Buffer.from(gh.config).toString('base64'),
      });
    }
    if (url.includes('/tarball/')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/gzip');
      return res.end(Buffer.from('fake-tarball'));
    }
    if (/\/deployments\?/.test(url)) return json(200, []);
    if (/\/commits\/[^/]+\/status/.test(url)) return json(200, { state: 'success', statuses: [] });
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const githubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-previews-'));
  devDb = await startDevDb({ dataDir, port: 56350 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const secrets = new MemorySecrets();
  for (const kind of ['agent', 'gate'] as const)
    await secrets.put(secretName(kind, 'private_key'), privateKey);
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: devDb.url,
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_CLIENT_ID: 'x',
      OIDC_CLIENT_SECRET: 'x',
      SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
      GITHUB_API_URL: githubUrl,
      PREVIEW_PORT_BASE: '9300',
    }),
    deps: made,
    workers: false,
    secrets,
    github: new GitHubClient(githubUrl),
    previewHost: host,
  });
  await app.ready();
}, 180_000);

beforeEach(async () => {
  gh.state = 'open';
  gh.config = CONFIG;
  gh.calls = [];
  host.started = [];
  host.stopped = [];
  host.failWith = null;
  host.busyPorts.clear();
  host.hold = null;
  // Each test starts with nothing running, so the limit of two never leaks from one test to the next.
  await db.update(previewRun).set({ state: 'stopped' }).where(eq(previewRun.state, 'ready'));
  await db.update(previewRun).set({ state: 'stopped' }).where(eq(previewRun.state, 'starting'));
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => server?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('a preview of what the build produced', () => {
  const startMain = (headers: Record<string, string>, id: string) =>
    app.inject({ method: 'POST', url: `/api/initiatives/${id}/preview/start`, headers });
  const viewMain = (headers: Record<string, string>, id: string) =>
    app.inject({ method: 'GET', url: `/api/initiatives/${id}/preview`, headers });

  it('runs the tip of the integration branch, and is replaced when the branch moves', async () => {
    const r = await review();
    const who = await newPerson();
    gh.mainSha = sha(901);
    expect((await viewMain(who.headers, r.initiativeId)).json()).toMatchObject({
      available: true,
      state: 'none',
      url: null,
    });

    const a = await startMain(who.headers, r.initiativeId);
    expect(a.statusCode).toBe(202);
    await settle();
    const ready = (await viewMain(who.headers, r.initiativeId)).json();
    expect(ready).toMatchObject({
      state: 'ready',
      sha: sha(901),
      url: expect.stringContaining('http://127.0.0.1:'),
    });
    // The config is read at the branch's commit.
    expect(gh.calls.some((c) => c.includes(`ref=${sha(901)}`))).toBe(true);

    const again = await startMain(who.headers, r.initiativeId);
    expect(again.statusCode).toBe(200);
    expect((again.json() as { id: string }).id).toBe(ready.id);

    gh.mainSha = sha(902);
    const next = await startMain(who.headers, r.initiativeId);
    expect(next.statusCode).toBe(202);
    await settle();
    expect(await rowOf(ready.id)).toMatchObject({
      state: 'stopped',
      detail: 'main has a new commit.',
    });
    expect((await viewMain(who.headers, r.initiativeId)).json()).toMatchObject({ sha: sha(902) });
    // The pull request's own preview is a different thing.
    expect((await view(who.headers, r.row.id)).json().platform.state).toBe('none');
  });

  it('is stopped like any other preview, and needs a role to start', async () => {
    const r = await review();
    const who = await newPerson();
    const nobody = await newPerson([]);
    gh.mainSha = sha(903);
    expect((await startMain(nobody.headers, r.initiativeId)).statusCode).toBe(403);
    const { id } = (await startMain(who.headers, r.initiativeId)).json() as { id: string };
    await settle();
    expect((await stopIt(who.headers, id)).statusCode).toBe(200);
    expect((await viewMain(who.headers, r.initiativeId)).json()).toMatchObject({
      state: 'stopped',
      url: null,
    });
  });

  it('says so when the branch has no commit to run', async () => {
    const r = await review();
    const who = await newPerson();
    gh.mainSha = null;
    const res = await startMain(who.headers, r.initiativeId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_branch');
  });
});

describe('a preview the platform runs', () => {
  it('starts when a person asks, shows as ready in the review pack, and says who started it', async () => {
    const r = await review();
    const who = await newPerson();
    let release!: () => void;
    host.hold = new Promise((resolve) => (release = resolve));
    const res = await start(who.headers, r.row.id);
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: string };
    expect((await rowOf(id)).state).toBe('starting');
    const mid = (await view(who.headers, r.row.id)).json();
    expect(mid).toMatchObject({ state: 'building', source: 'platform' });
    expect(mid.platform).toMatchObject({ available: true, state: 'starting' });
    release();

    await settle();
    const row = await rowOf(id);
    expect(row).toMatchObject({ state: 'ready', url: 'http://127.0.0.1:9300/', startedBy: who.id });
    expect(row.expiresAt!.getTime() - row.readyAt!.getTime()).toBe(30 * 60_000);
    expect(host.started).toHaveLength(1);
    expect(host.started[0]).toMatchObject({
      id,
      hostPort: 9300,
      bytes: 'fake-tarball'.length,
      config: { install: 'npm ci', start: 'npm run preview', port: 4173, readyPath: '/' },
    });
    // The file is read at the pull request's commit, so the branch decides how it is previewed.
    expect(gh.calls.some((c) => c.includes(`ref=${sha(r.prNumber)}`))).toBe(true);

    const pack = (await view(who.headers, r.row.id)).json();
    expect(pack).toMatchObject({
      state: 'ready',
      source: 'platform',
      url: 'http://127.0.0.1:9300/',
      sha: sha(r.prNumber),
    });
    expect(pack.platform).toMatchObject({ state: 'ready', id, ttlMinutes: 30 });
    expect(pack.detail).toContain('Run by the platform in a sandbox');
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'preview.started'));
    expect(log.some((l) => l.interactionId === r.row.id)).toBe(true);
  });

  it('asking twice for the same commit starts nothing new', async () => {
    const r = await review();
    const who = await newPerson();
    const a = await start(who.headers, r.row.id);
    const b = await start(who.headers, r.row.id);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect((b.json() as { id: string }).id).toBe((a.json() as { id: string }).id);
    await settle();
    expect(host.started).toHaveLength(1);
  });

  it('a new commit stops the preview of the old one and starts another', async () => {
    const r = await review();
    const who = await newPerson();
    const a = (await start(who.headers, r.row.id)).json() as { id: string };
    await settle();
    gh.headOf.set(r.prNumber, sha(9999));
    const b = (await start(who.headers, r.row.id)).json() as { id: string };
    await settle();
    expect(b.id).not.toBe(a.id);
    expect(await rowOf(a.id)).toMatchObject({
      state: 'stopped',
      detail: 'The pull request has a new commit.',
    });
    expect(host.stopped).toContain(a.id);
    expect(await rowOf(b.id)).toMatchObject({ state: 'ready', headSha: sha(9999) });
  });

  it('says so when the repository has no .sdlc/preview.yaml, or it is wrong', async () => {
    const r = await review();
    const who = await newPerson();
    gh.config = null;
    const a = (await start(who.headers, r.row.id)).json() as { id: string };
    await settle();
    expect(await rowOf(a.id)).toMatchObject({ state: 'failed' });
    expect((await rowOf(a.id)).detail).toContain('no .sdlc/preview.yaml');
    expect(host.started).toHaveLength(0);

    const r2 = await review();
    gh.config = 'install: npm ci\nport: 80\nenv: x\n';
    const b = (await start(who.headers, r2.row.id)).json() as { id: string };
    await settle();
    const row = await rowOf(b.id);
    expect(row.state).toBe('failed');
    expect(row.detail).toContain('start is required');
    expect(row.detail).toContain('port must be');
    expect(row.detail).toContain('unknown key "env"');
    expect(host.started).toHaveLength(0);
    const pack = (await view(who.headers, r2.row.id)).json();
    expect(pack).toMatchObject({ state: 'failed', source: 'platform' });
    expect(pack.platform.detail).toContain('start is required');
  });

  it('reports what went wrong when the preview does not start, and cleans up', async () => {
    const r = await review();
    const who = await newPerson();
    host.failWith = new PreviewStartError(
      'the preview stopped before it answered. Its output ended: boom',
    );
    const a = (await start(who.headers, r.row.id)).json() as { id: string };
    await settle();
    expect(await rowOf(a.id)).toMatchObject({
      state: 'failed',
      detail: 'the preview stopped before it answered. Its output ended: boom',
      url: null,
    });
    expect(host.stopped).toContain(a.id);

    host.failWith = new Error('docker is not running');
    const r2 = await review();
    const b = (await start(who.headers, r2.row.id)).json() as { id: string };
    await settle();
    expect((await rowOf(b.id)).detail).toBe('could not start the preview: docker is not running');
  });

  it('tries another port when the first is taken', async () => {
    const r = await review();
    const who = await newPerson();
    host.busyPorts.add(9300);
    const a = (await start(who.headers, r.row.id)).json() as { id: string };
    await settle();
    expect(host.started.map((s) => s.hostPort)).toEqual([9300, 9301]);
    expect(await rowOf(a.id)).toMatchObject({
      state: 'ready',
      hostPort: 9301,
      url: 'http://127.0.0.1:9301/',
    });
  });

  it('allows two at once and asks for a stop before a third', async () => {
    const who = await newPerson();
    const [a, b, c] = [await review(), await review(), await review()];
    expect((await start(who.headers, a.row.id)).statusCode).toBe(202);
    expect((await start(who.headers, b.row.id)).statusCode).toBe(202);
    await settle();
    const third = await start(who.headers, c.row.id);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('busy');
    const ready = await db.select().from(previewRun).where(eq(previewRun.state, 'ready'));
    expect(new Set(ready.map((x) => x.hostPort)).size).toBe(2);
    await stopIt(who.headers, ready[0]!.id);
    expect((await start(who.headers, c.row.id)).statusCode).toBe(202);
    await settle();
  });

  it('can be stopped, including while it is still starting', async () => {
    const who = await newPerson();
    const r = await review();
    const a = (await start(who.headers, r.row.id)).json() as { id: string };
    await settle();
    const res = await stopIt(who.headers, a.id);
    expect(res.json()).toMatchObject({ state: 'stopped' });
    expect(await rowOf(a.id)).toMatchObject({
      state: 'stopped',
      url: null,
      detail: 'Stopped by a person.',
    });
    expect(host.stopped).toContain(a.id);

    let release!: () => void;
    host.hold = new Promise((res2) => (release = res2));
    const r2 = await review();
    const b = (await start(who.headers, r2.row.id)).json() as { id: string };
    await new Promise((res2) => setTimeout(res2, 50));
    await stopIt(who.headers, b.id);
    release();
    await settle();
    expect((await rowOf(b.id)).state).toBe('stopped');
    expect(host.stopped.filter((x) => x === b.id).length).toBeGreaterThanOrEqual(2);
  });

  it('stops by itself after its time, and when the review is decided', async () => {
    const who = await newPerson();
    const r = await review();
    const a = (await start(who.headers, r.row.id)).json() as { id: string };
    const r2 = await review();
    const b = (await start(who.headers, r2.row.id)).json() as { id: string };
    await settle();
    await app.previews()!.tick();
    expect((await rowOf(a.id)).state).toBe('ready');

    await db
      .update(previewRun)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(previewRun.id, a.id));
    await db.update(interaction).set({ state: 'answered' }).where(eq(interaction.id, r2.row.id));
    await app.previews()!.tick();
    expect(await rowOf(a.id)).toMatchObject({ state: 'expired', url: null });
    expect(await rowOf(b.id)).toMatchObject({
      state: 'stopped',
      detail: 'The review was decided.',
    });
    expect(host.stopped).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('starts by itself in autopilot, once, and not in other modes', async () => {
    const auto = await review({ mode: 'autopilot' });
    const guided = await review({ mode: 'guided' });
    await app.previews()!.tick();
    await settle();
    await app.previews()!.tick();
    await settle();
    const rows = await db
      .select()
      .from(previewRun)
      .where(eq(previewRun.interactionId, auto.row.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'ready', startedBy: null });
    expect(
      await db.select().from(previewRun).where(eq(previewRun.interactionId, guided.row.id)),
    ).toHaveLength(0);

    gh.config = null;
    const bare = await review({ mode: 'autopilot' });
    await app.previews()!.tick();
    await settle();
    const [none] = await db
      .select()
      .from(previewRun)
      .where(eq(previewRun.interactionId, bare.row.id));
    expect(none).toMatchObject({ state: 'unavailable' });
    expect((await view((await newPerson()).headers, bare.row.id)).json().platform.state).toBe(
      'unavailable',
    );
  });

  it('removes what an earlier process left when it starts up', async () => {
    const who = await newPerson();
    const r = await review();
    const a = (await start(who.headers, r.row.id)).json() as { id: string };
    await settle();
    const before = host.reconciled;
    await app.previews()!.recover();
    expect(host.reconciled).toBe(before + 1);
    expect(await rowOf(a.id)).toMatchObject({ state: 'stopped', url: null });
  });

  it('is for signed-in people with a role, on an open pull request review', async () => {
    const r = await review();
    expect((await start({}, r.row.id)).statusCode).toBe(401);
    const nobody = await newPerson([]);
    expect((await start(nobody.headers, r.row.id)).statusCode).toBe(403);
    const who = await newPerson();
    const other = await review({ kind: 'integration' });
    expect((await start(who.headers, other.row.id)).statusCode).toBe(404);
    gh.state = 'closed';
    expect((await start(who.headers, r.row.id)).json().error.code).toBe('pull_request_closed');
    gh.state = 'open';
    await db.update(interaction).set({ state: 'answered' }).where(eq(interaction.id, r.row.id));
    expect((await start(who.headers, r.row.id)).json().error.code).toBe('review_decided');
    expect((await stopIt(who.headers, '0198a9d0-0000-7000-8000-000000000000')).statusCode).toBe(
      404,
    );
    expect((await stopIt(nobody.headers, '0198a9d0-0000-7000-8000-000000000000')).statusCode).toBe(
      403,
    );
  });
});
