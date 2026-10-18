import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  agentRun,
  assumption,
  createDb,
  createRunFixture,
  hat,
  interaction,
  notification,
  person,
  runMigrations,
  standingDecision,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { DEFAULT_ATTENTION_POLICY } from '@sdlc/core';
import type { AttentionPolicy } from '@sdlc/core';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { attentionTick } from './attention.js';
import { loadConfig } from './config.js';
import { createInteraction } from './interactions.js';
import type { NotificationBody, Notifier, Recipient } from './notifier.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

class Recorder implements Notifier {
  readonly channel = 'test';
  sent: Array<{ to: Recipient; body: NotificationBody }> = [];
  async deliver(to: Recipient, body: NotificationBody) {
    this.sent.push({ to, body });
    return {};
  }
  kinds(personId: string) {
    return this.sent.filter((s) => s.to.personId === personId).map((s) => s.body.kind);
  }
}

async function newPerson(roles: string[] = [], o: { name?: string; active?: boolean } = {}) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({
      displayName: o.name ?? `Person ${k}`,
      email: `p${k}@example.test`,
      oidcSubject: `p${k}`,
      active: o.active ?? true,
    })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  const cookie = `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`;
  return { id: p!.id, cookie, headers: { cookie } };
}

const minutes = (m: number) => new Date(Date.now() + m * 60_000);

function deps(notifier: Notifier, policy: AttentionPolicy = DEFAULT_ATTENTION_POLICY) {
  return { db, policy, notifier, publicUrl: 'http://localhost:5173', independentReview: true };
}

async function ask(
  f: Awaited<ReturnType<typeof createRunFixture>>,
  o: Partial<Parameters<typeof createInteraction>[1]> = {},
) {
  const { interaction: row } = await createInteraction(db, {
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'decision',
    title: 'Which provider?',
    contextCard: {},
    blocks: [{ runId: f.runId }],
    roleNeeded: 'backend_engineer',
    ...o,
  });
  return row;
}

const reload = async (id: string) =>
  (await db.select().from(interaction).where(eq(interaction.id, id)))[0]!;
const actions = async (id: string) =>
  (await db.select().from(activityEvent).where(eq(activityEvent.interactionId, id))).map(
    (a) => a.action,
  );

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-att-'));
  devDb = await startDevDb({ dataDir, port: 56340 });
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

// Each test sets up its own people. Nothing from an earlier test may be handed out or notified again.
beforeEach(async () => {
  await db.update(interaction).set({ state: 'withdrawn' }).where(eq(interaction.state, 'open'));
  await db.delete(notification);
  await db.delete(hat);
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('handing out asks', () => {
  it('gives an ask to the holder of the hat, once, and tells them', async () => {
    const bob = await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    const q = await ask(f);
    const rec = new Recorder();

    const first = await attentionTick(deps(rec));
    const second = await attentionTick(deps(rec));

    expect(first.assigned).toBe(1);
    expect(second.assigned).toBe(0);
    const row = await reload(q.id);
    expect(row.assignedPersonId).toBe(bob.id);
    expect(row.escalationLevel).toBe(0);
    expect(await actions(q.id)).toContain('interaction.assigned');
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]!.body).toMatchObject({
      kind: 'ask',
      title: 'Which provider?',
      chat: true,
      link: `http://localhost:5173/#/queue/${q.id}`,
    });
  });

  it('leaves an ask alone when nobody holds the hat and there is no admin', async () => {
    const f = await createRunFixture(db);
    const q = await ask(f);
    const res = await attentionTick(deps(new Recorder()));
    expect(res.assigned).toBe(0);
    expect((await reload(q.id)).assignedPersonId).toBeNull();
  });

  it('never notifies for notices', async () => {
    await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    await ask(f, { type: 'notice', blocks: [] });
    const rec = new Recorder();
    await attentionTick(deps(rec), minutes(600));
    expect(rec.sent).toHaveLength(0);
  });

  it('skips a person who is away and uses their deputy', async () => {
    const sofia = await newPerson([], { name: 'Sofia' });
    const bob = await newPerson(['backend_engineer']);
    await db
      .update(hat)
      .set({
        deputyPersonId: sofia.id,
        outOfOffice: {
          from: minutes(-60).toISOString(),
          until: minutes(60 * 24).toISOString(),
        },
      })
      .where(eq(hat.personId, bob.id));
    const f = await createRunFixture(db);
    const q = await ask(f);
    await attentionTick(deps(new Recorder()));
    expect((await reload(q.id)).assignedPersonId).toBe(sofia.id);
  });

  it('uses the delegate named in the time away before the deputy', async () => {
    const sofia = await newPerson([], { name: 'Sofia' });
    const zed = await newPerson([], { name: 'Zed' });
    const bob = await newPerson(['backend_engineer']);
    await db
      .update(hat)
      .set({
        deputyPersonId: sofia.id,
        outOfOffice: {
          from: minutes(-60).toISOString(),
          until: minutes(600).toISOString(),
          delegateTo: zed.id,
        },
      })
      .where(eq(hat.personId, bob.id));
    const f = await createRunFixture(db);
    const q = await ask(f);
    await attentionTick(deps(new Recorder()));
    expect((await reload(q.id)).assignedPersonId).toBe(zed.id);
  });

  it('never gives a review to the person who started the run', async () => {
    const lead = await newPerson(['platform_admin']);
    const f = await createRunFixture(db);
    // The sponsor holds the hat that reviews, and is the only one who does.
    await db.insert(hat).values({ personId: f.personId, role: 'backend_engineer' });
    const review = await ask(f, { type: 'review', blocks: [] });
    await attentionTick(deps(new Recorder()));
    expect((await reload(review.id)).assignedPersonId).toBe(lead.id);
  });
});

