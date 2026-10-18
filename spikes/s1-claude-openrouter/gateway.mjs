// Spike 1: thin Model Gateway between Claude Code and OpenRouter.
// Checks a per-run token, maps aliases, injects provider preferences,
// streams the response through unchanged, and meters tokens from the SSE stream.
import http from 'node:http';

const UPSTREAM = 'https://openrouter.ai/api';
const REAL_KEY = process.env.OPENROUTER_API_KEY;
const PORT = Number(process.env.GW_PORT || 8787);

const ALIASES = {
  'agent-default': 'anthropic/claude-haiku-4.5',
  'agent-fast': 'anthropic/claude-haiku-4.5',
  'agent-strong': 'anthropic/claude-sonnet-4.6',
};

const PROVIDER = JSON.parse(process.env.GW_PROVIDER ||
  '{"order":["anthropic"],"allow_fallbacks":false,"data_collection":"deny"}');

// run token -> run record (in memory for the spike)
const runs = new Map([
  ['run-tok-1', { runId: 'run-1', allowed: Object.keys(ALIASES), usage: { in: 0, out: 0, calls: 0 } }],
  ['run-tok-narrow', { runId: 'run-2', allowed: ['agent-fast'], usage: { in: 0, out: 0, calls: 0 } }],
]);

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function meterSse(run, text) {
  // Anthropic SSE: message_start carries input tokens, message_delta carries output tokens
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(line.slice(5));
      if (ev.type === 'message_start') {
        const u = ev.message?.usage || {};
        run.usage.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        run.usage.calls += 1;
      } else if (ev.type === 'message_delta') {
        run.usage.out = run.usage.out + (ev.usage?.output_tokens || 0);
      }
    } catch { /* partial line, ignore */ }
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('502', e.message, e.cause?.message || '');
    if (!res.headersSent) res.statusCode = 502;
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'gateway upstream failure' } }));
  });
});

async function handle(req, res) {
  if (req.url === '/_usage') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(Object.fromEntries([...runs].map(([k, v]) => [k, v.usage]))));
  }

  const tok = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
  const run = runs.get(tok);
  if (!run) {
    log('401', req.method, req.url);
    res.statusCode = 401;
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad run token' } }));
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = Buffer.concat(chunks);
  let isMessages = req.url.startsWith('/v1/messages') && req.method === 'POST';

  if (isMessages) {
    const json = JSON.parse(body.toString('utf8'));
    const alias = json.model;
    const real = ALIASES[alias] || alias;
    if (ALIASES[alias] && !run.allowed.includes(alias)) {
      log('403 alias not allowed', alias);
      res.statusCode = 403;
      return res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: `alias ${alias} not allowed for this run` } }));
    }
    json.model = real;
    json.provider = PROVIDER;
    body = Buffer.from(JSON.stringify(json));
    log('->', req.url.split('?')[0], alias, '=>', real, 'stream=' + !!json.stream, 'tools=' + (json.tools?.length || 0));
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'content-length', 'authorization', 'x-api-key', 'connection', 'expect', 'keep-alive', 'upgrade', 'te', 'transfer-encoding'].includes(k)) continue;
    headers[k] = v;
  }
  headers['authorization'] = `Bearer ${REAL_KEY}`;
  headers['content-type'] = 'application/json';

  const up = await fetch(UPSTREAM + req.url, {
    method: req.method,
    headers,
    body: req.method === 'GET' ? undefined : body,
  });

  res.statusCode = up.status;
  for (const [k, v] of up.headers) {
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) continue;
    res.setHeader(k, v);
  }

  if (!up.body) return res.end();
  const dec = new TextDecoder();
  let tail = '';
  for await (const chunk of up.body) {
    res.write(chunk);
    if (isMessages) {
      tail += dec.decode(chunk, { stream: true });
      const i = tail.lastIndexOf('\n');
      if (i >= 0) { meterSse(run, tail.slice(0, i)); tail = tail.slice(i + 1); }
    }
  }
  if (isMessages && tail) meterSse(run, tail);
  res.end();
  if (up.status >= 400) log('upstream', up.status, req.url);
}

server.listen(PORT, '127.0.0.1', () => log('gateway on', PORT, 'provider prefs', JSON.stringify(PROVIDER)));
