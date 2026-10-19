import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

// What starts inside a Fargate preview task (spec 12.4, previews): fetch the pull request's code from the address the
// platform gave, unpack it, and run the repository's own install and start commands. The task has no credentials, so
// the code comes by a signed address, and the program that runs is given none of the platform's variables.

export interface PreviewEnv {
  codeUrl: string;
  install: string | null;
  start: string;
  dir: string;
}

/** Reads what the platform passed in. The two addresses and commands are removed from what the previewed program sees. */
export function previewEnvFrom(
  e: Record<string, string | undefined>,
): { env: PreviewEnv; childEnv: Record<string, string> } | { error: string } {
  if (!e.PREVIEW_CODE_URL || !e.PREVIEW_START)
    return { error: 'PREVIEW_CODE_URL and PREVIEW_START are required' };
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(e))
    if (v !== undefined && !k.startsWith('PREVIEW_')) childEnv[k] = v;
  return {
    env: {
      codeUrl: e.PREVIEW_CODE_URL,
      install: e.PREVIEW_INSTALL || null,
      start: e.PREVIEW_START,
      dir: e.PREVIEW_DIR || '/work',
    },
    childEnv,
  };
}

/** Downloads the code and unpacks it into `dir`. Throws with what went wrong. */
export async function fetchCode(env: PreviewEnv, log: (l: string) => void): Promise<void> {
  const file = path.join(os.tmpdir(), `preview-code-${process.pid}.tgz`);
  await mkdir(env.dir, { recursive: true });
  try {
    const res = await fetch(env.codeUrl, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`downloading the code: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    await run('tar', ['-xzf', file, '--strip-components=1', '--no-same-owner', '-C', env.dir]);
    log('unpacked the code');
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Runs the install and the start, each in its own subshell so a `cd` in one does not change where the other runs.
 * Output goes to this process's own, which the platform collects.
 */
export function startProgram(
  env: PreviewEnv,
  childEnv: Record<string, string>,
): { child: ChildProcess; done: Promise<number> } {
  const script = `${env.install ? `(${env.install}) && ` : ''}(${env.start})`;
  const child = spawn('sh', ['-c', script], { cwd: env.dir, env: childEnv, stdio: 'inherit' });
  const done = new Promise<number>((resolve) => {
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 143 : 1)));
  });
  return { child, done };
}
