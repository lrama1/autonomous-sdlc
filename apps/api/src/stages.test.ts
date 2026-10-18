import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentRun,
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
import {
  designTask,
  ensureDesignStarts,
  ensureRevisions,
  planSpecStart,
  reviseTask,
  stageTick,
} from './stages.js';
import type { StageDeps } from './stages.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let agents: Map<string, LoadedAgent>;
let n = 0;

const closed: number[] = [];
const github: StageDeps['github'] = {
  comment: async () => {},
  closePullRequest: async (_repo, number) => {
    closed.push(number);
  },
};
const deps = (o: Partial<StageDeps> = {}): StageDeps => ({ db, agents, github, ...o });

async function newInitiative(o: { mode?: string; autoStages?: boolean } = {}) {
  const f = await createRunFixture(db);
  await db
    .update(initiative)
    .set({ autonomyMode: o.mode ?? 'balanced', autoStages: o.autoStages ?? true })
    .where(eq(initiative.id, f.initiativeId));
  const [init] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));
  return { ...f, init: init! };
}

/** An initiative whose spec was approved and merged. */
async function approvedSpec(
  o: {
    mode?: string;
    autoStages?: boolean;
    hoursAgo?: number;
    paths?: string[];
    merged?: boolean;
  } = {},
) {
  const f = await newInitiative(o);
  await db.update(agentRun).set({ agentRole: 'product' }).where(eq(agentRun.id, f.runId));
  const [review] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      state: 'answered',
      title: 'Review PR #3: spec',
      roleNeeded: 'product_owner',
      answer: { decision: 'approved' },
      answeredBy: f.personId,
      answeredAt: new Date(Date.now() - (o.hoursAgo ?? 0) * 3_600_000),
      contextCard: {
        kind: 'pull_request',
        diff: { changedPaths: o.paths ?? ['docs/spec/weather.md'] },
        gate: o.merged === false ? { state: 'waiting_ci' } : { state: 'merged', mergedSha: 'abc' },
      },
    })
    .returning();
  return { ...f, review: review! };
}

/** A spec or design pull request that a reviewer sent back. */
async function sentBack(
  o: {
    role?: 'product' | 'architect';
    decision?: string;
    text?: string;
    mode?: string;
    autoStages?: boolean;
    path?: string;
  } = {},
) {
  const role = o.role ?? 'product';
  const f = await newInitiative(o);
  await db.update(agentRun).set({ agentRole: role }).where(eq(agentRun.id, f.runId));
  const [review] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      state: 'answered',
      title: 'Review PR #9',
      roleNeeded: role === 'product' ? 'product_owner' : 'architect',
      answer: {
        decision: o.decision ?? 'changes_requested',
        text: o.text ?? 'Add a story for errors.',
      },
      answeredAt: new Date(),
      contextCard: {
        kind: 'pull_request',
        repository: 'o/r',
        prNumber: 9,
        diff: {
          changedPaths: [
            o.path ?? (role === 'product' ? 'docs/spec/weather.md' : 'docs/design/weather.md'),
          ],
        },
        gate: { state: 'waiting_ci' },
      },
    })
    .returning();
  return { ...f, review: review! };
}

const startsOf = (initiativeId: string) =>
  db.select().from(stageStart).where(eq(stageStart.initiativeId, initiativeId));

async function newPerson(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `s${k}@example.test`, oidcSubject: `s${k}` })
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
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-stages-'));
  devDb = await startDevDb({ dataDir, port: 56346 });
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

describe('the spec step', () => {
  it('starts by itself from the goal, sponsored by whoever created the initiative', async () => {
    const f = await newInitiative();
    await db
      .update(initiative)
      .set({ title: 'Weather', goal: 'Show the forecast' })
      .where(eq(initiative.id, f.initiativeId));
    const [init] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));
    const row = await planSpecStart(db, agents, init!, f.personId);
    expect(row).toMatchObject({ key: 'spec', state: 'pending', role: 'product' });
    expect(row!.task.split('\n')[0]).toBe('Draft the spec: Weather');
    expect(row!.task).toContain('Goal: Show the forecast');

    await stageTick(deps());
    const [started] = await startsOf(f.initiativeId);
    expect(started).toMatchObject({ state: 'started' });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, started!.runId!));
    expect(run).toMatchObject({
      agentRole: 'product',
      sponsorPersonId: f.personId,
      state: 'queued',
    });
    expect(run!.task).toBe(row!.task);
    await stageTick(deps());
    expect((await startsOf(f.initiativeId)).filter((s) => s.state === 'started')).toHaveLength(1);
  });

  it('waits for a click in guided mode, does nothing when the steps are off, and is made once', async () => {
    const guided = await newInitiative({ mode: 'guided' });
    expect(await planSpecStart(db, agents, guided.init, guided.personId)).toMatchObject({
      state: 'awaiting_start',
    });
    expect(await planSpecStart(db, agents, guided.init, guided.personId)).toBeNull();
    await stageTick(deps());
    expect((await startsOf(guided.initiativeId))[0]!.state).toBe('awaiting_start');

    const off = await newInitiative({ autoStages: false });
    expect(await planSpecStart(db, agents, off.init, off.personId)).toBeNull();
  });

  it('is invalid when no agent drafts specs', async () => {
    const f = await newInitiative();
    const without = new Map([...agents].filter(([role]) => role !== 'product'));
    expect(await planSpecStart(db, without, f.init, f.personId)).toMatchObject({
      state: 'invalid',
    });
  });

  it('holds back when the initiative budget would be exceeded', async () => {
    const f = await newInitiative();
    await db
      .update(initiative)
      .set({ budgetMicros: 500_000 })
      .where(eq(initiative.id, f.initiativeId));
    const [init] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));
    await planSpecStart(db, agents, init!, f.personId);
    await stageTick(deps());
    const [s] = await startsOf(f.initiativeId);
    expect(s).toMatchObject({ state: 'pending' });
    expect(s!.detail).toContain('budget');
  });
});

