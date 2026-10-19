import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExitReason, RunSpec } from '@sdlc/schemas';
import { RunInactiveError, RunnerApi } from './api.js';
import { PROXY_VARS, killTree, runClaude } from './claude.js';
import type { EngineEvent, EngineRun } from './claude.js';
import { COPILOT_ENGINE, runCopilot } from './copilot.js';
import { checkDesigns } from './design-check.js';
import { summarizeDiff } from './diff.js';
import {
  checkoutWorkBranch,
  cloneRepo,
  commitLeftovers,
  commitsAhead,
  configureRepo,
  fetchOrigin,
  pushBranch,
} from './git.js';

export interface RunnerEnv {
  apiUrl: string;
  runToken: string;
  workDir: string;
  claudeBin: string;
  claudeArgs?: string[];
  copilotBin?: string;
  copilotArgs?: string[];
  /** Where the engine reaches the Model Gateway and the platform tools from here. Inside a sandbox these differ from the spec. */
  gatewayUrl?: string;
  mcpUrl?: string;
  /** Signed addresses for the run's parked files. Given on Fargate, where nothing survives a task. */
  stateGetUrl?: string;
  statePutUrl?: string;
  log?: (line: string) => void;
}

const POLL_MS = 2000;
const FLUSH_MS = 1000;
const VERIFY_TIMEOUT_MS = 10 * 60_000;
const PARK_STATES = new Set(['parked']);
const STOP_STATES = new Set([
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'failed',
  'succeeded',
  'paused',
]);

interface VerifyResult {
  ok: boolean;
  durationMs: number;
  summary: string;
}

/** Runs the repository's verification command. It is the same command CI runs. */
export function runVerify(command: string, cwd: string, homeDir: string): Promise<VerifyResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const k of [
      'PATH',
      'Path',
      'PATHEXT',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'COMSPEC',
      'TEMP',
      'TMP',
      'TMPDIR',
      'ProgramFiles',
      'APPDATA',
      'LOCALAPPDATA',
      ...PROXY_VARS,
    ]) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
    Object.assign(env, { HOME: homeDir, USERPROFILE: homeDir, CI: '1', GIT_TERMINAL_PROMPT: '0' });
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let out = '';
    const take = (d: Buffer) => {
      out = (out + d.toString('utf8')).slice(-6000);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => killTree(child), VERIFY_TIMEOUT_MS);
    const end = (ok: boolean, extra = '') => {
      clearTimeout(timer);
      resolve({
        ok,
        durationMs: Date.now() - started,
        summary: `${extra}${out}`.trim().slice(-4000),
      });
    };
    child.on('error', (e) => end(false, `could not start: ${e.message}\n`));
    child.on('close', (code) => end(code === 0));
  });
}

