import http from 'node:http';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activityEvent, createDb, githubApp, hat, person, runMigrations } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { GitHubClient, appJwt, buildManifest, secretName } from './github-app.js';
import { MemorySecrets } from './secrets.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function verifyJwt(jwt: string): { iss: string; iat: number; exp: number } | null {
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return null;
  const ok = createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'));
  return ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null;
}

describe('appJwt', () => {
  it('is a valid RS256 token for the app, good for under ten minutes', () => {
    const now = 1_800_000_000;
    const claims = verifyJwt(appJwt(12345, privateKey, now));
    expect(claims).toEqual({ iss: '12345', iat: now - 30, exp: now + 540 });
    expect(claims!.exp - claims!.iat).toBeLessThanOrEqual(600);
  });

  it('is not valid for a different key', () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(verifyJwt(appJwt(1, other.privateKey))).toBeNull();
  });
});

describe('buildManifest', () => {
  it('gives the agent no merge or workflow rights, and the gate no push rights beyond merging', () => {
    const agent = buildManifest('agent', 'http://localhost:5173', 'x');
    const gate = buildManifest('gate', 'http://localhost:5173', 'x');
    expect(agent.default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
    expect(gate.default_permissions.checks).toBe('read');
    for (const m of [agent, gate]) {
      expect(m.default_permissions).not.toHaveProperty('workflows');
      expect(m.default_permissions).not.toHaveProperty('administration');
      expect(m.public).toBe(false);
      expect(m.name.length).toBeLessThanOrEqual(34);
    }
    expect(agent.redirect_url).toBe('http://localhost:5173/admin/github/created');
    expect(agent.setup_url).toBe('http://localhost:5173/admin/github/installed?kind=agent');
    expect(gate.setup_url).toContain('kind=gate');
  });

  it('declares no webhook for a local address, because GitHub rejects it even when inactive', () => {
    for (const url of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect(buildManifest('agent', url, 'x')).not.toHaveProperty('hook_attributes');
    }
  });

  it('declares a webhook for a public address', () => {
    expect(buildManifest('gate', 'https://sdlc.example.com', 'x').hook_attributes).toEqual({
      url: 'https://sdlc.example.com/webhooks/github',
      active: true,
    });
  });
});

// A fake GitHub API that checks the App JWT the way GitHub does.
let github: http.Server;
let githubUrl: string;
let seen: string[] = [];
let installation: { repository_selection: 'all' | 'selected' } = {
  repository_selection: 'selected',
};
let codeUsed: string | null = null;
// The repositories the installation covers, as GitHub answers it.
let listedRepos = ['lrama1/sdlc-scratch'];

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let secrets: MemorySecrets;
let n = 0;

async function login(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `P${k}`, email: `p${k}@example.test`, oidcSubject: `p${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
  };
}

const cookieValue = (res: { cookies: Array<{ name: string; value: string }> }, name: string) =>
  res.cookies.find((c) => c.name === name)?.value;

beforeAll(async () => {
  github = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (req.method === 'POST' && url.startsWith('/app-manifests/')) {
      const code = decodeURIComponent(url.split('/')[2]!);
      if (code !== 'good-code' || codeUsed === code) return json(404, { message: 'Not Found' });
      codeUsed = code;
      return json(201, {
        id: 4242,
        slug: 'autonomous-sdlc-agent-test',
        name: 'Autonomous SDLC Agent test',
        html_url: 'https://github.com/apps/autonomous-sdlc-agent-test',
        client_id: 'Iv1.abc',
        client_secret: 'client-secret-value',
        webhook_secret: 'webhook-secret-value',
        pem: privateKey,
        owner: { login: 'lrama1' },
      });
    }
    // Everything else needs a valid App JWT or an installation token.
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const isJwt = auth.split('.').length === 3;
    if (url.startsWith('/app/installations/') && !url.endsWith('/access_tokens')) {
      const claims = isJwt ? verifyJwt(auth) : null;
      if (!claims || claims.iss !== '4242')
        return json(401, { message: 'A JSON web token could not be decoded' });
      return json(200, {
        id: 777,
        account: { login: 'lrama1' },
        repository_selection: installation.repository_selection,
        permissions: { contents: 'write' },
      });
    }
    if (url.endsWith('/access_tokens') && req.method === 'POST') {
      const claims = isJwt ? verifyJwt(auth) : null;
      if (!claims) return json(401, { message: 'bad jwt' });
      return json(201, {
        token: 'ghs_installation_token',
        expires_at: '2026-10-17T20:00:00Z',
        repository_selection: 'selected',
        permissions: {},
      });
    }
    if (url.startsWith('/installation/repositories')) {
      if (auth !== 'ghs_installation_token') return json(401, { message: 'bad token' });
      return json(200, {
        total_count: listedRepos.length,
        repositories: listedRepos.map((full_name) => ({ full_name, private: true })),
      });
    }
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));
  githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-gh-'));
  devDb = await startDevDb({ dataDir, port: 56334 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  secrets = new MemorySecrets();
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: devDb.url,
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_CLIENT_ID: 'x',
      OIDC_CLIENT_SECRET: 'x',
      SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
      GITHUB_API_URL: githubUrl,
      GITHUB_WEB_URL: 'https://github.example',
    }),
    deps: made,
    workers: false,
    secrets,
    github: new GitHubClient(githubUrl),
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await new Promise((r) => github?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

beforeEach(async () => {
  seen = [];
  codeUsed = null;
  installation = { repository_selection: 'selected' };
  await db.delete(githubApp);
});

describe('who may configure GitHub', () => {
  it('needs a session', async () => {
    expect((await app.inject('/admin/github')).statusCode).toBe(401);
  });
  it('is for Platform Admins only', async () => {
    const eng = await login(['backend_engineer']);
    for (const url of ['/admin/github', '/admin/github/register?kind=agent', '/api/admin/github']) {
      expect((await app.inject({ url, headers: { cookie: eng.cookie } })).statusCode).toBe(403);
    }
  });
});

describe('registering an App from a manifest', () => {
  it('sends the admin to GitHub with a state value, and keeps the state in a signed cookie', async () => {
    const admin = await login(['platform_admin']);
    const res = await app.inject({
      url: '/admin/github/register?kind=agent',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(
      /action="https:\/\/github\.example\/settings\/apps\/new\?state=[0-9a-f]{32}"/,
    );
    expect(res.body).toContain('name="manifest"');
    expect(res.body).toContain('&quot;contents&quot;:&quot;write&quot;');
    expect(cookieValue(res, 'sdlc_gh_state')).toBeTruthy();
  });

  it('rejects an unknown kind', async () => {
    const admin = await login(['platform_admin']);
    expect(
      (
        await app.inject({
          url: '/admin/github/register?kind=root',
          headers: { cookie: admin.cookie },
        })
      ).statusCode,
    ).toBe(400);
  });

  async function startRegistration(admin: { cookie: string }) {
    const res = await app.inject({
      url: '/admin/github/register?kind=agent',
      headers: { cookie: admin.cookie },
    });
    const state = /state=([0-9a-f]{32})/.exec(res.body)![1]!;
    const stateCookie = `sdlc_gh_state=${cookieValue(res, 'sdlc_gh_state')}`;
    return { state, cookie: `${admin.cookie}; ${stateCookie}` };
  }

  it('trades the code for credentials, keeps the secrets out of the database, and logs it', async () => {
    const admin = await login(['platform_admin']);
    const { state, cookie } = await startRegistration(admin);
    const res = await app.inject({
      url: `/admin/github/created?code=good-code&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/github\?done=/);

    const [row] = await db.select().from(githubApp).where(eq(githubApp.kind, 'agent'));
    expect(row).toMatchObject({
      appId: 4242,
      slug: 'autonomous-sdlc-agent-test',
      ownerLogin: 'lrama1',
      installationId: null,
      installedOn: [],
    });
    expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(row)).not.toContain('client-secret-value');

    expect(await secrets.get(secretName('agent', 'private_key'))).toContain('BEGIN PRIVATE KEY');
    expect(await secrets.get(secretName('agent', 'client_secret'))).toBe('client-secret-value');
    expect(await secrets.get(secretName('agent', 'webhook_secret'))).toBe('webhook-secret-value');

    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'github.app_registered'));
    expect(log.some((l) => l.actorId === admin.id)).toBe(true);
  });

  it("refuses a wrong state value (someone else's redirect) and does not call GitHub", async () => {
    const admin = await login(['platform_admin']);
    const { cookie } = await startRegistration(admin);
    const res = await app.inject({
      url: '/admin/github/created?code=good-code&state=ffffffffffffffffffffffffffffffff',
      headers: { cookie },
    });
    expect(res.headers.location).toMatch(/error=/);
    expect(seen).toEqual([]);
    expect(await db.select().from(githubApp)).toHaveLength(0);
  });

  it('refuses a callback with no registration in progress', async () => {
    const admin = await login(['platform_admin']);
    const res = await app.inject({
      url: '/admin/github/created?code=good-code&state=abc',
      headers: { cookie: admin.cookie },
    });
    expect(res.headers.location).toMatch(/error=/);
    expect(seen).toEqual([]);
  });

  it('reports a code GitHub rejects, without storing anything', async () => {
    const admin = await login(['platform_admin']);
    const { state, cookie } = await startRegistration(admin);
    const res = await app.inject({
      url: `/admin/github/created?code=stale&state=${state}`,
      headers: { cookie },
    });
    expect(decodeURIComponent(res.headers.location as string)).toMatch(/error=.*404/);
    expect(await db.select().from(githubApp)).toHaveLength(0);
  });
});

