import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentRun,
  bugReport,
  createDb,
  createRunFixture,
  hat,
  initiative,
  interaction,
  person,
  runMigrations,
  stageStart,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadAgents } from './agents.js';
import type { LoadedAgent } from './agents.js';
import { loadConfig } from './config.js';
import { MemorySecrets } from './secrets.js';
import { bugTask, reportBug, stageTick, syncBugs } from './stages.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let agents: Map<string, LoadedAgent>;
let n = 0;

const input = {
  title: 'Discount is subtracted, not applied',
  description: 'applyDiscount(200, 25) returns 175. It should return 150.',
  steps: 'Call applyDiscount(200, 25).',
  severity: 'high',
};

async function newPerson(roles: string[], name = 'Reporter') {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `${name} ${k}`, email: `g${k}@example.test`, oidcSubject: `g${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    displayName: p!.displayName,
    headers: {
      cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
    },
  };
}

async function newInitiative(o: { mode?: string; autoStages?: boolean; state?: string } = {}) {
  const f = await createRunFixture(db);
  await db
    .update(initiative)
    .set({
      autonomyMode: o.mode ?? 'balanced',
      autoStages: o.autoStages ?? true,
      state: o.state ?? 'active',
    })
    .where(eq(initiative.id, f.initiativeId));
  const [init] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));
  return { ...f, init: init! };
}

const stepOf = async (bugId: string) => {
  const [b] = await db.select().from(bugReport).where(eq(bugReport.id, bugId));
  const [s] = await db.select().from(stageStart).where(eq(stageStart.id, b!.stageStartId!));
  return { bug: b!, step: s! };
};

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-bugs-'));
  devDb = await startDevDb({ dataDir, port: 56347 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  agents = await loadAgents(path.resolve(import.meta.dirname, '..', '..', '..', 'agents'));
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
    secrets: new MemorySecrets(),
    agents,
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('reporting a bug', () => {
  it('starts the fix by itself in a balanced initiative, sponsored by the reporter', async () => {
    const f = await newInitiative();
    const me = await newPerson(['backend_engineer']);
    const bug = await reportBug(db, agents, f.init, me, input);
    const { step } = await stepOf(bug.id);
    expect(step).toMatchObject({ stage: 'bug', role: 'bug', state: 'pending', startedBy: me.id });
    expect(step.task).toBe(bugTask(input, me.displayName));
    expect(step.task.split('\n')[0]).toBe('Fix bug: Discount is subtracted, not applied');
    expect(step.task).toContain('applyDiscount(200, 25) returns 175');
    expect(step.task).toContain('Steps to reproduce:');
    expect(step.task).toContain(`reported by ${me.displayName}`);

    await stageTick({ db, agents });
    const after = await stepOf(bug.id);
    expect(after.step.state).toBe('started');
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, after.step.runId!));
    expect(run).toMatchObject({
      agentRole: 'bug',
      agentDefinitionId: 'bug-agent',
      sponsorPersonId: me.id,
    });
    // The same pass that starts the run also notes it.
    expect(after.bug).toMatchObject({ state: 'fixing', detail: 'The agent is working on it.' });
  });

  it('waits for an engineer to click in guided mode or when the steps are off', async () => {
    const guided = await newInitiative({ mode: 'guided' });
    const off = await newInitiative({ autoStages: false });
    const me = await newPerson(['product_owner']);
    const a = await reportBug(db, agents, guided.init, me, input);
    const b = await reportBug(db, agents, off.init, me, input);
    expect((await stepOf(a.id)).step.state).toBe('awaiting_start');
    expect((await stepOf(b.id)).step.state).toBe('awaiting_start');
    await stageTick({ db, agents });
    expect((await stepOf(a.id)).step.state).toBe('awaiting_start');

    const post = (who: { headers: Record<string, string> }, id: string) =>
      app.inject({ method: 'POST', url: `/api/stages/${id}/start`, headers: who.headers });
    const owner = await newPerson(['product_owner']);
    const engineer = await newPerson(['backend_engineer']);
    expect((await post(owner, (await stepOf(a.id)).step.id)).statusCode).toBe(403);
    expect((await post(engineer, (await stepOf(a.id)).step.id)).json()).toMatchObject({
      state: 'pending',
      stage: 'bug',
    });
    await stageTick({ db, agents });
    const [run] = await db
      .select()
      .from(agentRun)
      .where(eq(agentRun.id, (await stepOf(a.id)).step.runId!));
    expect(run!.sponsorPersonId).toBe(engineer.id);
  });

  it('cannot start when no agent fixes bugs', async () => {
    const f = await newInitiative();
    const me = await newPerson(['backend_engineer']);
    const without = new Map([...agents].filter(([role]) => role !== 'bug'));
    const bug = await reportBug(db, without, f.init, me, input);
    expect((await stepOf(bug.id)).step.state).toBe('invalid');
    await syncBugs(db);
    expect((await stepOf(bug.id)).bug).toMatchObject({
      state: 'needs_attention',
      detail: 'No agent fixes bugs.',
    });
  });
});

describe('following the fix', () => {
  async function started() {
    const f = await newInitiative();
    const me = await newPerson(['backend_engineer']);
    const bug = await reportBug(db, agents, f.init, me, input);
    await stageTick({ db, agents });
    const { step } = await stepOf(bug.id);
    return { f, bug, runId: step.runId! };
  }
  const review = (f: { initiativeId: string }, runId: string, o: Record<string, unknown>) =>
    db.insert(interaction).values({
      initiativeId: f.initiativeId,
      runId,
      type: 'review',
      checkpointId: 'G3',
      title: 'Review PR #4',
      roleNeeded: 'backend_engineer',
      contextCard: { kind: 'pull_request' },
      ...o,
    });

  it('is fixing while the fix is in review, and fixed once the Gate merged it', async () => {
    const { f, bug, runId } = await started();
    await db
      .update(agentRun)
      .set({ state: 'succeeded', prNumber: 4 })
      .where(eq(agentRun.id, runId));
    await review(f, runId, {});
    await syncBugs(db);
    expect((await stepOf(bug.id)).bug).toMatchObject({
      state: 'fixing',
      detail: 'The fix is in review.',
    });
    await db
      .update(interaction)
      .set({
        state: 'answered',
        answer: { decision: 'approved' },
        contextCard: { kind: 'pull_request', gate: { state: 'merged' } },
      })
      .where(eq(interaction.runId, runId));
    await syncBugs(db);
    expect((await stepOf(bug.id)).bug).toMatchObject({
      state: 'fixed',
      detail: 'The fix was reviewed and merged.',
    });
  });

  it('needs a person when the agent made no fix, the run failed, or the reviewer declined', async () => {
    const none = await started();
    await db.update(agentRun).set({ state: 'succeeded' }).where(eq(agentRun.id, none.runId));
    const failed = await started();
    await db.update(agentRun).set({ state: 'failed' }).where(eq(agentRun.id, failed.runId));
    const declined = await started();
    await db
      .update(agentRun)
      .set({ state: 'succeeded', prNumber: 4 })
      .where(eq(agentRun.id, declined.runId));
    await review(declined.f, declined.runId, {
      state: 'answered',
      answer: { decision: 'changes_requested' },
    });
    await syncBugs(db);
    expect((await stepOf(none.bug.id)).bug.detail).toContain('without a fix to review');
    expect((await stepOf(failed.bug.id)).bug.detail).toContain('ended as failed');
    expect((await stepOf(declined.bug.id)).bug.detail).toContain('"changes_requested"');
    for (const x of [none, failed, declined])
      expect((await stepOf(x.bug.id)).bug.state).toBe('needs_attention');
  });
});

describe('the bug routes', () => {
  it('lets anyone signed in report a bug and see the list', async () => {
    const f = await newInitiative();
    const me = await newPerson(['product_owner']);
    const post = (headers: Record<string, string>, id: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/initiatives/${id}/bugs`,
        headers,
        payload: payload as never,
      });
    expect((await post({}, f.initiativeId, input)).statusCode).toBe(401);
    const res = await post(me.headers, f.initiativeId, input);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      title: input.title,
      severity: 'high',
      state: 'open',
      stageState: 'pending',
      runId: null,
      prNumber: null,
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/bugs?initiativeId=${f.initiativeId}`,
      headers: me.headers,
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].reportedBy).toBe(me.displayName);
    expect((await app.inject({ method: 'GET', url: '/api/bugs' })).statusCode).toBe(401);
  });

  it('refuses a report that is too thin, for an unknown initiative, or a finished one', async () => {
    const f = await newInitiative();
    const done = await newInitiative({ state: 'done' });
    const me = await newPerson(['backend_engineer']);
    const post = (id: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/initiatives/${id}/bugs`,
        headers: me.headers,
        payload: payload as never,
      });
    expect((await post(f.initiativeId, { title: 'x', description: 'short' })).statusCode).toBe(400);
    expect((await post('0190a000-0000-7000-8000-000000000000', input)).statusCode).toBe(404);
    expect((await post(done.initiativeId, input)).statusCode).toBe(409);
  });
});
