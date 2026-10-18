import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// No database is running for these tests. They cover what must work (or fail cleanly) without one.
const config = loadConfig({
  DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none',
  OIDC_ISSUER: 'http://localhost:9000',
  OIDC_CLIENT_ID: 'sdlc-web',
  OIDC_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
});

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ config });
});
afterAll(async () => {
  await app.close();
});

describe('api without a database', () => {
  it('/healthz reports ok', async () => {
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'api' });
  });

  it('/readyz reports not ready when the database is down', async () => {
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { database: 'fail' } });
  });

  it('/api/me needs a session', async () => {
    const res = await app.inject('/api/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('/api/me rejects a forged session cookie', async () => {
    const res = await app.inject({
      url: '/api/me',
      headers: { cookie: 'sdlc_session=0190a000-0000-7000-8000-000000000000.9999999999' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('/auth/callback without a sign-in in progress is a clear 400', async () => {
    const res = await app.inject('/auth/callback?code=abc&state=xyz');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('login_expired');
  });
});
