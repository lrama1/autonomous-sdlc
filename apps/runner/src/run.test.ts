/* eslint-disable @typescript-eslint/no-explicit-any */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExitReason } from '@sdlc/schemas';
import { runOnce, runVerify } from './run.js';

const fakeEngine = fileURLToPath(new URL('./testing/fake-engine.mjs', import.meta.url));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
// The platform user's git may refuse to use a bare repository by path, so ask for it explicitly.
const bareGit = (dir: string, ...a: string[]) =>
  execFileSync('git', [`--git-dir=${dir}`, ...a], { encoding: 'utf8' });

// ---- a bare repository to clone from and push to ----
let root: string;
let bare: string;

async function makeRemote() {
  const work = path.join(root, `seed-${Math.random().toString(36).slice(2)}`);
  await mkdir(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'seed');
  git(work, 'config', 'user.email', 'seed@example.test');
  await writeFile(path.join(work, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
  await writeFile(
    path.join(work, 'check.js'),
    "const fs=require('fs');const t=fs.existsSync('src/value.txt')?fs.readFileSync('src/value.txt','utf8'):'';if(t.trim()!=='good'){console.error('value.txt must say good, found: '+JSON.stringify(t));process.exit(1)}console.log('verify ok')",
  );
  await mkdir(path.join(work, '.github/workflows'), { recursive: true });
  await writeFile(path.join(work, '.github/workflows/ci.yml'), 'name: ci\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'seed');
  const b = path.join(root, `remote-${Math.random().toString(36).slice(2)}.git`);
  git(root, 'clone', '-q', '--bare', work, b);
  return b;
}

// ---- a fake platform API for the runner ----
interface Fake {
  status: string;
  inactive: boolean;
  events: Array<{ type: string; payload: Record<string, any> }>;
  stateCalls: Array<Record<string, any>>;
  triggers: Array<Record<string, any>>;
  prs: Array<Record<string, any>>;
  specOverrides: Record<string, any>;
  maxVerifyAttempts: number;
}
let api: http.Server;
let apiUrl: string;
let fake: Fake;
const TOKEN = 'run-token-abc';
const resetFake = (): Fake =>
  (fake = {
    status: 'starting',
    inactive: false,
    events: [],
    stateCalls: [],
    triggers: [],
    prs: [],
    specOverrides: {},
    maxVerifyAttempts: 3,
  });

function spec(cloneUrl: string, runId: string) {
  return {
    runId,
    role: 'backend_engineer',
    title: 'Add the value file',
    task: 'Create src/value.txt containing the word good.',
    systemPrompt: 'be careful',
    definition: { id: 'backend-engineer', version: 1 },
    engine: 'claude-code',
    resume: null,
    repo: {
      fullName: 'o/r',
      cloneUrl,
      branch: `agent/${runId}/add-the-value-file`,
      integrationBranch: 'main',
      writeMode: 'branch_pr',
      protectedPaths: ['.github/workflows/**'],
      verifyCommand: 'node check.js',
    },
    git: { token: 'ghs_secret_git_token', expiresAt: '2026-10-17T23:00:00Z' },
    model: { alias: 'agent-default' },
    gateway: { baseUrl: 'http://127.0.0.1:8787' },
    mcp: { url: 'http://127.0.0.1:8080/mcp' },
    limits: {
      maxTurns: 10,
      maxWallSeconds: 60,
      budgetMicros: 1_000_000,
      maxVerifyAttempts: fake.maxVerifyAttempts,
    },
    tools: { denied: ['web_fetch'] },
    ...fake.specOverrides,
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sdlc-runner-'));
  bare = await makeRemote();
  resetFake();
  api = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = (status: number, b: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'no' });
    if (fake.inactive) return send(403, { error: { code: 'run_not_active' } });
    const url = req.url ?? '';
    if (url === '/runner/spec')
      return send(200, spec(pathToFileURL(bare).href, '0190a000-0000-7000-8000-000000000001'));
    if (url === '/runner/status') return send(200, { state: fake.status });
    if (url === '/runner/events') {
      fake.events.push(...body.events);
      return send(200, { ok: true });
    }
    if (url === '/runner/state') {
      fake.stateCalls.push(body);
      if (body.state === 'running') fake.status = 'running';
      return send(200, { ok: true });
    }
    if (url === '/runner/trigger') {
      fake.triggers.push(body);
      fake.status = 'parked';
      return send(200, { interactionId: 'i-1' });
    }
    if (url === '/runner/pull-request') {
      fake.prs.push(body);
      return send(200, { number: 12, url: 'https://github.com/o/r/pull/12', interactionId: 'i-2' });
    }
    return send(404, {});
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise((r) => api?.close(r));
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  resetFake();
  // A fresh remote per test, so one test's pushed branch cannot affect the next.
  bare = await makeRemote();
});

async function runWith(
  scenario: object,
  opts: { workDir?: string; specOverrides?: Record<string, any> } = {},
) {
  const workDir = opts.workDir ?? (await mkdtemp(path.join(root, 'work-')));
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, 'scenario.json'), JSON.stringify(scenario));
  Object.assign(fake.specOverrides, opts.specOverrides ?? {});
  const logs: string[] = [];
  const reason: ExitReason = await runOnce({
    apiUrl,
    runToken: TOKEN,
    workDir,
    claudeBin: process.execPath,
    claudeArgs: [fakeEngine],
    log: (l) => logs.push(l),
  });
  const calls = JSON.parse(
    await readFile(path.join(workDir, 'calls.json'), 'utf8').catch(() => '[]'),
  ) as Array<{ prompt: string; resumed: boolean; env: Record<string, any> }>;
  return { reason, workDir, calls, logs };
}

