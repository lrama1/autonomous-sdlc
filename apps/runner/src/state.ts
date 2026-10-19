import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

// A parked run keeps its files between one task and the next (spec 12.4, Fargate). The platform gives the runner two
// signed addresses for one object, so the runner needs no cloud credentials. Nothing here runs unless they are given.

/** The run's tool configuration holds the run token, which is renewed on resume, so it never goes into the snapshot. */
const EXCLUDE = ['./mcp.json'];

export interface StateOptions {
  log: (line: string) => void;
  /** Tries per request before giving up, and the wait between them. */
  attempts?: number;
  retryMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmpFile = () => path.join(os.tmpdir(), `sdlc-state-${process.pid}.tgz`);

async function withRetries<T>(what: string, o: StateOptions, fn: () => Promise<T>): Promise<T> {
  const attempts = o.attempts ?? 4;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      o.log(`${what} failed (${e instanceof Error ? e.message : String(e)}), trying again`);
      await sleep(o.retryMs ?? 2000);
    }
  }
}

/**
 * Puts a parked run's files back. A missing object is a fresh run and is not an error. Any other answer is: carrying
 * on without the files would resume a conversation in an empty checkout.
 */
export async function restoreState(
  workDir: string,
  getUrl: string,
  o: StateOptions,
): Promise<'restored' | 'fresh'> {
  const file = tmpFile();
  await mkdir(workDir, { recursive: true });
  try {
    const found = await withRetries('downloading the saved state', o, async () => {
      const res = await fetch(getUrl, { signal: AbortSignal.timeout(10 * 60_000) });
      if (res.status === 404) return false;
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
      return true;
    });
    if (!found) {
      o.log('no saved state: this is a fresh run');
      return 'fresh';
    }
    await run('tar', ['-xzf', file, '-C', workDir], { maxBuffer: 16 * 1024 * 1024 });
    const { size } = await stat(file);
    o.log(`restored the saved state (${Math.round(size / 1024 / 1024)} MB compressed)`);
    return 'restored';
  } finally {
    await rm(file, { force: true });
  }
}

function put(url: string, file: string, size: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'PUT', headers: { 'content-length': String(size) }, timeout: 10 * 60_000 },
      (res) => {
        res.resume();
        res.on('end', () =>
          res.statusCode && res.statusCode < 300
            ? resolve()
            : reject(new Error(`HTTP ${res.statusCode}`)),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    createReadStream(file).on('error', reject).pipe(req);
  });
}

/** Saves the run's files, so the next task can carry on from them. */
export async function saveState(workDir: string, putUrl: string, o: StateOptions): Promise<void> {
  const file = tmpFile();
  try {
    await run('tar', ['-czf', file, ...EXCLUDE.map((e) => `--exclude=${e}`), '-C', workDir, '.'], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const { size } = await stat(file);
    await withRetries('uploading the state', o, () => put(putUrl, file, size));
    o.log(`saved the state (${Math.round(size / 1024 / 1024)} MB compressed)`);
  } finally {
    await rm(file, { force: true });
  }
}
