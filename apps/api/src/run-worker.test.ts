import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  agentRun,
  authenticateRunToken,
  createDb,
  createRunFixture,
  interaction,
  runEvent,
  runMigrations,
  runToken,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import type { LaunchInput, Launched, RunnerAdapter } from './launcher.js';
import { settleWithAnswer } from './interactions.js';
import { createRunWorker } from './run-worker.js';

class FakeAdapter implements RunnerAdapter {
  launched: Array<{
    input: LaunchInput;
    end: (code: number | null) => void;
    kill: ReturnType<typeof vi.fn>;
  }> = [];
  failNext = false;
  async launch(input: LaunchInput): Promise<Launched> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('no such runner');
    }
    let end!: (code: number | null) => void;
    const done = new Promise<{ code: number | null }>((r) => (end = (code) => r({ code })));
    const kill = vi.fn();
    this.launched.push({ input, end, kill });
    return { done, kill };
  }
}

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-worker-'));
  devDb = await startDevDb({ dataDir, port: 56338 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
}, 180_000);

afterAll(async () => {
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

// Runs left over from earlier tests would use up the concurrency limit.
beforeEach(async () => {
  await db
    .update(agentRun)
    .set({ state: 'cancelled' })
    .where(inArray(agentRun.state, ['queued', 'starting', 'running', 'resuming', 'parked']));
});

const worker = (adapter: FakeAdapter, maxConcurrent = 5) =>
  createRunWorker({ db, adapter, apiUrl: 'http://127.0.0.1:8080', maxConcurrent, log: () => {} });
const stateOf = async (id: string) =>
  (await db.select().from(agentRun).where(eq(agentRun.id, id)))[0]!;
const settle = () => new Promise((r) => setTimeout(r, 150));

// Other tests in this file share the database, so each test looks only at its own runs.
const launchedFor = (a: FakeAdapter, id: string) => a.launched.filter((l) => l.input.runId === id);

describe('starting queued runs', () => {
  it('launches a queued run with a fresh token and the API address', async () => {
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    await worker(a).tick();
    const [l] = launchedFor(a, f.runId);
    expect(l!.input.apiUrl).toBe('http://127.0.0.1:8080');
    expect((await stateOf(f.runId)).state).toBe('starting');
    const ctx = await authenticateRunToken(db, l!.input.token);
    expect(ctx).toMatchObject({ runId: f.runId });
    expect(ctx!.scopes).toContain('runner');
  });

  it('does not launch a run twice', async () => {
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    const w = worker(a);
    await w.tick();
    await w.tick();
    expect(launchedFor(a, f.runId)).toHaveLength(1);
  });

  it('respects the concurrency limit', async () => {
    await db.update(agentRun).set({ state: 'cancelled' }).where(eq(agentRun.state, 'queued'));
    await db.update(agentRun).set({ state: 'cancelled' }).where(eq(agentRun.state, 'starting'));
    await db.update(agentRun).set({ state: 'cancelled' }).where(eq(agentRun.state, 'running'));
    const runs = [
      await createRunFixture(db, { state: 'queued' }),
      await createRunFixture(db, { state: 'queued' }),
      await createRunFixture(db, { state: 'queued' }),
    ];
    const a = new FakeAdapter();
    const w = worker(a, 2);
    await w.tick();
    expect(a.launched).toHaveLength(2);
    // The oldest go first.
    expect(a.launched.map((l) => l.input.runId)).toEqual([runs[0]!.runId, runs[1]!.runId]);
    expect((await stateOf(runs[2]!.runId)).state).toBe('queued');
  });

  it('fails the run when the runner cannot be launched', async () => {
    await db.update(agentRun).set({ state: 'cancelled' }).where(eq(agentRun.state, 'queued'));
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    a.failNext = true;
    await worker(a).tick();
    expect(await stateOf(f.runId)).toMatchObject({ state: 'failed', exitReason: 'error' });
  });
});

describe('resuming parked runs', () => {
  async function parkedOn(f: Awaited<ReturnType<typeof createRunFixture>>) {
    const [q] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'question',
        title: 'Which?',
        roleNeeded: 'backend_engineer',
        blocks: [{ runId: f.runId }],
      })
      .returning();
    await db
      .update(agentRun)
      .set({ state: 'parked', parkReason: q!.id })
      .where(eq(agentRun.id, f.runId));
    return q!;
  }

  it('leaves a run parked while its question is open', async () => {
    const f = await createRunFixture(db, { state: 'running' });
    await parkedOn(f);
    const a = new FakeAdapter();
    await worker(a).tick();
    expect(launchedFor(a, f.runId)).toHaveLength(0);
    expect((await stateOf(f.runId)).state).toBe('parked');
  });

  it('resumes it, with a new token, once the question is answered', async () => {
    const f = await createRunFixture(db, { state: 'running' });
    const q = await parkedOn(f);
    await settleWithAnswer(db, q.id, { answer: 'PostgreSQL', by: f.personId, via: 'workspace' });
    const a = new FakeAdapter();
    await worker(a).tick();
    expect(launchedFor(a, f.runId)).toHaveLength(1);
    expect((await stateOf(f.runId)).state).toBe('resuming');
    expect(await authenticateRunToken(db, launchedFor(a, f.runId)[0]!.input.token)).toMatchObject({
      runId: f.runId,
    });
  });

  it('resumes a run parked on a default that applied, too', async () => {
    const f = await createRunFixture(db, { state: 'running' });
    const q = await parkedOn(f);
    await db
      .update(interaction)
      .set({ state: 'defaulted', answer: { text: 'md', source: 'default' } })
      .where(eq(interaction.id, q.id));
    const a = new FakeAdapter();
    await worker(a).tick();
    expect(launchedFor(a, f.runId)).toHaveLength(1);
  });
});