const remoteBranches = () =>
  bareGit(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean);
const lastFinished = () => fake.stateCalls.filter((s) => s.state === 'finished').at(-1);

describe('a successful run', () => {
  it('clones, runs the engine, verifies, pushes, and opens the pull request', async () => {
    const r = await runWith({ do: 'write-good' });
    expect(
      r.reason,
      JSON.stringify({ logs: r.logs, triggers: fake.triggers, last: fake.events.slice(-3) }),
    ).toBe('finished');
    expect(fake.stateCalls.map((s) => s.state)).toEqual(['running', 'finished']);
    expect(lastFinished()).toMatchObject({ exitReason: 'finished', summary: 'Added the value.' });

    const branch = remoteBranches().find((b) => b.startsWith('agent/'))!;
    expect(branch).toMatch(/^agent\/.*\/add-the-value-file$/);
    expect(bareGit(bare, 'show', `${branch}:src/value.txt`).trim()).toBe('good');
    expect(bareGit(bare, 'log', '-1', '--format=%an', branch).trim()).toBe('Autonomous SDLC Agent');

    expect(fake.prs).toHaveLength(1);
    expect(fake.prs[0]).toMatchObject({
      title: 'Add the value file',
      diff: {
        changedPaths: ['src/value.txt'],
        dependencyAdded: false,
        testsDeletedOrSkipped: false,
        protectedPathsTouched: [],
      },
      verify: { ok: true, command: 'node check.js', attempts: 1 },
      summary: 'Added the value.',
    });
    expect(fake.prs[0]!.body).toContain('## Verification');
    expect(fake.prs[0]!.body).toContain('Added the value.');

    const types = fake.events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'repo.cloning',
        'engine.started',
        'message',
        'tool.call',
        'file.changed',
        'tool.result',
        'verify.finished',
        'branch.pushed',
        'pull_request.created',
      ]),
    );
    expect(fake.events.find((e) => e.type === 'verify.finished')!.payload).toMatchObject({
      ok: true,
      attempt: 1,
    });
  });

  it('gives the engine the gateway and the run token, a private home, and no GitHub token', async () => {
    const r = await runWith({ do: 'write-good' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.env).toEqual({
      base: 'http://127.0.0.1:8787',
      token: TOKEN,
      home: path.join(r.workDir, 'home'),
      ghToken: null,
    });
    expect(r.calls[0]!.prompt).toContain('good');
  });

  it('uses the gateway and platform-tool addresses it was given instead of the ones in the run spec', async () => {
    const workDir = await mkdtemp(path.join(root, 'work-'));
    await writeFile(path.join(workDir, 'scenario.json'), JSON.stringify({ do: 'write-good' }));
    await runOnce({
      apiUrl,
      runToken: TOKEN,
      workDir,
      claudeBin: process.execPath,
      claudeArgs: [fakeEngine],
      gatewayUrl: 'http://10.9.8.7:8787',
      mcpUrl: 'http://10.9.8.7:8080/mcp',
      log: () => {},
    });
    const calls = JSON.parse(await readFile(path.join(workDir, 'calls.json'), 'utf8'));
    expect(calls[0].env.base).toBe('http://10.9.8.7:8787');
    const mcp = JSON.parse(await readFile(path.join(workDir, 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.platform.url).toBe('http://10.9.8.7:8080/mcp');
  });

  it('never writes the git token into the repository', async () => {
    const r = await runWith({ do: 'write-good' });
    const config = await readFile(path.join(r.workDir, 'repo', '.git', 'config'), 'utf8');
    expect(config).not.toContain('ghs_secret_git_token');
    expect(config).not.toContain(
      Buffer.from('x-access-token:ghs_secret_git_token').toString('base64'),
    );
    expect(JSON.stringify(fake.events)).not.toContain('ghs_secret_git_token');
    expect(r.logs.join('\n')).not.toContain('ghs_secret_git_token');
  });

  it('commits what the engine left uncommitted', async () => {
    const r = await runWith({ do: 'leave-uncommitted' });
    expect(r.reason).toBe('finished');
    expect(fake.prs).toHaveLength(1);
    expect(fake.prs[0]!.diff.changedPaths).toEqual(['src/value.txt']);
  });

  it('opens no pull request when there is nothing to change', async () => {
    const r = await runWith({ do: 'no-change' });
    expect(r.reason).toBe('finished');
    expect(fake.prs).toHaveLength(0);
    expect(lastFinished()).toMatchObject({ exitReason: 'finished', summary: 'Nothing to do.' });
    expect(remoteBranches().filter((b) => b.startsWith('agent/'))).toHaveLength(0);
  });
});

describe('verification', () => {
  it('sends a failure back to the engine, in the same session, and opens the PR once it passes', async () => {
    const r = await runWith({ steps: [{ do: 'write-bad' }, { do: 'write-good' }] });
    expect(r.reason).toBe('finished');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.resumed).toBe(true);
    expect(r.calls[1]!.prompt).toMatch(/^Verification failed \(attempt 1 of 3\)/);
    expect(r.calls[1]!.prompt).toContain('value.txt must say good');
    const verifies = fake.events
      .filter((e) => e.type === 'verify.finished')
      .map((e) => [e.payload.ok, e.payload.attempt]);
    expect(verifies).toEqual([
      [false, 1],
      [true, 2],
    ]);
    expect(fake.prs[0]!.verify.attempts).toBe(2);
  });

  it('stops after the allowed attempts, asks a person, and pushes nothing', async () => {
    fake.maxVerifyAttempts = 2;
    const r = await runWith({ do: 'write-bad' });
    expect(r.reason).toBe('blocked');
    expect(r.calls).toHaveLength(2);
    expect(fake.triggers).toEqual([
      { kind: 'verify_failed', summary: expect.stringContaining('failed 2 times'), paths: [] },
    ]);
    expect(lastFinished()).toMatchObject({ exitReason: 'blocked' });
    expect(fake.prs).toHaveLength(0);
    expect(remoteBranches().filter((b) => b.startsWith('agent/'))).toHaveLength(0);
  });
});

