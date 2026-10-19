import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
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
import { buildApp } from './app.js';
import { loadAgents } from './agents.js';
import { loadConfig } from './config.js';
import { GitHubClient, secretName } from './github-app.js';
import type { InlineModel } from './inline-model.js';
import { MemorySecrets } from './secrets.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const PAGE = `<script>\nfunction row(name){ return '<li onclick="pick(\\'' + name + '\\')">' + name + '</li>'; }\n</script>\n`;
const gh = {
  headOf: new Map<number, string>(),
  calls: [] as Array<{ method: string; url: string; body: Record<string, unknown> }>,
};
const finding = (over: Record<string, unknown> = {}) => ({
  severity: 'high',
  category: 'xss',
  file: 'public/app.js',
  line: 2,
  title: 'Name goes into an inline handler unescaped',
  why: 'A name with a quote breaks out of the attribute and runs script.',
  fix: 'Build the element with DOM calls, not a string.',
  ...over,
});

/** What the Security agent says next, and what it was asked. */
const model = {
  replies: [] as string[],
  asked: [] as Array<{ token: string; alias: string; system: string; user: string }>,
};
const fakeModel: InlineModel = {
  async ask(token, q) {
    model.asked.push({
      token,
      alias: q.alias,
      system: q.system,
      user: q.messages.map((m) => m.content).join('\n---\n'),
    });
    const next = model.replies.shift();
    if (next === undefined) throw new Error('the fake model has nothing to say');
    return next;
  },
};
const says = (summary: string, findings: unknown[]) => JSON.stringify({ summary, findings });

let server: http.Server;
let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let bare: Awaited<ReturnType<typeof buildApp>>;
let n = 0;
const sha = (k: number) => `cafe${String(k).padStart(36, '0')}`;

async function newPerson(roles: string[] = ['backend_engineer']) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `x${k}@example.test`, oidcSubject: `x${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    headers: {
      cookie: `sdlc_session=${app.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
    },
  };
}

async function review(changedPaths: string[] = ['public/app.js']) {
  const f = await createRunFixture(db);
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  await db.delete(githubApp);
  for (const k of ['agent', 'gate'])
    await db.insert(githubApp).values({
      kind: k,
      appId: 9,
      slug: k,
      name: k,
      ownerLogin: 'me',
      htmlUrl: 'https://x',
      installationId: 5,
      installedOn: (await db.select().from(repositoryEntry)).map((x) => x.fullName),
    });
  const prNumber = 700 + ++n;
  gh.headOf.set(prNumber, sha(prNumber));
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: `Review PR #${prNumber}: Add a page`,
      roleNeeded: 'backend_engineer',
      contextCard: {
        kind: 'pull_request',
        repository: repo!.fullName,
        prNumber,
        prUrl: `https://github.com/o/r/pull/${prNumber}`,
        headSha: sha(prNumber),
        diff: { changedPaths },
      },
    })
    .returning();
  return { id: row!.id, prNumber };
}

type Headers = Record<string, string>;
const url = (id: string, tail = '') => `/api/interactions/${id}/security${tail}`;
const get = (headers: Headers, id: string) => app.inject({ method: 'GET', url: url(id), headers });
const start = (headers: Headers, id: string) =>
  app.inject({ method: 'POST', url: url(id, '/start'), headers });
const dismiss = (headers: Headers, id: string, fid: string, reason?: string) =>
  app.inject({
    method: 'POST',
    url: url(id, `/findings/${fid}/dismiss`),
    headers,
    payload: reason === undefined ? {} : { reason },
  });
const sendBack = (headers: Headers, id: string) =>
  app.inject({ method: 'POST', url: url(id, '/send-back'), headers });
const approve = (headers: Headers, id: string) =>
  app.inject({
    method: 'POST',
    url: `/api/interactions/${id}/answer`,
    headers,
    payload: { decision: 'approved', answer: 'looks good' },
  });

