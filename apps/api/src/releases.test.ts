import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityEvent,
  agentRun,
  createDb,
  createRunFixture,
  githubApp,
  hat,
  interaction,
  person,
  repositoryEntry,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import type { MapStage as Stage } from '@sdlc/core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { GitHubClient, secretName } from './github-app.js';
import { MemorySecrets } from './secrets.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface World {
  head: string;
  ci: string;
  tagStatus: number;
  calls: Array<{ method: string; url: string; body: Record<string, unknown> }>;
}
let world: World;
const reset = () => (world = { head: 'sha-main-1', ci: 'success', tagStatus: 201, calls: [] });

let github: http.Server;
let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

async function newPerson(roles: string[]) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `r${k}@example.test`, oidcSubject: `r${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  const cookie = `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`;
  return { id: p!.id, headers: { cookie } };
}

async function setup() {
  const f = await createRunFixture(db);
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  await db.delete(githubApp);
  for (const kind of ['agent', 'gate']) {
    await db.insert(githubApp).values({
      kind,
      appId: 9,
      slug: kind,
      name: kind,
      ownerLogin: 'me',
      htmlUrl: 'https://x',
      installationId: 5,
      installedOn: [repo!.fullName],
    });
  }
  return { ...f, repo: repo! };
}

/** A pull request that the Gate merged, as the activity log and the review record it. */
async function merged(
  f: Awaited<ReturnType<typeof setup>>,
  number: number,
  title: string,
  at = new Date(),
) {
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      state: 'answered',
      title: `Review PR #${number}: ${title}`,
      roleNeeded: 'backend_engineer',
      contextCard: {
        kind: 'pull_request',
        prNumber: number,
        prUrl: `https://github.com/o/r/pull/${number}`,
        gate: { state: 'merged' },
      },
    })
    .returning();
  await db.insert(activityEvent).values({
    ts: at,
    actorType: 'system',
    initiativeId: f.initiativeId,
    runId: f.runId,
    interactionId: row!.id,
    action: 'pull_request.merged',
    detail: {},
  });
  return row!;
}

const post = (headers: Record<string, string>, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers, payload: payload as never });
const paths = () =>
  world.calls
    .map((c) => `${c.method} ${c.url.replace(/\/repos\/[^/]+\/[^/]+/, '')}`)
    .filter((c) => !c.includes('access_tokens'));

beforeAll(async () => {
  github = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = req.url ?? '';
    world.calls.push({ method: req.method ?? '', url, body });
    const json = (status: number, b: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b));
    };
    if (url.endsWith('/access_tokens'))
      return json(201, {
        token: 'ghs_fake',
        expires_at: '2026-10-18T00:00:00Z',
        repository_selection: 'selected',
        permissions: {},
      });
    if (req.method === 'GET' && url.endsWith('/git/ref/heads/main'))
      return json(200, { object: { sha: world.head } });
    if (req.method === 'GET' && url.includes('/check-runs'))
      return json(200, {
        check_runs: [{ name: 'verify', status: 'completed', conclusion: world.ci }],
      });
    if (req.method === 'POST' && url.endsWith('/git/refs'))
      return world.tagStatus === 201
        ? json(201, { ref: body.ref })
        : json(world.tagStatus, { message: 'Reference already exists' });
    if (req.method === 'POST' && url.endsWith('/releases'))
      return json(201, { html_url: `https://github.com/o/r/releases/tag/${body.tag_name}` });
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));
  const githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-rel-'));
  devDb = await startDevDb({ dataDir, port: 56343 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const secrets = new MemorySecrets();
  for (const kind of ['agent', 'gate'] as const)
    await secrets.put(secretName(kind, 'private_key'), privateKey);
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: devDb.url,
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_CLIENT_ID: 'x',
      OIDC_CLIENT_SECRET: 'x',
      SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
      GITHUB_API_URL: githubUrl,
    }),
    deps: made,
    workers: false,
    secrets,
    github: new GitHubClient(githubUrl),
  });
  await app.ready();
  reset();
}, 180_000);

