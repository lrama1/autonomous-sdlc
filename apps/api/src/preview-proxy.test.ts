import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, person, previewRun, runMigrations } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import {
  appCookies,
  cookieName,
  rewriteSetCookie,
  signAccess,
  verifyAccess,
} from './preview-proxy.js';
import { MemorySecrets } from './secrets.js';

const SECRET = 'unit-test-session-secret-0123456789abcdef';
const ORIGIN = 'https://previews.example.test';
const ID = '0198a9d0-3333-7000-8000-000000000001';

describe('access tokens', () => {
  const claim = { k: 'open' as const, id: ID, sub: 'p1', exp: 2000 };
  it('verify for the kind, the preview and the time they were made for', () => {
    const t = signAccess(SECRET, claim);
    expect(verifyAccess(SECRET, t, 'open', ID, 1000)).toMatchObject({ sub: 'p1' });
    expect(verifyAccess(SECRET, t, 'cookie', ID, 1000)).toBeNull();
    expect(
      verifyAccess(SECRET, t, 'open', '0198a9d0-3333-7000-8000-000000000002', 1000),
    ).toBeNull();
    expect(verifyAccess(SECRET, t, 'open', ID, 2000)).toBeNull();
    expect(verifyAccess('another-secret-0123456789abcdef0123', t, 'open', ID, 1000)).toBeNull();
  });
  it('refuse a changed or a made-up token', () => {
    const t = signAccess(SECRET, claim);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claim, sub: 'someone-else' })).toString(
      'base64url',
    );
    expect(verifyAccess(SECRET, `${forged}.${sig}`, 'open', ID, 1000)).toBeNull();
    expect(verifyAccess(SECRET, `${body}.AAAA`, 'open', ID, 1000)).toBeNull();
    for (const bad of [undefined, '', 'x', 'a.b.c', '.'])
      expect(verifyAccess(SECRET, bad, 'open', ID, 1000)).toBeNull();
  });
});

describe('cookies', () => {
  it("drops the platform's cookies and keeps the preview's own", () => {
    expect(appCookies('sdlc_session=abc; theme=dark; sdlc_pv_x=1')).toBe('theme=dark');
    expect(appCookies('sdlc_session=abc')).toBeUndefined();
    expect(appCookies(undefined)).toBeUndefined();
  });
  it("keeps a cookie the preview sets to the preview's own folder, with no domain", () => {
    expect(rewriteSetCookie('a=1; Path=/; Domain=evil.test; HttpOnly', ID)).toBe(
      `a=1; HttpOnly; Path=/${ID}/`,
    );
    expect(rewriteSetCookie('a=1; Path=/app', ID)).toBe(`a=1; Path=/${ID}/app`);
    expect(rewriteSetCookie('a=1', ID)).toBe(`a=1; Path=/${ID}/`);
  });
});

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let upstream: http.Server;
let target: string;
const seen: Array<{
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}> = [];
let n = 0;

async function newPerson() {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `P ${k}`, email: `x${k}@example.test`, oidcSubject: `x${k}` })
    .returning();
  return {
    id: p!.id,
    cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
  };
}

async function preview(state = 'ready', t: string | null = target) {
  const [row] = await db
    .insert(previewRun)
    .values({
      repository: 'o/r',
      prNumber: ++n,
      headSha: 'abc',
      state,
      target: t,
      url: 'https://x',
    })
    .returning();
  return row!.id;
}

const surface = { 'x-sdlc-surface': 'preview' };
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...surface, ...headers } });

