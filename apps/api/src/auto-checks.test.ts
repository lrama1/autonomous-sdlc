import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  createRunFixture,
  initiative,
  interaction,
  runMigrations,
  securityReview,
  smokeRun,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { AutoChecks } from './auto-checks.js';
import type { InteractionRow } from './interactions.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let n = 0;

const security = {
  required: vi.fn((_row: InteractionRow) => true),
  start: vi.fn(async (_id: string, _by: string) => ({ ok: true as const })),
};
const smoke = {
  requirementFor: vi.fn(async (_row: InteractionRow) => ({ kind: 'required', checks: 2 }) as const),
  start: vi.fn(async (_id: string, _by: string | null) => ({ ok: true as const })),
};
const previews = { hasFreeSlot: vi.fn(async () => true) };

const checks = () =>
  new AutoChecks({
    db,
    security: () => security as never,
    smoke: () => smoke as never,
    previews: () => previews as never,
  });

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-autochecks-'));
  devDb = await startDevDb({ dataDir, port: 56360 });
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

// Reviews left open by other tests would be picked up too.
beforeEach(async () => {
  await db.update(interaction).set({ state: 'answered' }).where(eq(interaction.state, 'open'));
  security.required.mockImplementation(() => true);
  security.start.mockClear();
  smoke.requirementFor.mockImplementation(async () => ({ kind: 'required', checks: 2 }) as const);
  smoke.start.mockClear();
  previews.hasFreeSlot.mockImplementation(async () => true);
});

/** An open pull request review for a run, in an initiative of the given mode. */
async function review(mode = 'balanced', o: { ageHours?: number } = {}) {
  const f = await createRunFixture(db);
  await db.update(initiative).set({ autonomyMode: mode }).where(eq(initiative.id, f.initiativeId));
  const prNumber = 700 + ++n;
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: `Review PR #${prNumber}`,
      roleNeeded: 'backend_engineer',
      createdAt: new Date(Date.now() - (o.ageHours ?? 0) * 3_600_000),
      contextCard: {
        kind: 'pull_request',
        repository: 'o/r',
        prNumber,
        headSha: `sha${prNumber}`,
      },
    })
    .returning();
  return { ...f, row: row!, prNumber, sha: `sha${prNumber}` };
}

describe('starting the checks a review needs', () => {
  it('starts the security review in every mode, with the run’s sponsor, once for a commit', async () => {
    const guided = await review('guided');
    const c = checks();
    await c.tick();
    expect(security.start).toHaveBeenCalledWith(guided.row.id, guided.personId);
    await c.tick();
    expect(security.start).toHaveBeenCalledTimes(1);
  });

  it('does not start a security review for a commit that has had one, whatever it found', async () => {
    const r = await review();
    await db.insert(securityReview).values({
      interactionId: r.row.id,
      initiativeId: r.initiativeId,
      repository: 'o/r',
      prNumber: r.prNumber,
      headSha: r.sha,
      state: 'error',
    });
    await checks().tick();
    expect(security.start).not.toHaveBeenCalledWith(r.row.id, expect.anything());
  });
  it('starts the smoke test in balanced and autopilot, not in guided', async () => {
    const guided = await review('guided');
    await checks().tick();
    expect(smoke.start).not.toHaveBeenCalled();
    await db
      .update(interaction)
      .set({ state: 'answered' })
      .where(eq(interaction.id, guided.row.id));

    const balanced = await review('balanced');
    await checks().tick();
    expect(smoke.start).toHaveBeenCalledWith(balanced.row.id, null);
    await db
      .update(interaction)
      .set({ state: 'answered' })
      .where(eq(interaction.id, balanced.row.id));

    const autopilot = await review('autopilot');
    await checks().tick();
    expect(smoke.start).toHaveBeenLastCalledWith(autopilot.row.id, null);
  });

  it('waits for a free slot, and for a readable smoke file, and starts one smoke test per pass', async () => {
    await review('balanced');
    await review('balanced');
    previews.hasFreeSlot.mockImplementation(async () => false);
    const c = checks();
    await c.tick();
    expect(smoke.start).not.toHaveBeenCalled();
    // The review was not given up on. When a slot opens it starts, one per pass.
    previews.hasFreeSlot.mockImplementation(async () => true);
    await c.tick();
    expect(smoke.start).toHaveBeenCalledTimes(1);
    await c.tick();
    expect(smoke.start).toHaveBeenCalledTimes(2);

    smoke.start.mockClear();
    await review('balanced');
    smoke.requirementFor.mockImplementation(
      async () => ({ kind: 'invalid', message: 'bad' }) as never,
    );
    await checks().tick();
    expect(smoke.start).not.toHaveBeenCalled();
  });

  it('never starts a smoke test again for a commit that has had one, whatever it said', async () => {
    const r = await review('balanced');
    await db.insert(smokeRun).values({
      interactionId: r.row.id,
      initiativeId: r.initiativeId,
      repository: 'o/r',
      prNumber: r.prNumber,
      headSha: r.sha,
      state: 'failed',
    });
    await checks().tick();
    expect(smoke.start).not.toHaveBeenCalledWith(r.row.id, null);
  });

  it('leaves an old review and a decided one alone', async () => {
    const old = await review('balanced', { ageHours: 72 });
    const decided = await review('balanced');
    await db
      .update(interaction)
      .set({ state: 'answered' })
      .where(eq(interaction.id, decided.row.id));
    await checks().tick();
    expect(security.start).not.toHaveBeenCalledWith(old.row.id, expect.anything());
    expect(smoke.start).not.toHaveBeenCalledWith(old.row.id, null);
    expect(security.start).not.toHaveBeenCalledWith(decided.row.id, expect.anything());
  });
});