class EventBuffer {
  private queue: EngineEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly api: RunnerApi,
    private readonly onInactive: () => void,
    private readonly log: (l: string) => void,
  ) {}

  push(events: EngineEvent[]): void {
    this.queue.push(...events);
    if (this.queue.length >= 40) void this.flush();
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, 100);
    try {
      await this.api.events(batch);
    } catch (e) {
      if (e instanceof RunInactiveError) return this.onInactive();
      this.queue.unshift(...batch);
      this.log(`could not send events, will retry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    for (let i = 0; i < 5 && this.queue.length > 0; i++) await this.flush();
  }
}

const trimTitle = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

/** One runner invocation: start or resume a run, verify the work, push it, and open the pull request. */
export async function runOnce(env: RunnerEnv): Promise<ExitReason> {
  const log = env.log ?? ((l: string) => console.log(l));
  const api = new RunnerApi(env.apiUrl, env.runToken);
  const repoDir = path.join(env.workDir, 'repo');
  const homeDir = path.join(env.workDir, 'home');
  const sessionFile = path.join(env.workDir, 'session.json');
  const mcpFile = path.join(env.workDir, 'mcp.json');

  let spec: RunSpec;
  try {
    spec = await api.spec();
  } catch (e) {
    log(`cannot start: ${e instanceof Error ? e.message : String(e)}`);
    return 'error';
  }

  let stop: 'inactive' | 'parked' | null = null;
  let engine: EngineRun | null = null;
  const requestStop = (why: 'inactive' | 'parked') => {
    if (stop) return;
    stop = why;
    engine?.kill();
  };
  const events = new EventBuffer(api, () => requestStop('inactive'), log);
  let poller: NodeJS.Timeout | undefined;

  try {
    await mkdir(homeDir, { recursive: true });
    await api.running();
    if (spec.engine !== COPILOT_ENGINE && spec.engine !== 'claude-code') {
      await api.finished('error', `The runner has no engine called "${spec.engine}".`);
      return 'error';
    }
    events.start();
    poller = setInterval(() => {
      api
        .status()
        .then((s) => {
          if (PARK_STATES.has(s)) requestStop('parked');
          else if (STOP_STATES.has(s)) requestStop('inactive');
        })
        .catch((e) => {
          if (e instanceof RunInactiveError) requestStop('inactive');
        });
    }, POLL_MS);

    if (!existsSync(path.join(repoDir, '.git'))) {
      events.push([{ type: 'repo.cloning', payload: { repository: spec.repo.fullName } }]);
      await cloneRepo(spec.repo.cloneUrl, repoDir, spec.git.token);
      await configureRepo(repoDir);
      await checkoutWorkBranch(repoDir, spec.repo.branch, spec.repo.integrationBranch);
    } else {
      await configureRepo(repoDir);
      await fetchOrigin(repoDir, spec.git.token);
    }

    await writeFile(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          platform: {
            type: 'http',
            url: env.mcpUrl ?? spec.mcp.url,
            headers: { Authorization: `Bearer ${env.runToken}` },
            ...(spec.engine === COPILOT_ENGINE ? { tools: ['*'] } : {}),
          },
        },
      }),
    );
    let sessionId: string | undefined = await readFile(sessionFile, 'utf8')
      .then((t) => (JSON.parse(t) as { sessionId?: string }).sessionId)
      .catch(() => undefined);

    let prompt = spec.resume ? spec.resume.message : spec.task;
    let attempts = 0;

    for (;;) {
      const useCopilot = spec.engine === COPILOT_ENGINE;
      engine = (useCopilot ? runCopilot : runClaude)({
        bin: useCopilot ? (env.copilotBin ?? 'copilot') : env.claudeBin,
        binArgs: useCopilot ? env.copilotArgs : env.claudeArgs,
        cwd: repoDir,
        homeDir,
        prompt,
        systemPrompt: spec.systemPrompt,
        resumeSessionId: sessionId,
        modelAlias: spec.model.alias,
        gatewayUrl: env.gatewayUrl ?? spec.gateway.baseUrl,
        runToken: env.runToken,
        mcpConfigPath: mcpFile,
        maxTurns: spec.limits.maxTurns,
        maxWallSeconds: spec.limits.maxWallSeconds,
        deniedTools: spec.tools.denied,
        onEvents: (e) => events.push(e),
        onSession: (id) => {
          sessionId = id;
          writeFileSync(sessionFile, JSON.stringify({ sessionId: id }));
        },
      });
      if (stop) engine.kill();
      const r = await engine.done;
      engine = null;
      if (r.sessionId) {
        sessionId = r.sessionId;
        await writeFile(sessionFile, JSON.stringify({ sessionId }));
      }
      await events.flush();

      if (stop === 'inactive') return 'cancelled';
      if (stop === 'parked') {
        await api.finished('parked');
        return 'parked';
      }
      if (r.killedBy === 'timeout') {
        await api.finished(
          'timeout',
          `The engine ran longer than ${spec.limits.maxWallSeconds} seconds.`,
        );
        return 'timeout';
      }
      // The engine may have parked the run itself (a blocked question, a checkpoint) just before it exited.
      const state = await api.status();
      if (PARK_STATES.has(state)) {
        await api.finished('parked');
        return 'parked';
      }
      if (r.isError) {
        const why =
          r.subtype === 'error_max_turns'
            ? 'The agent used all its turns without finishing.'
            : `The engine stopped with an error (${r.subtype}). ${r.stderrTail}`.trim();
        events.push([
          {
            type: 'engine.error',
            payload: { subtype: r.subtype, exitCode: r.exitCode, stderr: r.stderrTail.slice(-500) },
          },
        ]);
        await events.flush();
        await api.finished('error', why.slice(0, 2000));
        return 'error';
      }

      await commitLeftovers(
        repoDir,
        `${trimTitle(spec.title)} (changes left uncommitted by the agent)`,
      );
      if ((await commitsAhead(repoDir, spec.repo.integrationBranch)) === 0) {
        await api.finished('finished', r.finalText || 'The agent made no changes.');
        return 'finished';
      }

      const diff = await summarizeDiff(
        repoDir,
        spec.repo.integrationBranch,
        spec.repo.protectedPaths,
      );
      if (diff.protectedPathsTouched.length > 0) {
        events.push([
          { type: 'trigger.protected_path', payload: { paths: diff.protectedPathsTouched } },
        ]);
        await api.trigger(
          'protected_path',
          `The change edits protected paths: ${diff.protectedPathsTouched.join(', ')}`,
          diff.protectedPathsTouched,
        );
        await events.flush();
        await api.finished('blocked');
        return 'blocked';
      }

      // The Architect's task list is read by the platform later, so it must read now.
      if (spec.role === 'architect') {
        const problem = await checkDesigns(repoDir, diff.changedPaths);
        events.push([{ type: 'design.checked', payload: { ok: problem === null, problem } }]);
        if (problem) {
          attempts++;
          if (attempts < spec.limits.maxVerifyAttempts) {
            prompt = `The design is not accepted yet (attempt ${attempts} of ${spec.limits.maxVerifyAttempts}). Fix it and commit. The task list is a fenced block named sdlc-tasks holding a YAML list. Quote any line that contains a colon, a brace or a quote.\n\n${problem}`;
            continue;
          }
          await api.trigger(
            'verify_failed',
            `The design's task list was not valid after ${attempts} attempts:\n${problem}`,
          );
          await events.flush();
          await api.finished('blocked');
          return 'blocked';
        }
      }

      attempts++;
      const verify = await runVerify(spec.repo.verifyCommand, repoDir, homeDir);
      events.push([
        {
          type: 'verify.finished',
          payload: {
            ok: verify.ok,
            command: spec.repo.verifyCommand,
            attempt: attempts,
            durationMs: verify.durationMs,
            summary: verify.summary.slice(-500),
          },
        },
      ]);
      if (!verify.ok) {
        if (attempts < spec.limits.maxVerifyAttempts) {
          prompt = `Verification failed (attempt ${attempts} of ${spec.limits.maxVerifyAttempts}). Fix the problem and commit. Do not delete or skip tests. Output of \`${spec.repo.verifyCommand}\`:\n\n${verify.summary}`;
          continue;
        }
        await api.trigger(
          'verify_failed',
          `\`${spec.repo.verifyCommand}\` failed ${attempts} times. Last output:\n${verify.summary}`,
        );
        await events.flush();
        await api.finished('blocked');
        return 'blocked';
      }

      await pushBranch(repoDir, spec.repo.branch, spec.git.token);
      events.push([{ type: 'branch.pushed', payload: { branch: spec.repo.branch } }]);
      const seconds = Math.max(1, Math.round(verify.durationMs / 1000));
      const pr = await api.pullRequest({
        title: trimTitle(spec.title),
        body: [
          `Task: ${spec.title}`,
          '',
          '## Summary',
          r.finalText || '(the agent gave no summary)',
          '',
          '## Verification',
          `\`${spec.repo.verifyCommand}\` passed in ${seconds}s (attempt ${attempts}).`,
          '',
          `_Opened by the Autonomous SDLC platform. Run ${spec.runId}._`,
        ].join('\n'),
        diff,
        verify: {
          ok: true,
          command: spec.repo.verifyCommand,
          attempts,
          durationMs: verify.durationMs,
          summary: verify.summary.slice(-500),
        },
        summary: r.finalText,
      });
      events.push([{ type: 'pull_request.created', payload: { number: pr.number, url: pr.url } }]);
      await events.flush();
      await api.finished('finished', r.finalText);
      return 'finished';
    }
  } catch (e) {
    if (e instanceof RunInactiveError) return 'cancelled';
    const msg = e instanceof Error ? e.message : String(e);
    log(`runner failed: ${msg}`);
    await api.finished('error', msg.slice(0, 2000)).catch(() => {});
    return 'error';
  } finally {
    clearInterval(poller);
    await events.stop();
    engine?.kill();
  }
}