describe('installing an App', () => {
  async function registered() {
    const admin = await login(['platform_admin']);
    const res = await app.inject({
      url: '/admin/github/register?kind=agent',
      headers: { cookie: admin.cookie },
    });
    const state = /state=([0-9a-f]{32})/.exec(res.body)![1]!;
    const cookie = `${admin.cookie}; sdlc_gh_state=${cookieValue(res, 'sdlc_gh_state')}`;
    await app.inject({
      url: `/admin/github/created?code=good-code&state=${state}`,
      headers: { cookie },
    });
    seen = [];
    return admin;
  }

  it("checks the installation with the App's own JWT and records which repositories it covers", async () => {
    const admin = await registered();
    const res = await app.inject({
      url: '/admin/github/installed?kind=agent&installation_id=777',
      headers: { cookie: admin.cookie },
    });
    expect(res.headers.location).toMatch(/done=/);
    const [row] = await db.select().from(githubApp);
    expect(row).toMatchObject({ installationId: 777, installedOn: ['lrama1/sdlc-scratch'] });
    expect(seen).toEqual([
      'GET /app/installations/777',
      'POST /app/installations/777/access_tokens',
      'GET /installation/repositories?per_page=100',
    ]);
  });

  it('refuses an installation on all repositories', async () => {
    const admin = await registered();
    installation = { repository_selection: 'all' };
    const res = await app.inject({
      url: '/admin/github/installed?kind=agent&installation_id=777',
      headers: { cookie: admin.cookie },
    });
    expect(decodeURIComponent(res.headers.location as string)).toMatch(
      /error=.*Only select repositories/,
    );
    const [row] = await db.select().from(githubApp);
    expect(row!.installationId).toBeNull();
  });

  it('does not accept an installation for an App that was never registered here', async () => {
    const admin = await login(['platform_admin']);
    const res = await app.inject({
      url: '/admin/github/installed?kind=gate&installation_id=1',
      headers: { cookie: admin.cookie },
    });
    expect(res.headers.location).toMatch(/error=/);
    expect(seen).toEqual([]);
  });

  it('shows the status page and the JSON status', async () => {
    const admin = await registered();
    await app.inject({
      url: '/admin/github/installed?kind=agent&installation_id=777',
      headers: { cookie: admin.cookie },
    });
    const html = await app.inject({ url: '/admin/github', headers: { cookie: admin.cookie } });
    expect(html.body).toContain('lrama1/sdlc-scratch');
    expect(html.body).toContain('Register the Gate App on GitHub');
    const status = (
      await app.inject({ url: '/api/admin/github', headers: { cookie: admin.cookie } })
    ).json();
    expect(status).toEqual([
      {
        kind: 'agent',
        registered: true,
        slug: 'autonomous-sdlc-agent-test',
        owner: 'lrama1',
        installationId: 777,
        installedOn: ['lrama1/sdlc-scratch'],
      },
      { kind: 'gate', registered: false },
    ]);
  });

  it('escapes anything it prints', async () => {
    const admin = await login(['platform_admin']);
    const res = await app.inject({
      url: '/admin/github?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      headers: { cookie: admin.cookie },
    });
    expect(res.body).not.toContain('<script>alert(1)');
    expect(res.body).toContain('&lt;script&gt;');
  });
});

