import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
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
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { attentionTick } from './attention.js';
import { loadConfig } from './config.js';
import { createInteraction } from './interactions.js';
import { SlackClient, SlackNotifier, renderSlack, verifySlackSignature } from './slack.js';

const SECRET = 'slack-signing-secret-for-tests';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let made: ReturnType<typeof createDb>;
let cfg: ReturnType<typeof loadConfig>;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let fake: http.Server;
let fakeBase: string;
let posted: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = [];
let n = 0;

function sign(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return {
    'x-slack-request-timestamp': String(ts),
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
}

async function click(
  slackUser: string,
  action: { action_id: string; value?: string },
  o: { ts?: number; secret?: string } = {},
) {
  const payload = JSON.stringify({
    type: 'block_actions',
    user: { id: slackUser },
    response_url: `${fakeBase}/response/${++n}`,
    actions: [action],
  });
  const body = `payload=${encodeURIComponent(payload)}`;
  const res = await app.inject({
    method: 'POST',
    url: '/slack/interactions',
    headers: sign(body, o.ts, o.secret),
    payload: body,
  });
  // Slack is answered before the replies are posted, so give them a moment.
  await new Promise((r) => setTimeout(r, 50));
  return { res, replies: posted.filter((p) => p.path.startsWith('/response/')) };
}

async function newPerson(roles: string[], slackUserId?: string) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({
      displayName: `Person ${k}`,
      email: `s${k}@example.test`,
      oidcSubject: `s${k}`,
      slackUserId: slackUserId ?? null,
    })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return p!;
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
    options: [
      { id: 'A', label: 'Free tier' },
      { id: 'B', label: 'Paid' },
    ],
    recommendation: 'A',
    blocks: [{ runId: f.runId }],
    roleNeeded: 'backend_engineer',
    ...o,
  });
  return row;
}

const answerValue = (id: string, o: string) => JSON.stringify({ i: id, o });
const reload = async (id: string) =>
  (await db.select().from(interaction).where(eq(interaction.id, id)))[0]!;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      posted.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, channel: 'D123', ts: '1700000000.000100' }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-slack-'));
  devDb = await startDevDb({ dataDir, port: 56341 });
  await runMigrations(devDb.url);
  made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  cfg = loadConfig({
    DATABASE_URL: devDb.url,
    OIDC_ISSUER: 'http://localhost:9000',
    OIDC_CLIENT_ID: 'x',
    OIDC_CLIENT_SECRET: 'x',
    SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_API_URL: `${fakeBase}/api`,
  });
  app = await buildApp({
    config: cfg,
    deps: made,
    workers: false,
  });
  await app.ready();
}, 180_000);

beforeEach(async () => {
  posted = [];
  await db.update(interaction).set({ state: 'withdrawn' }).where(eq(interaction.state, 'open'));
  await db.delete(notification);
  await db.delete(hat);
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await devDb?.stop();
  await new Promise((r) => fake?.close(r));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('verifySlackSignature', () => {
  const body = 'payload=%7B%7D';
  const ts = 1_800_000_000;
  const good = sign(body, ts)['x-slack-signature'];
  it('accepts a request signed with the secret, within five minutes', () => {
    expect(verifySlackSignature(SECRET, String(ts), good, body, ts * 1000 + 60_000)).toBe(true);
  });
  it('refuses a wrong secret, a changed body, a stale request, and missing headers', () => {
    expect(verifySlackSignature('other', String(ts), good, body, ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), good, `${body}x`, ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), good, body, ts * 1000 + 6 * 60_000)).toBe(
      false,
    );
    expect(verifySlackSignature(SECRET, undefined, good, body, ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), undefined, body, ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), 'v0=short', body, ts * 1000)).toBe(false);
  });
});

