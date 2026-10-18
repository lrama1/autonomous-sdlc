import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meSchema } from '@sdlc/schemas';
import { CookieJar, signInAs } from './signin.js';
import { startStack } from './stack.js';
import type { Stack } from './stack.js';

// Starts the real stack (PostgreSQL, IdP, API, gateway, web) on spare ports. Takes a few seconds.
let stack: Stack;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-test-'));
  stack = await startStack({
    dataDir,
    ports: { web: 25173, api: 28080, gateway: 28787, idp: 29000, db: 56329 },
    apiEnv: { BOOTSTRAP_ADMIN_EMAIL: 'alice@example.test' },
    log: () => {},
  });
}, 180_000);

afterAll(async () => {
  await stack?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('local stack', () => {
  it('serves health and readiness through the web origin', async () => {
    const jar = new CookieJar();
    expect((await jar.fetch(`${stack.publicUrl}/healthz`)).status).toBe(200);
    const ready = await jar.fetch(`${stack.publicUrl}/readyz`);
    expect(JSON.parse(ready.text)).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('is signed out by default', async () => {
    const res = await new CookieJar().fetch(`${stack.publicUrl}/api/me`);
    expect(res.status).toBe(401);
  });

  it('signs in through the OIDC flow and returns the person with their hats', async () => {
    const jar = await signInAs(stack.publicUrl, 'dev-cara');
    const res = await jar.fetch(`${stack.publicUrl}/api/me`);
    expect(res.status).toBe(200);
    expect(meSchema.parse(JSON.parse(res.text))).toMatchObject({
      displayName: 'Cara Okafor',
      roles: ['architect'],
    });
  });

  it('gives the configured bootstrap address the admin hat, and nobody else', async () => {
    const alice = await signInAs(stack.publicUrl, 'dev-alice');
    const me = meSchema.parse(JSON.parse((await alice.fetch(`${stack.publicUrl}/api/me`)).text));
    expect(me.roles).toEqual(expect.arrayContaining(['product_owner', 'platform_admin']));
    const bob = await signInAs(stack.publicUrl, 'dev-bob');
    const other = meSchema.parse(JSON.parse((await bob.fetch(`${stack.publicUrl}/api/me`)).text));
    expect(other.roles).not.toContain('platform_admin');
  });

  it('writes a login row to the activity log', async () => {
    const { default: pg } = await import('pg');
    const client = new pg.Client(stack.databaseUrl);
    await client.connect();
    try {
      const rows = await client.query(
        "select detail from activity_event where action = 'auth.login'",
      );
      expect(rows.rows.map((r) => r.detail.subject)).toContain('dev-cara');
    } finally {
      await client.end();
    }
  });

  it('signing out ends the session', async () => {
    const jar = await signInAs(stack.publicUrl, 'dev-alice');
    expect((await jar.fetch(`${stack.publicUrl}/api/me`)).status).toBe(200);
    await jar.fetch(`${stack.publicUrl}/auth/logout`, { method: 'POST' });
    expect((await jar.fetch(`${stack.publicUrl}/api/me`)).status).toBe(401);
  });
});
