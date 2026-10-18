import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  agentRun,
  authenticateRunToken,
  createDb,
  githubApp,
  hat,
  initiative,
  person,
  repositoryEntry,
  runEvent,
  runMigrations,
  runToken,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { loadAgents } from './agents.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { issueRunToken } from './runs.js';

const agentsDir = fileURLToPath(new URL('../../../agents', import.meta.url));

describe('loadAgents', () => {
  it('loads the shipped backend engineer', async () => {
    const agents = await loadAgents(agentsDir);
    const a = agents.get('backend_engineer')!;
    expect(a.definition).toMatchObject({
      id: 'backend-engineer',
      version: 1,
      engine: 'claude-code',
      model_alias: 'agent-default',
    });
    expect(a.definition.limits.budget_usd).toBe(2);
    expect(a.prompt).toContain('ask_human');
    expect(a.prompt).toContain('search_standing_decisions');
  });

  it('returns nothing when the folder does not exist', async () => {
    expect((await loadAgents(path.join(agentsDir, 'nope'))).size).toBe(0);
  });

  it('rejects a definition that is not valid, naming the file and the problem', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-agents-'));
    try {
      await mkdir(path.join(dir, 'broken'));
      await writeFile(path.join(dir, 'broken', 'agent.yaml'), 'id: broken\nversion: 0\n');
      await expect(loadAgents(dir)).rejects.toThrow(/broken[\\/]agent\.yaml.*version/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a definition whose id does not match its folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-agents-'));
    try {
      await mkdir(path.join(dir, 'a'));
      const yaml = await readFile(path.join(agentsDir, 'backend-engineer', 'agent.yaml'), 'utf8');
      await writeFile(path.join(dir, 'a', 'agent.yaml'), yaml);
      await writeFile(path.join(dir, 'a', 'prompt.md'), 'x');
      await expect(loadAgents(dir)).rejects.toThrow(/must match the folder/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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

async function installApps(repos: string[]) {
  await db.delete(githubApp);
  for (const kind of ['agent', 'gate']) {
    await db.insert(githubApp).values({
      kind,
      appId: 1,
      slug: `${kind}-app`,
      name: kind,
      ownerLogin: 'me',
      htmlUrl: 'https://x',
      installationId: 9,
      installedOn: repos,
    });
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-work-'));
  devDb = await startDevDb({ dataDir, port: 56335 });
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
    agents: await loadAgents(agentsDir),
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

describe('the repository registry', () => {
  const body = {
    fullName: 'lrama1/sdlc-scratch',
    protectedPaths: ['.github/workflows/**', 'scripts/**'],
  };
  const post = (cookie: string, payload: object) =>
    app.inject({ method: 'POST', url: '/api/repositories', headers: as(cookie), payload });

  it('needs a session and is edited by a Platform Admin only', async () => {
    expect((await app.inject('/api/repositories')).statusCode).toBe(401);
    const eng = await login(['backend_engineer']);
    expect((await post(eng.cookie, body)).statusCode).toBe(403);
  });

  it('refuses a repository before the GitHub Apps are installed', async () => {
    const admin = await login(['platform_admin']);
    const res = await post(admin.cookie, body);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('github_not_ready');
  });

  it('refuses a repository the Apps are not installed on', async () => {
    await installApps(['someone/else']);
    const admin = await login(['platform_admin']);
    const res = await post(admin.cookie, body);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_installed');
  });

  it('adds a repository with safe defaults, logs it, and refuses a duplicate', async () => {
    await installApps(['lrama1/sdlc-scratch']);
    await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, 'lrama1/sdlc-scratch'));
    const admin = await login(['platform_admin']);
    const res = await post(admin.cookie, body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      fullName: 'lrama1/sdlc-scratch',
      writeMode: 'branch_pr',
      integrationBranch: 'main',
      verifyCommand: 'npm run verify',
      modelPolicy: 'any',
      protectedPaths: ['.github/workflows/**', 'scripts/**'],
    });
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'registry.added'));
    expect(log.some((l) => l.actorId === admin.id)).toBe(true);
    expect((await post(admin.cookie, body)).statusCode).toBe(409);
    const list = await app.inject({ url: '/api/repositories', headers: as(admin.cookie) });
    expect(list.json().map((r: { fullName: string }) => r.fullName)).toContain(
      'lrama1/sdlc-scratch',
    );
  });

  it('rejects a malformed name', async () => {
    const admin = await login(['platform_admin']);
    expect((await post(admin.cookie, { fullName: 'not a repo' })).statusCode).toBe(400);
  });
});

async function registered(name = `me/repo-${Date.now()}-${++n}`) {
  const [r] = await db.insert(repositoryEntry).values({ fullName: name }).returning();
  return r!;
}

describe('initiatives', () => {
  it('creates an initiative on a registered repository', async () => {
    const po = await login(['product_owner']);
    const repo = await registered();
    const res = await app.inject({
      method: 'POST',
      url: '/api/initiatives',
      headers: as(po.cookie),
      payload: {
        title: 'Health endpoint',
        goal: 'Add /health with a test',
        repositoryId: repo.id,
        budgetUsd: 5,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      title: 'Health endpoint',
      state: 'draft',
      autonomyMode: 'balanced',
      budgetUsd: 5,
      repositoryId: repo.id,
    });
    const got = await app.inject({
      url: `/api/initiatives/${res.json().id}`,
      headers: as(po.cookie),
    });
    expect(got.json()).toMatchObject({ title: 'Health endpoint', runs: [] });
  });

  it('refuses a repository that is not in the registry', async () => {
    const po = await login(['product_owner']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/initiatives',
      headers: as(po.cookie),
      payload: { title: 't', goal: 'g', repositoryId: '0190a000-0000-7000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_repository');
  });

  it('404s an unknown initiative', async () => {
    const po = await login(['product_owner']);
    expect(
      (
        await app.inject({
          url: '/api/initiatives/0190a000-0000-7000-8000-000000000000',
          headers: as(po.cookie),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('runs', () => {
  async function newInitiative() {
    const po = await login(['product_owner']);
    const repo = await registered();
    const res = await app.inject({
      method: 'POST',
      url: '/api/initiatives',
      headers: as(po.cookie),
      payload: { title: 'T', goal: 'G', repositoryId: repo.id },
    });
    return { po, initiativeId: res.json().id as string, repo };
  }
  const start = (cookie: string, initiativeId: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/initiatives/${initiativeId}/runs`,
      headers: as(cookie),
      payload,
    });

  it('creates a queued run from the agent definition, records it, and activates the initiative', async () => {
    const { po, initiativeId } = await newInitiative();
    const res = await start(po.cookie, initiativeId, { task: 'Add a /health endpoint' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      role: 'backend_engineer',
      state: 'queued',
      definition: 'backend-engineer@1',
      engine: 'claude-code',
      modelAlias: 'agent-default',
      budgetUsd: 2,
      costUsd: 0,
      sponsorPersonId: po.id,
      task: 'Add a /health endpoint',
    });

    const [init] = await db.select().from(initiative).where(eq(initiative.id, initiativeId));
    expect(init!.state).toBe('active');
    const log = await db.select().from(activityEvent).where(eq(activityEvent.runId, res.json().id));
    expect(log.map((l) => l.action)).toEqual(['run.created']);
    const events = await db.select().from(runEvent).where(eq(runEvent.runId, res.json().id));
    expect(events.map((e) => e.type)).toEqual(['run.queued']);
  });

  it('can lower the budget but not raise it past the definition', async () => {
    const { po, initiativeId } = await newInitiative();
    expect(
      (await start(po.cookie, initiativeId, { task: 't', budgetUsd: 0.5 })).json().budgetUsd,
    ).toBe(0.5);
    const high = await start(po.cookie, initiativeId, { task: 't', budgetUsd: 50 });
    expect(high.statusCode).toBe(400);
    expect(high.json().error.code).toBe('budget_too_high');
  });

  it('refuses a role with no agent definition', async () => {
    const { po, initiativeId } = await newInitiative();
    const res = await start(po.cookie, initiativeId, { task: 't', role: 'qa' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('no_agent');
  });

  it('404s an unknown initiative and refuses a finished one', async () => {
    const { po, initiativeId } = await newInitiative();
    expect(
      (await start(po.cookie, '0190a000-0000-7000-8000-000000000000', { task: 't' })).statusCode,
    ).toBe(404);
    await db.update(initiative).set({ state: 'done' }).where(eq(initiative.id, initiativeId));
    expect((await start(po.cookie, initiativeId, { task: 't' })).statusCode).toBe(409);
  });

  it('issues a run token that the gateway and MCP server accept, stored only as a hash', async () => {
    const { po, initiativeId } = await newInitiative();
    const run = (await start(po.cookie, initiativeId, { task: 't' })).json();
    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    const token = await issueRunToken(db, row!, { ttlMs: 60_000 });
    const ctx = await authenticateRunToken(db, token);
    expect(ctx).toMatchObject({ runId: run.id, initiativeId, budgetMicros: 2_000_000 });
    expect(ctx!.scopes).toEqual([
      'gateway',
      'mcp',
      'runner',
      'alias:agent-default',
      'alias:agent-fast',
    ]);
    const stored = await db.select().from(runToken).where(eq(runToken.runId, run.id));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('cancelling stops the run, revokes its token, and a second cancel is refused', async () => {
    const { po, initiativeId } = await newInitiative();
    const run = (await start(po.cookie, initiativeId, { task: 't' })).json();
    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    const token = await issueRunToken(db, row!, { ttlMs: 60_000 });
    expect(await authenticateRunToken(db, token)).not.toBeNull();

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/cancel`,
      headers: as(po.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'cancelled', exitReason: 'cancelled' });
    expect(await authenticateRunToken(db, token)).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/runs/${run.id}/cancel`,
          headers: as(po.cookie),
        })
      ).statusCode,
    ).toBe(409);
    const events = await app.inject({ url: `/api/runs/${run.id}/events`, headers: as(po.cookie) });
    expect(events.json().map((e: { type: string }) => e.type)).toEqual([
      'run.queued',
      'run.finished',
    ]);
  });

  it('lists events after a sequence number', async () => {
    const { po, initiativeId } = await newInitiative();
    const run = (await start(po.cookie, initiativeId, { task: 't' })).json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel`, headers: as(po.cookie) });
    const after = await app.inject({
      url: `/api/runs/${run.id}/events?after=1`,
      headers: as(po.cookie),
    });
    expect(after.json()).toEqual([expect.objectContaining({ seq: 2, type: 'run.finished' })]);
  });

  it('shows runs under the initiative', async () => {
    const { po, initiativeId } = await newInitiative();
    await start(po.cookie, initiativeId, { task: 'one' });
    const got = await app.inject({
      url: `/api/initiatives/${initiativeId}`,
      headers: as(po.cookie),
    });
    expect(got.json().runs).toHaveLength(1);
  });
});