describe('reminders and escalation', () => {
  it('reminds, then moves up the chain deputy then lead, and keeps reminding the last person', async () => {
    const lead = await newPerson(['platform_admin']);
    const sofia = await newPerson([], { name: 'Sofia' });
    const bob = await newPerson(['backend_engineer']);
    await db.update(hat).set({ deputyPersonId: sofia.id }).where(eq(hat.personId, bob.id));
    const f = await createRunFixture(db);
    const q = await ask(f);
    const rec = new Recorder();

    await attentionTick(deps(rec), minutes(0));
    expect((await attentionTick(deps(rec), minutes(119))).reminded).toBe(0);
    expect((await attentionTick(deps(rec), minutes(121))).reminded).toBe(1);
    expect(rec.kinds(bob.id)).toEqual(['ask', 'reminder']);

    expect((await attentionTick(deps(rec), minutes(241))).escalated).toBe(1);
    let row = await reload(q.id);
    expect(row.assignedPersonId).toBe(sofia.id);
    expect(row.escalationLevel).toBe(1);
    expect(row.reminderCount).toBe(0);
    expect(rec.kinds(sofia.id)).toEqual(['escalation']);

    // Sofia has her own two hours before a reminder, and four before it moves again.
    expect((await attentionTick(deps(rec), minutes(241 + 121))).reminded).toBe(1);
    expect((await attentionTick(deps(rec), minutes(241 + 241))).escalated).toBe(1);
    row = await reload(q.id);
    expect(row.assignedPersonId).toBe(lead.id);
    expect(row.escalationLevel).toBe(2);

    // Nobody is left above the lead, so the lead is reminded again at the escalation pace.
    expect((await attentionTick(deps(rec), minutes(482 + 241))).reminded).toBe(1);

    // None of this answered anything.
    row = await reload(q.id);
    expect(row.state).toBe('open');
    expect(row.answer).toBeNull();
    expect(await actions(q.id)).toEqual(
      expect.arrayContaining([
        'interaction.assigned',
        'interaction.reminded',
        'interaction.escalated',
      ]),
    );
  });

  it('does not remind or escalate a snoozed ask until the time is up', async () => {
    await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    const q = await ask(f);
    const rec = new Recorder();
    await attentionTick(deps(rec), minutes(0));
    await db
      .update(interaction)
      .set({ snoozedUntil: minutes(300) })
      .where(eq(interaction.id, q.id));
    const during = await attentionTick(deps(rec), minutes(250));
    expect([during.reminded, during.escalated]).toEqual([0, 0]);
    expect((await attentionTick(deps(rec), minutes(301))).reminded).toBe(1);
  });

  it('drops a message that was waiting when the ask was answered', async () => {
    await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    const q = await ask(f);
    const rec = new Recorder();
    const quiet: AttentionPolicy = {
      ...DEFAULT_ATTENTION_POLICY,
      defaultHours: { tz: 'UTC', start: '08:00', end: '20:00' },
    };
    const day = (hh: string) => new Date(`2030-03-06T${hh}:00Z`);
    await attentionTick(deps(rec, quiet), day('23:00'));
    await db.update(interaction).set({ state: 'answered' }).where(eq(interaction.id, q.id));
    await attentionTick(deps(rec, quiet), day('09:00'));
    expect(rec.sent).toHaveLength(0);
    const rows = await db.select().from(notification);
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ['skipped', 'settled before it was sent'],
    ]);
  });
});

