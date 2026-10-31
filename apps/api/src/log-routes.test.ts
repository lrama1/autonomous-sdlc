import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  addRunToFixture,
  agentRun,
  appendRunEvent,
  buildPlan,
  buildTask,
  createDb,
  createRunFixture,
  hat,
  interaction,
  person,
  pruneRunSteps,
  runEvent,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

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
    .values({ displayName: `Person ${k}`, email: `l${k}@example.test`, oidcSubject: `l${k}` })
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
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-log-'));
  devDb = await startDevDb({ dataDir, port: 56370 });
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

type Headers = Record<string, string>;
const log = (headers: Headers | undefined, query = '') =>
  app.inject({ method: 'GET', url: `/api/log${query}`, headers });

describe('the live log', () => {
  it('needs a person with a role', async () => {
    expect((await log(undefined)).statusCode).toBe(401);
    const nobody = await newPerson([]);
    const res = await log(nobody.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('wrong_role');
  });

  it('keeps secrets out of the events when they are written, so nothing reads them back', async () => {
    const f = await createRunFixture(db);
    const who = await newPerson(['backend_engineer']);
    await appendRunEvent(db, f.runId, 'tool.call', {
      name: 'Bash',
      input: 'curl -H "Authorization: Bearer abcdef0123456789xyz" https://api.example.test',
    });
    await appendRunEvent(db, f.runId, 'tool.result', {
      ok: true,
      summary: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 set',
    });
    const [stored] = await db.select().from(runEvent).where(eq(runEvent.runId, f.runId));
    expect(JSON.stringify(stored!.payload)).not.toContain('abcdef0123456789xyz');
    const res = (await log(who.headers, `?runId=${f.runId}`)).json();
    const text = JSON.stringify(res.events);
    expect(text).not.toContain('abcdef0123456789xyz');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(text).toContain('[redacted]');
    // What is not secret is kept as it was.
    expect(res.events[0].payload.name).toBe('Bash');
  });

  it('also redacts events that were stored before redaction existed', async () => {
    const f = await createRunFixture(db);
    const who = await newPerson(['backend_engineer']);
    // Written straight into the table, the way an old row would be.
    await db.insert(runEvent).values({
      runId: f.runId,
      seq: 1,
      type: 'tool.result',
      payload: { summary: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG' },
    });
    const res = (await log(who.headers, `?runId=${f.runId}`)).json();
    expect(JSON.stringify(res.events)).not.toContain('wJalrXUtnFEMI');
    const old = await app.inject({
      method: 'GET',
      url: `/api/runs/${f.runId}/events`,
      headers: who.headers,
    });
    expect(JSON.stringify(old.json())).not.toContain('wJalrXUtnFEMI');
  });

  it('gives the latest events first, then only what is newer, and says when there is more', async () => {
    const f = await createRunFixture(db);
    const who = await newPerson(['frontend_engineer']);
    for (let k = 1; k <= 7; k++) await appendRunEvent(db, f.runId, 'message', { text: `m${k}` });
    const first = (await log(who.headers, `?runId=${f.runId}&limit=3`)).json();
    // The latest three, oldest of them first.
    expect(first.events.map((e: { payload: { text: string } }) => e.payload.text)).toEqual([
      'm5',
      'm6',
      'm7',
    ]);
    expect(first.more).toBe(false);
    const cursor = first.events.at(-1).gid as number;
    expect((await log(who.headers, `?runId=${f.runId}&after=${cursor}`)).json().events).toEqual([]);

    for (let k = 8; k <= 12; k++) await appendRunEvent(db, f.runId, 'message', { text: `m${k}` });
    const next = (await log(who.headers, `?runId=${f.runId}&after=${cursor}&limit=3`)).json();
    expect(next.events.map((e: { payload: { text: string } }) => e.payload.text)).toEqual([
      'm8',
      'm9',
      'm10',
    ]);
    expect(next.more).toBe(true);
    const rest = (
      await log(who.headers, `?runId=${f.runId}&after=${next.events.at(-1).gid}&limit=3`)
    ).json();
    expect(rest.events.map((e: { payload: { text: string } }) => e.payload.text)).toEqual([
      'm11',
      'm12',
    ]);
    expect(rest.more).toBe(false);
  });

  it('interleaves the runs of an initiative in the order things happened, and names each run and its task', async () => {
    const f = await createRunFixture(db);
    const second = await addRunToFixture(db, f, { agentRole: 'frontend_engineer' });
    const who = await newPerson(['product_owner']);
    const [design] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'review',
        checkpointId: 'G1',
        state: 'answered',
        title: 'Design',
        roleNeeded: 'architect',
        contextCard: { kind: 'pull_request', prNumber: 1 },
      })
      .returning();
    const [plan] = await db
      .insert(buildPlan)
      .values({
        initiativeId: f.initiativeId,
        designInteractionId: design!.id,
        designPath: 'docs/design/x.md',
        designSha: 'abc',
        state: 'active',
        startedBy: f.personId,
      })
      .returning();
    await db.insert(buildTask).values({
      planId: plan!.id,
      key: 'T2',
      position: 0,
      title: 'The page',
      role: 'frontend_engineer',
      state: 'running',
      runId: second.runId,
    });
    await appendRunEvent(db, f.runId, 'message', { text: 'a1' });
    await appendRunEvent(db, second.runId, 'message', { text: 'b1' });
    await appendRunEvent(db, f.runId, 'message', { text: 'a2' });

    const res = (await log(who.headers, `?initiativeId=${f.initiativeId}`)).json();
    expect(res.events.map((e: { payload: { text: string } }) => e.payload.text)).toEqual([
      'a1',
      'b1',
      'a2',
    ]);
    const byId = new Map(res.runs.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(second.runId)).toMatchObject({
      role: 'frontend_engineer',
      taskKey: 'T2',
      taskTitle: 'The page',
      state: 'running',
    });
    expect(byId.get(f.runId)).toMatchObject({ role: 'backend_engineer', taskKey: null });
    // Another initiative's events are not in it.
    const other = await createRunFixture(db);
    await appendRunEvent(db, other.runId, 'message', { text: 'elsewhere' });
    expect(
      JSON.stringify((await log(who.headers, `?initiativeId=${f.initiativeId}`)).json()),
    ).not.toContain('elsewhere');
    expect(JSON.stringify((await log(who.headers)).json())).toContain('elsewhere');
  });
});