/** Starts a security review and waits for it to finish, the way a person watching the page would. */
async function runAndWait(headers: Headers, id: string) {
  const res = await start(headers, id);
  expect(res.statusCode).toBe(202);
  for (let i = 0; i < 200; i++) {
    const s = (await get(headers, id)).json();
    if (s.run && s.run.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the security review did not finish');
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = req.url ?? '';
    gh.calls.push({
      method: req.method ?? '',
      url: u,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
    });
    const json = (status: number, b: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b));
    };
    if (u.endsWith('/access_tokens'))
      return json(201, { token: 'ghs_fake', expires_at: '2026-10-19T00:00:00Z', permissions: {} });
    if (/\/pulls\/\d+\/files/.test(u))
      return json(200, [
        { filename: 'public/app.js', status: 'added', patch: '+function row(name){}' },
        { filename: 'public/util.js', status: 'added', patch: '+export const u = 1;' },
      ]);
    const pr = /\/pulls\/(\d+)$/.exec(u);
    if (pr && req.method === 'GET')
      return json(200, {
        number: Number(pr[1]),
        title: 'Add a page',
        body: 'Adds the page.',
        html_url: 'https://github.com/o/r/pull/7',
        state: 'open',
        merged: false,
        mergeable_state: 'clean',
        head: { sha: gh.headOf.get(Number(pr[1])) ?? sha(0), ref: 'agent/run/change' },
        base: { ref: 'main' },
      });
    if (u.includes('/contents/public/app.js'))
      return json(200, { encoding: 'base64', content: Buffer.from(PAGE).toString('base64') });
    if (u.includes('/contents/public/util.js'))
      return json(200, {
        encoding: 'base64',
        content: Buffer.from('export const u = 1;').toString('base64'),
      });
    if (u.includes('/check-runs'))
      return json(200, {
        check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }],
      });
    if (req.method === 'POST' && u.endsWith('/reviews')) return json(200, { id: 1 });
    if (req.method === 'PUT' && u.endsWith('/merge'))
      return json(200, { sha: 'merge-sha', merged: true });
    if (req.method === 'POST' && u.endsWith('/comments')) return json(201, { id: 2 });
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const githubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-secroutes-'));
  devDb = await startDevDb({ dataDir, port: 56355 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const secrets = new MemorySecrets();
  for (const kind of ['agent', 'gate'] as const)
    await secrets.put(secretName(kind, 'private_key'), privateKey);
  const agents = await loadAgents(fileURLToPath(new URL('../../../agents', import.meta.url)));
  const make = (withAgent: boolean) =>
    buildApp({
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
      agents: withAgent ? agents : new Map(),
      securityModel: fakeModel,
    });
  app = await make(true);
  await app.ready();
  // The same platform without a Security agent.
  bare = await make(false);
  await bare.ready();
}, 180_000);

