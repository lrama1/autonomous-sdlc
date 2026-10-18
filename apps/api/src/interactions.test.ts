import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  addRunToFixture,
  createDb,
  createRunFixture,
  hat,
  interaction,
  person,
  runEvent,
  runMigrations,
  standingDecision,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { applyDueDefaults, createInteraction } from './interactions.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

async function newPerson(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `p${k}@example.test`, oidcSubject: `p${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  const cookie = `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`;
  return { id: p!.id, cookie };
}

const as = (cookie: string) => ({ cookie });

async function ask(
  f: Awaited<ReturnType<typeof createRunFixture>>,
  o: Partial<Parameters<typeof createInteraction>[1]> = {},
) {
  const { interaction: row } = await createInteraction(db, {
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'question',
    title: 'Which library?',
    contextCard: {},
    blocks: [{ runId: f.runId }],
    roleNeeded: 'backend_engineer',
    ...o,
  });
  return row;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-ix-'));
  devDb = await startDevDb({ dataDir, port: 56333 });
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
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('the attention queue', () => {
  it('needs a session', async () => {
    expect((await app.inject('/api/interactions')).statusCode).toBe(401);
  });

  it('shows only what is addressed to my hats, ranked', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const alice = await newPerson(['product_owner']);
    const low = await ask(f, { title: 'low' });
    const stop = await ask(f, { title: 'hard stop', hardStop: true });
    const blocking2 = await ask(f, {
      title: 'blocks two',
      blocks: [{ runId: f.runId }, { runId: 'x' }],
    });
    await ask(f, { title: 'for the product owner', roleNeeded: 'product_owner' });

    const res = await app.inject({ url: '/api/interactions', headers: as(bob.cookie) });
    expect(res.statusCode).toBe(200);
    const mine = (res.json() as Array<{ id: string; title: string }>).filter((i) =>
      [low.id, stop.id, blocking2.id].includes(i.id),
    );
    expect(mine.map((i) => i.title)).toEqual(['hard stop', 'blocks two', 'low']);

    const aliceQueue = await app.inject({ url: '/api/interactions', headers: as(alice.cookie) });
    expect(
      (aliceQueue.json() as Array<{ title: string }>).some(
        (i) => i.title === 'for the product owner',
      ),
    ).toBe(true);
    expect((aliceQueue.json() as Array<{ title: string }>).some((i) => i.title === 'low')).toBe(
      false,
    );
  });
});

describe('answering', () => {
  it('lets the right hat answer, records it, and tells the run', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const q = await ask(f);
    const res = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/answer`,
      headers: as(bob.cookie),
      payload: { answer: 'date-fns' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'answered',
      answeredBy: bob.id,
      answeredVia: 'workspace',
      answer: { text: 'date-fns', source: 'human' },
    });
    const log = await db.select().from(activityEvent).where(eq(activityEvent.interactionId, q.id));
    expect(log.map((l) => l.action).sort()).toEqual(['interaction.answered', 'interaction.raised']);
    const events = await db.select().from(runEvent).where(eq(runEvent.runId, f.runId));
    expect(events.map((e) => e.type)).toEqual(['interaction.settled']);
  });

  it('refuses someone without the hat', async () => {
    const f = await createRunFixture(db);
    const alice = await newPerson(['product_owner']);
    const q = await ask(f);
    const res = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/answer`,
      headers: as(alice.cookie),
      payload: { answer: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('wrong_role');
  });

  it('answers only once', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const q = await ask(f);
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/api/interactions/${q.id}/answer`,
        headers: as(bob.cookie),
        payload: { answer: 'a' },
      });
    expect((await post()).statusCode).toBe(200);
    const second = await post();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('not_open');
  });

  it('settles a race between two answers with exactly one winner', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const q = await ask(f);
    const codes = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        app
          .inject({
            method: 'POST',
            url: `/api/interactions/${q.id}/answer`,
            headers: as(bob.cookie),
            payload: { answer: `a${i}` },
          })
          .then((r) => r.statusCode),
      ),
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(3);
  });

  it('"use this from now on" creates a standing decision linked to the answer', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const q = await ask(f, { topicKey: 'date-library' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/answer`,
      headers: as(bob.cookie),
      payload: { answer: 'Always use date-fns', makeStanding: true },
    });
    expect(res.statusCode).toBe(200);
    const [sd] = await db
      .select()
      .from(standingDecision)
      .where(eq(standingDecision.createdFromInteractionId, q.id));
    expect(sd).toMatchObject({
      scope: 'initiative',
      scopeId: f.initiativeId,
      topic: 'date-library',
      text: 'Always use date-fns',
      active: true,
    });
    const [row] = await db.select().from(interaction).where(eq(interaction.id, q.id));
    expect(row!.standingDecisionId).toBe(sd!.id);
  });

  it('records "didn\'t need to ask" without settling', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const q = await ask(f);
    const res = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/didnt-need-to-ask`,
      headers: as(bob.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'open', didntNeedToAsk: true });
  });

  it('rejects a malformed request with a 400', async () => {
    const bob = await newPerson(['backend_engineer']);
    expect(
      (await app.inject({ url: '/api/interactions/not-a-uuid', headers: as(bob.cookie) }))
        .statusCode,
    ).toBe(400);
  });
});