describe('a repository added to an installation later', () => {
  async function installed(kinds: Array<'agent' | 'gate'> = ['agent']) {
    await db.delete(githubApp);
    for (const kind of kinds) {
      await db.insert(githubApp).values({
        kind,
        appId: 4242,
        slug: `${kind}-app`,
        name: kind,
        ownerLogin: 'lrama1',
        htmlUrl: 'https://x',
        installationId: 777,
        installedOn: ['lrama1/sdlc-scratch'],
      });
      await secrets.put(secretName(kind, 'private_key'), privateKey);
    }
    seen = [];
  }
  afterEach(() => {
    listedRepos = ['lrama1/sdlc-scratch'];
  });

  it('is learned when an admin asks GitHub again, and logged', async () => {
    await installed();
    const admin = await login(['platform_admin']);
    listedRepos = ['lrama1/sdlc-scratch', 'lrama1/dogfood-app'];
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/github/refresh',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { kind: 'agent', installedOn: ['lrama1/sdlc-scratch', 'lrama1/dogfood-app'] },
    ]);
    expect(seen).toEqual([
      'POST /app/installations/777/access_tokens',
      'GET /installation/repositories?per_page=100',
    ]);
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'github.installation_refreshed'));
    expect(log.length).toBeGreaterThan(0);
    // Nothing changed: nothing more is written.
    const before = log.length;
    await app.inject({
      method: 'POST',
      url: '/api/admin/github/refresh',
      headers: { cookie: admin.cookie },
    });
    expect(
      (
        await db
          .select()
          .from(activityEvent)
          .where(eq(activityEvent.action, 'github.installation_refreshed'))
      ).length,
    ).toBe(before);
  });

  it('is for Platform Admins only', async () => {
    await installed();
    const who = await login(['backend_engineer']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/github/refresh',
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/admin/github/refresh' })).statusCode,
    ).toBe(401);
  });

  it('can be put in the registry at once, because the registry looks again before it says no', async () => {
    await installed(['agent', 'gate']);
    const admin = await login(['platform_admin']);
    const add = (fullName: string) =>
      app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: admin.cookie },
        payload: { fullName },
      });
    // Not on GitHub's list either: still refused.
    const no = await add('lrama1/never-added');
    expect(no.statusCode).toBe(409);
    expect(no.json().error.code).toBe('not_installed');
    // Added on GitHub a moment ago: accepted.
    listedRepos = ['lrama1/sdlc-scratch', 'lrama1/dogfood-app'];
    const yes = await add('lrama1/dogfood-app');
    expect(yes.statusCode).toBe(201);
  });
});

describe('installation tokens', () => {
  it('can be limited to one repository and fewer permissions', async () => {
    const client = new GitHubClient(githubUrl);
    const t = await client.createInstallationToken(appJwt(4242, privateKey), 777, {
      repositories: ['sdlc-scratch'],
      permissions: { contents: 'write' },
    });
    expect(t.token).toBe('ghs_installation_token');
  });
});
