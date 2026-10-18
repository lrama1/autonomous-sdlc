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
import { GitHubClient, secretName } from './github-app.js';
import { MemorySecrets } from './secrets.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const HEAD = 'c0ffee0000000000000000000000000000000001';
const OLD = 'decaf00000000000000000000000000000000002';

interface Deployment {
  id: number;
  sha: string;
  environment: string;
  created_at: string;
}
interface DeploymentStatus {
  state: string;
  environment_url?: string;
  target_url?: string;
  created_at: string;
}
interface World {
  deployments: Deployment[];
  statuses: Record<number, DeploymentStatus[]>;
  commitStatuses: Array<{
    context: string;
    state: string;
    target_url?: string;
    created_at: string;
  }>;
  deploymentsStatus: number;
  calls: string[];
}
let world: World;
const reset = () =>
  (world = {
    deployments: [],
    statuses: {},
    commitStatuses: [],
    deploymentsStatus: 200,
    calls: [],
  });

let github: http.Server;
let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

async function newPerson() {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `p${k}@example.test`, oidcSubject: `p${k}` })
    .returning();
  return {
    headers: {
      cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
    },
  };
}

async function review(kind = 'pull_request') {
  const f = await createRunFixture(db);
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  await db.delete(githubApp);
  for (const k of ['agent', 'gate']) {
    await db.insert(githubApp).values({
      kind: k,
      appId: 9,
      slug: k,
      name: k,
      ownerLogin: 'me',
      htmlUrl: 'https://x',
      installationId: 5,
      installedOn: [repo!.fullName],
    });
  }
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: 'Review PR #7',
      roleNeeded: 'backend_engineer',
      contextCard: {
        kind,
        repository: repo!.fullName,
        // The route caches per pull request, so each test uses its own.
        prNumber: 100 + ++n,
        prUrl: 'https://github.com/o/r/pull/7',
        headSha: HEAD,
      },
    })
    .returning();
  return row!;
}

const get = (headers: Record<string, string>, id: string) =>
  app.inject({ method: 'GET', url: `/api/interactions/${id}/preview`, headers });

beforeAll(async () => {
  github = http.createServer((req, res) => {
    const url = req.url ?? '';
    world.calls.push(`${req.method} ${url}`);
    const json = (status: number, b: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b));
    };
    if (url.endsWith('/access_tokens'))
      return json(201, { token: 'ghs_fake', expires_at: '2026-10-19T00:00:00Z', permissions: {} });
    if (/\/pulls\/\d+$/.test(url))
      return json(200, {
        number: Number(url.split('/').pop()),
        html_url: 'https://github.com/o/r/pull/7',
        state: 'open',
        merged: false,
        head: { sha: HEAD, ref: 'agent/run-1/change' },
        base: { ref: 'main' },
      });
    if (/\/deployments\?/.test(url)) {
      if (world.deploymentsStatus !== 200)
        return json(world.deploymentsStatus, { message: 'Resource not accessible by integration' });
      return json(200, world.deployments);
    }
    const m = /\/deployments\/(\d+)\/statuses/.exec(url);
    if (m) return json(200, world.statuses[Number(m[1])] ?? []);
    if (/\/commits\/[^/]+\/status/.test(url))
      return json(200, { state: 'success', statuses: world.commitStatuses });
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));
  const githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-preview-'));
  devDb = await startDevDb({ dataDir, port: 56344 });
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
    }),
    deps: made,
    workers: false,
    secrets,
    github: new GitHubClient(githubUrl),
  });
  await app.ready();
  reset();
}, 180_000);

beforeEach(() => reset());

afterAll(async () => {
  await app?.close();
  await new Promise((r) => github?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('the preview of a pull request under review', () => {
  it('requires a signed-in person and a pull request review', async () => {
    const r = await review();
    expect((await get({}, r.id)).statusCode).toBe(401);
    const person1 = await newPerson();
    const other = await review('integration');
    expect((await get(person1.headers, other.id)).statusCode).toBe(404);
  });

  it('shows the Deployment the repository reported for the current commit', async () => {
    const r = await review();
    const who = await newPerson();
    world.deployments = [
      { id: 11, sha: HEAD, environment: 'preview/pr-7', created_at: '2026-10-18T10:00:00Z' },
    ];
    world.statuses[11] = [
      {
        state: 'success',
        environment_url: 'https://pr-7.preview.example.test',
        created_at: '2026-10-18T10:02:00Z',
      },
    ];
    const res = await get(who.headers, r.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'ready',
      url: 'https://pr-7.preview.example.test/',
      label: 'preview/pr-7',
      source: 'deployment',
      sha: HEAD,
      headSha: HEAD,
    });
  });

  it('calls a preview of an older commit stale', async () => {
    const r = await review();
    const who = await newPerson();
    world.deployments = [
      { id: 12, sha: OLD, environment: 'preview/pr-7', created_at: '2026-10-18T09:00:00Z' },
    ];
    world.statuses[12] = [
      {
        state: 'success',
        environment_url: 'https://pr-7.preview.example.test',
        created_at: '2026-10-18T09:02:00Z',
      },
    ];
    const body = (await get(who.headers, r.id)).json();
    expect(body.state).toBe('stale');
    expect(body.sha).toBe(OLD);
    expect(body.detail).toContain('decaf00');
  });

  it('falls back to a commit status named "preview" when Deployments cannot be read', async () => {
    const r = await review();
    const who = await newPerson();
    world.deploymentsStatus = 403;
    world.commitStatuses = [
      {
        context: 'verify',
        state: 'success',
        target_url: 'https://ci.example.test/1',
        created_at: '2026-10-18T10:00:00Z',
      },
      {
        context: 'ci/preview',
        state: 'success',
        target_url: 'https://pr-7.status.example.test',
        created_at: '2026-10-18T10:00:00Z',
      },
    ];
    expect((await get(who.headers, r.id)).json()).toMatchObject({
      state: 'ready',
      source: 'status',
      label: 'ci/preview',
      url: 'https://pr-7.status.example.test/',
    });
  });

  it('explains the missing permission when nothing else was reported', async () => {
    const r = await review();
    const who = await newPerson();
    world.deploymentsStatus = 403;
    const body = (await get(who.headers, r.id)).json();
    expect(body.state).toBe('not_permitted');
    expect(body.detail).toContain('Deployments');
  });

  it('says none when the repository reported nothing, and never links an unsafe address', async () => {
    const r = await review();
    const who = await newPerson();
    expect((await get(who.headers, r.id)).json().state).toBe('none');

    const r2 = await review();
    world.deployments = [
      { id: 13, sha: HEAD, environment: 'preview', created_at: '2026-10-18T10:00:00Z' },
    ];
    world.statuses[13] = [
      {
        state: 'success',
        environment_url: 'javascript:alert(1)',
        created_at: '2026-10-18T10:01:00Z',
      },
    ];
    const body = (await get(who.headers, r2.id)).json();
    expect(body.state).toBe('none');
    expect(body.url).toBeNull();
  });

  it('asks GitHub at most once in a short while for the same pull request', async () => {
    const r = await review();
    const who = await newPerson();
    await get(who.headers, r.id);
    const first = world.calls.length;
    await get(who.headers, r.id);
    expect(world.calls.length).toBe(first);
  });
});
