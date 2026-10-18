import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface LaunchInput {
  runId: string;
  token: string;
  apiUrl: string;
}

export interface Launched {
  /** Resolves when the runner process ends, with its exit code. */
  done: Promise<{ code: number | null }>;
  kill: () => void;
}

/**
 * Starts a runner for one run. `process` is a child process on this machine (no isolation: scratch repositories only).
 * `docker` is an isolated container (see DockerRunner).
 */
export interface RunnerAdapter {
  launch(input: LaunchInput): Promise<Launched>;
  /** Removes what a finished run left behind (its checkout volume). Called once the run can never resume. */
  release?(runId: string): Promise<void>;
  /** Removes sandboxes left over from an earlier API process. Called once at start-up. */
  reconcile?(): Promise<void>;
  /** Stops what the adapter keeps running between runs. Called when the platform shuts down. */
  close?(): Promise<void>;
}

// The runner and the engine get a small environment. Platform and provider secrets are never inherited.
const INHERITED = [
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
  'LANG',
];

export class ProcessRunner implements RunnerAdapter {
  constructor(private readonly opts: { runsDir: string; entry: string; cwd: string }) {}

  async launch(input: LaunchInput): Promise<Launched> {
    const workDir = path.resolve(this.opts.runsDir, input.runId);
    await mkdir(workDir, { recursive: true });
    const env: Record<string, string> = {};
    for (const k of INHERITED) if (process.env[k]) env[k] = process.env[k]!;
    env.SDLC_API_URL = input.apiUrl;
    env.SDLC_RUN_TOKEN = input.token;
    env.SDLC_WORK_DIR = workDir;

    const child: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve(this.opts.cwd, this.opts.entry)],
      {
        cwd: this.opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const prefix = `[runner ${input.runId.slice(0, 8)}]`;
    const forward = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/))
        if (line.trim()) console.log(`${prefix} ${line}`);
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    const done = new Promise<{ code: number | null }>((resolve) => {
      child.on('error', () => resolve({ code: null }));
      child.on('exit', (code) => resolve({ code }));
    });
    return { done, kill: () => void child.kill() };
  }
}
