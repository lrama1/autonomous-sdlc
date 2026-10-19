import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

// How the platform runs a smoke test's commands inside a Fargate preview (mvp-contract section 16, smoke test). A preview
// has no way to call the platform, so the platform calls it: this small server takes one command at a time, runs it in
// the preview's folder with the same environment the previewed program has, and answers with its exit code and output.
// It answers only to the platform's own addresses (the preview's security group) and only with the preview's secret token.
// The previewed program runs in this same container as the same user, so it could do anything this server does.

export const CONTROL_PORT_DEFAULT = 38917;
const MAX_BODY = 16 * 1024;
const MAX_OUTPUT = 16_000;
const MAX_TIMEOUT_MS = 120_000;

export interface ExecResult {
  exitCode: number;
  output: string;
}

export type CommandRunner = (command: string, timeoutMs: number) => Promise<ExecResult>;

/**
 * Runs one command with `sh -c`. A command that overruns is killed with everything it started, and the answer does not
 * wait for what is left of it: it is exit -1 at the limit.
 */
export function shellRunner(dir: string, env: Record<string, string>): CommandRunner {
  return (command, timeoutMs) =>
    new Promise((resolve) => {
      // Its own process group, so the whole tree can be killed: a `sleep` under `sh` would otherwise outlive both.
      const child = spawn('sh', ['-c', command], {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let output = '';
      const keep = (b: Buffer) => (output = (output + b.toString()).slice(-MAX_OUTPUT));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      let settled = false;
      const settle = (r: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        settle({
          exitCode: -1,
          output: `${output}\nstopped after ${Math.round(timeoutMs / 1000)} s`,
        });
      }, timeoutMs);
      child.on('error', (e) =>
        settle({ exitCode: -1, output: `could not run the command: ${e.message}` }),
      );
      child.on('close', (code) => settle({ exitCode: code ?? -1, output }));
    });
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The control server. One command at a time: a second request waits for the first. */
export function createControlServer(opts: { token: string; run: CommandRunner }): http.Server {
  let queue: Promise<unknown> = Promise.resolve();
  return http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !same(auth.slice(7), opts.token))
      return reply(401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/exec') return reply(404, { error: 'not found' });
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reply(413, { error: 'too large' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body: { command?: unknown; timeoutMs?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {
        return reply(400, { error: 'not JSON' });
      }
      if (
        typeof body.command !== 'string' ||
        body.command.trim() === '' ||
        /[\r\n]/.test(body.command)
      )
        return reply(400, { error: 'command must be one line of text' });
      const timeoutMs =
        typeof body.timeoutMs === 'number' && body.timeoutMs > 0
          ? Math.min(body.timeoutMs, MAX_TIMEOUT_MS)
          : 60_000;
      const command = body.command;
      queue = queue
        .catch(() => {})
        .then(async () => reply(200, await opts.run(command, timeoutMs)))
        .catch((e) => reply(500, { error: e instanceof Error ? e.message : String(e) }));
    });
  });
}