beforeEach(async () => {
  reset();
  await db.delete(hat);
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => github?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('preparing a release', () => {
  it('lists what merged, pins the commit, and waits for the approver as a hard stop', async () => {
    const f = await setup();
    const po = await newPerson(['product_owner']);
    await merged(f, 3, 'Add the weather forecast');
    await merged(f, 4, 'Fix the packing list');
    const res = await post(po.headers, `/api/initiatives/${f.initiativeId}/releases`, {
      version: '0.2.0',
    });
    expect(res.statusCode).toBe(201);
    const [ask] = await db
      .select()
      .from(interaction)
      .where(eq(interaction.id, res.json().interactionId));
    expect(ask).toMatchObject({
      type: 'checkpoint',
      checkpointId: 'G6',
      hardStop: true,
      roleNeeded: 'product_owner',
      state: 'open',
      title: 'Release 0.2.0: 2 changes',
    });
    const card = ask!.contextCard as { tag: string; sha: string; branch: string; notes: string };
    expect(card).toMatchObject({ tag: 'release-0.2.0', sha: 'sha-main-1', branch: 'main' });
    expect(card.notes).toContain('- Add the weather forecast (#3)');
    expect(card.notes).toContain('- Fix the packing list (#4)');
    // Nothing is published by preparing.
    expect(paths().some((p) => p.includes('/releases') || p.includes('/git/refs'))).toBe(false);
  });

  it('is prepared by a Product Owner, DevOps, or an admin only, and with a real version', async () => {
    const f = await setup();
    await merged(f, 1, 'x');
    const eng = await newPerson(['backend_engineer']);
    const po = await newPerson(['product_owner']);
    const url = `/api/initiatives/${f.initiativeId}/releases`;
    expect((await post(eng.headers, url, { version: '1.0.0' })).statusCode).toBe(403);
    expect((await post(po.headers, url, { version: 'v1' })).json().error.code).toBe('bad_version');
    expect((await post(po.headers, url, {})).statusCode).toBe(400);
  });

  it('refuses when nothing merged, when the check is not green, and when one is already waiting', async () => {
    const f = await setup();
    const po = await newPerson(['product_owner']);
    const url = `/api/initiatives/${f.initiativeId}/releases`;
    expect((await post(po.headers, url, { version: '1.0.0' })).json().error.code).toBe(
      'nothing_to_release',
    );

    await merged(f, 1, 'x');
    world.ci = 'failure';
    const red = await post(po.headers, url, { version: '1.0.0' });
    expect(red.json().error).toMatchObject({ code: 'not_green' });
    expect(red.json().error.message).toContain('failure');

    world.ci = 'success';
    expect((await post(po.headers, url, { version: '1.0.0' })).statusCode).toBe(201);
    expect((await post(po.headers, url, { version: '1.0.1' })).json().error.code).toBe(
      'release_pending',
    );
  });
});

describe('deciding on a release', () => {
  async function prepared(version = '0.3.0') {
    const f = await setup();
    const po = await newPerson(['product_owner']);
    await merged(f, 5, 'Add invites');
    const res = await post(po.headers, `/api/initiatives/${f.initiativeId}/releases`, { version });
    return { f, po, id: res.json().interactionId as string };
  }
  const answer = (headers: Record<string, string>, id: string, decision: string) =>
    post(headers, `/api/interactions/${id}/answer`, { decision, answer: 'ok' });
  const card = async (id: string) =>
    (await db.select().from(interaction).where(eq(interaction.id, id)))[0]!.contextCard as {
      release: { state?: string; url?: string; detail?: string };
      prs: Array<{ number: number; title: string }>;
    };

  it('publishes the tag and the notes through the Gate App once approved', async () => {
    const { f, po, id } = await prepared();
    const approver = await newPerson(['product_owner']);
    expect((await answer(approver.headers, id, 'approved')).statusCode).toBe(200);
    expect(paths()).toEqual(
      expect.arrayContaining(['GET /git/ref/heads/main', 'POST /git/refs', 'POST /releases']),
    );
    const tag = world.calls.find((c) => c.url.endsWith('/git/refs'))!;
    expect(tag.body).toEqual({ ref: 'refs/tags/release-0.3.0', sha: 'sha-main-1' });
    const rel = world.calls.find((c) => c.url.endsWith('/releases'))!;
    expect(rel.body).toMatchObject({ tag_name: 'release-0.3.0', name: '0.3.0', draft: false });
    expect(rel.body.body).toContain('Add invites');
    expect((await card(id)).release).toMatchObject({
      state: 'released',
      url: 'https://github.com/o/r/releases/tag/release-0.3.0',
    });
    const log = await db.select().from(activityEvent).where(eq(activityEvent.interactionId, id));
    expect(log.map((l) => l.action)).toEqual(
      expect.arrayContaining(['release.prepared', 'release.published']),
    );

    // The map shows the release as done, and the list says where it is published.
    const map = await app.inject({
      url: `/api/initiatives/${f.initiativeId}/map`,
      headers: po.headers,
    });
    expect(map.json().stages.find((s: { id: string }) => s.id === 'release').status).toBe('done');
    const list = await app.inject({
      url: `/api/initiatives/${f.initiativeId}/releases`,
      headers: po.headers,
    });
    expect(list.json()[0]).toMatchObject({ version: '0.3.0', state: 'released' });
  });

  it('publishes nothing if the branch moved after it was prepared', async () => {
    const { id } = await prepared();
    const approver = await newPerson(['product_owner']);
    world.head = 'sha-main-2';
    await answer(approver.headers, id, 'approved');
    expect(paths().some((p) => p.includes('/releases') || p.includes('/git/refs'))).toBe(false);
    expect((await card(id)).release).toMatchObject({ state: 'stale' });
    expect((await card(id)).release.detail).toContain('Prepare it again');
  });

  it('publishes nothing when the release is declined, and records it', async () => {
    const { id } = await prepared();
    const approver = await newPerson(['product_owner']);
    await answer(approver.headers, id, 'rejected');
    expect(paths().some((p) => p.includes('/releases') || p.includes('/git/refs'))).toBe(false);
    expect((await card(id)).release.state).toBe('declined');
  });

  it('records a GitHub refusal, such as a tag that already exists, instead of failing the answer', async () => {
    const { id } = await prepared();
    const approver = await newPerson(['product_owner']);
    world.tagStatus = 422;
    expect((await answer(approver.headers, id, 'approved')).statusCode).toBe(200);
    expect((await card(id)).release).toMatchObject({ state: 'failed' });
    expect(paths().some((p) => p === 'POST /releases')).toBe(false);
  });

  it('cannot be decided by someone without the approver hat', async () => {
    const { id } = await prepared();
    const eng = await newPerson(['backend_engineer']);
    expect((await answer(eng.headers, id, 'approved')).statusCode).toBe(403);
    expect(paths().some((p) => p.includes('/releases'))).toBe(false);
  });

  it('counts only what merged after the last published release', async () => {
    const f = await setup();
    const po = await newPerson(['product_owner']);
    await merged(f, 1, 'old change', new Date(Date.now() - 3600_000));
    const first = await post(po.headers, `/api/initiatives/${f.initiativeId}/releases`, {
      version: '1.0.0',
    });
    const approver = await newPerson(['product_owner']);
    await answer(approver.headers, first.json().interactionId, 'approved');
    // Nothing new yet.
    expect(
      (
        await post(po.headers, `/api/initiatives/${f.initiativeId}/releases`, { version: '1.0.1' })
      ).json().error.code,
    ).toBe('nothing_to_release');
    await new Promise((r) => setTimeout(r, 20));
    await merged(f, 2, 'new change');
    const second = await post(po.headers, `/api/initiatives/${f.initiativeId}/releases`, {
      version: '1.1.0',
    });
    expect(second.statusCode).toBe(201);
    const c = await card(second.json().interactionId);
    expect(c.prs).toEqual([expect.objectContaining({ number: 2, title: 'new change' })]);
  });
});

describe('the map of an initiative', () => {
  it('follows the work from the spec to the release, and says who it waits on', async () => {
    const f = await setup();
    const po = await newPerson(['product_owner']);
    const url = `/api/initiatives/${f.initiativeId}/map`;
    const stages = async () =>
      Object.fromEntries(
        (await app.inject({ url, headers: po.headers })).json().stages.map((s: Stage) => [s.id, s]),
      );

    // The fixture's run is an engineer run that is running.
    let s = await stages();
    expect(s.spec.status).toBe('not_started');
    expect(s.build.status).toBe('working');

    // A spec agent is drafting.
    const [specRun] = await db
      .insert(agentRun)
      .values({
        initiativeId: f.initiativeId,
        agentRole: 'product',
        agentDefinitionId: 'product-agent',
        agentDefinitionVersion: 1,
        engine: 'claude-code',
        modelAlias: 'agent-default',
        state: 'running',
        sponsorPersonId: f.personId,
        repositoryId: f.repositoryId,
        budgetMicros: 1_000_000,
      })
      .returning();
    s = await stages();
    expect(s.spec.status).toBe('working');

    // Its pull request waits for the Product Owner.
    await db.update(agentRun).set({ state: 'succeeded' }).where(eq(agentRun.id, specRun!.id));
    const [g1] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: specRun!.id,
        type: 'review',
        checkpointId: 'G1',
        title: 'Review PR #1: spec',
        roleNeeded: 'product_owner',
        contextCard: { kind: 'pull_request', prNumber: 1 },
      })
      .returning();
    s = await stages();
    expect(s.spec).toMatchObject({ status: 'waiting_human', waitingOn: ['product_owner'] });

    // Approved and merged.
    await db
      .update(interaction)
      .set({
        state: 'answered',
        answer: { decision: 'approved', source: 'human' },
        contextCard: { kind: 'pull_request', prNumber: 1, gate: { state: 'merged' } },
      })
      .where(eq(interaction.id, g1!.id));
    s = await stages();
    expect(s.spec.status).toBe('done');
    expect(s.release.status).toBe('not_started');
    expect(
      (
        await app.inject({
          url: '/api/initiatives/00000000-0000-4000-8000-000000000000/map',
          headers: po.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ url })).statusCode).toBe(401);
  });
});
