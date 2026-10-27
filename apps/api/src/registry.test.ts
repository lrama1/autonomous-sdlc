import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  createDb,
  githubApp,
  hat,
  initiative,
  person,
  repositoryEntry,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadAgents } from './agents.js';
import { loadConfig } from './config.js';
import { GitHubClient, GitHubError, secretName } from './github-app.js';
import { MemorySecrets } from './secrets.js';
import { checkReadiness, scriptOf, workflowProvides } from './repo-readiness.js';
import type { AppState, RepoReader, RepoToCheck } from './repo-readiness.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

// A GitHub that knows a few repositories. Each says whether it is empty, has its branch, protects it, and holds files.
interface FakeRepo {
  empty?: boolean;
  branch?: boolean;
  protected?: boolean;
  files?: Record<string, string>;
}
const repos: Record<string, FakeRepo> = {};
let puts: Array<{ auth: string | null; path: string; body: Record<string, unknown> }> = [];
let tokenAsks: Array<Record<string, unknown>> = [];

class FakeGitHub extends GitHubClient {
  constructor() {
    super('http://github.invalid');
  }
  override async call<T>(
    method: string,
    path: string,
    auth: string | null,
    body?: unknown,
  ): Promise<T> {
    if (method === 'POST' && path.startsWith('/app/installations/')) {
      tokenAsks.push((body ?? {}) as Record<string, unknown>);
      return { token: 'tok', expires_at: '2099-01-01T00:00:00Z' } as T;
    }
    const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
    if (!m) throw new GitHubError(404, `unexpected ${method} ${path}`);
    const r = repos[m[1]!];
    const rest = m[2]!;
    if (!r) throw new GitHubError(404, 'Not Found');
    const [route, query = ''] = rest.split('?');
    if (method === 'GET' && route!.startsWith('branches/')) {
      if (r.empty || !r.branch) throw new GitHubError(404, 'Branch not found');
      return { commit: { sha: 'abcdef1234567' }, protected: Boolean(r.protected) } as T;
    }
    if (method === 'GET' && route === 'branches') return (r.empty ? [] : [{ name: 'other' }]) as T;
    if (method === 'PUT' && route!.startsWith('contents/')) {
      puts.push({
        auth,
        path: route!.slice('contents/'.length),
        body: (body ?? {}) as Record<string, unknown>,
      });
      return { commit: { sha: 'c0ffee1' } } as T;
    }
    if (method === 'GET' && route!.startsWith('contents/')) {
      const file = decodeURIComponent(route!.slice('contents/'.length));
      const files = r.files ?? {};
      const dirFiles = Object.keys(files).filter((f) => f.startsWith(`${file}/`));
      if (dirFiles.length > 0)
        return dirFiles.map((f) => ({ name: f.slice(file.length + 1), type: 'file' })) as T;
      if (files[file] === undefined) throw new GitHubError(404, 'Not Found');
      void query;
      return { encoding: 'base64', content: Buffer.from(files[file]!).toString('base64') } as T;
    }
    throw new GitHubError(404, `unexpected ${method} ${path}`);
  }
}

