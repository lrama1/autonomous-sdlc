import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentRun,
  buildPlan,
  buildTask,
  createDb,
  createRunFixture,
  hat,
  initiative,
  interaction,
  person,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { buildTick, cancelPlan, ensurePlans, retryTask, skipTask, startPlan } from './build.js';
import type { BuildDeps } from './build.js';
import { loadAgents } from './agents.js';
import { loadConfig } from './config.js';
import { MemorySecrets } from './secrets.js';
import type { LoadedAgent } from './agents.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let agents: Map<string, LoadedAgent>;
let n = 0;

let designText = '';
let reads = 0;
const github: BuildDeps['github'] = {
  readFile: async () => {
    reads++;
    return designText;
  },
};
const deps = (o: Partial<BuildDeps> = {}): BuildDeps => ({
  db,
  github,
  agents,
  maxActive: 4,
  ...o,
});

const block = (tasks: string) => `# Design\n\n\`\`\`sdlc-tasks\n${tasks}\`\`\`\n`;
const task = (id: string, o: { dependsOn?: string[]; role?: string; done?: string } = {}) =>
  `- id: ${id}\n  title: Task ${id}\n  role: ${o.role ?? 'backend_engineer'}\n  stories: [US-1]\n  depends_on: [${(o.dependsOn ?? []).join(', ')}]\n  paths: [src/${id}.js]\n  done_when:\n    - '${o.done ?? `${id} works`}'\n`;
const THREE = block(task('T1') + task('T2', { dependsOn: ['T1'] }) + task('T3'));

/** An initiative whose architect design was approved and merged. */
async function approvedDesign(
  o: { mode?: string; merged?: boolean; budgetMicros?: number; approvedHoursAgo?: number } = {},
) {
  const f = await createRunFixture(db);
  await db
    .update(initiative)
    .set({ autonomyMode: o.mode ?? 'balanced', budgetMicros: o.budgetMicros ?? null })
    .where(eq(initiative.id, f.initiativeId));
  await db.update(agentRun).set({ agentRole: 'architect' }).where(eq(agentRun.id, f.runId));
  const [review] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      state: 'answered',
      title: 'Review PR #5: design',
      roleNeeded: 'architect',
      answer: { decision: 'approved' },
      answeredBy: f.personId,
      answeredAt: new Date(Date.now() - (o.approvedHoursAgo ?? 0) * 3_600_000),
      contextCard: {
        kind: 'pull_request',
        repository: 'o/r',
        prNumber: 5,
        diff: { changedPaths: ['docs/design/thing.md'] },
        gate:
          o.merged === false ? { state: 'waiting_ci' } : { state: 'merged', mergedSha: 'abc123' },
      },
    })
    .returning();
  return { ...f, review: review! };
}

async function planOf(initiativeId: string) {
  const [plan] = await db.select().from(buildPlan).where(eq(buildPlan.initiativeId, initiativeId));
  const tasks = plan
    ? await db
        .select()
        .from(buildTask)
        .where(eq(buildTask.planId, plan.id))
        .orderBy(buildTask.position)
    : [];
  return { plan, tasks, state: Object.fromEntries(tasks.map((t) => [t.key, t.state])) };
}

/** Plays what a run and its review would do, so the plan can see it. */
async function finishTask(
  planId: string,
  key: string,
  how: 'merged' | 'declined' | 'no_pr' | 'run_failed' | 'review_open' | 'ci_failed',
) {
  const [t] = await db
    .select()
    .from(buildTask)
    .where(and(eq(buildTask.planId, planId), eq(buildTask.key, key)));
  const runId = t!.runId!;
  if (how === 'run_failed') {
    await db
      .update(agentRun)
      .set({ state: 'failed', exitReason: 'error' })
      .where(eq(agentRun.id, runId));
    return;
  }
  await db
    .update(agentRun)
    .set({ state: 'succeeded', prNumber: how === 'no_pr' ? null : 20 })
    .where(eq(agentRun.id, runId));
  if (how === 'no_pr') return;
  const [run] = await db.select().from(agentRun).where(eq(agentRun.id, runId));
  await db.insert(interaction).values({
    initiativeId: run!.initiativeId,
    runId,
    type: 'review',
    checkpointId: 'G3',
    state: how === 'review_open' ? 'open' : 'answered',
    title: `Review ${key}`,
    roleNeeded: 'backend_engineer',
    answer:
      how === 'declined'
        ? { decision: 'changes_requested' }
        : how === 'review_open'
          ? null
          : { decision: 'approved' },
    contextCard: {
      kind: 'pull_request',
      gate:
        how === 'merged'
          ? { state: 'merged' }
          : how === 'ci_failed'
            ? { state: 'ci_failed', detail: 'tests' }
            : undefined,
    },
  });
}

