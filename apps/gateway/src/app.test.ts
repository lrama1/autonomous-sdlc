import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  agentRun,
  costRecord,
  createDb,
  createRunFixture,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { gatewayConfigSchema, parseEnv } from '@sdlc/schemas';
import { createGatewayServer } from './app.js';

// Real PostgreSQL, a fake model provider, and the real gateway on a random port.

const sse = (usageStart: object, usageEnd: object) => [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', model: 'anthropic/claude-haiku-4.5', usage: usageStart } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usageEnd })}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let upstream: http.Server;
let gateway: http.Server;
let gw: string;
let received: Array<{
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  url: string;
}> = [];
let respond: (res: http.ServerResponse) => void | Promise<void>;

const FIRST = {
  input_tokens: 100,
  cache_creation_input_tokens: 2000,
  cache_read_input_tokens: 10000,
  output_tokens: 1,
};
const LAST = {
  input_tokens: 100,
  cache_creation_input_tokens: 2000,
  cache_read_input_tokens: 10000,
  output_tokens: 500,
};
// 100*1 + 2000*1.25 + 10000*0.1 + 500*5 micro-USD
const EXPECTED_COST = 6100;

function post(
  token: string | undefined,
  body: object,
  urlPath = '/v1/messages',
  extra: Record<string, string> = {},
) {
  return fetch(gw + urlPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-gw-'));
  devDb = await startDevDb({ dataDir, port: 56331 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();

  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({
      headers: req.headers,
      url: req.url ?? '',
      body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
    });
    await respond(res);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const config = parseEnv(gatewayConfigSchema, {
    DATABASE_URL: devDb.url,
    OPENROUTER_KEY_AGENTS: 'sk-or-real-provider-key',
    UPSTREAM_URL: upstreamUrl,
  });
  gateway = createGatewayServer({
    db,
    config,
    log: (e) => {
      if (e.level === 'error' || process.env.GW_DEBUG) console.log(JSON.stringify(e));
    },
  });
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

beforeEach(() => {
  received = [];
  respond = (res) => {
    res.setHeader('content-type', 'text/event-stream');
    for (const part of sse(FIRST, LAST)) res.write(part);
    res.end();
  };
});

describe('authentication', () => {
  it('rejects a missing token', async () => {
    expect((await post(undefined, { model: 'agent-default', messages: [] })).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    expect((await post('sdlc_nope', { model: 'agent-default', messages: [] })).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const f = await createRunFixture(db, { tokenTtlMs: -1000 });
    expect((await post(f.token, { model: 'agent-default', messages: [] })).status).toBe(401);
  });

  it('rejects a revoked token', async () => {
    const f = await createRunFixture(db, { revoked: true });
    expect((await post(f.token, { model: 'agent-default', messages: [] })).status).toBe(401);
  });

  it('rejects a token that lacks the gateway scope', async () => {
    const f = await createRunFixture(db, { scopes: ['mcp'] });
    expect((await post(f.token, { model: 'agent-default', messages: [] })).status).toBe(401);
  });

  it('does not serve other paths', async () => {
    const f = await createRunFixture(db);
    const r = await fetch(`${gw}/v1/models`, { headers: { authorization: `Bearer ${f.token}` } });
    expect(r.status).toBe(404);
  });

  it('answers the HEAD / probe and /healthz without a token', async () => {
    expect((await fetch(gw, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(`${gw}/healthz`)).status).toBe(200);
  });
});

describe('aliases and the run state', () => {
  it('rejects an alias the token does not allow', async () => {
    const f = await createRunFixture(db, { scopes: ['gateway', 'alias:agent-fast'] });
    const r = await post(f.token, { model: 'agent-strong', messages: [] });
    expect(r.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('rejects a raw provider model id', async () => {
    const f = await createRunFixture(db);
    const r = await post(f.token, { model: 'anthropic/claude-opus-4.8', messages: [] });
    expect(r.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it.each(['paused', 'parked', 'succeeded', 'cancelled'])(
    'refuses calls from a %s run',
    async (state) => {
      const f = await createRunFixture(db, { state });
      expect((await post(f.token, { model: 'agent-default', messages: [] })).status).toBe(403);
      expect(received).toHaveLength(0);
    },
  );
});

describe('forwarding', () => {
  it('maps the alias, pins the provider, and swaps in the real key', async () => {
    const f = await createRunFixture(db);
    const res = await post(
      f.token,
      {
        model: 'agent-default',
        max_tokens: 10,
        stream: true,
        messages: [],
        provider: { order: ['amazon-bedrock'] },
      },
      '/v1/messages',
      { cookie: 'secret=1', 'anthropic-beta': 'tools-2026' },
    );
    await res.text();
    expect(received).toHaveLength(1);
    const up = received[0]!;
    expect(up.url).toBe('/v1/messages');
    expect(up.body.model).toBe('anthropic/claude-haiku-4.5');
    expect(up.body.provider).toEqual({
      order: ['anthropic'],
      allow_fallbacks: false,
      data_collection: 'deny',
    });
    expect(up.headers.authorization).toBe('Bearer sk-or-real-provider-key');
    expect(up.headers['anthropic-beta']).toBe('tools-2026');
    expect(up.headers.cookie).toBeUndefined();
    expect(JSON.stringify(up.headers)).not.toContain(f.token);
  });

  it('streams the response through byte for byte', async () => {
    const f = await createRunFixture(db);
    const res = await post(f.token, { model: 'agent-default', stream: true, messages: [] });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe(sse(FIRST, LAST).join(''));
  });

  it('passes an upstream error through and records no cost', async () => {
    respond = (res) => {
      res.statusCode = 429;
      res.setHeader('content-type', 'application/json');
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
    };
    const f = await createRunFixture(db);
    const res = await post(f.token, { model: 'agent-default', messages: [] });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { type: 'rate_limit_error' } });
    expect(await db.select().from(costRecord).where(eq(costRecord.runId, f.runId))).toHaveLength(0);
  });

  it('returns 502 when the provider is unreachable, with no fallback', async () => {
    const f = await createRunFixture(db);
    const config = parseEnv(gatewayConfigSchema, {
      DATABASE_URL: devDb.url,
      OPENROUTER_KEY_AGENTS: 'k',
      UPSTREAM_URL: 'http://127.0.0.1:1',
    });
    const dead = createGatewayServer({ db, config, log: () => {} });
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agent-default', messages: [] }),
    });
    expect(r.status).toBe(502);
    await new Promise((res) => dead.close(res));
  });
});

describe('metering and budget', () => {
  it('records tokens and cost from a streamed call, using the final totals', async () => {
    const f = await createRunFixture(db);
    await (await post(f.token, { model: 'agent-default', stream: true, messages: [] })).text();
    const rows = await db.select().from(costRecord).where(eq(costRecord.runId, f.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'agent',
      alias: 'agent-default',
      providerModel: 'anthropic/claude-haiku-4.5',
      inputTokens: 100,
      cacheWriteTokens: 2000,
      cachedTokens: 10000,
      outputTokens: 500,
      costMicros: EXPECTED_COST,
    });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run!.costMicros).toBe(EXPECTED_COST);
  });

  it('meters a non-streaming response', async () => {
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'm',
          model: 'anthropic/claude-haiku-4.5',
          content: [],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      );
    };
    const f = await createRunFixture(db);
    await (await post(f.token, { model: 'agent-default', messages: [] })).text();
    const [row] = await db.select().from(costRecord).where(eq(costRecord.runId, f.runId));
    expect(row).toMatchObject({ inputTokens: 10, outputTokens: 20, costMicros: 10 + 100 });
  });

  it('adds up several calls', async () => {
    const f = await createRunFixture(db);
    for (let i = 0; i < 3; i++)
      await (await post(f.token, { model: 'agent-default', stream: true, messages: [] })).text();
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run!.costMicros).toBe(EXPECTED_COST * 3);
  });

  it('still records what was streamed when the client hangs up early', async () => {
    respond = async (res) => {
      res.setHeader('content-type', 'text/event-stream');
      const parts = sse(FIRST, LAST);
      res.write(parts[0]!);
      res.write(parts[1]!);
      await new Promise((r) => setTimeout(r, 400));
      res.write(parts[2]!);
      res.end();
    };
    const f = await createRunFixture(db);
    const ac = new AbortController();
    const res = await fetch(`${gw}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agent-default', stream: true, messages: [] }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await db.select().from(costRecord).where(eq(costRecord.runId, f.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(100);
  });

  it('answers 402 once the budget is used, stops the run, and logs it', async () => {
    const f = await createRunFixture(db, { budgetMicros: 5000, costMicros: 5000 });
    const r = await post(f.token, { model: 'agent-default', messages: [] });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: { type: 'budget_exceeded' } });
    expect(received).toHaveLength(0);
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run).toMatchObject({ state: 'budget_exceeded', exitReason: 'budget' });
    const log = await db.select().from(activityEvent).where(eq(activityEvent.runId, f.runId));
    expect(log.map((l) => l.action)).toEqual(['run.budget_exceeded']);
  });

  it('lets a call through while under budget, then blocks the next one', async () => {
    const f = await createRunFixture(db, { budgetMicros: 6000 });
    expect(
      await post(f.token, { model: 'agent-default', stream: true, messages: [] }).then((r) =>
        r.text().then(() => r.status),
      ),
    ).toBe(200);
    expect(
      (await post(f.token, { model: 'agent-default', stream: true, messages: [] })).status,
    ).toBe(402);
  });
});