const workflowText = (jobs: string, on = 'pull_request') => `name: CI\non: ${on}\njobs:\n${jobs}`;
const goodFiles = {
  'package.json': JSON.stringify({ scripts: { verify: 'node --test' } }),
  '.github/workflows/ci.yml': workflowText('  verify:\n    runs-on: ubuntu-latest\n'),
};
async function login(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `P${k}`, email: `p${k}@example.test`, oidcSubject: `p${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
  };
}
const as = (cookie: string) => ({ cookie });

async function installApps(perApp: { agent: string[]; gate: string[] }) {
  await db.delete(githubApp);
  for (const kind of ['agent', 'gate'] as const) {
    await db.insert(githubApp).values({
      kind,
      appId: 1,
      slug: `${kind}-app`,
      name: kind,
      ownerLogin: 'me',
      htmlUrl: 'https://x',
      installationId: 9,
      installedOn: perApp[kind],
    });
  }
}

async function register(
  name = `me/repo-${Date.now()}-${++n}`,
  more: Partial<typeof repositoryEntry.$inferInsert> = {},
) {
  const [r] = await db
    .insert(repositoryEntry)
    .values({ fullName: name, ...more })
    .returning();
  return r!;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-registry-'));
  devDb = await startDevDb({ dataDir, port: 56356 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const pem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const secrets = new MemorySecrets();
  await secrets.put(secretName('agent', 'private_key'), pem);
  await secrets.put(secretName('gate', 'private_key'), pem);
  app = await buildApp({
    github: new FakeGitHub(),
    secrets,
    config: loadConfig({
      DATABASE_URL: devDb.url,
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_CLIENT_ID: 'x',
      OIDC_CLIENT_SECRET: 'x',
      SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
    }),
    deps: made,
    workers: false,
    agents: await loadAgents(fileURLToPath(new URL('../../../agents', import.meta.url))),
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

beforeEach(async () => {
  await db.delete(githubApp);
  for (const k of Object.keys(repos)) delete repos[k];
  puts = [];
  tokenAsks = [];
});

describe('which repositories can be registered', () => {
  const get = (cookie: string) =>
    app.inject({ url: '/api/repositories/available', headers: as(cookie) });

  it('is for a Platform Admin only', async () => {
    expect((await app.inject('/api/repositories/available')).statusCode).toBe(401);
    const eng = await login(['backend_engineer']);
    expect((await get(eng.cookie)).statusCode).toBe(403);
  });

  it('says what is missing before both Apps are installed', async () => {
    const admin = await login(['platform_admin']);
    const res = await get(admin.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().available).toEqual([]);
    expect(res.json().problem).toMatch(/GitHub setup/);
  });

  it('lists only repositories both Apps can see and that are not registered', async () => {
    await register('acme/taken');
    await installApps({
      agent: ['acme/taken', 'acme/b-both', 'acme/a-both', 'acme/agent-only'],
      gate: ['acme/taken', 'acme/b-both', 'acme/a-both', 'acme/gate-only'],
    });
    const admin = await login(['platform_admin']);
    const res = await get(admin.cookie);
    expect(res.json()).toEqual({ problem: null, available: ['acme/a-both', 'acme/b-both'] });
  });
});

describe('changing and removing a repository', () => {
  const patch = (cookie: string, repoId: string, payload: object) =>
    app.inject({
      method: 'PATCH',
      url: `/api/repositories/${repoId}`,
      headers: as(cookie),
      payload,
    });
  const del = (cookie: string, repoId: string) =>
    app.inject({ method: 'DELETE', url: `/api/repositories/${repoId}`, headers: as(cookie) });

  it('needs a Platform Admin', async () => {
    const repo = await register();
    const eng = await login(['backend_engineer']);
    expect((await patch(eng.cookie, repo.id, { verifyCommand: 'npm test' })).statusCode).toBe(403);
    expect((await del(eng.cookie, repo.id)).statusCode).toBe(403);
  });

  it('changes only the settings it is given, and logs what changed', async () => {
    const repo = await register(undefined, { integrationBranch: 'develop', writeMode: 'direct' });
    const admin = await login(['platform_admin']);
    const res = await patch(admin.cookie, repo.id, {
      verifyCommand: 'pnpm verify',
      protectedPaths: ['.github/**'],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      fullName: repo.fullName,
      verifyCommand: 'pnpm verify',
      protectedPaths: ['.github/**'],
      integrationBranch: 'develop',
      requiredCheck: 'verify',
      writeMode: 'direct',
    });
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'registry.updated'));
    const mine = log.find((l) => l.actorId === admin.id);
    expect(mine?.detail).toMatchObject({
      fullName: repo.fullName,
      changed: { verifyCommand: 'pnpm verify' },
      was: { verifyCommand: 'npm run verify' },
    });
  });

  it('refuses an empty change, a bad value, and an unknown repository', async () => {
    const repo = await register();
    const admin = await login(['platform_admin']);
    expect((await patch(admin.cookie, repo.id, {})).statusCode).toBe(400);
    expect((await patch(admin.cookie, repo.id, { writeMode: 'yolo' })).statusCode).toBe(400);
    expect(
      (await patch(admin.cookie, '00000000-0000-4000-8000-000000000000', { requiredCheck: 'ci' }))
        .statusCode,
    ).toBe(404);
  });

  it('removes a repository nobody has used, and logs it', async () => {
    const repo = await register();
    const admin = await login(['platform_admin']);
    expect((await del(admin.cookie, repo.id)).statusCode).toBe(204);
    const rows = await db.select().from(repositoryEntry).where(eq(repositoryEntry.id, repo.id));
    expect(rows).toHaveLength(0);
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'registry.removed'));
    expect(log.some((l) => l.actorId === admin.id)).toBe(true);
  });

  it('keeps a repository that has initiatives', async () => {
    const repo = await register();
    const admin = await login(['platform_admin']);
    await db
      .insert(initiative)
      .values({ title: 't', goal: 'g', repositoryId: repo.id, createdBy: admin.id });
    const res = await del(admin.cookie, repo.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('in_use');
    expect(
      await db.select().from(repositoryEntry).where(eq(repositoryEntry.id, repo.id)),
    ).toHaveLength(1);
  });
});

async function installBoth(names: string[]) {
  await installApps({ agent: names, gate: names });
}

describe('the readiness route', () => {
  it('is for a Platform Admin and reports the Apps first', async () => {
    const repo = await register('acme/ready-route');
    const eng = await login(['backend_engineer']);
    const url = `/api/repositories/${repo.id}/readiness`;
    expect((await app.inject({ url, headers: as(eng.cookie) })).statusCode).toBe(403);
    const admin = await login(['platform_admin']);
    const res = await app.inject({ url, headers: as(admin.cookie) });
    expect(res.statusCode).toBe(200);
    const checks = res.json().checks as Array<{ id: string; status: string }>;
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['apps', 'problem'],
      ['branch', 'unknown'],
      ['verify', 'unknown'],
      ['ci', 'unknown'],
      ['protection', 'unknown'],
    ]);
  });

  it('offers the first commit for an empty repository, with exactly what it would write', async () => {
    const repo = await register('acme/brand-new');
    await installBoth(['acme/brand-new']);
    repos['acme/brand-new'] = { empty: true };
    const admin = await login(['platform_admin']);
    const res = await app.inject({
      url: `/api/repositories/${repo.id}/readiness`,
      headers: as(admin.cookie),
    });
    const branch = (res.json().checks as Array<{ id: string; status: string; fix?: object }>).find(
      (c) => c.id === 'branch',
    )!;
    expect(branch.status).toBe('problem');
    expect(branch.fix).toMatchObject({ kind: 'first_commit', path: 'README.md' });
  });

  it('says how to protect a branch that is not protected, and calls a protected one ready', async () => {
    const repo = await register('acme/guarded');
    await installBoth(['acme/guarded']);
    repos['acme/guarded'] = { branch: true, protected: false, files: goodFiles };
    const admin = await login(['platform_admin']);
    const url = `/api/repositories/${repo.id}/readiness`;
    type C = { id: string; status: string; howTo?: { link?: string; steps: string[] } };
    const first = (await app.inject({ url, headers: as(admin.cookie) })).json().checks as C[];
    const p = first.find((c) => c.id === 'protection')!;
    expect(p.status).toBe('problem');
    expect(p.howTo!.link).toBe('https://github.com/acme/guarded/settings/rules/new?target=branch');
    expect(p.howTo!.steps.join(' ')).toContain('Require status checks');
    repos['acme/guarded']!.protected = true;
    const second = (await app.inject({ url, headers: as(admin.cookie) })).json().checks as C[];
    expect(second.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });
});

describe('the first commit', () => {
  const post = (cookie: string, repoId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/repositories/${repoId}/first-commit`,
      headers: as(cookie),
    });

  it('is for a Platform Admin only', async () => {
    const repo = await register('acme/first-a');
    const eng = await login(['backend_engineer']);
    expect((await post(eng.cookie, repo.id)).statusCode).toBe(403);
    expect(puts).toHaveLength(0);
  });

  it('makes the first commit of an empty repository with the Agent App, and logs it', async () => {
    const repo = await register('acme/first-b');
    await installBoth(['acme/first-b']);
    repos['acme/first-b'] = { empty: true };
    const admin = await login(['platform_admin']);
    const res = await post(admin.cookie, repo.id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sha: 'c0ffee1', branch: 'main', path: 'README.md' });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.auth).toBe('tok');
    expect(puts[0]!.body).toMatchObject({ branch: 'main', message: 'Start the repository' });
    expect(Buffer.from(String(puts[0]!.body.content), 'base64').toString()).toContain('# first-b');
    expect(tokenAsks.at(-1)).toMatchObject({
      repositories: ['first-b'],
      permissions: { contents: 'write' },
    });
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'registry.first_commit'));
    expect(log.some((l) => l.actorId === admin.id)).toBe(true);
  });

  it('leaves a repository that already has commits alone', async () => {
    const repo = await register('acme/first-c');
    await installBoth(['acme/first-c']);
    repos['acme/first-c'] = { branch: true, files: goodFiles };
    const admin = await login(['platform_admin']);
    const res = await post(admin.cookie, repo.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_empty');
    expect(puts).toHaveLength(0);
  });
});