describe('checkpoints and independent review', () => {
  it('needs a decision, and only independent people may decide', async () => {
    const f = await createRunFixture(db);
    const sponsor = await newPerson(['backend_engineer']);
    // The sponsor started the run, so they cannot review its work. Another run in the same initiative has a different sponsor.
    const reviewer = await newPerson(['backend_engineer']);
    const second = await addRunToFixture(db, f, { sponsorPersonId: sponsor.id });
    const pr = await ask(f, {
      type: 'review',
      title: 'PR #12',
      runId: second.runId,
      blocks: [{ runId: second.runId }],
    });

    const post = (cookie: string, payload: object) =>
      app.inject({
        method: 'POST',
        url: `/api/interactions/${pr.id}/answer`,
        headers: as(cookie),
        payload,
      });

    expect((await post(reviewer.cookie, { answer: 'looks fine' })).json().error.code).toBe(
      'decision_required',
    );
    const own = await post(sponsor.cookie, { decision: 'approved' });
    expect(own.statusCode).toBe(403);
    expect(own.json().error.code).toBe('independent_review');

    const ok = await post(reviewer.cookie, { decision: 'approved', answer: 'LGTM' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      state: 'answered',
      answer: { decision: 'approved', text: 'LGTM' },
    });
    const log = await db.select().from(activityEvent).where(eq(activityEvent.interactionId, pr.id));
    expect(log.map((l) => l.action)).toContain('interaction.approved');
  });

  it('refuses a decision on a plain question', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const q = await ask(f);
    const res = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/answer`,
      headers: as(bob.cookie),
      payload: { decision: 'approved' },
    });
    expect(res.json().error.code).toBe('decision_not_allowed');
  });
});

describe('defaults', () => {
  it('the worker applies only what is due, and never a checkpoint or hard stop', async () => {
    const f = await createRunFixture(db);
    const past = new Date(Date.now() - 1000);
    const due = await ask(f, { title: 'due', recommendation: 'a', defaultValue: 'a', dueAt: past });
    const notYet = await ask(f, {
      title: 'later',
      defaultValue: 'a',
      dueAt: new Date(Date.now() + 3_600_000),
    });
    const stop = await ask(f, { title: 'stop', defaultValue: 'a', dueAt: past, hardStop: true });
    const cp = await ask(f, {
      title: 'cp',
      type: 'checkpoint',
      checkpointId: 'G1',
      defaultValue: 'a',
      dueAt: past,
    });

    expect(await applyDueDefaults(db)).toBeGreaterThanOrEqual(1);
    const state = async (id: string) =>
      (await db.select().from(interaction).where(eq(interaction.id, id)))[0]!;
    expect(await state(due.id)).toMatchObject({
      state: 'defaulted',
      answeredVia: 'default',
      answer: { text: 'a', source: 'default' },
    });
    expect((await state(notYet.id)).state).toBe('open');
    expect((await state(stop.id)).state).toBe('open');
    expect((await state(cp.id)).state).toBe('open');
  });

  it('a late human answer does not overwrite a default that already applied', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer']);
    const q = await ask(f, { defaultValue: 'md', dueAt: new Date(Date.now() - 1000) });
    await applyDueDefaults(db);
    const res = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/answer`,
      headers: as(bob.cookie),
      payload: { answer: 'txt' },
    });
    expect(res.statusCode).toBe(409);
  });
});