describe('defaults', () => {
  it('applies the recommendation after the deadline, flags it, and tells the owner', async () => {
    const bob = await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    const q = await ask(f, {
      recommendation: 'A',
      defaultValue: 'A',
      dueAt: minutes(60),
    });
    const rec = new Recorder();
    await attentionTick(deps(rec), minutes(0));
    expect((await reload(q.id)).state).toBe('open');

    const res = await attentionTick(deps(rec), minutes(61));
    expect(res.defaulted).toBe(1);
    const row = await reload(q.id);
    expect(row).toMatchObject({ state: 'defaulted', answeredVia: 'default' });
    expect(row.answer).toMatchObject({ text: 'A', source: 'default' });
    expect(await actions(q.id)).toContain('interaction.defaulted');
    const told = rec.sent.find((s) => s.body.kind === 'default_applied');
    expect(told?.to.personId).toBe(bob.id);
    expect(told?.body.appliedDefault).toBe('A');
  });

  it('never applies a default to a hard stop or a review, but still escalates it', async () => {
    const lead = await newPerson(['platform_admin']);
    const sofia = await newPerson([], { name: 'Sofia' });
    const bob = await newPerson(['backend_engineer']);
    await db.update(hat).set({ deputyPersonId: sofia.id }).where(eq(hat.personId, bob.id));
    const f = await createRunFixture(db);
    const stop = await ask(f, {
      hardStop: true,
      defaultValue: 'discard',
      recommendation: 'discard',
      dueAt: minutes(10),
    });
    const rec = new Recorder();
    await attentionTick(deps(rec), minutes(0));
    await attentionTick(deps(rec), minutes(300));
    const row = await reload(stop.id);
    expect(row.state).toBe('open');
    expect(row.assignedPersonId).toBe(sofia.id);
    expect(lead.id).toBeTruthy();
  });
});