describe('starting an initiative', () => {
  const start = (cookie: string, repositoryId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/initiatives',
      headers: as(cookie),
      payload: { title: 'Plan', goal: 'A goal', repositoryId },
    });

  it('is refused, with the reason, while the repository has no branch to start from', async () => {
    const repo = await register('acme/no-branch');
    await installBoth(['acme/no-branch']);
    repos['acme/no-branch'] = { empty: true };
    const po = await login(['product_owner']);
    const res = await start(po.cookie, repo.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('branch_missing');
    expect(res.json().error.message).toContain('Repositories page');
    expect(
      await db.select().from(initiative).where(eq(initiative.repositoryId, repo.id)),
    ).toHaveLength(0);
  });

  it('goes ahead when the branch exists, and when GitHub cannot be asked', async () => {
    const po = await login(['product_owner']);
    const ok = await register('acme/has-branch');
    await installBoth(['acme/has-branch']);
    repos['acme/has-branch'] = { branch: true, files: goodFiles };
    expect((await start(po.cookie, ok.id)).statusCode).toBe(201);
    // No Apps installed for this one: GitHub cannot be asked, and that must not block the work.
    await db.delete(githubApp);
    const unknown = await register('acme/unknown-state');
    expect((await start(po.cookie, unknown.id)).statusCode).toBe(201);
  });
});

