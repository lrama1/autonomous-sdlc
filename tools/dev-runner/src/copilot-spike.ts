/* eslint-disable @typescript-eslint/no-explicit-any -- throwaway spike code that reads untyped JSONL */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDb, createRunFixture } from '@sdlc/db';
import { startStack } from './stack.js';

// Spike: can the GitHub Copilot CLI be a second engine behind the same AgentEngine port?
//   node --import tsx src/copilot-spike.ts
// Throwaway. It prints what it finds. Needs the OPENROUTER_API_KEY that the gateway uses.

const say = (m: string) => console.log(m);
const out = (label: string, v: unknown) =>
  say(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const stack = await startStack({
  dataDir: path.join(os.tmpdir(), `sdlc-copilot-spike-${Date.now()}`),
  log: () => {},
});
const { db, pool } = createDb(stack.databaseUrl);
const raw = new pg.Client(stack.databaseUrl);
await raw.connect();

// The npm shim is a script, so run the loader with node directly: no shell, and no quoting problems.
const COPILOT_JS = path.join(
  execFileSync('npm', ['root', '-g'], { shell: process.platform === 'win32' })
    .toString()
    .trim(),
  '@github',
  'copilot',
  'npm-loader.js',
);

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runCopilot(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs = 180_000,
): Promise<Result> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [COPILOT_JS, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

const jsonLines = (s: string) =>
  s
    .split(/\r?\n/)
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, any>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, any> => x !== null);

async function newRun() {
  const f = await createRunFixture(db, {
    scopes: ['gateway', 'mcp', 'alias:agent-fast', 'alias:agent-default'],
    budgetMicros: 1_000_000,
  });
  return f;
}

const cost = async (runId: string) =>
  (
    await raw.query(
      'select count(*)::int n, coalesce(sum(input_tokens),0)::int i, coalesce(sum(output_tokens),0)::int o, coalesce(sum(cost_micros),0)::int c from cost_record where run_id = $1',
      [runId],
    )
  ).rows[0];

const home = await mkdtemp(path.join(os.tmpdir(), 'copilot-home-'));
const baseEnv = (token: string): Record<string, string> => ({
  COPILOT_HOME: home,
  COPILOT_PROVIDER_TYPE: 'anthropic',
  COPILOT_PROVIDER_BASE_URL: stack.gatewayUrl,
  COPILOT_PROVIDER_BEARER_TOKEN: token,
  COPILOT_MODEL: 'agent-fast',
  COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '120000',
  COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '8000',
  // Make sure nothing the person is signed in with can be used by accident.
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  COPILOT_GITHUB_TOKEN: '',
  NO_COLOR: '1',
});

try {
  // ---------------------------------------------------------------- T1: one prompt through the gateway
  say('T1  headless prompt, BYOK through the Model Gateway, no GitHub sign-in');
  const f1 = await newRun();
  const dir1 = await mkdtemp(path.join(os.tmpdir(), 'cp-t1-'));
  const t1 = await runCopilot(
    [
      '-p',
      'Reply with exactly the word PONG and nothing else.',
      '--allow-all-tools',
      '--output-format',
      'json',
      '--log-level',
      'error',
    ],
    baseEnv(f1.token),
    dir1,
  );
  out('exit', t1.code);
  out('seconds', Math.round(t1.ms / 1000));
  const ev1 = jsonLines(t1.stdout);
  out('jsonl lines', ev1.length);
  out('event types', [...new Set(ev1.map((e) => e.type))]);
  out('stdout head', t1.stdout.slice(0, 600).replace(/\s+/g, ' '));
  out('stderr head', t1.stderr.slice(0, 400).replace(/\s+/g, ' '));
  out('gateway cost records', await cost(f1.runId));

  // ---------------------------------------------------------------- T2: edit files and commit
  say('T2  edits a file and commits, with the tool allowlist');
  const f2 = await newRun();
  const dir2 = await mkdtemp(path.join(os.tmpdir(), 'cp-t2-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir2 });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir2 });
  execFileSync('git', ['config', 'user.name', 'agent'], { cwd: dir2 });
  await writeFile(path.join(dir2, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '.'], { cwd: dir2 });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir2 });
  const t2 = await runCopilot(
    [
      '-p',
      'Create a file hello.txt containing the single line "hello from copilot", then run git add and git commit -m "add hello". Do nothing else.',
      '--allow-all-tools',
      '--output-format',
      'json',
      '--log-level',
      'error',
    ],
    baseEnv(f2.token),
    dir2,
  );
  out('exit', t2.code);
  out('seconds', Math.round(t2.ms / 1000));
  out('hello.txt', await readFile(path.join(dir2, 'hello.txt'), 'utf8').catch(() => 'MISSING'));
  out(
    'git log',
    execFileSync('git', ['log', '--oneline'], { cwd: dir2 }).toString().trim().split('\n'),
  );
  const ev2 = jsonLines(t2.stdout);
  out('event types', [...new Set(ev2.map((e) => e.type))]);
  out('gateway cost records', await cost(f2.runId));
  await writeFile(path.join(os.tmpdir(), 'copilot-spike-t2.jsonl'), t2.stdout);

  // ---------------------------------------------------------------- T3: platform MCP tools
  say('T3  the platform MCP server over HTTP with the run token');
  const f3 = await newRun();
  const dir3 = await mkdtemp(path.join(os.tmpdir(), 'cp-t3-'));
  const mcp = {
    mcpServers: {
      platform: {
        type: 'http',
        url: `http://127.0.0.1:${new URL(stack.apiUrl).port}/mcp`,
        headers: { Authorization: `Bearer ${f3.token}` },
        tools: ['*'],
      },
    },
  };
  const t3 = await runCopilot(
    [
      '-p',
      'Call the ask_human tool once with blocking set to false, question "Which greeting do you prefer?", options [{"id":"hello","label":"Hello"},{"id":"howdy","label":"Howdy"}], recommendation "hello", topicKey "spike-greeting". Then say DONE.',
      '--allow-all-tools',
      '--additional-mcp-config',
      JSON.stringify(mcp),
      '--output-format',
      'json',
      '--log-level',
      'error',
    ],
    baseEnv(f3.token),
    dir3,
  );
  out('exit', t3.code);
  out('seconds', Math.round(t3.ms / 1000));
  const asked = await raw.query(
    'select id, title, state, options, recommendation, topic_key from interaction where run_id = $1',
    [f3.runId],
  );
  out(
    'interactions raised',
    asked.rows.map((r) => ({
      title: r.title,
      state: r.state,
      topic: r.topic_key,
      rec: r.recommendation,
    })),
  );
  const ev3 = jsonLines(t3.stdout);
  out('event types', [...new Set(ev3.map((e) => e.type))]);
  out(
    'tool-ish events',
    ev3
      .filter((e) => /tool/i.test(String(e.type)))
      .slice(0, 6)
      .map((e) => JSON.stringify(e).slice(0, 260)),
  );
  await writeFile(path.join(os.tmpdir(), 'copilot-spike-t3.jsonl'), t3.stdout);
  out('t3 stderr', t3.stderr.slice(0, 300).replace(/\s+/g, ' '));

  // ---------------------------------------------------------------- T4: resume a session by id
  say('T4  a second invocation resumes the same session');
  const f4 = await newRun();
  const dir4 = await mkdtemp(path.join(os.tmpdir(), 'cp-t4-'));
  const sid = '0190a000-0000-7000-8000-' + String(Date.now()).padStart(12, '0').slice(-12);
  const a = await runCopilot(
    [
      '-p',
      'Remember the codename ZEBRA-4417. Reply only: STORED.',
      '--allow-all-tools',
      '--session-id',
      sid,
      '--output-format',
      'json',
      '--log-level',
      'error',
    ],
    baseEnv(f4.token),
    dir4,
  );
  const b = await runCopilot(
    [
      '-p',
      'What was the codename I asked you to remember? Reply with only the codename.',
      '--allow-all-tools',
      '--resume',
      sid,
      '--output-format',
      'json',
      '--log-level',
      'error',
    ],
    baseEnv(f4.token),
    dir4,
  );
  out('first exit', a.code);
  out('second exit', b.code);
  out('second answer mentions ZEBRA-4417', /ZEBRA-4417/.test(b.stdout));
  out('second stdout tail', b.stdout.slice(-300).replace(/\s+/g, ' '));
  out('session id from events', [
    ...new Set(
      jsonLines(a.stdout)
        .map((e) => e.sessionId ?? e.data?.sessionId)
        .filter(Boolean),
    ),
  ]);

  // ---------------------------------------------------------------- T5: where does it try to connect?
  say('T5  hosts it contacts when BYOK is set (CONNECT proxy log)');
  const seen = new Set<string>();
  const proxy = http.createServer((_q, r) => r.end('no'));
  proxy.on('connect', (req, socket) => {
    seen.add(req.url ?? '');
    const [h, p] = (req.url ?? '').split(':');
    const up = net.connect(Number(p) || 443, h, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const f5 = await newRun();
  const dir5 = await mkdtemp(path.join(os.tmpdir(), 'cp-t5-'));
  const t5 = await runCopilot(
    [
      '-p',
      'Reply with exactly: OK',
      '--allow-all-tools',
      '--output-format',
      'json',
      '--log-level',
      'error',
      '--disable-client-telemetry',
    ],
    {
      ...baseEnv(f5.token),
      HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
      NO_PROXY: '127.0.0.1,localhost',
    },
    dir5,
    120_000,
  );
  out('exit', t5.code);
  out('hosts reached through the proxy', [...seen]);
  proxy.close();

  await rm(home, { recursive: true, force: true }).catch(() => {});
} catch (e) {
  say(`SPIKE ERROR: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await raw.end().catch(() => {});
  await pool.end().catch(() => {});
  await stack.stop();
}
void mkdir;