describe('the Architect agent', () => {
  const architect = { specOverrides: { role: 'architect' } };

  it('sends a design whose task list does not read back to the engine, and opens the PR once it does', async () => {
    const r = await runWith(
      { steps: [{ do: 'write-design-bad' }, { do: 'write-design-good' }] },
      architect,
    );
    expect(r.reason).toBe('finished');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.resumed).toBe(true);
    expect(r.calls[1]!.prompt).toMatch(/^The design is not accepted yet \(attempt 1 of 3\)/);
    expect(r.calls[1]!.prompt).toContain('docs/design/thing.md');
    expect(r.calls[1]!.prompt).toContain('not valid YAML');
    expect(fake.events.filter((e) => e.type === 'design.checked').map((e) => e.payload.ok)).toEqual(
      [false, true],
    );
    expect(fake.prs).toHaveLength(1);
    expect(fake.prs[0]!.diff.changedPaths).toContain('docs/design/thing.md');
  });

  it('stops after the allowed attempts, asks a person, and pushes nothing', async () => {
    fake.maxVerifyAttempts = 2;
    const r = await runWith({ do: 'write-design-bad' }, architect);
    expect(r.reason).toBe('blocked');
    expect(r.calls).toHaveLength(2);
    expect(fake.triggers).toEqual([
      {
        kind: 'verify_failed',
        summary: expect.stringContaining('task list was not valid after 2 attempts'),
        paths: [],
      },
    ]);
    expect(fake.prs).toHaveLength(0);
    expect(remoteBranches().filter((b) => b.startsWith('agent/'))).toHaveLength(0);
  });

  it('asks for a design when the branch has none', async () => {
    const r = await runWith(
      { steps: [{ do: 'write-good' }, { do: 'write-design-good' }] },
      architect,
    );
    expect(r.reason).toBe('finished');
    expect(r.calls[1]!.prompt).toContain('has no design file');
  });

  it('does not read design files for other roles', async () => {
    const r = await runWith({ do: 'write-design-bad' });
    expect(r.reason).toBe('finished');
    expect(fake.events.some((e) => e.type === 'design.checked')).toBe(false);
  });
});

describe('protected paths', () => {
  it('asks a person and pushes nothing when the change touches a protected path', async () => {
    const r = await runWith({ do: 'edit-workflow' });
    expect(r.reason).toBe('blocked');
    expect(fake.triggers).toEqual([
      {
        kind: 'protected_path',
        summary: expect.stringContaining('.github/workflows/ci.yml'),
        paths: ['.github/workflows/ci.yml'],
      },
    ]);
    expect(fake.prs).toHaveLength(0);
    expect(remoteBranches().filter((b) => b.startsWith('agent/'))).toHaveLength(0);
    expect(fake.events.some((e) => e.type === 'verify.finished')).toBe(false);
  });
});