describe('the readiness checks', () => {
  const repo: RepoToCheck = {
    fullName: 'acme/shop',
    integrationBranch: 'main',
    verifyCommand: 'npm run verify',
    requiredCheck: 'verify',
  };
  const both: AppState[] = [
    { kind: 'agent', installationId: 1, installedOn: ['acme/shop'] },
    { kind: 'gate', installationId: 2, installedOn: ['acme/shop'] },
  ];
  const workflow = workflowText;
  const fake = (
    files: Record<string, string>,
    o: { branch?: boolean; empty?: boolean; protected?: boolean } = {},
  ): RepoReader => ({
    branchInfo: async () =>
      o.branch === false ? null : { sha: 'abcdef1234567', protected: o.protected ?? true },
    isEmpty: async () => Boolean(o.empty),
    readFile: async (_r, p) => files[p] ?? null,
    listFiles: async (_r, dir) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${dir}/`))
        .map((f) => f.slice(dir.length + 1)),
  });
  const statuses = async (r: RepoToCheck, apps: AppState[], gh: RepoReader) =>
    Object.fromEntries((await checkReadiness(r, apps, gh)).map((c) => [c.id, c.status]));

  it('passes a repository set up the way the platform expects', async () => {
    const gh = fake({
      'package.json': JSON.stringify({ scripts: { verify: 'node --test' } }),
      '.github/workflows/ci.yml': workflow('  verify:\n    runs-on: ubuntu-latest\n'),
    });
    expect(await statuses(repo, both, gh)).toEqual({
      apps: 'ok',
      branch: 'ok',
      verify: 'ok',
      ci: 'ok',
      protection: 'ok',
    });
  });

  it('says which App is missing', async () => {
    const checks = await checkReadiness(
      repo,
      [both[0]!, { kind: 'gate', installationId: 2, installedOn: ['acme/other'] }],
      fake({}),
    );
    expect(checks[0]).toMatchObject({ id: 'apps', status: 'problem' });
    expect(checks[0]!.detail).toContain('gate GitHub App');
    expect(checks[0]!.detail).not.toContain('agent and');
  });

  it('tells an empty repository from one that only lacks the branch', async () => {
    const empty = await checkReadiness(repo, both, fake({}, { branch: false, empty: true }));
    expect(empty.find((c) => c.id === 'branch')).toMatchObject({
      status: 'problem',
      fix: { kind: 'first_commit', path: 'README.md' },
    });
    const other = await checkReadiness(repo, both, fake({}, { branch: false }));
    const b = other.find((c) => c.id === 'branch')!;
    expect(b.status).toBe('problem');
    expect(b.fix).toBeUndefined();
    expect(b.detail).toContain('no branch called main');
    expect(await statuses(repo, both, fake({}, { branch: false }))).toMatchObject({
      verify: 'unknown',
      ci: 'unknown',
      protection: 'unknown',
    });
  });

  it('flags a missing script, workflow, a workflow that skips pull requests, and no protection', async () => {
    expect(await statuses(repo, both, fake({}))).toMatchObject({
      branch: 'ok',
      verify: 'problem',
      ci: 'problem',
    });
    const noScript = fake({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
    expect(await statuses(repo, both, noScript)).toMatchObject({ verify: 'problem' });
    const pushOnly = fake({
      '.github/workflows/ci.yml': workflow('  verify:\n    runs-on: x\n', 'push'),
    });
    expect(await statuses(repo, both, pushOnly)).toMatchObject({ ci: 'problem' });
    expect(await statuses(repo, both, fake({}, { protected: false }))).toMatchObject({
      protection: 'problem',
    });
  });

  it('cannot look up a command that is not a package script', async () => {
    const s = await statuses({ ...repo, verifyCommand: 'make check' }, both, fake({}));
    expect(s.verify).toBe('unknown');
  });

  it('reports a GitHub failure as unknown, not as a problem with the repository', async () => {
    const gh: RepoReader = {
      branchInfo: async () => ({ sha: 'abc1234', protected: true }),
      isEmpty: async () => false,
      readFile: async () => {
        throw new Error('rate limited');
      },
      listFiles: async () => {
        throw new Error('rate limited');
      },
    };
    expect(await statuses(repo, both, gh)).toMatchObject({ verify: 'unknown', ci: 'unknown' });
  });
});
describe('reading a workflow', () => {
  it('finds the job by its key or its name, and matrix variants', () => {
    const base = (job: string) => `on: [pull_request]
jobs:
${job}`;
    expect(workflowProvides(base('  verify:\n    runs-on: x\n'), 'verify').provides).toBe(true);
    expect(
      workflowProvides(base('  build:\n    name: verify\n    runs-on: x\n'), 'verify').provides,
    ).toBe(true);
    expect(
      workflowProvides(base('  v:\n    name: verify (node 22)\n    runs-on: x\n'), 'verify')
        .provides,
    ).toBe(true);
    expect(workflowProvides(base('  other:\n    runs-on: x\n'), 'verify').provides).toBe(false);
    expect(workflowProvides(': not yaml: [', 'verify')).toEqual({
      provides: false,
      onPullRequest: false,
    });
  });

  it('knows the script a command runs', () => {
    expect(scriptOf('npm run verify')).toBe('verify');
    expect(scriptOf('pnpm verify')).toBe('verify');
    expect(scriptOf('yarn run test:all')).toBe('test:all');
    expect(scriptOf('make check')).toBeNull();
    expect(scriptOf('npm run verify && echo hi')).toBeNull();
  });
});