describe('what is sent to Slack', () => {
  it('gives each option a button, marks the recommendation, and always links to the Workspace', () => {
    const msg = renderSlack({
      kind: 'ask',
      urgency: 'now',
      interactionId: '11111111-1111-4111-8111-111111111111',
      title: 'Which provider?',
      type: 'decision',
      options: [
        { id: 'A', label: 'Free tier' },
        { id: 'B', label: 'Paid' },
      ],
      recommendation: 'A',
      chat: true,
      link: 'http://localhost:5173/#/queue/x',
      blocksCount: 1,
    });
    const buttons = (
      msg.blocks as Array<{ type: string; elements?: Array<Record<string, unknown>> }>
    )
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements ?? []);
    expect(buttons.map((b) => b.action_id)).toEqual([
      'ask.answer.0',
      'ask.answer.1',
      'ask.open',
      'ask.snooze',
    ]);
    expect(buttons[0]).toMatchObject({ style: 'primary' });
    expect(JSON.parse(buttons[1]!.value as string)).toEqual({
      i: '11111111-1111-4111-8111-111111111111',
      o: 'B',
    });
    expect(buttons[2]).toMatchObject({ url: 'http://localhost:5173/#/queue/x' });
  });

  it('offers only the Workspace for what chat may not settle, and no snooze for a hard stop', () => {
    const msg = renderSlack({
      kind: 'ask',
      urgency: 'now',
      interactionId: '11111111-1111-4111-8111-111111111111',
      title: 'Protected path changed',
      type: 'decision',
      hardStop: true,
      options: [{ id: 'allow', label: 'Allow' }],
      chat: false,
      link: 'http://x/#/queue',
    });
    const ids = (msg.blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>)
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements ?? [])
      .map((e) => e.action_id);
    expect(ids).toEqual(['ask.open']);
  });

  it('delivers through the Web API with the bot token, and skips people who are not linked', async () => {
    const linked = await newPerson(['backend_engineer'], 'U0LINKED01');
    const f = await createRunFixture(db);
    await ask(f);
    const client = new SlackClient('xoxb-test-token', `${fakeBase}/api`);
    await attentionTick({
      db,
      policy: DEFAULT_ATTENTION_POLICY,
      notifier: new SlackNotifier(client),
      publicUrl: 'http://localhost:5173',
      independentReview: true,
    });
    const call = posted.find((p) => p.path === '/api/chat.postMessage')!;
    expect(call.auth).toBe('Bearer xoxb-test-token');
    expect(call.body.channel).toBe('U0LINKED01');
    const [row] = await db.select().from(notification).where(eq(notification.personId, linked.id));
    expect(row).toMatchObject({ status: 'sent', channel: 'slack' });
    expect(row!.externalRef).toMatchObject({ channel: 'D123', ts: '1700000000.000100' });

    // A second person without a link is recorded as skipped, not as an error.
    await db.update(interaction).set({ state: 'withdrawn' });
    await db.delete(hat);
    const unlinked = await newPerson(['backend_engineer']);
    await ask(f);
    posted = [];
    await attentionTick({
      db,
      policy: DEFAULT_ATTENTION_POLICY,
      notifier: new SlackNotifier(client),
      publicUrl: 'http://localhost:5173',
      independentReview: true,
    });
    expect(posted.filter((p) => p.path === '/api/chat.postMessage')).toHaveLength(0);
    const [skipped] = await db
      .select()
      .from(notification)
      .where(eq(notification.personId, unlinked.id));
    expect(skipped).toMatchObject({ status: 'skipped' });
    expect(skipped!.error).toMatch(/Slack/);
  });
});

