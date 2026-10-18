import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  agentRun,
  costRecord,
  createDb,
  createRunFixture,
  initiative,
  person,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { checkBudgetAlert, costReport } from './costs.js';
import { MemorySecrets } from './secrets.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

const budget = { monthlyBudgetUsd: 0, alertPercent: 80 };
const NOW = new Date('2026-10-18T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

/** A fresh initiative and run, with cost records: [dollars, daysAgo, alias, tokens...]. */
async function spend(
  role: string,
  records: Array<{
    usd: number;
    ago: number;
    alias?: string;
    model?: string;
    cached?: number;
    input?: number;
  }>,
  o: { budgetUsd?: number; title?: string } = {},
) {
  const f = await createRunFixture(db);
  await db
    .update(agentRun)
    .set({ agentRole: role, task: `Task for ${role}\nmore` })
    .where(eq(agentRun.id, f.runId));
  await db
    .update(initiative)
    .set({
      title: o.title ?? `Initiative ${++n}`,
      budgetMicros: o.budgetUsd === undefined ? null : o.budgetUsd * 1_000_000,
    })
    .where(eq(initiative.id, f.initiativeId));
  for (const r of records) {
    await db.insert(costRecord).values({
      runId: f.runId,
      initiativeId: f.initiativeId,
      source: 'agent',
      alias: r.alias ?? 'agent-default',
      providerModel: r.model ?? 'anthropic/claude-sonnet-4.6',
      inputTokens: r.input ?? 1000,
      cacheWriteTokens: 0,
      cachedTokens: r.cached ?? 0,
      outputTokens: 100,
      costMicros: Math.round(r.usd * 1_000_000),
      createdAt: daysAgo(r.ago),
    });
  }
  return f;
}

async function signedIn() {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `c${k}@example.test`, oidcSubject: `c${k}` })
    .returning();
  return {
    cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-costs-'));
  devDb = await startDevDb({ dataDir, port: 56348 });
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
      MONTHLY_BUDGET_USD: '100',
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
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('the cost report', () => {
  it('adds up spend by day, initiative, role, model and run, for one initiative', async () => {
    const f = await spend(
      'backend_engineer',
      [
        { usd: 0.5, ago: 1, cached: 3000 },
        { usd: 0.25, ago: 1, alias: 'agent-fast', model: 'anthropic/claude-haiku-4.5' },
        { usd: 0.1, ago: 5 },
        { usd: 9, ago: 60 },
      ],
      { budgetUsd: 10, title: 'Report me' },
    );
    const r = await costReport(db, { days: 30, initiativeId: f.initiativeId, budget, now: NOW });
    expect(r.initiativeId).toBe(f.initiativeId);
    expect(r.totals).toMatchObject({
      costUsd: 0.85,
      calls: 3,
      runs: 1,
      cachedTokens: 3000,
      inputTokens: 3000,
      outputTokens: 300,
    });
    expect(r.totals.cacheReadShare).toBeCloseTo(0.5);
    expect(r.byDay).toEqual([
      { day: '2026-10-13', costUsd: 0.1, calls: 1 },
      { day: '2026-10-17', costUsd: 0.75, calls: 2 },
    ]);
    expect(r.byInitiative).toEqual([
      expect.objectContaining({
        id: f.initiativeId,
        title: 'Report me',
        costUsd: 0.85,
        allTimeUsd: 9.85,
        budgetUsd: 10,
        runs: 1,
      }),
    ]);
    expect(r.byInitiative[0]!.percentOfBudget).toBeCloseTo(98.5);
    expect(r.byRole).toEqual([
      { role: 'backend_engineer', costUsd: 0.85, runs: 1, avgPerRunUsd: 0.85 },
    ]);
    expect(r.byModel.map((m) => [m.alias, m.costUsd, m.calls])).toEqual([
      ['agent-default', 0.6, 2],
      ['agent-fast', 0.25, 1],
    ]);
    expect(r.topRuns).toEqual([
      expect.objectContaining({
        id: f.runId,
        role: 'backend_engineer',
        title: 'Task for backend_engineer',
        costUsd: 0.85,
      }),
    ]);
    // A longer window brings in the old record.
    const wide = await costReport(db, { days: 90, initiativeId: f.initiativeId, budget, now: NOW });
    expect(wide.totals.costUsd).toBe(9.85);
  });

  it('covers every initiative when none is chosen, ranked by cost', async () => {
    const small = await spend('product', [{ usd: 0.01, ago: 0 }], { title: 'Small' });
    const big = await spend(
      'architect',
      [
        { usd: 3, ago: 0 },
        { usd: 2, ago: 0 },
      ],
      { title: 'Big' },
    );
    const r = await costReport(db, { days: 7, initiativeId: null, budget, now: NOW });
    const ids = r.byInitiative.map((i) => i.id);
    expect(ids.indexOf(big.initiativeId)).toBeLessThan(ids.indexOf(small.initiativeId));
    expect(r.byRole.find((x) => x.role === 'architect')).toMatchObject({
      costUsd: 5,
      runs: 1,
      avgPerRunUsd: 5,
    });
    expect(r.topRuns[0]!.costUsd).toBeGreaterThanOrEqual(r.topRuns.at(-1)!.costUsd);
  });
});

describe('the monthly budget', () => {
  it('compares this month with the budget, and warns once at 80% and once at 100%', async () => {
    const cfg = { monthlyBudgetUsd: 50, alertPercent: 80 };
    const at = new Date('2031-03-15T10:00:00Z');
    // March 2031 has no other spend, so this sets the whole month.
    const f = await createRunFixture(db);
    const add = (usd: number) =>
      db.insert(costRecord).values({
        runId: f.runId,
        initiativeId: f.initiativeId,
        source: 'agent',
        alias: 'agent-default',
        providerModel: 'anthropic/claude-sonnet-4.6',
        costMicros: usd * 1_000_000,
        createdAt: at,
      });
    await add(20);
    expect(await checkBudgetAlert(db, cfg, at)).toBeNull();
    await add(25);
    expect(await checkBudgetAlert(db, cfg, at)).toBe('warning');
    expect(await checkBudgetAlert(db, cfg, at)).toBeNull();
    await add(10);
    expect(await checkBudgetAlert(db, cfg, at)).toBe('exceeded');
    expect(await checkBudgetAlert(db, cfg, at)).toBeNull();
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'budget.alert'));
    expect(
      log
        .filter((l) => (l.detail as { month: string }).month === '2031-03-01')
        .map((l) => (l.detail as { level: string }).level)
        .sort(),
    ).toEqual(['exceeded', 'warning']);
    expect(await checkBudgetAlert(db, { monthlyBudgetUsd: 0, alertPercent: 80 }, at)).toBeNull();
  });
});

describe('the cost routes', () => {
  it('needs a signed-in person, validates the window, and returns the report', async () => {
    const who = await signedIn();
    expect((await app.inject({ method: 'GET', url: '/api/costs' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/costs?days=0', headers: who })).statusCode,
    ).toBe(400);
    const res = await app.inject({ method: 'GET', url: '/api/costs?days=30', headers: who });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ days: 30, monthly: { budgetUsd: 100, alertPercent: 80 } });
    const b = await app.inject({ method: 'GET', url: '/api/costs/budget', headers: who });
    expect(b.json()).toMatchObject({
      budgetUsd: 100,
      level: expect.stringMatching(/ok|warning|exceeded/),
    });
    expect((await app.inject({ method: 'GET', url: '/api/costs/budget' })).statusCode).toBe(401);
  });
});