describe('dropping old agent steps', () => {
  it('drops the steps of finished runs older than the limit, and nothing the platform reads', async () => {
    const done = await createRunFixture(db, { state: 'succeeded' });
    const live = await createRunFixture(db, { state: 'running' });
    for (const id of [done.runId, live.runId]) {
      await appendRunEvent(db, id, 'tool.call', { name: 'Read' });
      await appendRunEvent(db, id, 'message', { text: 'hello' });
      await appendRunEvent(db, id, 'run.summary', { text: 'done' });
    }
    const age = (runId: string, days: number) =>
      db.execute(
        sql`update run_event set ts = now() - make_interval(days => ${days}) where run_id = ${runId}`,
      );
    await age(done.runId, 45);
    await age(live.runId, 45);
    const left = async (runId: string) =>
      (await db.select({ t: runEvent.type }).from(runEvent).where(eq(runEvent.runId, runId))).map(
        (r) => r.t,
      );

    expect(await pruneRunSteps(db, 30)).toBeGreaterThanOrEqual(2);
    // The finished run keeps its summary, and loses its steps.
    expect(await left(done.runId)).toEqual(['run.summary']);
    // A run that is still going keeps everything, however old.
    expect((await left(live.runId)).sort()).toEqual(['message', 'run.summary', 'tool.call']);
    // Steps that are younger than the limit stay.
    await appendRunEvent(db, done.runId, 'message', { text: 'recent' });
    expect(await pruneRunSteps(db, 30)).toBe(0);
    expect(await left(done.runId)).toContain('message');
    void agentRun;
  });
});
