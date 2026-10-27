import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activityEvent, createDb, hat, modelSetting, person, runMigrations } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { internalKey } from '@sdlc/core';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { loadAgents } from './agents.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const agentsDir = fileURLToPath(new URL('../../../agents', import.meta.url));

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let fakeGateway: http.Server;
let gatewayCalls: Array<{ key: string | undefined; body: { model?: string } }> = [];
let gatewayAnswer: object = { ok: true, answer: 'OK', ms: 420, costMicros: 1500 };
let n = 0;

async function login(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `P${k}`, email: `p${k}@example.test`, oidcSubject: `p${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    name: `P${k}`,
    cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
  };
}
const as = (cookie: string) => ({ cookie });

beforeAll(async () => {
  fakeGateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const key = req.headers['x-sdlc-internal'];
    gatewayCalls.push({
      key: typeof key === 'string' ? key : undefined,
      body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(gatewayAnswer));
  });
  await new Promise<void>((r) => fakeGateway.listen(0, '127.0.0.1', r));

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-settings-'));
  devDb = await startDevDb({ dataDir, port: 56357 });
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
      GATEWAY_URL: `http://127.0.0.1:${(fakeGateway.address() as AddressInfo).port}`,
    }),
    deps: made,
    workers: false,
    agents: await loadAgents(agentsDir),
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await new Promise((r) => fakeGateway?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

beforeEach(async () => {
  gatewayCalls = [];
  gatewayAnswer = { ok: true, answer: 'OK', ms: 420, costMicros: 1500 };
  await db.delete(modelSetting);
});

type View = {
  aliases: Array<{
    alias: string;
    model: string;
    defaultModel: string;
    usedBy: string[];
    changedBy: string | null;
  }>;
  models: Array<{ id: string }>;
};

describe('reading the model settings', () => {
  it('needs a session', async () => {
    expect((await app.inject('/api/settings/models')).statusCode).toBe(401);
  });

  it('shows the three aliases with their defaults, who uses them, and the models to choose from', async () => {
    const eng = await login(['backend_engineer']);
    const res = await app.inject({ url: '/api/settings/models', headers: as(eng.cookie) });
    expect(res.statusCode).toBe(200);
    const v = res.json() as View;
    expect(v.aliases.map((a) => a.alias)).toEqual(['agent-fast', 'agent-default', 'agent-strong']);
    const byAlias = Object.fromEntries(v.aliases.map((a) => [a.alias, a]));
    expect(byAlias['agent-default']).toMatchObject({
      model: 'anthropic/claude-sonnet-5.5',
      changedBy: null,
    });
    expect(byAlias['agent-default']!.usedBy).toContain('backend-engineer');
    expect(byAlias['agent-strong']!.usedBy).toContain('security-agent');
    expect(v.models.map((m) => m.id)).toContain('anthropic/claude-opus-4.8');
  });
});

describe('changing a model', () => {
  const put = (cookie: string, alias: string, model: string) =>
    app.inject({
      method: 'PUT',
      url: `/api/settings/models/${alias}`,
      headers: as(cookie),
      payload: { model },
    });

  it('is for a Platform Admin only', async () => {
    const eng = await login(['backend_engineer']);
    expect((await put(eng.cookie, 'agent-default', 'anthropic/claude-opus-4.8')).statusCode).toBe(
      403,
    );
    expect(await db.select().from(modelSetting)).toHaveLength(0);
  });

  it('keeps the choice, shows who made it, and logs the old and new model', async () => {
    const admin = await login(['platform_admin']);
    const res = await put(admin.cookie, 'agent-default', 'anthropic/claude-opus-4.8');
    expect(res.statusCode).toBe(200);
    const a = (res.json() as View).aliases.find((x) => x.alias === 'agent-default')!;
    expect(a).toMatchObject({
      model: 'anthropic/claude-opus-4.8',
      defaultModel: 'anthropic/claude-sonnet-5.5',
      changedBy: admin.name,
    });
    const [row] = await db
      .select()
      .from(modelSetting)
      .where(eq(modelSetting.alias, 'agent-default'));
    expect(row).toMatchObject({ model: 'anthropic/claude-opus-4.8', updatedBy: admin.id });
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'settings.model_changed'));
    expect(log.find((l) => l.actorId === admin.id)?.detail).toEqual({
      alias: 'agent-default',
      from: 'anthropic/claude-sonnet-5.5',
      to: 'anthropic/claude-opus-4.8',
    });
  });

  it('can change a choice again, and put the default back', async () => {
    const admin = await login(['platform_admin']);
    await put(admin.cookie, 'agent-fast', 'anthropic/claude-sonnet-5');
    const res = await put(admin.cookie, 'agent-fast', 'anthropic/claude-haiku-4.5');
    const a = (res.json() as View).aliases.find((x) => x.alias === 'agent-fast')!;
    expect(a.model).toBe(a.defaultModel);
    expect(await db.select().from(modelSetting)).toHaveLength(1);
  });

  it('refuses a model that is not on the list, and an alias that does not exist', async () => {
    const admin = await login(['platform_admin']);
    const bad = await put(admin.cookie, 'agent-default', 'openai/gpt-4o');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('unsupported_model');
    expect((await put(admin.cookie, 'agent-extra', 'anthropic/claude-opus-4.8')).statusCode).toBe(
      400,
    );
    expect(await db.select().from(modelSetting)).toHaveLength(0);
  });
});

describe('testing a model', () => {
  const test = (cookie: string, model: string) =>
    app.inject({
      method: 'POST',
      url: '/api/settings/models/test',
      headers: as(cookie),
      payload: { model },
    });

  it('is for a Platform Admin only, and a listed model only', async () => {
    const eng = await login(['backend_engineer']);
    expect((await test(eng.cookie, 'anthropic/claude-haiku-4.5')).statusCode).toBe(403);
    const admin = await login(['platform_admin']);
    expect((await test(admin.cookie, 'openai/gpt-4o')).statusCode).toBe(400);
    expect(gatewayCalls).toHaveLength(0);
  });

  it('asks the gateway with the platform key and passes its answer on, and logs the test', async () => {
    const admin = await login(['platform_admin']);
    const res = await test(admin.cookie, 'anthropic/claude-opus-4.8');
    expect(res.json()).toEqual({ ok: true, answer: 'OK', ms: 420, costMicros: 1500 });
    expect(gatewayCalls).toEqual([
      { key: internalKey(devDb.url), body: { model: 'anthropic/claude-opus-4.8' } },
    ]);
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'settings.model_tested'));
    expect(log.find((l) => l.actorId === admin.id)?.detail).toMatchObject({
      model: 'anthropic/claude-opus-4.8',
      ok: true,
    });
  });

  it('passes on a refusal from the provider', async () => {
    gatewayAnswer = { ok: false, status: 404, error: 'No endpoints found for this model' };
    const admin = await login(['platform_admin']);
    const res = await test(admin.cookie, 'anthropic/claude-sonnet-4.6');
    expect(res.json()).toMatchObject({ ok: false, error: expect.stringContaining('No endpoints') });
  });
});
