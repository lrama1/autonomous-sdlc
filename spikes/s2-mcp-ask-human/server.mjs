// Spike 2: platform MCP server with ask_human (blocking and non-blocking), check_answers, declare_assumption.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.MCP_PORT || 8801);
const interactions = new Map(); // id -> {id, question, options, recommendation, state, answer, source, waiters}
const assumptions = [];
let seq = 0;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function settle(it, answer, source) {
  if (it.state !== 'open') return;
  it.state = source === 'human' ? 'answered' : 'defaulted';
  it.answer = answer;
  it.source = source;
  clearTimeout(it.timer);
  it.waiters.forEach((w) => w());
  log('settle', it.id, it.state, JSON.stringify(answer));
}

function create(args) {
  const it = {
    id: `I-${++seq}`, ...args, state: 'open', answer: null, source: null, waiters: [],
    created: Date.now(),
  };
  if (args.default_after_s) {
    it.timer = setTimeout(() => settle(it, args.recommendation, 'default'), args.default_after_s * 1000);
  }
  interactions.set(it.id, it);
  log('create', it.id, args.blocking ? 'blocking' : 'non-blocking', JSON.stringify(args.question));
  return it;
}

function buildServer() {
  const s = new McpServer({ name: 'platform', version: '0.0.1' });

  s.registerTool('ask_human', {
    description: 'Ask a person a question or decision. Provide options and a recommendation. ' +
      'blocking=true waits for the answer. blocking=false returns an interaction id at once so you can keep working; ' +
      'collect the answer later with check_answers. If default_after_s elapses, the recommendation is applied.',
    inputSchema: {
      question: z.string(),
      options: z.array(z.string()).optional(),
      recommendation: z.string().optional(),
      blocking: z.boolean().default(true),
      default_after_s: z.number().optional(),
    },
  }, async (args) => {
    const it = create(args);
    if (!args.blocking) {
      return { content: [{ type: 'text', text: JSON.stringify({ interaction_id: it.id, status: 'open', note: 'continue with other work; call check_answers later' }) }] };
    }
    await new Promise((r) => it.waiters.push(r));
    return { content: [{ type: 'text', text: JSON.stringify({ interaction_id: it.id, status: it.state, answer: it.answer, source: it.source }) }] };
  });

  s.registerTool('check_answers', {
    description: 'Return the state of all interactions you opened (open, answered, defaulted).',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify([...interactions.values()].map((i) => ({ id: i.id, state: i.state, answer: i.answer, source: i.source }))) }],
  }));

  s.registerTool('declare_assumption', {
    description: 'Record an assumption you made instead of asking.',
    inputSchema: { text: z.string() },
  }, async ({ text }) => {
    assumptions.push(text);
    log('assumption', text);
    return { content: [{ type: 'text', text: 'recorded' }] };
  });

  return s;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/answer' && req.method === 'POST') {
    let b = ''; for await (const c of req) b += c;
    const { id, answer } = JSON.parse(b);
    const it = interactions.get(id);
    if (!it) { res.statusCode = 404; return res.end('no such interaction'); }
    settle(it, answer, 'human');
    return res.end('ok');
  }
  if (url.pathname === '/state') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ interactions: [...interactions.values()].map(({ waiters, timer, ...r }) => r), assumptions }));
  }
  if (url.pathname === '/mcp') {
    let body;
    if (req.method === 'POST') { let b = ''; for await (const c of req) b += c; body = JSON.parse(b); }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }
  res.statusCode = 404; res.end();
}).listen(PORT, '127.0.0.1', () => log('platform MCP on', PORT));
