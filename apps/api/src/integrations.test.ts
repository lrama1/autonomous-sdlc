import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  createDb,
  createRunFixture,
  docSnapshot,
  hat,
  integrationEntry,
  interaction,
  person,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import {
  confirmedHosts,
  createDocFetcher,
  entriesForInitiative,
  isPrivateAddress,
  latestSnapshots,
  proposeIntegration,
  refreshDocs,
  validHostname,
} from './integrations.js';
import type { DocFetcher } from './integrations.js';

describe('isPrivateAddress', () => {
  it('refuses this machine, the private network, link-local and metadata addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ])
      expect(isPrivateAddress(a), a).toBe(true);
  });
  it('allows public addresses', () => {
    for (const a of ['8.8.8.8', '172.32.0.1', '151.101.1.1', '2606:4700::1111'])
      expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('validHostname', () => {
  it('accepts plain hostnames only', () => {
    expect(validHostname('api.weather.example.com')).toBe(true);
    expect(validHostname('API.Example.COM')).toBe(true);
    for (const h of [
      '*.example.com',
      'example',
      '10.0.0.1',
      'https://example.com',
      'example.com/path',
      'example.com:443',
      'exa mple.com',
      '-bad.example.com',
      '',
    ])
      expect(validHostname(h), h).toBe(false);
  });
});

// A small web server for the documentation fetches.
let web: http.Server;
let webBase: string;
let page = { type: 'text/markdown', body: '# v1' };

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;
let live = false;

/** Stands in for the network when a route test must not depend on it. */
const fakeFetcher: DocFetcher = async (url) => {
  if (!live) throw new Error('offline');
  const text = `docs for ${url} (${page.body})`;
  return { sha256: `sha-${page.body}`, text };
};

async function newPerson(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `i${k}@example.test`, oidcSubject: `i${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  const cookie = `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`;
  return { id: p!.id, headers: { cookie } };
}

beforeAll(async () => {
  web = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', '/final');
      return void res.end();
    }
    if (req.url === '/loop') {
      res.statusCode = 302;
      res.setHeader('location', '/loop');
      return void res.end();
    }
    if (req.url === '/missing') {
      res.statusCode = 404;
      return void res.end('no');
    }
    if (req.url === '/big') {
      res.setHeader('content-type', 'text/plain');
      return void res.end('x'.repeat(600 * 1024));
    }
    if (req.url === '/image') {
      res.setHeader('content-type', 'image/png');
      return void res.end('png');
    }
    if (req.url === '/html') {
      res.setHeader('content-type', 'text/html');
      return void res.end(
        '<html><script>evil()</script><h1>Title</h1><p>Body&nbsp;text</p></html>',
      );
    }
    res.setHeader('content-type', page.type);
    res.end(page.body);
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  webBase = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-int-'));
  devDb = await startDevDb({ dataDir, port: 56342 });
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
      SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
    }),
    deps: made,
    workers: false,
    docFetcher: fakeFetcher,
  });
  await app.ready();
}, 180_000);

beforeEach(async () => {
  page = { type: 'text/markdown', body: '# v1' };
  live = true;
  await db.update(interaction).set({ state: 'withdrawn' }).where(eq(interaction.state, 'open'));
  await db.delete(hat);
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await devDb?.stop();
  await new Promise((r) => web?.close(r));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('the documentation fetcher', () => {
  const fetcher = createDocFetcher({ allowLoopbackHttp: true });

  it('fetches text, hashes the bytes, and follows a redirect', async () => {
    const a = await fetcher(`${webBase}/doc`);
    expect(a.text).toBe('# v1');
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await fetcher(`${webBase}/redirect`)).text).toBe('# v1');
    page = { type: 'text/markdown', body: '# v2' };
    expect((await fetcher(`${webBase}/doc`)).sha256).not.toBe(a.sha256);
  });

  it('turns html into plain text and drops scripts', async () => {
    const r = await fetcher(`${webBase}/html`);
    expect(r.text).toBe('Title Body text');
  });

  it('refuses errors, loops, other content types, and large files, with a reason', async () => {
    await expect(fetcher(`${webBase}/missing`)).rejects.toThrow(/404/);
    await expect(fetcher(`${webBase}/loop`)).rejects.toThrow(/redirects/);
    await expect(fetcher(`${webBase}/image`)).rejects.toThrow(/not a text document/);
    await expect(fetcher(`${webBase}/big`)).rejects.toThrow(/larger than 512 KB/);
  });

  it('refuses plain http and any name that points inside the network', async () => {
    const strict = createDocFetcher();
    await expect(strict(`${webBase}/doc`)).rejects.toThrow(/only https/);
    await expect(strict('https://localhost:1/x')).rejects.toThrow(/private address/);
    await expect(strict('https://127.0.0.1:1/x')).rejects.toThrow(/private address/);
    await expect(strict('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private address/,
    );
  });
});

async function entry(o: Partial<typeof integrationEntry.$inferInsert> = {}) {
  const [row] = await db
    .insert(integrationEntry)
    .values({
      name: `Weather ${Date.now()}-${++n}`,
      hosts: ['api.weather.example.com'],
      docs: ['https://docs.weather.example.com/openapi.yaml'],
      status: 'confirmed',
      ...o,
    })
    .returning();
  return row!;
}

describe('the documentation snapshots', () => {
  it('stores the first copy, ignores an unchanged one, and keeps a new copy when it changed', async () => {
    const e = await entry();
    const r1 = await refreshDocs(db, e, fakeFetcher);
    expect(r1).toMatchObject({ fetched: 1, changed: [], failed: [] });
    expect((await refreshDocs(db, e, fakeFetcher)).changed).toEqual([]);
    expect(
      await db.select().from(docSnapshot).where(eq(docSnapshot.integrationId, e.id)),
    ).toHaveLength(1);

    page = { type: 'text/markdown', body: '# v2' };
    const r2 = await refreshDocs(db, e, fakeFetcher);
    expect(r2.changed).toEqual([e.docs[0]]);
    const rows = await db.select().from(docSnapshot).where(eq(docSnapshot.integrationId, e.id));
    expect(rows).toHaveLength(2);
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'integration.docs_changed'));
    expect(log.some((l) => (l.detail as { integration?: string }).integration === e.name)).toBe(
      true,
    );
  });

  it('records a failure once, and keeps the last good copy for agents', async () => {
    const e = await entry();
    await refreshDocs(db, e, fakeFetcher);
    live = false;
    const r = await refreshDocs(db, e, fakeFetcher);
    expect(r.failed).toEqual([{ url: e.docs[0], error: 'offline' }]);
    await refreshDocs(db, e, fakeFetcher);
    const rows = await db.select().from(docSnapshot).where(eq(docSnapshot.integrationId, e.id));
    expect(rows.filter((x) => x.error)).toHaveLength(1);

    const newest = await latestSnapshots(db, [e.id]);
    expect(newest[0]).toMatchObject({ error: 'offline', content: null });
    const good = await latestSnapshots(db, [e.id], { goodOnly: true });
    expect(good[0]!.content).toContain('docs for');
  });
});

describe('who may use an entry', () => {
  it('gives an initiative the shared entries and its own, only when confirmed', async () => {
    const f = await createRunFixture(db);
    const other = await createRunFixture(db);
    const shared = await entry({ name: `shared-${f.runId}` });
    const mine = await entry({ name: `mine-${f.runId}`, initiativeId: f.initiativeId });
    const theirs = await entry({ name: `theirs-${f.runId}`, initiativeId: other.initiativeId });
    const proposed = await entry({ name: `proposed-${f.runId}`, status: 'proposed' });
    const retired = await entry({ name: `retired-${f.runId}`, status: 'retired' });
    const names = (await entriesForInitiative(db, f.initiativeId)).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([shared.name, mine.name]));
    for (const e of [theirs, proposed, retired]) expect(names).not.toContain(e.name);
  });

  it('allows the hosts of confirmed entries only', async () => {
    await entry({ name: `h-ok-${n}`, hosts: ['ok.example.com', 'OK2.example.com'] });
    await entry({ name: `h-no-${n}`, hosts: ['proposed.example.com'], status: 'proposed' });
    await entry({ name: `h-old-${n}`, hosts: ['retired.example.com'], status: 'retired' });
    const hosts = await confirmedHosts(db);
    expect(hosts).toEqual(expect.arrayContaining(['ok.example.com', 'ok2.example.com']));
    expect(hosts).not.toContain('proposed.example.com');
    expect(hosts).not.toContain('retired.example.com');
  });
});

describe('the register through the API', () => {
  const body = (o: Record<string, unknown> = {}) => ({
    name: `Maps ${Date.now()}-${++n}`,
    docs: ['https://docs.maps.example.com/api'],
    hosts: ['api.maps.example.com'],
    testStrategy: 'mock',
    authType: 'api_key',
    credentialRef: 'integrations/maps/test_key',
    ...o,
  });
  const post = (headers: Record<string, string>, payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/integrations', headers, payload: payload as never });

  it('lets an architect, engineer, or admin add an entry, and nobody else', async () => {
    const arch = await newPerson(['architect']);
    const po = await newPerson(['product_owner']);
    expect((await post(po.headers, body())).statusCode).toBe(403);
    const res = await post(arch.headers, body());
    expect(res.statusCode).toBe(201);
    const made = res.json();
    expect(made).toMatchObject({
      status: 'confirmed',
      testStrategy: 'mock',
      hosts: ['api.maps.example.com'],
    });
    expect(made.snapshots).toHaveLength(1);
    expect(made.snapshots[0]).toMatchObject({ ok: true });
    // Anyone signed in can read the register.
    const list = await app.inject({ url: '/api/integrations', headers: po.headers });
    expect((list.json() as Array<{ id: string }>).some((x) => x.id === made.id)).toBe(true);
    expect((await app.inject('/api/integrations')).statusCode).toBe(401);
  });

  it('refuses a duplicate name and hosts that are not plain hostnames', async () => {
    const arch = await newPerson(['architect']);
    const first = body();
    expect((await post(arch.headers, first)).statusCode).toBe(201);
    expect((await post(arch.headers, first)).statusCode).toBe(409);
    for (const hosts of [
      ['*.example.com'],
      ['10.0.0.5'],
      ['https://x.example.com/path'],
      ['localhost'],
    ]) {
      expect((await post(arch.headers, body({ hosts }))).statusCode, hosts[0]).toBe(400);
    }
    expect((await post(arch.headers, body({ credentialRef: 'has spaces' }))).statusCode).toBe(400);
  });

  it('edits and retires an entry, and logs the hosts before and after', async () => {
    const arch = await newPerson(['architect']);
    const eng = await newPerson(['backend_engineer']);
    const po = await newPerson(['product_owner']);
    const made = (await post(arch.headers, body())).json();
    const patch = (headers: Record<string, string>, payload: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/api/integrations/${made.id}`,
        headers,
        payload: payload as never,
      });
    expect((await patch(po.headers, { terms: 'x' })).statusCode).toBe(403);
    const edited = await patch(eng.headers, {
      hosts: ['api.maps.example.com', 'tiles.maps.example.com'],
    });
    expect(edited.json().hosts).toEqual(['api.maps.example.com', 'tiles.maps.example.com']);
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.action, 'integration.updated'));
    expect(
      log.some((l) => (l.detail as { hostsBefore?: string[] }).hostsBefore?.length === 1),
    ).toBe(true);
    expect((await patch(eng.headers, { hosts: ['bad host'] })).statusCode).toBe(400);

    const retire = await app.inject({
      method: 'POST',
      url: `/api/integrations/${made.id}/retire`,
      headers: arch.headers,
    });
    expect(retire.statusCode).toBe(200);
    expect(await confirmedHosts(db)).not.toContain('tiles.maps.example.com');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/integrations/00000000-0000-4000-8000-000000000000/retire',
          headers: arch.headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('asks the architect when the documentation changed', async () => {
    const f = await createRunFixture(db);
    const arch = await newPerson(['architect']);
    const made = (await post(arch.headers, body({ initiativeId: f.initiativeId }))).json();
    page = { type: 'text/markdown', body: '# v2' };
    const res = await app.inject({
      method: 'POST',
      url: `/api/integrations/${made.id}/refresh-docs`,
      headers: arch.headers,
    });
    expect(res.json().changed).toHaveLength(1);
    const asks = await db
      .select()
      .from(interaction)
      .where(eq(interaction.initiativeId, f.initiativeId));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      type: 'decision',
      roleNeeded: 'architect',
      state: 'open',
      title: `The documentation for ${made.name} changed`,
    });
    const docs = await app.inject({
      url: `/api/integrations/${made.id}/docs`,
      headers: arch.headers,
    });
    expect(docs.json()[0].content).toContain('# v2');
  });
});