/** Opens a preview as the platform would: a signed link, traded for the cookie. */
async function cookieFor(id: string, sub = 'p1') {
  const t = signAccess(SECRET, { k: 'open', id, sub, exp: Math.floor(Date.now() / 1000) + 300 });
  const res = await get(`/${id}/?t=${t}`);
  const cookie = [res.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0]!)
    .join('; ');
  return { res, cookie };
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/landing' });
        return res.end();
      }
      res.setHeader('content-type', 'text/html');
      res.setHeader('set-cookie', ['visit=1; Path=/; Domain=evil.test']);
      res.end(`<h1>preview ${req.url}</h1>`);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-proxy-'));
  devDb = await startDevDb({ dataDir, port: 56352 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: devDb.url,
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_CLIENT_ID: 'x',
      OIDC_CLIENT_SECRET: 'x',
      SESSION_SECRET: SECRET,
      PREVIEW_ORIGIN: ORIGIN,
    }),
    deps: made,
    workers: false,
    secrets: new MemorySecrets(),
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await new Promise((r) => upstream?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe("the door on the platform's address", () => {
  it('sends a signed-in person to the preview origin with a link, only for a running preview', async () => {
    const id = await preview();
    const who = await newPerson();
    expect((await app.inject({ method: 'GET', url: `/api/previews/${id}/open` })).statusCode).toBe(
      401,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/previews/${id}/open`,
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe(`/${id}/`);
    const claim = verifyAccess(
      SECRET,
      location.searchParams.get('t')!,
      'open',
      id,
      Math.floor(Date.now() / 1000),
    );
    expect(claim).toMatchObject({ sub: who.id });
    // The link works once it is used as an address, not as a cookie.
    expect(verifyAccess(SECRET, location.searchParams.get('t')!, 'cookie', id, 0)).toBeNull();

    const stopped = await preview('stopped');
    const gone = await app.inject({
      method: 'GET',
      url: `/api/previews/${stopped}/open`,
      headers: { cookie: who.cookie },
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('the preview origin', () => {
  it('asks for a link first, and trades a good link for a cookie that is kept to that preview', async () => {
    const id = await preview();
    expect((await get(`/${id}/`)).statusCode).toBe(401);
    expect((await get(`/${id}/?t=nonsense`)).statusCode).toBe(401);
    expect((await get(`/${id}`)).headers.location).toBe(`/${id}/`);

    const { res, cookie } = await cookieFor(id);
    expect(res.statusCode).toBe(302);
    // The app is then served from the root of the origin, so what it links to by absolute address works.
    expect(res.headers.location).toBe('/');
    const set = String(res.headers['set-cookie']);
    expect(set).toContain('Path=/;');
    expect(set).toContain(`sdlc_pv_cur=${id}`);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).not.toContain('t=');

    const page = await get(`/${id}/`, { cookie });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe('<h1>preview /</h1>');

    const other = await preview();
    expect((await get(`/${other}/`, { cookie })).statusCode).toBe(401);
  });

  it('refuses a cookie that has expired, and one made from a link that is not a cookie', async () => {
    const id = await preview();
    const old = signAccess(SECRET, {
      k: 'cookie',
      id,
      sub: 'p1',
      exp: Math.floor(Date.now() / 1000) - 5,
    });
    expect((await get(`/${id}/`, { cookie: `${cookieName(id)}=${old}` })).statusCode).toBe(401);
    const link = signAccess(SECRET, {
      k: 'open',
      id,
      sub: 'p1',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect((await get(`/${id}/`, { cookie: `${cookieName(id)}=${link}` })).statusCode).toBe(401);
  });

  it("passes requests to the preview without the platform's cookies or headers, and keeps what it sets to its own folder", async () => {
    const id = await preview();
    const { cookie } = await cookieFor(id);
    seen.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: `/${id}/a/b?x=1&y=2`,
      headers: {
        ...surface,
        cookie: `${cookie}; sdlc_session=SECRET-SESSION; theme=dark`,
        'x-origin-verify': 'secret',
        'content-type': 'text/plain',
      },
      payload: 'hello body',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>preview /a/b?x=1&y=2</h1>');
    const s = seen.at(-1)!;
    expect(s.method).toBe('POST');
    expect(s.url).toBe('/a/b?x=1&y=2');
    expect(s.body).toBe('hello body');
    expect(s.headers.cookie).toBe('theme=dark');
    expect(JSON.stringify(s.headers)).not.toContain('SECRET-SESSION');
    expect(s.headers['x-origin-verify']).toBeUndefined();
    expect(s.headers['x-sdlc-surface']).toBeUndefined();
    expect(s.headers['x-forwarded-prefix']).toBe(`/${id}`);
    expect(s.headers['x-forwarded-host']).toBe('previews.example.test');
    expect([res.headers['set-cookie']].flat()).toEqual([`visit=1; Path=/${id}/`]);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const redirect = await get(`/${id}/redirect`, { cookie });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(`/${id}/landing`);
  });

  it('serves the app from the root of the origin, so absolute addresses in its pages work', async () => {
    const id = await preview();
    const { cookie } = await cookieFor(id);
    seen.length = 0;
    const asset = await get('/assets/app.js?v=3', { cookie });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('<h1>preview /assets/app.js?v=3</h1>');
    const s = seen.at(-1)!;
    expect(s.url).toBe('/assets/app.js?v=3');
    expect(s.headers['x-forwarded-prefix']).toBeUndefined();
    // Its cookie keeps its own path, and its redirects keep their address.
    expect([asset.headers['set-cookie']].flat()).toEqual(['visit=1; Path=/']);
    const redirect = await get('/redirect', { cookie });
    expect(redirect.headers.location).toBe('/landing');

    // Without the cookie for it, or after it stopped, nothing is served.
    expect((await get('/assets/app.js', { cookie: `sdlc_pv_cur=${id}` })).statusCode).toBe(401);
    expect((await get('/assets/app.js', { cookie: 'sdlc_pv_cur=nonsense' })).statusCode).toBe(404);
    await db.update(previewRun).set({ state: 'stopped' }).where(eq(previewRun.id, id));
    expect((await get('/assets/app.js', { cookie })).statusCode).toBe(404);
  });
  it("serves nothing but previews: not the API, not the web app, not another preview's state", async () => {
    for (const url of [
      '/',
      '/api/me',
      '/healthz',
      '/readyz',
      '/admin/github',
      '/api/previews/x/open',
    ])
      expect((await get(url)).statusCode, url).toBe(404);
    const id = await preview();
    const { cookie } = await cookieFor(id);
    // An address with no preview in it is the preview this browser opened: its own program answers, not the platform.
    const own = await get('/api/costs', { cookie });
    expect(own.statusCode).toBe(200);
    expect(own.body).toBe('<h1>preview /api/costs</h1>');
    // And the platform's own address does not serve previews.
    const platform = await app.inject({ method: 'GET', url: `/${id}/`, headers: { cookie } });
    expect(platform.statusCode).toBe(404);
    expect(platform.body).not.toContain('preview');
  });

  it('says so when the preview is not running, or does not answer', async () => {
    const stopped = await preview('stopped');
    expect((await get(`/${stopped}/`)).statusCode).toBe(404);
    const dead = await preview('ready', 'http://127.0.0.1:1');
    const { cookie } = await cookieFor(dead);
    const res = await get(`/${dead}/`, { cookie });
    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('The preview did not answer.');
    await db.update(previewRun).set({ state: 'stopped' }).where(eq(previewRun.id, dead));
    expect((await get(`/${dead}/`, { cookie })).statusCode).toBe(404);
  });
});