describe('engine failures', () => {
  it('reports running out of turns as an error', async () => {
    const r = await runWith({ do: 'max-turns' });
    expect(r.reason).toBe('error');
    expect(lastFinished()).toMatchObject({
      exitReason: 'error',
      summary: expect.stringContaining('all its turns'),
    });
    expect(fake.prs).toHaveLength(0);
  });

  it('refuses an engine it does not know', async () => {
    fake.specOverrides = { engine: 'mystery-engine' };
    const r = await runWith({ do: 'write-good' });
    expect(r.reason).toBe('error');
    expect(lastFinished()).toMatchObject({
      exitReason: 'error',
      summary: expect.stringContaining('mystery-engine'),
    });
    expect(fake.prs).toHaveLength(0);
  });

  it('reports an engine that cannot start', async () => {
    const workDir = await mkdtemp(path.join(root, 'work-'));
    await writeFile(path.join(workDir, 'scenario.json'), '{}');
    const reason = await runOnce({
      apiUrl,
      runToken: TOKEN,
      workDir,
      claudeBin: path.join(root, 'no-such-engine'),
      log: () => {},
    });
    expect(reason).toBe('error');
    expect(lastFinished()).toMatchObject({ exitReason: 'error' });
  });
});

describe('parking and cancelling', () => {
  it('stops the engine when the run is parked, and records a parked exit', async () => {
    const run = runWith({ do: 'hang' });
    await new Promise((r) => setTimeout(r, 1200));
    fake.status = 'parked';
    const r = await run;
    expect(r.reason).toBe('parked');
    expect(lastFinished()).toMatchObject({ exitReason: 'parked' });
    expect(fake.prs).toHaveLength(0);
  }, 30_000);

  it('remembers the engine session while it runs, so a killed runner can still resume it', async () => {
    const workDir = await mkdtemp(path.join(root, 'work-'));
    const run = runWith({ do: 'hang' }, { workDir });
    await new Promise((r) => setTimeout(r, 1500));
    // The engine is still running (it hangs like a blocked question). The id is already on disk.
    expect(JSON.parse(await readFile(path.join(workDir, 'session.json'), 'utf8'))).toEqual({
      sessionId: 'fake-session-1',
    });
    fake.status = 'parked';
    await run;
  }, 30_000);

  it('stops the engine when the platform says the run is over, and says nothing more', async () => {
    const run = runWith({ do: 'hang' });
    await new Promise((r) => setTimeout(r, 1200));
    fake.inactive = true;
    const r = await run;
    expect(r.reason).toBe('cancelled');
    expect(fake.stateCalls.filter((s) => s.state === 'finished')).toHaveLength(0);
  }, 30_000);

  it('resumes the same session in the same checkout with the answer as the first message', async () => {
    const first = runWith({ do: 'hang' });
    await new Promise((r) => setTimeout(r, 1200));
    fake.status = 'parked';
    const parked = await first;
    expect(parked.reason).toBe('parked');

    fake.status = 'resuming';
    const second = await runWith(
      { do: 'write-good' },
      {
        workDir: parked.workDir,
        specOverrides: {
          resume: { message: 'A person answered on your question "Which value?": good' },
        },
      },
    );
    expect(second.reason).toBe('finished');
    expect(second.calls).toHaveLength(2);
    expect(second.calls[1]).toMatchObject({
      prompt: 'A person answered on your question "Which value?": good',
      resumed: true,
    });
    expect(second.logs.join('\n')).not.toMatch(/cloning/);
    expect(fake.prs).toHaveLength(1);
  }, 40_000);
});

describe('runVerify', () => {
  it('passes on exit code 0 and keeps the output', async () => {
    const cwd = await mkdtemp(path.join(root, 'v-'));
    const r = await runVerify('node -e "console.log(123)"', cwd, cwd);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('123');
  });
  it('fails on a non-zero exit and keeps the end of the output', async () => {
    const cwd = await mkdtemp(path.join(root, 'v-'));
    const r = await runVerify('node -e "console.error(\'boom\'); process.exit(3)"', cwd, cwd);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('boom');
  });
  it('does not see platform secrets', async () => {
    const cwd = await mkdtemp(path.join(root, 'v-'));
    process.env.OPENROUTER_API_KEY = 'sk-or-should-not-appear';
    try {
      const r = await runVerify(
        'node -e "console.log(process.env.OPENROUTER_API_KEY || \'absent\')"',
        cwd,
        cwd,
      );
      expect(r.summary).toContain('absent');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
