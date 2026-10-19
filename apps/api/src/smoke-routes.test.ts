import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  createRunFixture,
  githubApp,
  hat,
  interaction,
  person,
  repositoryEntry,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { PreviewHost } from './docker-preview.js';
import { GitHubClient, secretName } from './github-app.js';
import { MemorySecrets } from './secrets.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CONFIG =
  'start: node server.js\nport: 3000\nsmoke:\n  - get: /health\n  - get: /items\n    contains: items\n  - run: npm run smoke\n';

const gh = {
  headOf: new Map<number, string>(),
  config: CONFIG as string | null,
  calls: [] as Array<{ method: string; url: string; body: Record<string, unknown> }>,
};

/** The app under test: answers /health and /items, or breaks when told to. Commands pass or fail as told. */
const target = { healthy: true, exitCode: 0 };
let appServer: http.Server;
class Host implements PreviewHost {
  async start() {
    return { url: `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/` };
  }
  async exec() {
    return { exitCode: target.exitCode, output: target.exitCode ? 'it broke' : 'fine' };
  }
  async stop() {}
  async reconcile() {}
}

let server: http.Server;
let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let bare: Awaited<ReturnType<typeof buildApp>>;
let n = 0;
const sha = (k: number) => `beef${String(k).padStart(36, '0')}`;

async function newPerson(roles: string[] = ['backend_engineer'], a = app) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `s${k}@example.test`, oidcSubject: `s${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    headers: {
      cookie: `sdlc_session=${a.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
    },
  };
}

async function review() {
  const f = await createRunFixture(db);
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
  const prNumber = 400 + ++n;
  gh.headOf.set(prNumber, sha(prNumber));
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: `Review PR #${prNumber}: Add a page`,
      roleNeeded: 'backend_engineer',
      contextCard: {
        kind: 'pull_request',
        repository: repo!.fullName,
        prNumber,
        prUrl: `https://github.com/o/r/pull/${prNumber}`,
        headSha: sha(prNumber),
      },
    })
    .returning();
  return { id: row!.id, prNumber };
}

type Headers = Record<string, string>;
const get = (headers: Headers, id: string) =>
  app.inject({ method: 'GET', url: `/api/interactions/${id}/smoke`, headers });
const start = (headers: Headers, id: string) =>
  app.inject({ method: 'POST', url: `/api/interactions/${id}/smoke/start`, headers });