describe('the design step', () => {
  it('starts after the spec is merged, for that spec, sponsored by the person who approved it', async () => {
    const f = await approvedSpec();
    expect(await ensureDesignStarts(deps())).toBeGreaterThanOrEqual(1);
    const [s] = await startsOf(f.initiativeId);
    expect(s).toMatchObject({
      stage: 'design',
      key: `design:${f.review.id}`,
      state: 'pending',
      role: 'architect',
      sourceInteractionId: f.review.id,
      startedBy: f.personId,
    });
    expect(s!.task).toBe(designTask('docs/spec/weather.md'));
    expect(s!.task.split('\n')[0]).toBe('Design: weather');
    expect(s!.task).toContain('docs/design/weather.md');

    await stageTick(deps());
    const [after] = await startsOf(f.initiativeId);
    expect(after!.state).toBe('started');
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, after!.runId!));
    expect(run).toMatchObject({ agentRole: 'architect', sponsorPersonId: f.personId });
  });

  it('is made once, and not for a spec that is not merged or an initiative with the steps off', async () => {
    const a = await approvedSpec();
    const open = await approvedSpec({ merged: false });
    const off = await approvedSpec({ autoStages: false });
    await ensureDesignStarts(deps());
    await ensureDesignStarts(deps());
    expect(await startsOf(a.initiativeId)).toHaveLength(1);
    expect(await startsOf(open.initiativeId)).toHaveLength(0);
    expect(await startsOf(off.initiativeId)).toHaveLength(0);
  });

  it('waits for a person in guided mode, after an old approval, and when the spec file cannot be found', async () => {
    const guided = await approvedSpec({ mode: 'guided' });
    const old = await approvedSpec({ mode: 'autopilot', hoursAgo: 5 });
    const none = await approvedSpec({ paths: ['README.md'] });
    await ensureDesignStarts(deps());
    expect((await startsOf(guided.initiativeId))[0]!.state).toBe('awaiting_start');
    const oldStart = (await startsOf(old.initiativeId))[0]!;
    expect(oldStart.state).toBe('awaiting_start');
    expect(oldStart.detail).toContain('a while ago');
    expect((await startsOf(none.initiativeId))[0]).toMatchObject({ state: 'invalid' });
    await stageTick(deps());
    expect((await startsOf(guided.initiativeId))[0]!.state).toBe('awaiting_start');
  });
});