async function newPerson(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `b${k}@example.test`, oidcSubject: `b${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    headers: {
      cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
    },
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-build-'));
  devDb = await startDevDb({ dataDir, port: 56345 });
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

describe('making a plan from an approved design', () => {
  it('reads the design at the merged commit and lists its tasks in order', async () => {
    designText = THREE;
    const f = await approvedDesign();
    await ensurePlans(deps());
    const { plan, tasks } = await planOf(f.initiativeId);
    expect(plan).toMatchObject({
      state: 'active',
      designPath: 'docs/design/thing.md',
      designSha: 'abc123',
      startedBy: f.personId,
    });
    expect(tasks.map((t) => [t.key, t.dependsOn, t.state])).toEqual([
      ['T1', [], 'waiting'],
      ['T2', ['T1'], 'waiting'],
      ['T3', [], 'waiting'],
    ]);
  });

  it('makes one plan per design, and none for a design that is not merged', async () => {
    designText = THREE;
    const merged = await approvedDesign();
    const open = await approvedDesign({ merged: false });
    await ensurePlans(deps());
    const before = reads;
    await ensurePlans(deps());
    await ensurePlans(deps());
    expect(
      await db.select().from(buildPlan).where(eq(buildPlan.initiativeId, merged.initiativeId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(buildPlan).where(eq(buildPlan.initiativeId, open.initiativeId)),
    ).toHaveLength(0);
    // The unmerged one is never read, and the merged one is not read again.
    expect(reads).toBe(before);
  });

  it('waits for a person to start it in guided mode', async () => {
    designText = THREE;
    const f = await approvedDesign({ mode: 'guided' });
    await buildTick(deps());
    expect((await planOf(f.initiativeId)).plan!.state).toBe('awaiting_start');
    expect((await planOf(f.initiativeId)).state).toEqual({
      T1: 'waiting',
      T2: 'waiting',
      T3: 'waiting',
    });

    const starter = await newPerson(['architect']);
    const plan = (await planOf(f.initiativeId)).plan!;
    expect(await startPlan(db, plan.id, starter.id)).toMatchObject({
      state: 'active',
      startedBy: starter.id,
    });
    expect(await startPlan(db, plan.id, starter.id)).toBeNull();
    await buildTick(deps());
    expect((await planOf(f.initiativeId)).state).toMatchObject({
      T1: 'running',
      T2: 'waiting',
      T3: 'running',
    });
    // The person who started it sponsors the runs.
    const runs = await db
      .select()
      .from(agentRun)
      .where(
        and(eq(agentRun.initiativeId, f.initiativeId), eq(agentRun.agentRole, 'backend_engineer')),
      );
    expect(runs.filter((r) => r.id !== f.runId).map((r) => r.sponsorPersonId)).toEqual([
      starter.id,
      starter.id,
    ]);
  });

  it('leaves a design approved long ago for a person to start, even in autopilot', async () => {
    designText = THREE;
    const f = await approvedDesign({ mode: 'autopilot', approvedHoursAgo: 5 });
    await buildTick(deps());
    const after = await planOf(f.initiativeId);
    expect(after.plan).toMatchObject({ state: 'awaiting_start' });
    expect(after.plan!.detail).toContain('a while ago');
    expect(Object.values(after.state)).toEqual(['waiting', 'waiting', 'waiting']);
  });

  it('marks a design that cannot be built as invalid and starts nothing', async () => {
    designText = '# Design\n\nNo tasks here.\n';
    const bad = await approvedDesign();
    await buildTick(deps());
    designText = block(task('T1', { role: 'frontend_engineer' }));
    const unstaffed = await approvedDesign();
    // As if the platform had no frontend agent.
    const withoutFrontend = new Map([...agents].filter(([role]) => role !== 'frontend_engineer'));
    await buildTick(deps({ agents: withoutFrontend }));
    const a = await planOf(bad.initiativeId);
    expect(a.plan).toMatchObject({ state: 'invalid' });
    expect(a.plan!.errors[0]).toContain('no ```sdlc-tasks block');
    const b = await planOf(unstaffed.initiativeId);
    expect(b.plan).toMatchObject({ state: 'invalid' });
    expect(b.plan!.errors[0]).toContain('frontend_engineer');
    expect(
      await db.select().from(agentRun).where(eq(agentRun.initiativeId, bad.initiativeId)),
    ).toHaveLength(1);
  });
});