const override = (headers: Headers, id: string, reason?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/interactions/${id}/smoke/override`,
    headers,
    payload: reason === undefined ? {} : { reason },
  });
const approve = (headers: Headers, id: string) =>
  app.inject({
    method: 'POST',
    url: `/api/interactions/${id}/answer`,
    headers,
    payload: { decision: 'approved', answer: 'looks good' },
  });

/** Starts a smoke test and waits for it to finish, the way a person watching the page would. */
async function runAndWait(headers: Headers, id: string) {
  const res = await start(headers, id);
  expect(res.statusCode).toBe(202);
  for (let i = 0; i < 200; i++) {
    const s = (await get(headers, id)).json();
    if (s.run && s.run.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the smoke test did not finish');
}

beforeAll(async () => {
  appServer = http.createServer((req, res) => {
    if (req.url === '/health') return void res.writeHead(target.healthy ? 200 : 500).end('ok');
    if (req.url === '/items') return void res.end('{"items":[]}');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));

  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? '';
    gh.calls.push({
      method: req.method ?? '',
      url,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
    });
    const json = (status: number, b: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b));
    };
    if (url.endsWith('/access_tokens'))
      return json(201, { token: 'ghs_fake', expires_at: '2026-10-19T00:00:00Z', permissions: {} });
    const pr = /\/pulls\/(\d+)$/.exec(url);
    if (pr && req.method === 'GET')
      return json(200, {
        number: Number(pr[1]),
        html_url: 'https://github.com/o/r/pull/7',
        state: 'open',
        merged: false,
        mergeable_state: 'clean',
        head: { sha: gh.headOf.get(Number(pr[1])) ?? sha(0), ref: 'agent/run/change' },
        base: { ref: 'main' },
      });
    if (url.includes('/contents/.sdlc/preview.yaml')) {
      if (gh.config === null) return json(404, { message: 'Not Found' });
      return json(200, { encoding: 'base64', content: Buffer.from(gh.config).toString('base64') });
    }
    if (url.includes('/tarball/')) return void res.writeHead(200).end(Buffer.from('fake-tarball'));
    if (url.includes('/check-runs'))
      return json(200, {
        check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }],
      });
    if (req.method === 'POST' && url.endsWith('/reviews')) return json(200, { id: 1 });
    if (req.method === 'PUT' && url.endsWith('/merge'))
      return json(200, { sha: 'merge-sha', merged: true });
    if (req.method === 'POST' && url.endsWith('/comments')) return json(201, { id: 2 });
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const githubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-smokeroutes-'));
  devDb = await startDevDb({ dataDir, port: 56354 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const secrets = new MemorySecrets();
  for (const kind of ['agent', 'gate'] as const)
    await secrets.put(secretName(kind, 'private_key'), privateKey);
  const make = (previewHost?: PreviewHost) =>
    buildApp({
      config: loadConfig({
        DATABASE_URL: devDb.url,
        OIDC_ISSUER: 'http://localhost:9000',
        OIDC_CLIENT_ID: 'x',
        OIDC_CLIENT_SECRET: 'x',
        SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
        GITHUB_API_URL: githubUrl,
        PREVIEW_PORT_BASE: '9400',
      }),
      deps: made,
      workers: false,
      secrets,
      github: new GitHubClient(githubUrl),
      previewHost,
    });
  app = await make(new Host());
  await app.ready();
  // The same platform without a way to run previews.
  bare = await make();
  await bare.ready();
}, 180_000);

beforeEach(() => {
  gh.config = CONFIG;
  gh.calls = [];
  target.healthy = true;
  target.exitCode = 0;
});

afterAll(async () => {
  await app?.close();
  await bare?.close();
  appServer?.closeAllConnections();
  await new Promise((r) => appServer?.close(r));
  await new Promise((r) => server?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('the smoke test on a review', () => {
  it('holds the approval, runs on a click, and lets the pull request merge once it passes', async () => {
    const r = await review();
    const who = await newPerson();

    const before = (await get(who.headers, r.id)).json();
    expect(before).toMatchObject({ available: true, required: 'required', run: null });
    expect(before.blocks).toContain('none has run on this commit');

    const held = await approve(who.headers, r.id);
    expect(held.statusCode).toBe(409);
    expect(held.json().error.code).toBe('smoke_required');
    expect((await db.select().from(interaction).where(eq(interaction.id, r.id)))[0]!.state).toBe(
      'open',
    );

    const done = await runAndWait(who.headers, r.id);
    expect(done.run).toMatchObject({ state: 'passed', by: expect.any(String) });
    expect(done.run.results.map((x: { label: string }) => x.label)).toEqual([
      'GET /health',
      'GET /items',
      'run npm run smoke',
    ]);
    expect(done.blocks).toBeNull();

    const ok = await approve(who.headers, r.id);
    expect(ok.statusCode).toBe(200);
    const approval = gh.calls.find((c) => c.url.endsWith('/reviews'))!;
    expect(approval.body.body).toContain('Smoke test passed (3 checks).');
    expect(gh.calls.some((c) => c.url.endsWith('/merge'))).toBe(true);
  });

  it('keeps holding a failed test, shows why, and merges only after a reasoned override', async () => {
    const r = await review();
    const reviewer = await newPerson();
    target.healthy = false;
    target.exitCode = 1;
    const failed = await runAndWait(reviewer.headers, r.id);
    expect(failed.run.state).toBe('failed');
    expect(failed.run.results.map((x: { ok: boolean }) => x.ok)).toEqual([false, true, false]);
    expect(failed.run.results[0].detail).toBe('expected 200, got 500: ok');
    expect((await approve(reviewer.headers, r.id)).statusCode).toBe(409);

    // An override needs a real reason, and a person who may approve.
    expect((await override(reviewer.headers, r.id)).statusCode).toBe(400);
    expect((await override(reviewer.headers, r.id, 'no')).json().error.code).toBe(
      'reason_required',
    );
    const nobody = await newPerson([]);
    expect((await override(nobody.headers, r.id, 'the reason is long enough')).statusCode).toBe(
      403,
    );
    const wrongHat = await newPerson(['frontend_engineer']);
    expect((await override(wrongHat.headers, r.id, 'the reason is long enough')).statusCode).toBe(
      403,
    );

    const res = await override(
      reviewer.headers,
      r.id,
      'The health route is being rebuilt in the next PR.',
    );
    expect(res.statusCode).toBe(201);
    const after = (await get(reviewer.headers, r.id)).json();
    expect(after.run).toMatchObject({
      state: 'overridden',
      detail: 'The health route is being rebuilt in the next PR.',
    });
    expect(after.blocks).toBeNull();

    expect((await approve(reviewer.headers, r.id)).statusCode).toBe(200);
    const approval = gh.calls.find((c) => c.url.endsWith('/reviews'))!;
    expect(approval.body.body).toContain('Smoke test overridden by');
    expect(approval.body.body).toContain('The health route is being rebuilt in the next PR.');
    expect(gh.calls.some((c) => c.url.endsWith('/merge'))).toBe(true);
  });

  it('says nothing about a repository with no smoke checks, and does not hold it', async () => {
    gh.config = 'start: node server.js\n';
    const r = await review();
    const who = await newPerson();
    expect((await get(who.headers, r.id)).json()).toMatchObject({
      required: 'none',
      blocks: null,
    });
    expect((await start(who.headers, r.id)).json().error.code).toBe('no_smoke_checks');
    expect((await override(who.headers, r.id, 'the reason is long enough')).statusCode).toBe(409);
    expect((await approve(who.headers, r.id)).statusCode).toBe(200);
  });

  it('is off on a platform that cannot run previews, and asks nothing', async () => {
    const r = await review();
    const who = await newPerson(['backend_engineer'], bare);
    const view = await bare.inject({
      method: 'GET',
      url: `/api/interactions/${r.id}/smoke`,
      headers: who.headers,
    });
    expect(view.json()).toMatchObject({ available: false, required: 'none', blocks: null });
    const click = await bare.inject({
      method: 'POST',
      url: `/api/interactions/${r.id}/smoke/start`,
      headers: who.headers,
    });
    expect(click.statusCode).toBe(409);
    expect(click.json().error.code).toBe('smoke_off');
    const ok = await bare.inject({
      method: 'POST',
      url: `/api/interactions/${r.id}/answer`,
      headers: who.headers,
      payload: { decision: 'approved', answer: 'fine' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('needs a signed-in person with a role, and a pull request review', async () => {
    const r = await review();
    expect((await get({}, r.id)).statusCode).toBe(401);
    expect((await start({}, r.id)).statusCode).toBe(401);
    expect((await override({}, r.id, 'the reason is long enough')).statusCode).toBe(401);
    const nobody = await newPerson([]);
    expect((await start(nobody.headers, r.id)).statusCode).toBe(403);
    const who = await newPerson();
    expect((await get(who.headers, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});