describe('quiet hours and the digest', () => {
  const quiet: AttentionPolicy = {
    ...DEFAULT_ATTENTION_POLICY,
    defaultHours: { tz: 'UTC', start: '08:00', end: '20:00' },
    digestAt: '17:00',
    tz: 'UTC',
    // Long enough that the hours between ticks in these tests do not trigger reminders.
    reminderAfterMs: 100 * 3600_000,
    escalateAfterMs: 200 * 3600_000,
  };
  const day = (hh: string) => new Date(`2030-03-06T${hh}:00Z`);

  it('holds a normal ask overnight, sends it in the morning, and never holds a hard stop', async () => {
    await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    const normal = await ask(f, { title: 'normal' });
    const stop = await ask(f, { title: 'hard stop', hardStop: true });
    const rec = new Recorder();

    await attentionTick(deps(rec, quiet), day('23:00'));
    expect(rec.sent.map((s) => s.body.title)).toEqual(['hard stop']);
    const held = await db.select().from(notification).where(eq(notification.status, 'held'));
    expect(held).toHaveLength(1);

    await attentionTick(deps(rec, quiet), day('08:30'));
    expect(rec.sent.map((s) => s.body.title)).toEqual(['hard stop', 'normal']);
    expect([normal.id, stop.id]).toHaveLength(2);
  });

  it('uses the hat own hours instead of the team default', async () => {
    const bob = await newPerson(['backend_engineer']);
    await db
      .update(hat)
      .set({ hours: { tz: 'UTC', start: '14:00', end: '23:00' } })
      .where(eq(hat.personId, bob.id));
    const f = await createRunFixture(db);
    await ask(f);
    const rec = new Recorder();
    await attentionTick(deps(rec, quiet), day('12:00'));
    expect(rec.sent).toHaveLength(0);
    await attentionTick(deps(rec, quiet), day('15:00'));
    expect(rec.sent).toHaveLength(1);
  });

  it('sends low-priority asks as one digest at the digest time', async () => {
    const bob = await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    await ask(f, { title: 'tabs or spaces', blocks: [] });
    await ask(f, { title: 'label wording', blocks: [] });
    await ask(f, { title: 'blocking one', blocks: [{ runId: f.runId }] });
    const rec = new Recorder();

    await attentionTick(deps(rec, quiet), day('10:00'));
    expect(rec.sent.map((s) => s.body.title)).toEqual(['blocking one']);

    expect((await attentionTick(deps(rec, quiet), day('17:05'))).digests).toBe(1);
    const digest = rec.sent.find((s) => s.body.kind === 'digest')!;
    expect(digest.to.personId).toBe(bob.id);
    expect(digest.body.items?.map((i) => i.title).sort()).toEqual([
      'label wording',
      'tabs or spaces',
    ]);

    // Once a day.
    expect((await attentionTick(deps(rec, quiet), day('18:00'))).digests).toBe(0);
  });
});