describe('running the plan', () => {
  it('starts only what has nothing to wait for, with the task as the title', async () => {
    designText = THREE;
    const f = await approvedDesign();
    await buildTick(deps());
    const { state, tasks } = await planOf(f.initiativeId);
    expect(state).toEqual({ T1: 'running', T2: 'waiting', T3: 'running' });
    const runs = await db
      .select()
      .from(agentRun)
      .where(
        and(eq(agentRun.initiativeId, f.initiativeId), eq(agentRun.agentRole, 'backend_engineer')),
      );
    const t1 = runs.find((r) => r.id === tasks[0]!.runId)!;
    expect(t1.task.split('\n')[0]).toBe('T1: Task T1');
    expect(t1.task).toContain('docs/design/thing.md');
    expect(t1.task).toContain('- T1 works');
    expect(t1.sponsorPersonId).toBe(f.personId);
    expect(tasks[0]!.attempt).toBe(1);
  });

  it('gives each task to the agent for its role', async () => {
    designText = block(
      task('T1') +
        task('T2', { role: 'frontend_engineer', dependsOn: ['T1'] }) +
        task('T3', { role: 'frontend_engineer' }),
    );
    const f = await approvedDesign();
    await buildTick(deps());
    const plan = (await planOf(f.initiativeId)).plan!;
    await finishTask(plan.id, 'T1', 'merged');
    await buildTick(deps());
    const { tasks } = await planOf(f.initiativeId);
    const runs = await db.select().from(agentRun).where(eq(agentRun.initiativeId, f.initiativeId));
    const of = (key: string) => runs.find((r) => r.id === tasks.find((t) => t.key === key)!.runId)!;
    expect(of('T1')).toMatchObject({
      agentRole: 'backend_engineer',
      agentDefinitionId: 'backend-engineer',
    });
    expect(of('T2')).toMatchObject({
      agentRole: 'frontend_engineer',
      agentDefinitionId: 'frontend-engineer',
    });
    expect(of('T3')).toMatchObject({
      agentRole: 'frontend_engineer',
      agentDefinitionId: 'frontend-engineer',
    });
  });

  it('starts a task only after what it depends on is merged', async () => {
    designText = THREE;
    const f = await approvedDesign();
    await buildTick(deps());
    const plan = (await planOf(f.initiativeId)).plan!;

    await finishTask(plan.id, 'T1', 'review_open');
    await buildTick(deps());
    expect((await planOf(f.initiativeId)).state).toMatchObject({ T1: 'review', T2: 'waiting' });

    await db
      .update(interaction)
      .set({
        state: 'answered',
        answer: { decision: 'approved' },
        contextCard: { kind: 'pull_request', gate: { state: 'merged' } },
      })
      .where(
        and(
          eq(interaction.runId, (await planOf(f.initiativeId)).tasks[0]!.runId!),
          eq(interaction.type, 'review'),
        ),
      );
    await buildTick(deps());
    expect((await planOf(f.initiativeId)).state).toMatchObject({ T1: 'merged', T2: 'running' });
  });

  it('is done when every task is merged', async () => {
    designText = block(task('T1') + task('T2', { dependsOn: ['T1'] }));
    const f = await approvedDesign();
    await buildTick(deps());
    const plan = (await planOf(f.initiativeId)).plan!;
    await finishTask(plan.id, 'T1', 'merged');
    await buildTick(deps());
    await finishTask(plan.id, 'T2', 'merged');
    await buildTick(deps());
    const after = await planOf(f.initiativeId);
    expect(after.plan!.state).toBe('done');
    expect(after.state).toEqual({ T1: 'merged', T2: 'merged' });
  });

  it('never has more runs going than the limit', async () => {
    designText = block(['T1', 'T2', 'T3', 'T4', 'T5'].map((k) => task(k)).join(''));
    const f = await approvedDesign();
    await buildTick(deps({ maxActive: 2 }));
    expect(
      Object.values((await planOf(f.initiativeId)).state).filter((s) => s === 'running'),
    ).toHaveLength(2);
    await buildTick(deps({ maxActive: 2 }));
    expect(
      Object.values((await planOf(f.initiativeId)).state).filter((s) => s === 'running'),
    ).toHaveLength(2);
    const plan = (await planOf(f.initiativeId)).plan!;
    await finishTask(plan.id, 'T1', 'merged');
    await buildTick(deps({ maxActive: 2 }));
    expect((await planOf(f.initiativeId)).state).toMatchObject({
      T1: 'merged',
      T2: 'running',
      T3: 'running',
      T4: 'waiting',
    });
  });

  it('holds back when the initiative budget would be exceeded', async () => {
    designText = THREE;
    const f = await approvedDesign({ budgetMicros: 1_000_000 });
    await buildTick(deps());
    expect((await planOf(f.initiativeId)).state).toEqual({
      T1: 'waiting',
      T2: 'waiting',
      T3: 'waiting',
    });
    expect((await planOf(f.initiativeId)).plan!.detail).toContain('budget');
  });
});

