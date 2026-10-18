import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startDevDb } from './index.js';
import type { DevDb } from './index.js';

let dir: string;
let db: DevDb;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-devdb-'));
  db = await startDevDb({ dataDir: dir, port: 56339 });
}, 120_000);

afterAll(async () => {
  await db?.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('the development database', () => {
  it('is UTF8, so it stores what test runners and people write', async () => {
    const c = new pg.Client(db.url);
    await c.connect();
    try {
      const enc = await c.query(
        "select pg_encoding_to_char(encoding) as e from pg_database where datname = 'sdlc'",
      );
      expect(enc.rows[0].e).toBe('UTF8');
      await c.query('create temp table t (s text)');
      const text = '✔ GET /health returns ok ℹ naïve café 日本語';
      await c.query('insert into t values ($1)', [text]);
      expect((await c.query('select s from t')).rows[0].s).toBe(text);
    } finally {
      await c.end();
    }
  });
});