describe('answering from Slack', () => {
  it('refuses a request that was not signed by Slack', async () => {
    const body = `payload=${encodeURIComponent('{}')}`;
    const unsigned = await app.inject({
      method: 'POST',
      url: '/slack/interactions',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    const stale = await click(
      'U1',
      { action_id: 'ask.answer.0', value: '{}' },
      { ts: 1_000_000_000 },
    );
    expect(stale.res.statusCode).toBe(401);
    const forged = await click(
      'U1',
      { action_id: 'ask.answer.0', value: '{}' },
      { secret: 'nope' },
    );
    expect(forged.res.statusCode).toBe(401);
  });

  it('settles a decision from a button, as the linked person, and says so in the log', async () => {
    const bob = await newPerson(['backend_engineer'], 'U0BOB0001');
    const f = await createRunFixture(db);
    const q = await ask(f);

    const { res, replies } = await click('U0BOB0001', {
      action_id: 'ask.answer.0',
      value: answerValue(q.id, 'A'),
    });
    expect(res.statusCode).toBe(200);

    const row = await reload(q.id);
    expect(row).toMatchObject({ state: 'answered', answeredBy: bob.id, answeredVia: 'slack' });
    expect(row.answer).toMatchObject({ text: 'A: Free tier', choice: 'A', source: 'human' });
    const log = await db.select().from(activityEvent).where(eq(activityEvent.interactionId, q.id));
    expect(log.find((l) => l.action === 'interaction.answered')?.detail).toMatchObject({
      via: 'slack',
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(replies[0]!.body)).toContain('Free tier');
  });

  it('can save the answer as a standing decision, once, and only for the person who gave it', async () => {
    const bob = await newPerson(['backend_engineer'], 'U0BOB0002');
    await newPerson(['backend_engineer'], 'U0BOB0003');
    const f = await createRunFixture(db);
    const q = await ask(f, { topicKey: 'weather-provider' });
    await click('U0BOB0002', { action_id: 'ask.answer.1', value: answerValue(q.id, 'B') });

    const other = await click('U0BOB0003', {
      action_id: 'ask.standing',
      value: JSON.stringify({ i: q.id }),
    });
    expect(other.replies.at(-1)!.body.text).toMatch(/Only the person who answered/);
    expect(
      await db
        .select()
        .from(standingDecision)
        .where(eq(standingDecision.createdFromInteractionId, q.id)),
    ).toHaveLength(0);

    await click('U0BOB0002', { action_id: 'ask.standing', value: JSON.stringify({ i: q.id }) });
    const [sd] = await db
      .select()
      .from(standingDecision)
      .where(eq(standingDecision.createdFromInteractionId, q.id));
    expect(sd).toMatchObject({ topic: 'weather-provider', text: 'B: Paid', createdBy: bob.id });

    await click('U0BOB0002', { action_id: 'ask.standing', value: JSON.stringify({ i: q.id }) });
    expect(
      await db
        .select()
        .from(standingDecision)
        .where(eq(standingDecision.createdFromInteractionId, q.id)),
    ).toHaveLength(1);
  });

  it('ignores a Slack user nobody linked', async () => {
    await newPerson(['backend_engineer']);
    const f = await createRunFixture(db);
    const q = await ask(f);
    const { replies } = await click('U0STRANGER', {
      action_id: 'ask.answer.0',
      value: answerValue(q.id, 'A'),
    });
    expect((await reload(q.id)).state).toBe('open');
    expect(replies.at(-1)!.body.text).toMatch(/not linked/);
    expect(replies.at(-1)!.body.response_type).toBe('ephemeral');
  });

  it('applies the same role check as the Workspace', async () => {
    await newPerson(['backend_engineer']);
    await newPerson(['product_owner'], 'U0ALICE001');
    const f = await createRunFixture(db);
    const q = await ask(f);
    const { replies } = await click('U0ALICE001', {
      action_id: 'ask.answer.0',
      value: answerValue(q.id, 'A'),
    });
    expect((await reload(q.id)).state).toBe('open');
    expect(replies.at(-1)!.body.text).toMatch(/not addressed to you/);
  });

  it('says so when it was already answered, and does not answer twice', async () => {
    await newPerson(['backend_engineer'], 'U0BOB0004');
    await newPerson(['backend_engineer'], 'U0BOB0005');
    const f = await createRunFixture(db);
    const q = await ask(f);
    await click('U0BOB0004', { action_id: 'ask.answer.0', value: answerValue(q.id, 'A') });
    const late = await click('U0BOB0005', {
      action_id: 'ask.answer.1',
      value: answerValue(q.id, 'B'),
    });
    expect(late.replies.at(-1)!.body.text).toMatch(/already answered/);
    expect((await reload(q.id)).answer).toMatchObject({ choice: 'A' });
  });

  it('never settles a checkpoint, a hard stop, or a triggered review from chat', async () => {
    await newPerson(['backend_engineer'], 'U0BOB0006');
    const f = await createRunFixture(db);
    const cases = [
      await ask(f, { type: 'checkpoint', checkpointId: 'G1', title: 'spec' }),
      await ask(f, { hardStop: true, title: 'stop' }),
      await ask(f, {
        type: 'review',
        title: 'pr',
        options: undefined,
        contextCard: { triggers: [{ id: 'new-dependency' }] },
      }),
    ];
    for (const q of cases) {
      const { replies } = await click('U0BOB0006', {
        action_id: 'ask.decide.approved',
        value: JSON.stringify({ i: q.id, d: 'approved' }),
      });
      expect((await reload(q.id)).state).toBe('open');
      expect(replies.at(-1)!.body.text).toMatch(/needs the Workspace/);
    }
  });

  it('approves a low-risk review from chat when the team allows it, but not for the person who started the run', async () => {
    // The team has allowed chat approval of reviews that fired no trigger.
    const open = await buildApp({
      config: cfg,
      deps: made,
      workers: false,
      policy: { ...DEFAULT_ATTENTION_POLICY, chatApprove: ['question', 'decision', 'review'] },
    });
    await open.ready();
    const f = await createRunFixture(db);
    await db.update(person).set({ slackUserId: 'U0SPONSOR1' }).where(eq(person.id, f.personId));
    await db.insert(hat).values({ personId: f.personId, role: 'backend_engineer' });
    await newPerson(['backend_engineer'], 'U0REVIEW01');
    const review = await ask(f, { type: 'review', title: 'pr', options: undefined, blocks: [] });

    const clickOn = async (user: string) => {
      const payload = JSON.stringify({
        type: 'block_actions',
        user: { id: user },
        response_url: `${fakeBase}/response/${++n}`,
        actions: [
          {
            action_id: 'ask.decide.approved',
            value: JSON.stringify({ i: review.id, d: 'approved' }),
          },
        ],
      });
      const body = `payload=${encodeURIComponent(payload)}`;
      await open.inject({
        method: 'POST',
        url: '/slack/interactions',
        headers: sign(body),
        payload: body,
      });
      await new Promise((r) => setTimeout(r, 50));
    };

    await clickOn('U0SPONSOR1');
    expect((await reload(review.id)).state).toBe('open');
    expect(posted.at(-1)!.body.text).toMatch(/started or steered/);

    await clickOn('U0REVIEW01');
    expect(await reload(review.id)).toMatchObject({ state: 'answered', answeredVia: 'slack' });
    expect((await reload(review.id)).answer).toMatchObject({ decision: 'approved' });
    await open.close();
  });
  it('snoozes from chat, but not a hard stop', async () => {
    await newPerson(['backend_engineer'], 'U0BOB0007');
    const f = await createRunFixture(db);
    const q = await ask(f);
    const stop = await ask(f, { hardStop: true, title: 'stop' });
    await click('U0BOB0007', { action_id: 'ask.snooze', value: JSON.stringify({ i: q.id }) });
    const until = (await reload(q.id)).snoozedUntil!.getTime() - Date.now();
    expect(until).toBeGreaterThan(110 * 60_000);
    await click('U0BOB0007', { action_id: 'ask.snooze', value: JSON.stringify({ i: stop.id }) });
    expect((await reload(stop.id)).snoozedUntil).toBeNull();
  });

  it('only posts replies to Slack hosts', async () => {
    const client = new SlackClient('t', `${fakeBase}/api`, ['hooks.slack.com']);
    await expect(
      client.respond('https://evil.example/steal', { text: 'x', blocks: [] }),
    ).rejects.toThrow(/Refusing/);
    await expect(
      client.respond('http://hooks.slack.com/x', { text: 'x', blocks: [] }),
    ).rejects.toThrow(/Refusing/);
  });
});