describe('an agent proposing a system', () => {
  async function propose(f: Awaited<ReturnType<typeof createRunFixture>>, o = {}) {
    const out = await proposeIntegration(db, {
      name: `Stripe-${Date.now()}-${++n}`,
      kind: 'third_party',
      hosts: ['API.stripe.example.com'],
      docs: ['https://docs.stripe.example.com/api'],
      testStrategy: 'vendor_sandbox',
      why: 'The task takes payments.',
      initiativeId: f.initiativeId,
      runId: f.runId,
      ...o,
    });
    if ('error' in out) throw new Error(out.error);
    return out;
  }

  it('raises a hard stop for the architect, and nothing is allowed yet', async () => {
    const f = await createRunFixture(db);
    const { entry: e, interaction: ask } = await propose(f);
    expect(e).toMatchObject({ status: 'proposed', hosts: ['api.stripe.example.com'] });
    expect(ask).toMatchObject({ hardStop: true, roleNeeded: 'architect', type: 'decision' });
    expect(await confirmedHosts(db)).not.toContain('api.stripe.example.com');
  });

  it('allows the hosts once an architect confirms, and fetches the documentation', async () => {
    const f = await createRunFixture(db);
    const arch = await newPerson(['architect']);
    const { entry: e, interaction: ask } = await propose(f);
    const res = await app.inject({
      method: 'POST',
      url: `/api/interactions/${ask.id}/answer`,
      headers: arch.headers,
      payload: { optionId: 'confirm' },
    });
    expect(res.statusCode).toBe(200);
    const [after] = await db.select().from(integrationEntry).where(eq(integrationEntry.id, e.id));
    expect(after).toMatchObject({ status: 'confirmed', confirmedBy: arch.id });
    expect(await confirmedHosts(db)).toContain('api.stripe.example.com');
    expect((await latestSnapshots(db, [e.id], { goodOnly: true })).length).toBe(1);
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.interactionId, ask.id));
    expect(log.map((l) => l.action)).toContain('integration.confirmed');
  });

  it('keeps the hosts blocked when the architect rejects', async () => {
    const f = await createRunFixture(db);
    const arch = await newPerson(['architect']);
    const { entry: e, interaction: ask } = await propose(f, { hosts: ['rejected.example.com'] });
    await app.inject({
      method: 'POST',
      url: `/api/interactions/${ask.id}/answer`,
      headers: arch.headers,
      payload: { optionId: 'reject' },
    });
    const [after] = await db.select().from(integrationEntry).where(eq(integrationEntry.id, e.id));
    expect(after!.status).toBe('rejected');
    expect(await confirmedHosts(db)).not.toContain('rejected.example.com');
  });

  it('refuses a proposal with no documentation unless the agent says it does not know it', async () => {
    const f = await createRunFixture(db);
    const base = {
      name: `NoDocs-${Date.now()}-${++n}`,
      kind: 'third_party' as const,
      hosts: ['nodocs.example.com'],
      docs: [],
      testStrategy: 'mock' as const,
      why: 'x',
      initiativeId: f.initiativeId,
      runId: f.runId,
    };
    const refused = await proposeIntegration(db, base);
    expect(refused).toMatchObject({ error: expect.stringContaining('docsUnknown') });
    const asked = await proposeIntegration(db, { ...base, docsUnknown: true });
    if ('error' in asked) throw new Error(asked.error);
    expect(asked.interaction.contextCard).toMatchObject({ docsUnknown: true, docs: [] });
    expect((asked.interaction.options as Array<{ id: string }>).map((o) => o.id)).toEqual([
      'confirm',
      'confirm_no_docs',
      'reject',
    ]);
  });

  it('will not confirm a system with no documentation until the person pastes a link', async () => {
    const f = await createRunFixture(db);
    const arch = await newPerson(['architect']);
    const out = await proposeIntegration(db, {
      name: `Paste-${Date.now()}-${++n}`,
      kind: 'third_party',
      hosts: ['paste.example.com'],
      docs: [],
      docsUnknown: true,
      testStrategy: 'vendor_sandbox',
      why: 'x',
      initiativeId: f.initiativeId,
      runId: f.runId,
    });
    if ('error' in out) throw new Error(out.error);
    const answer = (payload: object) =>
      app.inject({
        method: 'POST',
        url: `/api/interactions/${out.interaction.id}/answer`,
        headers: arch.headers,
        payload,
      });

    const bare = await answer({ optionId: 'confirm' });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('docs_required');
    const insecure = await answer({ optionId: 'confirm', answer: 'http://docs.example.com/api' });
    expect(insecure.json().error.code).toBe('docs_link_refused');
    expect(await confirmedHosts(db)).not.toContain('paste.example.com');

    const ok = await answer({
      optionId: 'confirm',
      answer: 'The docs are at https://docs.example.com/api, and https://docs.example.com/hooks.',
    });
    expect(ok.statusCode).toBe(200);
    const [after] = await db
      .select()
      .from(integrationEntry)
      .where(eq(integrationEntry.id, out.entry.id));
    expect(after).toMatchObject({ status: 'confirmed' });
    expect(after!.docs).toEqual(['https://docs.example.com/api', 'https://docs.example.com/hooks']);
    expect((await latestSnapshots(db, [out.entry.id], { goodOnly: true })).length).toBe(2);
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.interactionId, out.interaction.id));
    expect(log.map((l) => l.action)).toContain('integration.docs_added');
  });

  it("lets the person confirm without documentation, and adds links pasted to an agent's own", async () => {
    const f = await createRunFixture(db);
    const arch = await newPerson(['architect']);
    const none = await proposeIntegration(db, {
      name: `Skip-${Date.now()}-${++n}`,
      kind: 'third_party',
      hosts: ['skip.example.com'],
      docs: [],
      docsUnknown: true,
      testStrategy: 'none',
      why: 'x',
      initiativeId: f.initiativeId,
      runId: f.runId,
    });
    if ('error' in none) throw new Error(none.error);
    const skipped = await app.inject({
      method: 'POST',
      url: `/api/interactions/${none.interaction.id}/answer`,
      headers: arch.headers,
      payload: { optionId: 'confirm_no_docs' },
    });
    expect(skipped.statusCode).toBe(200);
    expect(await confirmedHosts(db)).toContain('skip.example.com');
    const [e1] = await db
      .select()
      .from(integrationEntry)
      .where(eq(integrationEntry.id, none.entry.id));
    expect(e1!.docs).toEqual([]);

    const { entry: e2, interaction: ask } = await propose(f, { hosts: ['more.example.com'] });
    const more = await app.inject({
      method: 'POST',
      url: `/api/interactions/${ask.id}/answer`,
      headers: arch.headers,
      payload: { optionId: 'confirm', answer: 'also https://docs.stripe.example.com/webhooks' },
    });
    expect(more.statusCode).toBe(200);
    const [after] = await db.select().from(integrationEntry).where(eq(integrationEntry.id, e2.id));
    expect(after!.docs).toEqual([
      'https://docs.stripe.example.com/api',
      'https://docs.stripe.example.com/webhooks',
    ]);
  });

  it('refuses bad hostnames and a name that is taken', async () => {
    const f = await createRunFixture(db);
    const bad = await proposeIntegration(db, {
      name: 'Bad',
      kind: 'third_party',
      hosts: ['*.example.com'],
      docs: [],
      docsUnknown: true,
      testStrategy: 'none',
      why: 'x',
      initiativeId: f.initiativeId,
      runId: f.runId,
    });
    expect(bad).toMatchObject({ error: expect.stringContaining('plain hostname') });
    const { entry: e } = await propose(f);
    const dup = await proposeIntegration(db, {
      name: e.name,
      kind: 'third_party',
      hosts: ['other.example.com'],
      docs: [],
      docsUnknown: true,
      testStrategy: 'none',
      why: 'x',
      initiativeId: f.initiativeId,
      runId: f.runId,
    });
    expect(dup).toMatchObject({ error: expect.stringContaining('already an entry') });
  });
});
