import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchCode, previewEnvFrom, startProgram } from './preview.js';

let dir: string;
let server: http.Server;
let base: string;
let archive: Buffer;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-preview-boot-'));
  const top = path.join(dir, 'src', 'owner-repo-abc');
  await mkdir(path.join(top, 'app'), { recursive: true });
  await writeFile(path.join(top, 'app', 'out.txt'), 'from the archive');
  execFileSync('tar', [
    '-czf',
    path.join(dir, 'a.tgz'),
    '-C',
    path.join(dir, 'src'),
    'owner-repo-abc',
  ]);
  archive = await readFile(path.join(dir, 'a.tgz'));
  server = http.createServer((req, res) => {
    if (req.url === '/code.tgz') return res.end(archive);
    res.statusCode = 403;
    res.end('expired');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('previewEnvFrom', () => {
  it('needs the code address and a start command, and hides what it was given from the program', () => {
    expect(previewEnvFrom({})).toEqual({
      error: 'PREVIEW_CODE_URL and PREVIEW_START are required',
    });
    const r = previewEnvFrom({
      PREVIEW_CODE_URL: 'https://s3/signed?X-Amz-Signature=abc',
      PREVIEW_START: 'npm start',
      PREVIEW_INSTALL: 'npm ci',
      PORT: '4000',
      HTTPS_PROXY: 'http://egress:3128',
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.env).toEqual({
      codeUrl: 'https://s3/signed?X-Amz-Signature=abc',
      install: 'npm ci',
      start: 'npm start',
      dir: '/work',
    });
    expect(r.childEnv).toEqual({ PORT: '4000', HTTPS_PROXY: 'http://egress:3128' });
  });
});

// The programs run through `sh`, which the sandbox image has and a Windows machine may not. CI runs these.
describe.skipIf(process.platform === 'win32')('running a preview', () => {
  it('fetches and unpacks the code, then runs install and start in their own folders', async () => {
    const work = path.join(dir, 'work');
    const env = {
      codeUrl: `${base}/code.tgz`,
      install: 'cd app && echo installed > ../install.txt',
      start: 'cd app && cat out.txt > ../started.txt',
      dir: work,
    };
    const logs: string[] = [];
    await fetchCode(env, (l) => logs.push(l));
    expect(await readFile(path.join(work, 'app', 'out.txt'), 'utf8')).toBe('from the archive');
    const { done } = startProgram(env, { PATH: process.env.PATH ?? '' });
    expect(await done).toBe(0);
    expect((await readFile(path.join(work, 'install.txt'), 'utf8')).trim()).toBe('installed');
    expect(await readFile(path.join(work, 'started.txt'), 'utf8')).toBe('from the archive');
  });

  it('does not start anything when the install fails, and reports its exit code', async () => {
    const work = path.join(dir, 'work2');
    const env = {
      codeUrl: `${base}/code.tgz`,
      install: 'exit 7',
      start: 'touch ran.txt',
      dir: work,
    };
    await fetchCode(env, () => {});
    expect(await startProgram(env, { PATH: process.env.PATH ?? '' }).done).toBe(7);
    await expect(readFile(path.join(work, 'ran.txt'))).rejects.toThrow();
  });

  it('passes a stop on to the program, and refuses an address that no longer works', async () => {
    const work = path.join(dir, 'work3');
    const env = { codeUrl: `${base}/code.tgz`, install: null, start: 'sleep 30', dir: work };
    await fetchCode(env, () => {});
    const { child, done } = startProgram(env, { PATH: process.env.PATH ?? '' });
    setTimeout(() => child.kill('SIGTERM'), 100);
    expect(await done).toBe(143);
    await expect(fetchCode({ ...env, codeUrl: `${base}/old.tgz` }, () => {})).rejects.toThrow(
      'HTTP 403',
    );
  });
});
