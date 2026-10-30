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
import { designTask, specTask } from './stages.js';

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
    expect(a.prompt).toContain('set up the verification command and CI');
    const architect = agents.get('architect')!;
    expect(architect.prompt).toContain('Set up the verification command and CI');
    expect(architect.prompt).toContain('make every other task depend on T1');
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

  it('says what kind of work it is: a new app on a repository with no work yet, a feature after that', async () => {
    const po = await login(['product_owner']);
    const repo = await registered();
    const make = (extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/initiatives',
        headers: as(po.cookie),
        payload: { title: 'Thing', goal: 'A thing', repositoryId: repo.id, ...extra },
      });
    expect((await make()).json().kind).toBe('new_app');
    expect((await make()).json().kind).toBe('feature');
    // What a person picks wins over the suggestion.
    expect((await make({ kind: 'change' })).json().kind).toBe('change');
    expect((await make({ kind: 'epic' })).statusCode).toBe(400);
  });

  it('warns when a new app is made in a repository that already has work, and tells the agents to keep it apart', async () => {
    const po = await login(['product_owner']);
    const repo = await registered();
    const make = (extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/initiatives',
        headers: as(po.cookie),
        payload: { title: 'Thing', goal: 'A thing', repositoryId: repo.id, ...extra },
      });
    // The first app in an empty repository is the normal case: no warning.
    const first = (await make()).json();
    expect(first).toMatchObject({ kind: 'new_app', alongside: false, warnings: [] });
    // A feature on it is normal too.
    expect((await make({ kind: 'feature' })).json()).toMatchObject({
      alongside: false,
      warnings: [],
    });
    // A second new app next to it needs a yes: the platform cannot preview or smoke-test it.
    const refused = await make({ kind: 'new_app' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('shared_repository');
    const second = await make({ kind: 'new_app', acknowledgeSharedRepository: true });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ kind: 'new_app', alongside: true });
    expect(second.json().warnings[0]).toContain('register another repository');
    const [row] = await db.select().from(initiative).where(eq(initiative.id, second.json().id));
    expect(row!.alongside).toBe(true);
    expect(specTask(row!)).toContain('its own top-level folder');
    expect(designTask('docs/spec/x.md', row!.kind, row!.alongside)).toContain('apps/<short-name>');
    const [normal] = await db.select().from(initiative).where(eq(initiative.id, first.id));
    expect(specTask(normal!)).not.toContain('top-level folder');
    const logged = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.initiativeId, second.json().id));
    expect(logged.find((e) => e.action === 'initiative.created')!.detail).toMatchObject({
      warning: 'alongside',
      acknowledged: true,
    });

    // Changing the type moves it in and out of that state.
    const patch = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'PATCH',
        url: `/api/initiatives/${id}`,
        headers: as(po.cookie),
        payload: { kind, ...extra },
      });
    await patch(second.json().id, 'feature');
    expect(
      (await db.select().from(initiative).where(eq(initiative.id, second.json().id)))[0]!.alongside,
    ).toBe(false);
    // Back to a new app next to another needs the same yes, and nothing changes without it.
    expect((await patch(second.json().id, 'new_app')).statusCode).toBe(409);
    expect(
      (await db.select().from(initiative).where(eq(initiative.id, second.json().id)))[0]!.kind,
    ).toBe('feature');
    expect(
      (await patch(second.json().id, 'new_app', { acknowledgeSharedRepository: true })).statusCode,
    ).toBe(200);
    expect(
      (await db.select().from(initiative).where(eq(initiative.id, second.json().id)))[0]!.alongside,
    ).toBe(true);
    // The first app owns the repository root: nothing was there before it, so it is never beside another, and it
    // needs no yes to be a new app.
    expect((await patch(first.id, 'feature')).statusCode).toBe(200);
    expect((await patch(first.id, 'new_app')).statusCode).toBe(200);
    expect(
      (await db.select().from(initiative).where(eq(initiative.id, first.id)))[0]!.alongside,
    ).toBe(false);
  });

  it('lets a Product Owner or Platform Admin change the kind, and nobody else', async () => {
    const po = await login(['product_owner']);
    const dev = await login(['backend_engineer']);
    const repo = await registered();
    const made = await app.inject({
      method: 'POST',
      url: '/api/initiatives',
      headers: as(po.cookie),
      payload: { title: 'Old', goal: 'g', repositoryId: repo.id },
    });
    const id = made.json().id as string;
    const patch = (cookie: string, body: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/api/initiatives/${id}`,
        headers: as(cookie),
        payload: body,
      });
    expect((await patch(dev.cookie, { kind: 'feature' })).statusCode).toBe(403);
    expect((await patch(po.cookie, { kind: 'nonsense' })).statusCode).toBe(400);
    expect((await patch(po.cookie, {})).statusCode).toBe(400);
    const ok = await patch(po.cookie, { kind: 'feature' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ kind: 'feature', autonomyMode: 'balanced' });
    const got = await app.inject({ url: `/api/initiatives/${id}`, headers: as(po.cookie) });
    expect(got.json().kind).toBe('feature');
    // The mode still changes on its own, and leaves the kind alone.
    const mode = await patch(po.cookie, { autonomyMode: 'guided' });
    expect(mode.json()).toMatchObject({ kind: 'feature', autonomyMode: 'guided' });
    const map = await app.inject({ url: `/api/initiatives/${id}/map`, headers: as(po.cookie) });
    expect(map.json().initiative.kind).toBe('feature');
  });
  it('keeps the reference links, and refuses a link that is not https', async () => {
    const po = await login(['product_owner']);
    const repo = await registered();
    const make = (referenceLinks: string[]) =>
      app.inject({
        method: 'POST',
        url: '/api/initiatives',
        headers: as(po.cookie),
        payload: { title: 'Pay', goal: 'Take payments', repositoryId: repo.id, referenceLinks },
      });
    const ok = await make(['https://docs.vendor.example/api', 'https://docs.vendor.example/api']);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().referenceLinks).toEqual(['https://docs.vendor.example/api']);
    expect((await make(['http://docs.vendor.example/api'])).statusCode).toBe(400);
    expect((await make(['not a link'])).statusCode).toBe(400);
    const none = await app.inject({
      method: 'POST',
      url: '/api/initiatives',
      headers: as(po.cookie),
      payload: { title: 'Plain', goal: 'g', repositoryId: repo.id },
    });
    expect(none.json().referenceLinks).toEqual([]);
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

describe('running a failed spec or design step again', () => {
  async function failedRun(role: 'product' | 'architect' | 'backend_engineer', state = 'failed') {
    const po = await login(['product_owner']);
    const repo = await registered();
    const [init] = await db
      .insert(initiative)
      .values({ title: 'Retry me', goal: 'G', repositoryId: repo.id, createdBy: po.id })
      .returning();
    const [run] = await db
      .insert(agentRun)
      .values({
        initiativeId: init!.id,
        agentRole: role,
        task: 'Draft the spec: Retry me',
        agentDefinitionId: `${role}-agent`,
        agentDefinitionVersion: 1,
        engine: 'claude-code',
        modelAlias: 'agent-default',
        state,
        sponsorPersonId: po.id,
        repositoryId: repo.id,
        budgetMicros: 1_500_000,
      })
      .returning();
    return { po, init: init!, run: run! };
  }
  const retry = (cookie: string, runId: string) =>
    app.inject({ method: 'POST', url: `/api/runs/${runId}/retry`, headers: as(cookie) });

  it('starts a new run with the same agent, task and budget, and logs it', async () => {
    const { po, init, run } = await failedRun('product');
    const res = await retry(po.cookie, run.id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      role: 'product',
      task: 'Draft the spec: Retry me',
      budgetUsd: 1.5,
      state: 'queued',
      initiativeId: init.id,
      sponsorPersonId: po.id,
    });
    const log = await db.select().from(activityEvent).where(eq(activityEvent.runId, res.json().id));
    expect(log.map((l) => l.action)).toContain('run.retried');
  });

  it.each(['failed', 'cancelled', 'budget_exceeded', 'timed_out'])(
    'accepts a run that ended as %s',
    async (state) => {
      const { po, run } = await failedRun('architect', state);
      expect((await retry(po.cookie, run.id)).statusCode).toBe(201);
    },
  );

  it('refuses a run that is still going or did not fail', async () => {
    const { po, run } = await failedRun('product', 'succeeded');
    const res = await retry(po.cookie, run.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_failed');
  });

  it('refuses a second retry of the same step, and a build task', async () => {
    const { po, run } = await failedRun('product');
    expect((await retry(po.cookie, run.id)).statusCode).toBe(201);
    const again = await retry(po.cookie, run.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('superseded');
    const build = await failedRun('backend_engineer');
    const res = await retry(build.po.cookie, build.run.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_retryable');
  });

  it('needs a person with a say in the step, and a run that exists', async () => {
    const { run } = await failedRun('product');
    const eng = await login(['backend_engineer']);
    expect((await retry(eng.cookie, run.id)).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: `/api/runs/${run.id}/retry` })).statusCode,
    ).toBe(401);
    const po = await login(['product_owner']);
    expect((await retry(po.cookie, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});
