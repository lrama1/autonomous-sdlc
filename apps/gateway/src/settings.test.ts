import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { costRecord, createDb, createRunFixture, modelSetting, runMigrations } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { internalKey } from '@sdlc/core';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { gatewayConfigSchema, parseEnv } from '@sdlc/schemas';
import { createGatewayServer } from './app.js';

// A model a Platform Admin picked on the Settings page, read from the table by the real gateway, with a fake provider.

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let upstream: http.Server;
let gateway: http.Server;
let gw: string;
let received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
let respond: (res: http.ServerResponse) => void;

const answer = (res: http.ServerResponse) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      model: 'x',
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    }),
  );
};

const call = async (token: string, alias: string) => {
  const res = await fetch(`${gw}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ model: alias, max_tokens: 10, messages: [] }),
  });
  await res.text();
  return res;
};

const testCall = (model: string, key?: string) =>
  fetch(`${gw}/internal/model-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-sdlc-internal': key } : {}) },
    body: JSON.stringify({ model }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-gw-settings-'));
  devDb = await startDevDb({ dataDir, port: 56358 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();

  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
    });
    respond(res);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const config = parseEnv(gatewayConfigSchema, {
    DATABASE_URL: devDb.url,
    OPENROUTER_KEY_AGENTS: 'sk-or-real-provider-key',
    UPSTREAM_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  });
  gateway = createGatewayServer({ db, config, aliasCacheMs: 0, log: () => {} });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  gw = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise((r) => gateway?.close(r));
  await new Promise((r) => upstream?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

beforeEach(async () => {
  received = [];
  respond = answer;
  await db.delete(modelSetting);
});

describe('a model chosen on the Settings page', () => {
  it('uses the built-in default when nothing is saved', async () => {
    const f = await createRunFixture(db);
    expect((await call(f.token, 'agent-default')).status).toBe(200);
    expect(received[0]!.body.model).toBe('anthropic/claude-sonnet-5.5');
  });

  it('is what the alias means from the next call, and is priced as that model', async () => {
    const f = await createRunFixture(db);
    await db
      .insert(modelSetting)
      .values({ alias: 'agent-default', model: 'anthropic/claude-opus-4.8' });
    expect((await call(f.token, 'agent-default')).status).toBe(200);
    expect(received[0]!.body.model).toBe('anthropic/claude-opus-4.8');
    const [rec] = await db.select().from(costRecord).where(eq(costRecord.runId, f.runId));
    expect(rec).toMatchObject({
      alias: 'agent-default',
      providerModel: 'anthropic/claude-opus-4.8',
    });
    // Opus: 1000 * 5 + 100 * 25 micro-USD
    expect(rec!.costMicros).toBe(7500);
  });

  it('is ignored when the model has no price, so cost is never recorded as zero', async () => {
    const f = await createRunFixture(db, { scopes: ['gateway', 'alias:agent-strong'] });
    await db.insert(modelSetting).values({ alias: 'agent-strong', model: 'openai/gpt-4o' });
    expect((await call(f.token, 'agent-strong')).status).toBe(200);
    expect(received[0]!.body.model).toBe('anthropic/claude-sonnet-5.5');
  });

  it('does not add an alias that does not exist', async () => {
    const f = await createRunFixture(db);
    await db
      .insert(modelSetting)
      .values({ alias: 'agent-extra', model: 'anthropic/claude-opus-4.8' });
    expect((await call(f.token, 'agent-extra')).status).toBe(403);
    expect(received).toHaveLength(0);
  });
});

describe('the model test', () => {
  const key = () => internalKey(devDb.url);

  it('refuses a caller without the platform key', async () => {
    expect((await testCall('anthropic/claude-haiku-4.5')).status).toBe(401);
    expect((await testCall('anthropic/claude-haiku-4.5', 'guess')).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('refuses a model with no price', async () => {
    expect((await testCall('openai/gpt-4o', key())).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('asks one tiny question with the real key and the provider pinned, and reports the cost', async () => {
    const res = await testCall('anthropic/claude-haiku-4.5', key());
    const body = (await res.json()) as { ok: boolean; answer: string; costMicros: number };
    expect(body).toMatchObject({ ok: true, answer: 'OK' });
    // Haiku: 1000 * 1 + 100 * 5 micro-USD
    expect(body.costMicros).toBe(1500);
    expect(received[0]!.headers.authorization).toBe('Bearer sk-or-real-provider-key');
    expect(received[0]!.body).toMatchObject({
      model: 'anthropic/claude-haiku-4.5',
      max_tokens: 16,
      provider: { order: ['anthropic'], allow_fallbacks: false },
    });
  });

  it('says what the provider said when it refuses', async () => {
    respond = (res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'No endpoints found for this model' } }));
    };
    const body = (await (await testCall('anthropic/claude-haiku-4.5', key())).json()) as {
      ok: boolean;
      status: number;
      error: string;
    };
    expect(body).toMatchObject({ ok: false, status: 404 });
    expect(body.error).toContain('No endpoints');
  });
});
