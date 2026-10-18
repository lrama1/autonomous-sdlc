import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Runs git. The token (if any) is passed for this one command and never written to a config file.
 * Credential helpers are switched off so a helper on the machine cannot supply someone's own login.
 */
export async function git(
  cwd: string,
  args: string[],
  opts: { token?: string; allowFail?: boolean } = {},
): Promise<{ out: string; ok: boolean }> {
  const auth = opts.token
    ? [
        '-c',
        `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`,
      ]
    : [];
  try {
    const { stdout } = await exec('git', ['-c', 'credential.helper=', ...auth, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { out: stdout, ok: true };
  } catch (e) {
    if (opts.allowFail) return { out: String((e as { stdout?: string }).stdout ?? ''), ok: false };
    const err = e as { stderr?: string; message: string };
    // Never echo the token if git printed the command line.
    const text = (err.stderr || err.message).split(opts.token ?? '\u0000').join('***');
    // The original error holds the whole command line, including the token header, so it is not attached.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`git ${args[0]} failed: ${text.trim().slice(0, 600)}`);
  }
}

export async function cloneRepo(cloneUrl: string, dir: string, token: string): Promise<void> {
  // No line-ending conversion: the runner and the engine must see the same bytes. The engine runs without system git config.
  await git(process.cwd(), ['-c', 'core.autocrlf=false', 'clone', '--quiet', cloneUrl, dir], {
    token,
  });
}

export async function configureRepo(dir: string): Promise<void> {
  await git(dir, ['config', 'user.name', 'Autonomous SDLC Agent']);
  await git(dir, ['config', 'user.email', 'agent@users.noreply.github.com']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  // Local override: no credential helper for pushes the engine might try. Only the runner pushes.
  await git(dir, ['config', 'credential.helper', '']);
}

export async function checkoutWorkBranch(
  dir: string,
  branch: string,
  integrationBranch: string,
): Promise<void> {
  await git(dir, ['checkout', '--quiet', '-B', branch, `origin/${integrationBranch}`]);
}

/** Commits anything the engine left uncommitted. Returns true if it made a commit. */
export async function commitLeftovers(dir: string, message: string): Promise<boolean> {
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.out.trim()) return false;
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', message]);
  return true;
}

export async function commitsAhead(dir: string, integrationBranch: string): Promise<number> {
  const r = await git(dir, ['rev-list', '--count', `origin/${integrationBranch}..HEAD`]);
  return Number(r.out.trim());
}

export async function pushBranch(dir: string, branch: string, token: string): Promise<void> {
  await git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { token });
}

export async function fetchOrigin(dir: string, token: string): Promise<void> {
  await git(dir, ['fetch', '--quiet', 'origin'], { token });
}
