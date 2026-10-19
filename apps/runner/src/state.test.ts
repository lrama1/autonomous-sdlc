import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { restoreState, saveState } from './state.js';

let server: http.Server;
let base: string;
let dir: string;
let stored: Buffer | null = null;
let failNext: number[] = [];
const logs: string[] = [];
const o = { log: (l: string) => logs.push(l), retryMs: 1 };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-state-test-'));
  server = http.createServer((req, res) => {
    const forced = failNext.shift();
    if (forced) {
      res.statusCode = forced;
      return res.end('no');
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        stored = Buffer.concat(chunks);
        res.end();
      });
      return;
    }
    if (!stored) {
      res.statusCode = 404;
      return res.end('missing');
    }
    res.end(stored);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/state.tgz`;
});

beforeEach(() => {
  stored = null;
  failNext = [];
  logs.length = 0;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function workDir(name: string, files: Record<string, string>) {
  const w = path.join(dir, name);
  for (const [f, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(w, f)), { recursive: true });
    await writeFile(path.join(w, f), text);
  }
  return w;
}

describe("a parked run's files", () => {
  it('are saved and put back, without the run token', async () => {
    const before = await workDir('a', {
      'repo/.git/HEAD': 'ref: refs/heads/agent/x',
      'repo/src/code.js': 'export const x = 1;\n',
      'repo/node_modules/dep/index.js': 'module.exports = 1;\n',
      'home/.claude/projects/p/session.jsonl': '{"a":1}\n',
      'session.json': '{"sessionId":"s-1"}',
      'mcp.json': '{"Authorization":"Bearer SECRET-RUN-TOKEN"}',
    });
    await saveState(before, base, o);
    expect(stored!.length).toBeGreaterThan(100);
    expect(stored!.includes(Buffer.from('SECRET-RUN-TOKEN'))).toBe(false);

    const after = path.join(dir, 'b');
    expect(await restoreState(after, base, o)).toBe('restored');
    expect(await readFile(path.join(after, 'repo/src/code.js'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(await readFile(path.join(after, 'repo/node_modules/dep/index.js'), 'utf8')).toContain(
      'module.exports',
    );
    expect(await readFile(path.join(after, 'home/.claude/projects/p/session.jsonl'), 'utf8')).toBe(
      '{"a":1}\n',
    );
    expect(JSON.parse(await readFile(path.join(after, 'session.json'), 'utf8'))).toEqual({
      sessionId: 's-1',
    });
    await expect(readFile(path.join(after, 'mcp.json'))).rejects.toThrow();
    expect(logs.join('\n')).toContain('saved the state');
    expect(logs.join('\n')).toContain('restored the saved state');
  });

  it('start fresh when nothing was saved', async () => {
    const w = path.join(dir, 'fresh');
    expect(await restoreState(w, base, o)).toBe('fresh');
    expect(logs.join('\n')).toContain('this is a fresh run');
  });

  it('are fetched again after a passing failure, but a refusal stops the run rather than start it empty', async () => {
    const before = await workDir('c', { 'session.json': '{"sessionId":"s-2"}' });
    await saveState(before, base, o);
    failNext = [500, 503];
    const w = path.join(dir, 'd');
    expect(await restoreState(w, base, o)).toBe('restored');
    expect(logs.join('\n')).toContain('trying again');

    failNext = [403, 403, 403, 403];
    await expect(restoreState(path.join(dir, 'e'), base, o)).rejects.toThrow('HTTP 403');
  });

  it('are uploaded again after a passing failure, and an upload that keeps failing is an error', async () => {
    const w = await workDir('f', { 'session.json': '{}' });
    failNext = [500];
    await saveState(w, base, o);
    expect(stored).not.toBeNull();
    stored = null;
    failNext = [500, 500, 500, 500];
    await expect(saveState(w, base, o)).rejects.toThrow('HTTP 500');
    expect(stored).toBeNull();
  });
});