beforeEach(() => {
  gh.calls = [];
  model.replies = [];
  model.asked = [];
});

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await new Promise((r) => server?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe('the security review on a review', () => {
  it('holds the approval, reads the change on a click, and shows what it found', async () => {
    const r = await review();
    const who = await newPerson();

    const before = (await get(who.headers, r.id)).json();
    expect(before).toMatchObject({ available: true, required: true, run: null });
    expect(before.blocks).toContain('has not had a security review');
    const held = await approve(who.headers, r.id);
    expect(held.statusCode).toBe(409);
    expect(held.json().error.code).toBe('smoke_required');

    model.replies.push(says('One real problem.', [finding()]));
    const done = await runAndWait(who.headers, r.id);
    expect(done.run).toMatchObject({ state: 'done', summary: 'One real problem.' });
    expect(done.run.findings).toHaveLength(1);
    expect(done.run.findings[0]).toMatchObject({ id: 'F1', severity: 'high', category: 'xss' });
    expect(done.blocks).toContain('F1');
    expect((await approve(who.headers, r.id)).statusCode).toBe(409);

    // The agent was shown the diff and the full files, through an alias, with a token of its own.
    expect(model.asked).toHaveLength(1);
    const q = model.asked[0]!;
    expect(q.alias).toBe('agent-strong');
    expect(q.user).toContain('onclick="pick(');
    expect(q.user).toContain('export const u = 1;');
    expect(q.system).toContain('xss');
    const runs = await db.select().from(agentRun).where(eq(agentRun.agentRole, 'security'));
    expect(runs.some((x) => x.state === 'succeeded')).toBe(true);
  });

  it('lets a finding go only with a reasoned dismissal by someone who may approve, and then merges', async () => {
    const r = await review();
    const reviewer = await newPerson();
    model.replies.push(
      says('Found one.', [finding(), finding({ severity: 'medium', title: 'No rate limit' })]),
    );
    await runAndWait(reviewer.headers, r.id);

    expect((await dismiss(reviewer.headers, r.id, 'F1')).statusCode).toBe(400);
    expect((await dismiss(reviewer.headers, r.id, 'F1', 'no')).json().error.code).toBe(
      'reason_required',
    );
    const nobody = await newPerson([]);
    expect(
      (await dismiss(nobody.headers, r.id, 'F1', 'this reason is long enough')).statusCode,
    ).toBe(403);
    const wrongHat = await newPerson(['frontend_engineer']);
    expect(
      (await dismiss(wrongHat.headers, r.id, 'F1', 'this reason is long enough')).statusCode,
    ).toBe(403);
    expect(
      (await dismiss(reviewer.headers, r.id, 'F9', 'this reason is long enough')).statusCode,
    ).toBe(404);

    const res = await dismiss(
      reviewer.headers,
      r.id,
      'F1',
      'Names come from a fixed list in this demo.',
    );
    expect(res.statusCode).toBe(201);
    expect(
      (await dismiss(reviewer.headers, r.id, 'F1', 'this reason is long enough')).statusCode,
    ).toBe(409);
    const after = (await get(reviewer.headers, r.id)).json();
    expect(after.blocks).toBeNull();
    expect(after.run.findings[0].dismissed).toMatchObject({
      reason: 'Names come from a fixed list in this demo.',
    });

    expect((await approve(reviewer.headers, r.id)).statusCode).toBe(200);
    const approval = gh.calls.find((c) => c.url.endsWith('/reviews'))!;
    expect(approval.body.body).toContain('Security review:');
    expect(approval.body.body).toContain('F1 dismissed by');
    expect(approval.body.body).toContain('Names come from a fixed list in this demo.');
    expect(gh.calls.some((c) => c.url.endsWith('/merge'))).toBe(true);
  });

  it('does not hold the approval for medium and low findings, or a clean review', async () => {
    const r = await review();
    const who = await newPerson();
    model.replies.push(
      says('Small things.', [
        finding({ severity: 'medium', title: 'No rate limit' }),
        finding({ severity: 'low', title: 'Verbose error' }),
      ]),
    );
    const done = await runAndWait(who.headers, r.id);
    expect(done.run.findings).toHaveLength(2);
    expect(done.blocks).toBeNull();
    expect((await approve(who.headers, r.id)).statusCode).toBe(200);

    const clean = await review();
    model.replies.push(says('Nothing to report.', []));
    const ok = await runAndWait(who.headers, clean.id);
    expect(ok.run.findings).toEqual([]);
    expect(ok.blocks).toBeNull();
    expect((await approve(who.headers, clean.id)).statusCode).toBe(200);
  });

  it('sends the findings back to the engineer as a change request in one click', async () => {
    const r = await review();
    const who = await newPerson();
    expect((await sendBack(who.headers, r.id)).json().error.code).toBe('no_review');
    model.replies.push(says('One problem.', [finding()]));
    await runAndWait(who.headers, r.id);

    const out = await sendBack(who.headers, r.id);
    expect(out.statusCode).toBe(201);
    expect(out.json()).toEqual({ sent: 1 });
    const [row] = await db.select().from(interaction).where(eq(interaction.id, r.id));
    expect(row!.state).toBe('answered');
    expect(row!.answer).toMatchObject({
      decision: 'changes_requested',
      text: expect.stringContaining('F1 [high] Name goes into an inline handler unescaped'),
    });
    expect(gh.calls.some((c) => c.url.endsWith('/merge'))).toBe(false);
  });

  it('asks again once when the answer cannot be read, then says it could not finish', async () => {
    const r = await review();
    const who = await newPerson();
    model.replies.push('Looks fine to me!', 'Still not JSON.');
    const done = await runAndWait(who.headers, r.id);
    expect(model.asked).toHaveLength(2);
    expect(model.asked[1]!.user).toContain('could not be read');
    expect(done.run.state).toBe('error');
    expect(done.blocks).toContain('could not finish');
    expect((await approve(who.headers, r.id)).statusCode).toBe(409);

    // A second click tries again, and a good answer clears it.
    model.replies.push('{ "summary": "ok", "findings": [] }');
    const again = await runAndWait(who.headers, r.id);
    expect(again.run.state).toBe('done');
    expect(again.blocks).toBeNull();
  });

  it('reports a model that is down as an error to retry, not as a pass', async () => {
    const r = await review();
    const who = await newPerson();
    const done = await runAndWait(who.headers, r.id);
    expect(done.run.state).toBe('error');
    expect(done.run.detail).toContain('could not run the security review');
    expect(done.blocks).toContain('Run it again');
  });

  it('has nothing to read in a change that only touches documents', async () => {
    const r = await review(['README.md', 'docs/guide.md']);
    const who = await newPerson();
    expect((await get(who.headers, r.id)).json()).toMatchObject({ required: false, blocks: null });
    const res = await start(who.headers, r.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('not_needed');
    expect((await approve(who.headers, r.id)).statusCode).toBe(200);
  });

  it('is only for a person with a role, and shows a new commit as not yet reviewed', async () => {
    const r = await review();
    const who = await newPerson();
    const nobody = await newPerson([]);
    expect((await start(nobody.headers, r.id)).statusCode).toBe(403);

    model.replies.push(says('Nothing to report.', []));
    await runAndWait(who.headers, r.id);
    // The engineer pushed again: the review of the old commit says nothing about the new one.
    const [row] = await db.select().from(interaction).where(eq(interaction.id, r.id));
    await db
      .update(interaction)
      .set({ contextCard: { ...(row!.contextCard as object), headSha: sha(9999) } })
      .where(eq(interaction.id, r.id));
    expect((await get(who.headers, r.id)).json()).toMatchObject({ run: null });
    expect((await approve(who.headers, r.id)).statusCode).toBe(409);
  });

  it('is off on a platform with no Security agent, and asks nothing', async () => {
    const r = await review();
    const who = await newPerson();
    const res = await bare.inject({ method: 'GET', url: url(r.id), headers: who.headers });
    expect(res.json()).toMatchObject({ available: false, required: false, blocks: null });
    const st = await bare.inject({
      method: 'POST',
      url: url(r.id, '/start'),
      headers: who.headers,
    });
    expect(st.statusCode).toBe(409);
    expect(st.json().error.code).toBe('security_off');
    const ok = await bare.inject({
      method: 'POST',
      url: `/api/interactions/${r.id}/answer`,
      headers: who.headers,
      payload: { decision: 'approved', answer: 'looks good' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
