import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  bugReport,
  costRecord,
  createDb,
  createRunFixture,
  initiative,
  interaction,
  person,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { portfolio } from './portfolio.js';
import { MemorySecrets } from './secrets.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

async function newPerson() {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `p${k}@example.test`, oidcSubject: `p${k}` })
    .returning();
  return p!;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-portfolio-'));
  devDb = await startDevDb({ dataDir, port: 56349 });
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
    secrets: new MemorySecrets(),
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await devDb?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('the portfolio', () => {
  it('shows each initiative with its stage, spend, bugs, last activity and release', async () => {
    const who = await newPerson();
    const f = await createRunFixture(db);
    await db
      .update(initiative)
      .set({ title: 'Portfolio shop', budgetMicros: 5_000_000 })
      .where(eq(initiative.id, f.initiativeId));
    await db.insert(costRecord).values({
      runId: f.runId,
      initiativeId: f.initiativeId,
      source: 'agent',
      alias: 'agent-default',
      providerModel: 'anthropic/claude-sonnet-4.6',
      costMicros: 1_250_000,
    });
    await db.insert(bugReport).values([
      { initiativeId: f.initiativeId, title: 'Open one', description: 'x', reportedBy: who.id },
      {
        initiativeId: f.initiativeId,
        title: 'Fixed one',
        description: 'x',
        reportedBy: who.id,
        state: 'fixed',
      },
    ]);
    await db.insert(activityEvent).values({
      actorType: 'system',
      initiativeId: f.initiativeId,
      action: 'release.published',
      detail: { version: '1.2.0', tag: 'v1.2.0', url: 'https://example.test/r' },
    });

    const cookie = `sdlc_session=${app.signCookie(`${who.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`;
    const res = await app.inject({ method: 'GET', url: '/api/portfolio', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Awaited<ReturnType<typeof portfolio>>;
    const row = body.initiatives.find((i) => i.id === f.initiativeId)!;
    expect(row).toMatchObject({
      title: 'Portfolio shop',
      spentUsd: 1.25,
      budgetUsd: 5,
      openBugs: 1,
      lastRelease: { version: '1.2.0' },
    });
    expect(row.stage).not.toBeNull();
    expect(new Date(row.lastActivityAt).getTime()).toBeGreaterThan(0);
    // The Portfolio groups an app's initiatives and lists them oldest first, so it needs to know when each was made.
    expect(new Date(row.createdAt).getTime()).toBeGreaterThan(0);
    expect(body.releases.find((r) => r.initiativeId === f.initiativeId)).toMatchObject({
      version: '1.2.0',
      tag: 'v1.2.0',
      url: 'https://example.test/r',
      initiativeTitle: 'Portfolio shop',
    });
  });

  it('puts what waits on a person first, and counts open asks', async () => {
    const f = await createRunFixture(db);
    await db.insert(interaction).values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'checkpoint',
      checkpointId: 'G1',
      title: 'Approve the spec',
      roleNeeded: 'product_owner',
    });
    const { initiatives } = await portfolio(db);
    const row = initiatives.find((i) => i.id === f.initiativeId)!;
    expect(row.openAsks).toBe(1);
    expect(row.stage).toMatchObject({ id: 'spec', status: 'waiting_human' });
    expect(row.stage?.waitingOn).toContain('product_owner');
    const firstOthers = initiatives.findIndex((i) => i.stage?.status !== 'waiting_human');
    const lastWaiting = initiatives.map((i) => i.stage?.status).lastIndexOf('waiting_human');
    expect(firstOthers === -1 || lastWaiting < firstOthers).toBe(true);
  });

  it('needs a signed-in person', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/portfolio' })).statusCode).toBe(401);
  });
});