describe('when a task goes wrong', () => {
  const failures: Array<['run_failed' | 'no_pr' | 'declined' | 'ci_failed', string]> = [
    ['run_failed', 'The run ended as failed'],
    ['no_pr', 'without opening a pull request'],
    ['declined', 'The reviewer chose'],
    ['ci_failed', 'The merge stopped (ci_failed: tests)'],
  ];
  it.each(failures)(
    'fails the task on %s and keeps the tasks behind it waiting',
    async (how, text) => {
      designText = THREE;
      const f = await approvedDesign();
      await buildTick(deps());
      const plan = (await planOf(f.initiativeId)).plan!;
      await finishTask(plan.id, 'T1', how);
      await buildTick(deps());
      const after = await planOf(f.initiativeId);
      expect(after.state).toMatchObject({ T1: 'failed', T2: 'waiting' });
      expect(after.tasks[0]!.detail).toContain(text);
    },
  );

  it('starts the task again on retry, or lets what is behind it go on when it is skipped', async () => {
    designText = THREE;
    const f = await approvedDesign();
    const by = await newPerson(['product_owner']);
    await buildTick(deps());
    const plan = (await planOf(f.initiativeId)).plan!;
    const firstRun = (await planOf(f.initiativeId)).tasks[0]!.runId;
    await finishTask(plan.id, 'T1', 'run_failed');
    await buildTick(deps());

    expect(await retryTask(db, plan.id, 'T1', by.id)).toMatchObject({ state: 'waiting' });
    await buildTick(deps());
    const retried = (await planOf(f.initiativeId)).tasks[0]!;
    expect(retried).toMatchObject({ state: 'running', attempt: 2 });
    expect(retried.runId).not.toBe(firstRun);

    await finishTask(plan.id, 'T1', 'run_failed');
    await buildTick(deps());
    expect(await skipTask(db, plan.id, 'T1', by.id)).toMatchObject({ state: 'skipped' });
    await buildTick(deps());
    expect((await planOf(f.initiativeId)).state).toMatchObject({ T1: 'skipped', T2: 'running' });
    // A running task cannot be skipped or retried.
    expect(await skipTask(db, plan.id, 'T2', by.id)).toBeNull();
    expect(await retryTask(db, plan.id, 'T2', by.id)).toBeNull();
  });

  it('cancels the plan, its unfinished tasks, and the runs still going', async () => {
    designText = THREE;
    const f = await approvedDesign();
    const by = await newPerson(['platform_admin']);
    await buildTick(deps());
    const { plan, tasks } = await planOf(f.initiativeId);
    expect(await cancelPlan(db, plan!.id, by.id)).toMatchObject({ state: 'cancelled' });
    expect(await cancelPlan(db, plan!.id, by.id)).toBeNull();
    const after = await planOf(f.initiativeId);
    expect(Object.values(after.state)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    const run = (await db.select().from(agentRun).where(eq(agentRun.id, tasks[0]!.runId!)))[0]!;
    expect(run.state).toBe('cancelled');
    await buildTick(deps());
    expect((await planOf(f.initiativeId)).plan!.state).toBe('cancelled');
  });
});

describe('the build routes', () => {
  it('shows the plan with what each task is behind, to anyone signed in', async () => {
    designText = THREE;
    const f = await approvedDesign();
    await buildTick(deps());
    const plan = (await planOf(f.initiativeId)).plan!;
    await finishTask(plan.id, 'T1', 'run_failed');
    await buildTick(deps());
    const who = await newPerson(['backend_engineer']);
    expect(
      (await app.inject({ method: 'GET', url: `/api/initiatives/${f.initiativeId}/plan` }))
        .statusCode,
    ).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: `/api/initiatives/${f.initiativeId}/plan`,
      headers: who.headers,
    });
    const body = res.json().plan;
    expect(body).toMatchObject({ state: 'active', designPath: 'docs/design/thing.md' });
    expect(
      body.tasks.map((t: { key: string; state: string; stuckBehind: string[] }) => [
        t.key,
        t.state,
        t.stuckBehind,
      ]),
    ).toEqual([
      ['T1', 'failed', []],
      ['T2', 'waiting', ['T1']],
      ['T3', 'running', []],
    ]);
    const none = await createRunFixture(db);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/initiatives/${none.initiativeId}/plan`,
          headers: who.headers,
        })
      ).json(),
    ).toEqual({ plan: null });
  });

  it('lets only the people who decide what is built control it', async () => {
    designText = THREE;
    const f = await approvedDesign({ mode: 'guided' });
    await buildTick(deps());
    const plan = (await planOf(f.initiativeId)).plan!;
    const engineer = await newPerson(['backend_engineer']);
    const owner = await newPerson(['product_owner']);
    const post = (who: { headers: Record<string, string> }, url: string) =>
      app.inject({ method: 'POST', url, headers: who.headers });

    expect((await post(engineer, `/api/plans/${plan.id}/start`)).statusCode).toBe(403);
    expect((await post(owner, `/api/plans/${plan.id}/start`)).json()).toMatchObject({
      state: 'active',
    });
    expect((await post(owner, `/api/plans/${plan.id}/start`)).statusCode).toBe(409);

    await buildTick(deps());
    expect(
      (await post(owner, `/api/plans/${plan.id}/tasks/T2/skip`)).json().tasks[1],
    ).toMatchObject({ key: 'T2', state: 'skipped' });
    expect((await post(owner, `/api/plans/${plan.id}/tasks/T1/retry`)).statusCode).toBe(409);
    expect((await post(owner, `/api/plans/${plan.id}/tasks/nope/skip`)).statusCode).toBe(400);
    expect((await post(engineer, `/api/plans/${plan.id}/cancel`)).statusCode).toBe(403);
    expect((await post(owner, `/api/plans/${plan.id}/cancel`)).json()).toMatchObject({
      state: 'cancelled',
    });
  });
});
