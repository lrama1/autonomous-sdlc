import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, integrationEntry, runMigrations } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { sameSecret } from './egress-routes.js';
import { MemorySecrets } from './secrets.js';

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let on: Awaited<ReturnType<typeof buildApp>>;
let off: Awaited<ReturnType<typeof buildApp>>;
const TOKEN = 'egress-token-0123456789abcdef';

const base = (extra: Record<string, string> = {}) => ({
  DATABASE_URL: '',
  OIDC_ISSUER: 'http://localhost:9000',
  OIDC_CLIENT_ID: 'x',
  OIDC_CLIENT_SECRET: 'x',
  SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  ...extra,
});

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-egress-'));
  devDb = await startDevDb({ dataDir, port: 56351 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const build = (extra: Record<string, string>) =>
    buildApp({
      config: loadConfig({ ...base(extra), DATABASE_URL: devDb.url }),
      deps: made,
      workers: false,
      secrets: new MemorySecrets(),
    });
  on = await build({
    EGRESS_ALLOW_TOKEN: TOKEN,
    RUNNER_EGRESS_ALLOW: 'GitHub.com, registry.npmjs.org',
  });
  // A second app on the same database cannot own the pool twice, so it only needs to answer one request.
  off = await build({});
  await on.ready();
}, 180_000);

afterAll(async () => {
  await on?.close();
  await off?.close();
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

const get = (app: typeof on, auth?: string) =>
  app.inject({
    method: 'GET',
    url: '/api/internal/egress-allow',
    headers: auth ? { authorization: auth } : {},
  });

describe('the egress allowlist route', () => {
  it('is off when no token is configured, and refuses a missing or wrong token', async () => {
    expect((await get(off, `Bearer ${TOKEN}`)).statusCode).toBe(404);
    expect((await get(on)).statusCode).toBe(401);
    expect((await get(on, 'Bearer nope')).statusCode).toBe(401);
    expect((await get(on, TOKEN)).statusCode).toBe(401);
    expect((await get(on, `Bearer ${TOKEN}x`)).statusCode).toBe(401);
  });

  it('gives the fixed hosts plus every confirmed register entry, and follows the register', async () => {
    const first = await get(on, `Bearer ${TOKEN}`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ hosts: ['github.com', 'registry.npmjs.org'] });

    const entry = (name: string, status: string, hosts: string[]) => ({ name, status, hosts });
    await db
      .insert(integrationEntry)
      .values([
        entry('Stripe', 'confirmed', ['API.Stripe.com']),
        entry('Draft', 'proposed', ['draft.example.com']),
      ]);
    const next = await get(on, `Bearer ${TOKEN}`);
    expect(next.json()).toEqual({ hosts: ['api.stripe.com', 'github.com', 'registry.npmjs.org'] });
  });
});

describe('sameSecret', () => {
  it('compares without caring where two secrets differ', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', '')).toBe(true);
  });
});
