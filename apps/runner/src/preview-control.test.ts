import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlServer, shellRunner } from './preview-control.js';
import type { CommandRunner } from './preview-control.js';

let server: Server;
let base: string;
const seen: Array<[string, number]> = [];
let active = 0;
let maxActive = 0;

const run: CommandRunner = async (command, ms) => {
  seen.push([command, ms]);
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise((r) => setTimeout(r, command === 'slow' ? 60 : 1));
  active--;
  return command === 'bad' ? { exitCode: 3, output: 'it broke' } : { exitCode: 0, output: 'fine' };
};

beforeAll(async () => {
  server = createControlServer({ token: 'secret-token', run });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server?.close(r));
});

const post = (body: unknown, token: string | null = 'secret-token', path = '/exec') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the preview control server', () => {
  it('runs a command and answers with its exit code and output', async () => {
    const ok = await post({ command: 'npm run smoke', timeoutMs: 5000 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ exitCode: 0, output: 'fine' });
    const bad = await post({ command: 'bad' });
    expect(await bad.json()).toEqual({ exitCode: 3, output: 'it broke' });
    expect(seen).toContainEqual(['npm run smoke', 5000]);
    expect(seen).toContainEqual(['bad', 60_000]);
  });

  it('answers nobody without the token', async () => {
    const before = seen.length;
    expect((await post({ command: 'x' }, null)).status).toBe(401);
    expect((await post({ command: 'x' }, 'wrong')).status).toBe(401);
    expect((await post({ command: 'x' }, 'secret-token-longer')).status).toBe(401);
    expect(seen.length).toBe(before);
  });

  it('refuses what is not a single command, and unknown paths', async () => {
    expect((await post({ command: '' })).status).toBe(400);
    expect((await post({ command: 'a\nb' })).status).toBe(400);
    expect((await post({ command: 7 })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await post({ command: 'x' }, 'secret-token', '/other')).status).toBe(404);
    const get = await fetch(`${base}/exec`, { headers: { authorization: 'Bearer secret-token' } });
    expect(get.status).toBe(404);
  });

  it('caps how long a command may run, and how big a request may be', async () => {
    seen.length = 0;
    await post({ command: 'x', timeoutMs: 9_999_999 });
    expect(seen[0]).toEqual(['x', 120_000]);
    const big = await post({ command: 'x'.repeat(20_000) }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
  });

  it('runs one command at a time', async () => {
    maxActive = 0;
    await Promise.all([
      post({ command: 'slow' }),
      post({ command: 'slow' }),
      post({ command: 'slow' }),
    ]);
    expect(maxActive).toBe(1);
  });
});

// Real commands run through `sh`, which a Windows machine may not have. CI runs these.
describe.skipIf(process.platform === 'win32')('the shell runner', () => {
  it('runs in the folder with the given environment and reports the exit code', async () => {
    const r = shellRunner('/tmp', { PATH: process.env.PATH ?? '', GREETING: 'hello' });
    expect(await r('echo $GREETING from $(pwd)', 5000)).toEqual({
      exitCode: 0,
      output: 'hello from /tmp\n',
    });
    expect(await r('echo oops >&2; exit 4', 5000)).toEqual({ exitCode: 4, output: 'oops\n' });
  });

  it('does not pass on anything it was not given', async () => {
    const r = shellRunner('/tmp', { PATH: process.env.PATH ?? '' });
    process.env.SECRET_FOR_THIS_TEST = 'x';
    expect((await r('echo "[$SECRET_FOR_THIS_TEST]"', 5000)).output).toBe('[]\n');
  });

  it('kills a command that runs too long', async () => {
    const r = shellRunner('/tmp', { PATH: process.env.PATH ?? '' });
    const out = await r('sleep 30', 300);
    expect(out.exitCode).toBe(-1);
    expect(out.output).toContain('stopped after');
  });
});