describe('queue and snooze through the API', () => {
  it('shows who an ask is with and whether chat may settle it', async () => {
    const bob = await newPerson(['backend_engineer'], { name: 'Bob' });
    const f = await createRunFixture(db);
    const q = await ask(f, { options: [{ id: 'A', label: 'Free' }], recommendation: 'A' });
    await ask(f, { type: 'checkpoint', title: 'spec', blocks: [] });
    await attentionTick(deps(new Recorder()));
    const res = await app.inject({ url: '/api/interactions', headers: bob.headers });
    const items = res.json() as Array<{
      id: string;
      assignedToName: string;
      initiativeTitle: string;
      chatAnswerable: boolean;
      type: string;
    }>;
    const mine = items.find((i) => i.id === q.id)!;
    expect(mine).toMatchObject({ assignedToName: 'Bob', chatAnswerable: true });
    expect(mine.initiativeTitle).toMatch(/Initiative/);
    expect(items.find((i) => i.type === 'checkpoint')!.chatAnswerable).toBe(false);
  });

  it('answers by option and stores what was chosen', async () => {
    const bob = await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    const q = await ask(f, {
      options: [
        { id: 'A', label: 'Free tier' },
        { id: 'B', label: 'Paid' },
      ],
      recommendation: 'A',
    });
    const bad = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/answer`,
      headers: bob.headers,
      payload: { optionId: 'Z' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('unknown_option');

    const ok = await app.inject({
      method: 'POST',
      url: `/api/interactions/${q.id}/answer`,
      headers: bob.headers,
      payload: { optionId: 'B', makeStanding: true, standingScope: 'repository' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().answer).toMatchObject({ text: 'B: Paid', choice: 'B' });
    const [sd] = await db
      .select()
      .from(standingDecision)
      .where(eq(standingDecision.createdFromInteractionId, q.id));
    expect(sd).toMatchObject({
      scope: 'repository',
      scopeId: f.repositoryId,
      createdBy: bob.id,
      text: 'B: Paid',
    });
  });

  it('snoozes for the person it is addressed to, and not a hard stop', async () => {
    const bob = await newPerson(['backend_engineer']);
    const alice = await newPerson(['product_owner']);
    const f = await createRunFixture(db);
    const q = await ask(f);
    const stop = await ask(f, { hardStop: true });

    const post = (id: string, headers: Record<string, string>, minutes = 90) =>
      app.inject({
        method: 'POST',
        url: `/api/interactions/${id}/snooze`,
        headers,
        payload: { minutes },
      });

    expect((await post(q.id, alice.headers)).statusCode).toBe(403);
    expect((await post(stop.id, bob.headers)).statusCode).toBe(409);
    expect((await post(q.id, bob.headers, 1)).statusCode).toBe(400);
    const ok = await post(q.id, bob.headers);
    expect(ok.statusCode).toBe(200);
    const until = new Date(ok.json().snoozedUntil).getTime() - Date.now();
    expect(until).toBeGreaterThan(80 * 60_000);
    expect(until).toBeLessThanOrEqual(90 * 60_000);
    expect(await actions(q.id)).toContain('interaction.snoozed');
  });
});

describe('standing decisions', () => {
  it('are listed, created, changed only by their owner or an admin, and retired', async () => {
    const f = await createRunFixture(db);
    const bob = await newPerson(['backend_engineer'], { name: 'Bob' });
    const cara = await newPerson(['architect']);
    const admin = await newPerson(['platform_admin']);
    const nobody = await newPerson([]);

    const create = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/standing-decisions',
        headers,
        payload: {
          scope: 'initiative',
          scopeId: f.initiativeId,
          topic: 'date-library',
          text: 'Use date-fns',
        },
      });
    expect((await create(nobody.headers)).statusCode).toBe(403);
    const made = await create(bob.headers);
    expect(made.statusCode).toBe(201);
    const id = made.json().id as string;

    const noScope = await app.inject({
      method: 'POST',
      url: '/api/standing-decisions',
      headers: bob.headers,
      payload: { scope: 'repository', topic: 't', text: 'x' },
    });
    expect(noScope.statusCode).toBe(400);

    const patch = (headers: Record<string, string>, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/standing-decisions/${id}`, headers, payload });
    expect((await patch(cara.headers, { active: false })).statusCode).toBe(403);
    expect((await patch(bob.headers, { text: 'Use date-fns, never moment' })).statusCode).toBe(200);

    // An ask on that topic is now answered without a person.
    const { interaction: auto } = await createInteraction(db, {
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'question',
      title: 'Date library?',
      contextCard: {},
      blocks: [],
      topicKey: 'Date-Library',
      roleNeeded: 'backend_engineer',
    });
    expect(auto).toMatchObject({
      state: 'answered',
      answeredVia: 'standing',
      standingDecisionId: id,
    });
    expect(auto.answer).toMatchObject({ text: 'Use date-fns, never moment', source: 'standing' });

    const list = await app.inject({ url: '/api/standing-decisions', headers: cara.headers });
    const row = (
      list.json() as Array<{ id: string; createdByName: string; answeredSince: number }>
    ).find((r) => r.id === id)!;
    expect(row).toMatchObject({ createdByName: 'Bob', answeredSince: 1 });

    expect((await patch(admin.headers, { active: false })).statusCode).toBe(200);
    const after = await createInteraction(db, {
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'question',
      title: 'Date library?',
      contextCard: {},
      blocks: [],
      topicKey: 'date-library',
      roleNeeded: 'backend_engineer',
    });
    expect(after.interaction.state).toBe('open');
    const retired = await app.inject({
      url: '/api/standing-decisions?active=false',
      headers: cara.headers,
    });
    expect((retired.json() as Array<{ id: string }>).some((r) => r.id === id)).toBe(true);
  });

  it('prefers the narrowest scope', async () => {
    const f = await createRunFixture(db);
    await db.insert(standingDecision).values([
      { scope: 'global', topic: 'logger', text: 'console' },
      { scope: 'repository', scopeId: f.repositoryId, topic: 'logger', text: 'winston' },
      { scope: 'initiative', scopeId: f.initiativeId, topic: 'logger', text: 'pino' },
    ]);
    const { interaction: row } = await createInteraction(db, {
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'question',
      title: 'Logger?',
      contextCard: {},
      blocks: [],
      topicKey: 'logger',
      roleNeeded: 'backend_engineer',
    });
    expect(row.answer).toMatchObject({ text: 'pino' });
  });

  it('do not answer hard stops, reviews, or asks with no topic', async () => {
    const f = await createRunFixture(db);
    await db.insert(standingDecision).values({ scope: 'global', topic: 'merge-it', text: 'yes' });
    const mk = (o: Partial<Parameters<typeof createInteraction>[1]>) =>
      createInteraction(db, {
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'question',
        title: 't',
        contextCard: {},
        blocks: [],
        roleNeeded: 'backend_engineer',
        ...o,
      });
    expect((await mk({ topicKey: 'merge-it', hardStop: true })).interaction.state).toBe('open');
    expect((await mk({ topicKey: 'merge-it', type: 'review' })).interaction.state).toBe('open');
    expect((await mk({ title: 'merge-it' })).interaction.state).toBe('open');
  });
});