describe('a spec or design that is sent back', () => {
  it("is rewritten by a new run of the same agent, from the current main, with the reviewer's words", async () => {
    const f = await sentBack({ text: 'Add a story for errors.' });
    closed.length = 0;
    expect(await ensureRevisions(deps())).toBeGreaterThanOrEqual(1);
    const [s] = await startsOf(f.initiativeId);
    expect(s).toMatchObject({
      key: `revise:${f.review.id}`,
      stage: 'spec',
      role: 'product',
      state: 'pending',
      startedBy: f.personId,
    });
    expect(s!.task).toBe(reviseTask('spec', 'docs/spec/weather.md', 9, 'Add a story for errors.'));
    expect(s!.task.split('\n')[0]).toBe('Revise the spec: weather');
    expect(s!.task).toContain('The reviewer said: Add a story for errors.');

    await stageTick(deps());
    const [after] = await startsOf(f.initiativeId);
    expect(after!.state).toBe('started');
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, after!.runId!));
    expect(run).toMatchObject({ agentRole: 'product', sponsorPersonId: f.personId, task: s!.task });
    // The pull request that was sent back is closed.
    expect(closed).toEqual([9]);
    expect(await ensureRevisions(deps())).toBe(0);
  });

  it('also revises a design, and says which spec it is for', async () => {
    const f = await sentBack({ role: 'architect', text: 'Split T1 in two.' });
    await ensureRevisions(deps());
    const [s] = await startsOf(f.initiativeId);
    expect(s).toMatchObject({ stage: 'design', role: 'architect', state: 'pending' });
    expect(s!.task).toContain('docs/design/weather.md');
    expect(s!.task).toContain('The approved spec it designs is docs/spec/weather.md.');
  });

  it('is left alone when the reviewer approved or rejected, or the steps are off', async () => {
    const rejected = await sentBack({ decision: 'rejected' });
    const approved = await sentBack({ decision: 'approved' });
    const off = await sentBack({ autoStages: false });
    await ensureRevisions(deps());
    expect(await startsOf(rejected.initiativeId)).toHaveLength(0);
    expect(await startsOf(approved.initiativeId)).toHaveLength(0);
    expect(await startsOf(off.initiativeId)).toHaveLength(0);
  });

  it('waits for a click in guided mode, and has no file to revise when the change has none', async () => {
    const guided = await sentBack({ mode: 'guided' });
    const none = await sentBack({ path: 'README.md' });
    await ensureRevisions(deps());
    expect((await startsOf(guided.initiativeId))[0]!.state).toBe('awaiting_start');
    expect((await startsOf(none.initiativeId))[0]).toMatchObject({ state: 'invalid' });
  });

  it('hands over to a person after three revisions', async () => {
    const f = await sentBack();
    for (let k = 0; k < 3; k++) {
      await db.insert(stageStart).values({
        initiativeId: f.initiativeId,
        key: `revise:earlier-${k}`,
        stage: 'spec',
        role: 'product',
        task: 'x',
        state: 'started',
      });
    }
    await ensureRevisions(deps());
    const mine = (await startsOf(f.initiativeId)).find((s) => s.key === `revise:${f.review.id}`)!;
    expect(mine.state).toBe('invalid');
    expect(mine.detail).toContain('revised 3 times');
  });
});

describe('what a person can do', () => {
  it('starts a waiting step, with themselves as the sponsor, or skips it', async () => {
    const f = await approvedSpec({ mode: 'guided' });
    await ensureDesignStarts(deps());
    const [s] = await startsOf(f.initiativeId);
    const architect = await newPerson(['architect']);
    const engineer = await newPerson(['backend_engineer']);
    const post = (who: { headers: Record<string, string> }, url: string) =>
      app.inject({ method: 'POST', url, headers: who.headers });

    expect((await post(engineer, `/api/stages/${s!.id}/start`)).statusCode).toBe(403);
    expect((await post(architect, `/api/stages/${s!.id}/start`)).json()).toMatchObject({
      state: 'pending',
      stage: 'design',
    });
    expect((await post(architect, `/api/stages/${s!.id}/start`)).statusCode).toBe(409);
    await stageTick(deps());
    const [after] = await startsOf(f.initiativeId);
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, after!.runId!));
    expect(run!.sponsorPersonId).toBe(architect.id);

    const g = await approvedSpec({ mode: 'guided' });
    await ensureDesignStarts(deps());
    const [waiting] = await startsOf(g.initiativeId);
    expect((await post(architect, `/api/stages/${waiting!.id}/skip`)).json()).toMatchObject({
      state: 'cancelled',
    });
    expect((await post(architect, `/api/stages/${waiting!.id}/skip`)).statusCode).toBe(409);
  });

  it('lists the steps of an initiative to anyone signed in', async () => {
    const f = await approvedSpec();
    await ensureDesignStarts(deps());
    const who = await newPerson(['backend_engineer']);
    expect(
      (await app.inject({ method: 'GET', url: `/api/initiatives/${f.initiativeId}/stages` }))
        .statusCode,
    ).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: `/api/initiatives/${f.initiativeId}/stages`,
      headers: who.headers,
    });
    expect(res.json()).toEqual([
      expect.objectContaining({
        stage: 'design',
        state: 'pending',
        title: 'Design: weather',
        runId: null,
      }),
    ]);
  });

  it('creating an initiative plans the spec, unless the steps are turned off', async () => {
    const fixture = await createRunFixture(db);
    const maker = await newPerson(['backend_engineer']);
    const create = (extra: object) =>
      app.inject({
        method: 'POST',
        url: '/api/initiatives',
        headers: maker.headers,
        payload: { title: 'T', goal: 'G', repositoryId: fixture.repositoryId, ...extra } as never,
      });
    const on = (await create({})).json();
    expect(on.autoStages).toBe(true);
    expect(await startsOf(on.id)).toEqual([
      expect.objectContaining({ key: 'spec', state: 'pending', startedBy: maker.id }),
    ]);
    const off = (await create({ autoStages: false })).json();
    expect(off.autoStages).toBe(false);
    expect(await startsOf(off.id)).toHaveLength(0);
    const guided = (await create({ autonomyMode: 'guided' })).json();
    expect((await startsOf(guided.id))[0]!.state).toBe('awaiting_start');
  });
});
