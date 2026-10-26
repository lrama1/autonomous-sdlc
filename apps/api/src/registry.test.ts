import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { loadConfig } from './config.js';
import { GitHubError } from './github-app.js';
import { checkReadiness, scriptOf, workflowProvides } from './repo-readiness.js';
import type { AppState, RepoReader, RepoToCheck } from './repo-readiness.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

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
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: devDb.url,
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_CLIENT_ID: 'x',
      OIDC_CLIENT_SECRET: 'x',
      SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
    }),
    deps: made,
    workers: false,
    agents: new Map(),
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
    ]);
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
  const workflow = (jobs: string, on = 'pull_request') => `name: CI
on: ${on}
jobs:
${jobs}`;
  const fake = (files: Record<string, string>, branchExists = true): RepoReader => ({
    branchHead: async () => {
      if (!branchExists) throw new GitHubError(404, 'Not Found');
      return 'abcdef1234567';
    },
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

  it('flags a missing branch, script, workflow and a workflow that skips pull requests', async () => {
    expect(await statuses(repo, both, fake({}, false))).toMatchObject({
      branch: 'problem',
      verify: 'unknown',
      ci: 'unknown',
    });
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
  });

  it('cannot look up a command that is not a package script', async () => {
    const s = await statuses({ ...repo, verifyCommand: 'make check' }, both, fake({}));
    expect(s.verify).toBe('unknown');
  });

  it('reports a GitHub failure as unknown, not as a problem with the repository', async () => {
    const gh: RepoReader = {
      branchHead: async () => 'abc1234',
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
