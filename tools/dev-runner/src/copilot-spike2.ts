/* eslint-disable @typescript-eslint/no-explicit-any -- throwaway spike code that reads untyped JSONL */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDb, createRunFixture } from '@sdlc/db';
import { startStack } from './stack.js';

// Spike part 2: offline mode, blocking asks, parking and resume, tool limits, and a clean home.
//   node --import tsx src/copilot-spike2.ts
// Throwaway. It prints what it finds. Needs the OPENROUTER_API_KEY that the gateway uses.

const say = (m: string) => console.log(m);
const out = (label: string, v: unknown) =>
  say(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const stack = await startStack({
  dataDir: path.join(os.tmpdir(), `sdlc-copilot-spike-${Date.now()}`),
  log: () => {},
  apiEnv: { BLOCKING_MAX_S: '25' },
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
  const cleanHome = await mkdtemp(path.join(os.tmpdir(), 'cp-userhome-'));
  const isolated = (token: string): Record<string, string> => ({
    ...baseEnv(token),
    HOME: cleanHome,
    USERPROFILE: cleanHome,
    APPDATA: path.join(cleanHome, 'AppData'),
    LOCALAPPDATA: path.join(cleanHome, 'Local'),
    COPILOT_AUTO_UPDATE: 'false',
  });
  const mcpFor = (token: string) =>
    JSON.stringify({
      mcpServers: {
        platform: {
          type: 'http',
          url: `http://127.0.0.1:${new URL(stack.apiUrl).port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
          tools: ['*'],
        },
      },
    });
  const common = [
    '--allow-all-tools',
    '--output-format',
    'json',
    '--log-level',
    'error',
    '--disable-client-telemetry',
  ];

  // ---------------------------------------------------------------- T6: offline mode, clean home
  say('T6  COPILOT_OFFLINE=true with a clean home: does it still work, and what does it contact?');
  const seen = new Set<string>();
  const proxy = http.createServer((_q, r) => r.end('no'));
  proxy.on('connect', (req, socket) => {
    seen.add(req.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const f6 = await newRun();
  const dir6 = await mkdtemp(path.join(os.tmpdir(), 'cp-t6-'));
  const t6 = await runCopilot(
    ['-p', 'Reply with exactly: OK6', ...common],
    {
      ...isolated(f6.token),
      COPILOT_OFFLINE: 'true',
      HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
      NO_PROXY: '127.0.0.1,localhost',
    },
    dir6,
    120_000,
  );
  out('exit', t6.code);
  out('answered OK6', /OK6/.test(t6.stdout));
  out('hosts it tried (all refused by the proxy)', [...seen]);
  out('skills loaded from the real user home', /gepeto|pinokio/.test(t6.stdout));
  out('stderr', t6.stderr.slice(0, 300).replace(/\s+/g, ' '));
  // the same without offline, but with the proxy refusing api.github.com
  seen.clear();
  const f6b = await newRun();
  const t6b = await runCopilot(
    ['-p', 'Reply with exactly: OK6B', ...common],
    {
      ...isolated(f6b.token),
      HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
      NO_PROXY: '127.0.0.1,localhost',
    },
    dir6,
    120_000,
  );
  out('not offline, api.github.com refused: exit', t6b.code);
  out('not offline: answered OK6B', /OK6B/.test(t6b.stdout));
  out('not offline: hosts tried', [...seen]);
  proxy.close();

  // ---------------------------------------------------------------- T7: a blocking ask that is answered while the tool call is open
  say('T7  ask_human blocking, answered while the call is open');
  const f7 = await newRun();
  const dir7 = await mkdtemp(path.join(os.tmpdir(), 'cp-t7-'));
  const answerLater = (async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await raw.query("select id from interaction where run_id = $1 and state = 'open'", [
        f7.runId,
      ]);
      if (r.rows[0]) {
        await new Promise((r2) => setTimeout(r2, 6000));
        await raw.query(
          "update interaction set state = 'answered', answer = $2::jsonb, answered_via = 'workspace', answered_at = now() where id = $1",
          [r.rows[0].id, JSON.stringify({ text: 'howdy', source: 'human' })],
        );
        return Date.now();
      }
    }
    return 0;
  })();
  const t7 = await runCopilot(
    [
      '-p',
      'Call ask_human with blocking true, question "Which greeting?", options [{"id":"hello","label":"Hello"},{"id":"howdy","label":"Howdy"}]. Then write the answer you received into the file greeting.txt and say DONE.',
      '--additional-mcp-config',
      mcpFor(f7.token),
      ...common,
    ],
    isolated(f7.token),
    dir7,
    150_000,
  );
  await answerLater;
  out('exit', t7.code);
  out('seconds', Math.round(t7.ms / 1000));
  out(
    'greeting.txt',
    await readFile(path.join(dir7, 'greeting.txt'), 'utf8').catch(() => 'MISSING'),
  );

  // ---------------------------------------------------------------- T8: an ask nobody answers: the tool parks, then resume with the answer
  say(
    'T8  ask_human blocking, unanswered: parks after BLOCKING_MAX_S=25, then the session is resumed with the answer',
  );
  const f8 = await newRun();
  const dir8 = await mkdtemp(path.join(os.tmpdir(), 'cp-t8-'));
  const sid = '0190a000-0000-7000-8000-' + String(Date.now()).padStart(12, '0').slice(-12);
  const t8 = await runCopilot(
    [
      '-p',
      'Remember the codename OTTER-77. Then call ask_human with blocking true, question "Which colour?", options [{"id":"red","label":"Red"},{"id":"blue","label":"Blue"}]. If the result says parked, stop at once and reply PARKED with nothing else.',
      '--session-id',
      sid,
      '--additional-mcp-config',
      mcpFor(f8.token),
      ...common,
    ],
    isolated(f8.token),
    dir8,
    150_000,
  );
  out('exit', t8.code);
  out('seconds (the tool waits 25 s before parking)', Math.round(t8.ms / 1000));
  const parked = jsonLines(t8.stdout)
    .filter((e) => e.type === 'tool.execution_complete')
    .map((e) => JSON.stringify(e.data).slice(0, 300));
  out('tool result', parked);
  out(
    'final text',
    jsonLines(t8.stdout)
      .filter((e) => e.type === 'assistant.message')
      .map((e) => String(e.data?.content ?? '').slice(0, 80))
      .slice(-2),
  );
  const t8b = await runCopilot(
    [
      '-p',
      'A person answered your question: they chose blue. What was the codename, and what did they choose? Reply as: <codename> <colour>.',
      '--resume',
      sid,
      '--additional-mcp-config',
      mcpFor(f8.token),
      ...common,
    ],
    isolated(f8.token),
    dir8,
    120_000,
  );
  out('resumed exit', t8b.code);
  out(
    'resumed remembers codename and uses the answer',
    /OTTER-77/.test(t8b.stdout) && /blue/i.test(t8b.stdout),
  );

  // ---------------------------------------------------------------- T9: tool limits
  say('T9  denying shell(git push), and limiting the tools the model can see');
  const f9 = await newRun();
  const dir9 = await mkdtemp(path.join(os.tmpdir(), 'cp-t9-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir9 });
  const bare = await mkdtemp(path.join(os.tmpdir(), 'cp-bare-'));
  execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir9 });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir9 });
  execFileSync('git', ['config', 'user.name', 'agent'], { cwd: dir9 });
  await writeFile(path.join(dir9, 'a.txt'), 'a');
  execFileSync('git', ['add', '.'], { cwd: dir9 });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir9 });
  const t9 = await runCopilot(
    [
      '-p',
      'Run the shell command: git push origin main. Report exactly what happened.',
      '--allow-tool=shell(git:*)',
      '--deny-tool=shell(git push)',
      '--output-format',
      'json',
      '--log-level',
      'error',
      '--disable-client-telemetry',
    ],
    isolated(f9.token),
    dir9,
    120_000,
  );
  const pushed = execFileSync('git', ['--git-dir', bare, 'branch', '--list']).toString().trim();
  out('exit', t9.code);
  out(
    'branches on the remote after the run (empty means the push was blocked)',
    pushed || '(none)',
  );
  out(
    'tool events',
    jsonLines(t9.stdout)
      .filter((e) => /^tool\./.test(String(e.type)))
      .map((e) => `${e.type} ${JSON.stringify(e.data).slice(0, 160)}`)
      .slice(0, 4),
  );
  const f9b = await newRun();
  const t9b = await runCopilot(
    [
      '-p',
      'List the names of every tool you can call, comma separated, nothing else.',
      '--available-tools',
      'view',
      'edit',
      'create',
      'shell',
      '--allow-all-tools',
      '--output-format',
      'json',
      '--log-level',
      'error',
      '--disable-client-telemetry',
    ],
    isolated(f9b.token),
    dir9,
    120_000,
  );
  out(
    'tools it reports with --available-tools view edit create shell',
    jsonLines(t9b.stdout)
      .filter((e) => e.type === 'assistant.message')
      .map((e) => String(e.data?.content ?? '').slice(0, 200))
      .slice(-1),
  );
  out(
    'baseline input tokens for a one-line prompt (Claude Code is about 30000)',
    (await cost(f9b.runId)).i,
  );
  await rm(home, { recursive: true, force: true }).catch(() => {});
} catch (e) {
  say(`SPIKE ERROR: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await raw.end().catch(() => {});
  await pool.end().catch(() => {});
  await stack.stop();
}
void mkdir;