describe('a runner that ends on its own', () => {
  it('fails the run and revokes its token when it reported nothing', async () => {
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    await worker(a).tick();
    const l = launchedFor(a, f.runId)[0]!;
    await db.update(agentRun).set({ state: 'running' }).where(eq(agentRun.id, f.runId));
    l.end(1);
    await settle();
    expect(await stateOf(f.runId)).toMatchObject({ state: 'failed', exitReason: 'error' });
    expect(await authenticateRunToken(db, l.input.token)).toBeNull();
    const events = await db.select().from(runEvent).where(eq(runEvent.runId, f.runId));
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', payload: { exitReason: 'error' } });
  });

  it('leaves a run alone if the runner already reported its end', async () => {
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    await worker(a).tick();
    await db.update(agentRun).set({ state: 'succeeded' }).where(eq(agentRun.id, f.runId));
    launchedFor(a, f.runId)[0]!.end(0);
    await settle();
    expect((await stateOf(f.runId)).state).toBe('succeeded');
  });

  it('parks the run instead of failing it when it was lost while a person was being asked', async () => {
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    await worker(a).tick();
    await db.update(agentRun).set({ state: 'running' }).where(eq(agentRun.id, f.runId));
    const [q] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'question',
        title: 'Which?',
        roleNeeded: 'backend_engineer',
        blocks: [{ runId: f.runId }],
      })
      .returning();
    launchedFor(a, f.runId)[0]!.end(null);
    await settle();
    expect(await stateOf(f.runId)).toMatchObject({ state: 'parked', parkReason: q!.id });
    const events = await db.select().from(runEvent).where(eq(runEvent.runId, f.runId));
    expect(events.at(-1)).toMatchObject({ type: 'run.parked', payload: { cause: 'runner_lost' } });
    // The token is kept, so the resume can mint a new one and the old checkout stays.
    expect(
      (await db.select().from(runToken).where(eq(runToken.runId, f.runId))).every(
        (t) => t.revokedAt === null,
      ),
    ).toBe(true);

    // Answering it resumes the run.
    await settleWithAnswer(db, q!.id, { answer: 'PostgreSQL', by: f.personId, via: 'workspace' });
    const b = new FakeAdapter();
    await worker(b).tick();
    expect(launchedFor(b, f.runId)).toHaveLength(1);
  });

  it('does not park a run on a question that only the agent might look at later (not blocking)', async () => {
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    await worker(a).tick();
    await db.update(agentRun).set({ state: 'running' }).where(eq(agentRun.id, f.runId));
    await db.insert(interaction).values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'question',
      title: 'Optional?',
      roleNeeded: 'backend_engineer',
      blocks: [],
    });
    launchedFor(a, f.runId)[0]!.end(1);
    await settle();
    expect((await stateOf(f.runId)).state).toBe('failed');
  });
});

describe('stopping', () => {
  it('kills the process of a cancelled run on the next tick', async () => {
    const f = await createRunFixture(db, { state: 'queued' });
    const a = new FakeAdapter();
    const w = worker(a);
    await w.tick();
    const l = launchedFor(a, f.runId)[0]!;
    await db.update(agentRun).set({ state: 'cancelled' }).where(eq(agentRun.id, f.runId));
    await w.tick();
    expect(l.kill).toHaveBeenCalled();
  });
});