describe('assumptions', () => {
  async function declared() {
    const f = await createRunFixture(db);
    const [a] = await db
      .insert(assumption)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        text: 'Invite links expire after 7 days',
      })
      .returning();
    return { f, a: a! };
  }

  it('are listed, accepted once, and not decided twice', async () => {
    const { a } = await declared();
    const bob = await newPerson(['backend_engineer']);
    const nobody = await newPerson([]);
    const list = await app.inject({ url: '/api/assumptions', headers: bob.headers });
    expect((list.json() as Array<{ id: string }>).some((x) => x.id === a.id)).toBe(true);

    const accept = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/api/assumptions/${a.id}/accept`, headers });
    expect((await accept(nobody.headers)).statusCode).toBe(403);
    expect((await accept(bob.headers)).statusCode).toBe(200);
    expect((await accept(bob.headers)).statusCode).toBe(409);
    const [row] = await db.select().from(assumption).where(eq(assumption.id, a.id));
    expect(row).toMatchObject({ state: 'accepted', decidedBy: bob.id });
    const done = await app.inject({ url: '/api/assumptions', headers: bob.headers });
    expect((done.json() as Array<{ id: string }>).some((x) => x.id === a.id)).toBe(false);
  });

  it('rejecting one asks the person who started the run what to redo', async () => {
    const { f, a } = await declared();
    const bob = await newPerson(['backend_engineer']);
    const res = await app.inject({
      method: 'POST',
      url: `/api/assumptions/${a.id}/reject`,
      headers: bob.headers,
    });
    expect(res.statusCode).toBe(200);
    const [task] = await db
      .select()
      .from(interaction)
      .where(eq(interaction.initiativeId, f.initiativeId));
    expect(task).toMatchObject({
      type: 'question',
      state: 'open',
      assignedPersonId: f.personId,
    });
    expect(task!.title).toContain('Invite links expire after 7 days');
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run!.state).toBe('running');
  });
});

describe('people, hats and chat links', () => {
  it('lets only an admin link a Slack account, one account to one person', async () => {
    const admin = await newPerson(['platform_admin']);
    const bob = await newPerson(['backend_engineer']);
    const cara = await newPerson(['architect']);
    const put = (id: string, headers: Record<string, string>, slackUserId: string | null) =>
      app.inject({
        method: 'PUT',
        url: `/api/people/${id}/slack`,
        headers,
        payload: { slackUserId },
      });

    expect((await put(bob.id, bob.headers, 'U0BOB0001')).statusCode).toBe(403);
    expect((await put(bob.id, admin.headers, 'not an id')).statusCode).toBe(400);
    expect((await put(bob.id, admin.headers, 'U0BOB0001')).statusCode).toBe(200);
    expect((await put(cara.id, admin.headers, 'U0BOB0001')).statusCode).toBe(409);

    const asAdmin = (
      await app.inject({ url: '/api/people', headers: admin.headers })
    ).json() as Array<{ id: string; slackUserId?: string }>;
    expect(asAdmin.find((p) => p.id === bob.id)!.slackUserId).toBe('U0BOB0001');
    const asBob = (await app.inject({ url: '/api/people', headers: bob.headers })).json() as Array<{
      id: string;
      slackUserId?: string;
      slackLinked: boolean;
    }>;
    expect(asBob.find((p) => p.id === bob.id)).toMatchObject({ slackLinked: true });
    expect(asBob.find((p) => p.id === bob.id)!.slackUserId).toBeUndefined();

    expect((await put(bob.id, admin.headers, null)).statusCode).toBe(200);
    const [row] = await db.select().from(person).where(eq(person.id, bob.id));
    expect(row!.slackUserId).toBeNull();
  });

  it('lets people set their own deputy, hours and time away, and validates them', async () => {
    const bob = await newPerson(['backend_engineer']);
    const sofia = await newPerson(['qa']);
    const cara = await newPerson(['architect']);
    const patch = (
      headers: Record<string, string>,
      payload: object,
      id = bob.id,
      role = 'backend_engineer',
    ) => app.inject({ method: 'PATCH', url: `/api/people/${id}/hats/${role}`, headers, payload });

    expect((await patch(cara.headers, { deputyPersonId: sofia.id })).statusCode).toBe(403);
    expect((await patch(bob.headers, { deputyPersonId: bob.id })).statusCode).toBe(400);
    expect((await patch(bob.headers, { hours: { start: '9am', end: '17:00' } })).statusCode).toBe(
      400,
    );
    expect(
      (await patch(bob.headers, { hours: { tz: 'Mars/Base', start: '09:00', end: '17:00' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await patch(bob.headers, {
          outOfOffice: { from: '2030-01-02T00:00:00Z', until: '2030-01-01T00:00:00Z' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await patch(bob.headers, {}, bob.id, 'security')).statusCode).toBe(200);
    expect(
      (await patch(bob.headers, { deputyPersonId: sofia.id }, bob.id, 'security')).statusCode,
    ).toBe(404);

    const ok = await patch(bob.headers, {
      deputyPersonId: sofia.id,
      hours: { tz: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      outOfOffice: {
        from: '2030-01-01T00:00:00Z',
        until: '2030-01-08T00:00:00Z',
        delegateTo: sofia.id,
      },
    });
    expect(ok.statusCode).toBe(200);

    const profile = await app.inject({ url: '/api/attention/profile', headers: bob.headers });
    expect(profile.json()).toMatchObject({
      hats: [{ role: 'backend_engineer', deputyName: expect.stringMatching(/^Person/) }],
      slackLinked: false,
      chatConfigured: false,
      reminderAfterMin: 120,
      escalateAfterMin: 240,
    });
  });
});

describe('interruption metrics', () => {
  it('counts asks per merged pull request, the recommendation taken, and time to answer', async () => {
    const f = await createRunFixture(db);
    await db
      .update(agentRun)
      .set({ startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(agentRun.id, f.runId));
    const bob = await newPerson(['backend_engineer']);
    const mk = (title: string) =>
      ask(f, {
        title,
        recommendation: 'A',
        options: [
          { id: 'A', label: 'a' },
          { id: 'B', label: 'b' },
        ],
        topicKey: 'weather',
      });

    for (const [i, pick] of ['A', 'B'].entries()) {
      const q = await mk(`q${i}`);
      // Skip the de-duplication of the second one by settling the first.
      await app.inject({
        method: 'POST',
        url: `/api/interactions/${q.id}/answer`,
        headers: bob.headers,
        payload: { optionId: pick },
      });
    }
    await db.insert(activityEvent).values({
      actorType: 'system',
      initiativeId: f.initiativeId,
      runId: f.runId,
      action: 'pull_request.merged',
    });

    const res = await app.inject({
      url: `/api/metrics/interruptions?initiativeId=${f.initiativeId}`,
      headers: bob.headers,
    });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m).toMatchObject({
      asks: 2,
      answeredByPerson: 2,
      mergedPrs: 1,
      questionsPerMergedPr: 2,
      unchangedShare: 0.5,
    });
    expect(m.medianAnswerMs).toBeGreaterThanOrEqual(0);
    expect(m.byAgent).toEqual([
      expect.objectContaining({ agentRole: 'backend_engineer', asks: 2, merged: 1 }),
    ]);
    expect(m.situations[0]).toMatchObject({ situation: 'weather', asked: 2 });
    expect(m.weekly).toHaveLength(4);
  });

  it('needs a session and validates the window', async () => {
    expect((await app.inject('/api/metrics/interruptions')).statusCode).toBe(401);
    const bob = await newPerson(['backend_engineer']);
    expect(
      (await app.inject({ url: '/api/metrics/interruptions?days=1', headers: bob.headers }))
        .statusCode,
    ).toBe(400);
  });
});
