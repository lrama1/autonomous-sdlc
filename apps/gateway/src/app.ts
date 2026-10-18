import http from 'node:http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  CALLABLE_STATES,
  activityEvent,
  agentRun,
  authenticateRunToken,
  bearerFrom,
  costRecord,
} from '@sdlc/db';
import type { Db, RunContext } from '@sdlc/db';
import { costMicros } from '@sdlc/core';
import { healthSchema } from '@sdlc/schemas';
import type { GatewayConfig } from '@sdlc/schemas';
import { addCacheBreakpoints } from './cache.js';
import { SseMeter, usageFromJson } from './metering.js';
import { loadSettings } from './settings.js';
import type { Settings } from './settings.js';

export const VERSION = '0.0.0';

export interface GatewayDeps {
  db: Db;
  config: GatewayConfig;
  settings?: Settings;
  fetchImpl?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
}

// Request headers that are safe to pass on. Everything else (cookies, the caller's token) is dropped.
const FORWARD_REQUEST_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta'];
// Response headers worth keeping. Transfer framing is recomputed by Node.
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'request-id'];

const ALLOWED = new Set(['POST /v1/messages', 'POST /v1/messages/count_tokens']);

function anthropicError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createGatewayServer(deps: GatewayDeps): http.Server {
  const { db, config } = deps;
  const settings = deps.settings ?? loadSettings(config);
  const doFetch = deps.fetchImpl ?? fetch;
  const log =
    deps.log ?? ((e) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e })));
  const maxBytes = config.GATEWAY_MAX_BODY_MB * 1024 * 1024;

  async function overBudget(run: RunContext): Promise<boolean> {
    if (run.costMicros < run.budgetMicros) return false;
    // Only move a live run. A run that already finished keeps its state.
    const moved = await db
      .update(agentRun)
      .set({ state: 'budget_exceeded', exitReason: 'budget', finishedAt: new Date() })
      .where(and(eq(agentRun.id, run.runId), inArray(agentRun.state, [...CALLABLE_STATES])))
      .returning({ id: agentRun.id });
    if (moved.length > 0) {
      await db.insert(activityEvent).values({
        actorType: 'system',
        runId: run.runId,
        initiativeId: run.initiativeId,
        action: 'run.budget_exceeded',
        detail: { costMicros: run.costMicros, budgetMicros: run.budgetMicros },
      });
    }
    return true;
  }

  async function record(
    run: RunContext,
    alias: string,
    model: string,
    meter: SseMeter,
    status: number,
    startedAt: number,
  ): Promise<void> {
    const u = meter.usage;
    if (u.inputTokens + u.cacheWriteTokens + u.cachedTokens + u.outputTokens === 0) return;
    const cost = costMicros(settings.prices[model], u, model);
    await db.transaction(async (tx) => {
      await tx.insert(costRecord).values({
        runId: run.runId,
        initiativeId: run.initiativeId,
        source: 'agent',
        alias,
        providerModel: model,
        inputTokens: u.inputTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        cachedTokens: u.cachedTokens,
        outputTokens: u.outputTokens,
        costMicros: cost,
        httpStatus: status,
        latencyMs: Date.now() - startedAt,
      });
      await tx
        .update(agentRun)
        .set({ costMicros: sql`${agentRun.costMicros} + ${cost}` })
        .where(eq(agentRun.id, run.runId));
    });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path === '/healthz') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          healthSchema.parse({
            status: 'ok',
            service: 'gateway',
            version: VERSION,
            time: new Date().toISOString(),
          }),
        ),
      );
      return;
    }
    // Claude Code probes HEAD / at start-up.
    if (path === '/' && (method === 'HEAD' || method === 'GET')) {
      res.statusCode = 200;
      res.end();
      return;
    }
    if (!ALLOWED.has(`${method} ${path}`)) {
      anthropicError(
        res,
        404,
        'not_found_error',
        `${method} ${path} is not served by this gateway`,
      );
      return;
    }

    const run = await authenticateRunToken(db, bearerFrom(req.headers));
    if (!run || !run.scopes.includes('gateway')) {
      anthropicError(res, 401, 'authentication_error', 'invalid or expired run token');
      return;
    }
    if (!CALLABLE_STATES.has(run.state)) {
      anthropicError(res, 403, 'permission_error', `run is ${run.state}`);
      return;
    }

    const raw = await readBody(req, maxBytes);
    if (!raw) {
      anthropicError(res, 413, 'request_too_large', 'request body is too large');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      anthropicError(res, 400, 'invalid_request_error', 'body is not valid JSON');
      return;
    }

    // Only aliases are accepted, never raw provider model ids.
    const alias = typeof body.model === 'string' ? body.model : '';
    const model = settings.aliases[alias];
    if (!model || !run.scopes.includes(`alias:${alias}`)) {
      anthropicError(
        res,
        403,
        'permission_error',
        `model alias "${alias}" is not allowed for this run`,
      );
      return;
    }

    if (await overBudget(run)) {
      anthropicError(res, 402, 'budget_exceeded', 'the run budget has been used up');
      return;
    }

    body.model = model;
    if (path === '/v1/messages') {
      body.provider = settings.provider;
      addCacheBreakpoints(body);
    } else delete body.provider;

    const headers: Record<string, string> = {
      authorization: `Bearer ${config.OPENROUTER_KEY_AGENTS}`,
      'content-type': 'application/json',
    };
    for (const name of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === 'string') headers[name] = v;
    }

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const startedAt = Date.now();
    const meter = new SseMeter();
    let status = 502;
    let recorded = false;
    const recordOnce = async (): Promise<void> => {
      if (recorded || path !== '/v1/messages') return;
      recorded = true;
      await record(run, alias, model, meter, status, startedAt).catch((e) =>
        log({ level: 'error', msg: 'could not record cost', runId: run.runId, error: String(e) }),
      );
    };

    try {
      const up = await doFetch(config.UPSTREAM_URL + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      status = up.status;
      res.statusCode = up.status;
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const v = up.headers.get(name);
        if (v) res.setHeader(name, v);
      }

      const streaming = (up.headers.get('content-type') ?? '').includes('text/event-stream');
      const decoder = new TextDecoder();
      let jsonText = '';
      if (up.body) {
        for await (const chunk of up.body) {
          if (!res.write(chunk)) await new Promise<void>((r) => res.once('drain', r));
          if (path === '/v1/messages') {
            const text = decoder.decode(chunk, { stream: true });
            if (streaming) meter.push(text);
            else jsonText += text;
          }
        }
      }
      if (streaming) meter.finish();
      else if (path === '/v1/messages' && up.ok) meter.usage = usageFromJson(jsonText).usage;
      // Record before the last byte goes out, so the caller's next request already sees this cost.
      await recordOnce();
      res.end();
    } catch (e) {
      if (!abort.signal.aborted) {
        log({
          level: 'error',
          msg: 'upstream failure',
          runId: run.runId,
          error: e instanceof Error ? e.message : String(e),
        });
        anthropicError(res, 502, 'api_error', 'the model provider could not be reached');
      }
    } finally {
      // Tokens already streamed are billed even if the client hung up or the stream broke, so always record.
      await recordOnce();
      log({
        level: 'info',
        msg: 'call',
        runId: run.runId,
        alias,
        model,
        status,
        ms: Date.now() - startedAt,
        in: meter.usage.inputTokens + meter.usage.cacheWriteTokens + meter.usage.cachedTokens,
        out: meter.usage.outputTokens,
      });
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log({ level: 'error', msg: 'unhandled', error: e instanceof Error ? e.message : String(e) });
      anthropicError(res, 500, 'api_error', 'internal gateway error');
    });
  });
}
