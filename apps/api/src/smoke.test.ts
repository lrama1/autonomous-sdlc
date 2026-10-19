import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SmokeCheck } from '@sdlc/core';
import { runSmoke } from './smoke.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health') return void res.end('ok');
    if (req.url === '/items') {
      res.setHeader('content-type', 'application/json');
      return void res.end('{"items":[1,2,3]}');
    }
    if (req.url === '/created') return void res.writeHead(201).end('made');
    if (req.url === '/old') return void res.writeHead(302, { location: '/health' }).end();
    if (req.url === '/boom') return void res.writeHead(500).end('stack trace here\nwith lines');
    if (req.url === '/slow') return; // never answers
    res.writeHead(404).end('nothing at ' + req.url);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const get = (path: string, status = 200, contains: string | null = null): SmokeCheck => ({
  kind: 'get',
  path,
  status,
  contains,
});

describe('runSmoke', () => {
  it('passes when every check passes, and says what each did', async () => {
    const r = await runSmoke({
      baseUrl: base,
      checks: [get('/health'), get('/items', 200, '"items"'), get('/created', 201)],
    });
    expect(r.passed).toBe(true);
    expect(r.results.map((x) => [x.label, x.ok, x.detail])).toEqual([
      ['GET /health', true, '200'],
      ['GET /items', true, '200'],
      ['GET /created', true, '201'],
    ]);
  });

  it('runs every check even after one fails, and fails as a whole', async () => {
    const r = await runSmoke({
      baseUrl: base,
      checks: [get('/boom'), get('/health'), get('/missing')],
    });
    expect(r.passed).toBe(false);
    expect(r.results.map((x) => x.ok)).toEqual([false, true, false]);
    expect(r.results[0]!.detail).toBe('expected 200, got 500: stack trace here with lines');
    expect(r.results[2]!.detail).toContain('expected 200, got 404');
  });

  it('checks the body when asked, and does not follow a redirect', async () => {
    const r = await runSmoke({
      baseUrl: base,
      checks: [get('/items', 200, 'nope'), get('/old', 302), get('/old')],
    });
    expect(r.results.map((x) => x.ok)).toEqual([false, true, false]);
    expect(r.results[0]!.detail).toContain('does not contain "nope"');
    expect(r.results[2]!.detail).toBe('expected 200, got 302');
  });

  it('fails a check that gets no answer or cannot connect', async () => {
    const r = await runSmoke({
      baseUrl: base,
      checks: [get('/slow')],
      getTimeoutMs: 200,
    });
    expect(r.results[0]).toMatchObject({ ok: false, detail: 'no answer within 0.2 s' });
    const down = await runSmoke({ baseUrl: 'http://127.0.0.1:1', checks: [get('/')] });
    expect(down.results[0]!.ok).toBe(false);
    expect(down.results[0]!.detail).toContain('could not connect');
  });

  it('runs commands through exec, by exit code', async () => {
    const calls: Array<[string, number]> = [];
    const r = await runSmoke({
      baseUrl: base,
      checks: [
        { kind: 'run', command: 'npm run smoke' },
        { kind: 'run', command: 'exit 3' },
        { kind: 'run', command: 'throws' },
      ],
      runTimeoutMs: 5000,
      exec: async (command, ms) => {
        calls.push([command, ms]);
        if (command === 'throws') throw new Error('docker is gone');
        return command === 'exit 3'
          ? { exitCode: 3, output: 'bad things\n' }
          : { exitCode: 0, output: '12 checks ok\n' };
      },
    });
    expect(calls).toEqual([
      ['npm run smoke', 5000],
      ['exit 3', 5000],
      ['throws', 5000],
    ]);
    expect(r.results.map((x) => [x.ok, x.detail])).toEqual([
      [true, '12 checks ok'],
      [false, 'exit 3: bad things'],
      [false, 'docker is gone'],
    ]);
    expect(r.passed).toBe(false);
  });

  it('fails a command check on a host that cannot run commands', async () => {
    const r = await runSmoke({ baseUrl: base, checks: [{ kind: 'run', command: 'x' }] });
    expect(r.results[0]).toMatchObject({
      ok: false,
      detail: 'this host cannot run commands in the preview',
    });
  });

  it('does not pass when there is nothing to check', async () => {
    expect(await runSmoke({ baseUrl: base, checks: [] })).toEqual({ passed: false, results: [] });
  });

  it('keeps long output short', async () => {
    const r = await runSmoke({
      baseUrl: base,
      checks: [{ kind: 'run', command: 'x' }],
      exec: async () => ({ exitCode: 1, output: 'a'.repeat(5000) + 'END' }),
    });
    expect(r.results[0]!.detail.length).toBeLessThan(450);
    expect(r.results[0]!.detail.endsWith('END')).toBe(true);
  });
});
