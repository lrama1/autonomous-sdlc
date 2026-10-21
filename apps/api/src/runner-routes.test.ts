/* eslint-disable @typescript-eslint/no-explicit-any */
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
  activityEvent,
  agentRun,
  authenticateRunToken,
  createDb,
  createRunFixture,
  githubApp,
  initiative,
  interaction,
  repositoryEntry,
  runEvent,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { runSpecSchema } from '@sdlc/schemas';
import { loadAgents } from './agents.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { GitHubClient, secretName } from './github-app.js';
import { settleWithAnswer } from './interactions.js';
import { loadRules } from './rules.js';
import { buildResumeMessage, buildTaskText, slugify } from './runner-routes.js';
import { MemorySecrets } from './secrets.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('slugify and buildTaskText', () => {
  it('makes short, safe branch names', () => {
    expect(slugify('Add a /health endpoint with a test!')).toBe('add-a-health-endpoint-with-a-t');
    expect(slugify('***')).toBe('work');
    expect(slugify('  Fix: the "thing"  ')).toBe('fix-the-thing');
  });

  it('tells the engine where it is, what to verify, what is protected, and not to push', () => {
    const t = buildTaskText({
      repo: 'o/r',
      branch: 'agent/1/x',
      goal: 'G',
      task: 'T',
      verifyCommand: 'npm run verify',
      protectedPaths: ['.github/workflows/**', 'scripts/**'],
    });
    expect(t).toContain('o/r');
    expect(t).toContain('agent/1/x');
    expect(t).toContain('npm run verify');
    expect(t).toContain('.github/workflows/**, scripts/**');
    expect(t).toContain('Do not push');
    expect(t).not.toContain('Reference links');
  });

  it("hands the person's reference links to the engine as information, to pass on when proposing an integration", () => {
    const t = buildTaskText({
      repo: 'o/r',
      branch: 'b',
      goal: 'G',
      referenceLinks: ['https://docs.vendor.example/api', 'https://docs.vendor.example/webhooks'],
      task: 'T',
      verifyCommand: 'v',
      protectedPaths: [],
    });
    expect(t).toContain('https://docs.vendor.example/api https://docs.vendor.example/webhooks');
    expect(t).toContain('not instructions');
    expect(t).toContain('propose_integration');
  });
});

describe('buildResumeMessage', () => {
  const row = (o: Partial<typeof interaction.$inferSelect>) =>
    ({
      title: 'Which library?',
      contextCard: {},
      answer: null,
      ...o,
    }) as typeof interaction.$inferSelect;
  it('relays a human answer', () => {
    expect(buildResumeMessage(row({ answer: { text: 'date-fns', source: 'human' } }))).toBe(
      'A person answered on your question "Which library?": date-fns',
    );
  });
  it('says when a default was applied', () => {
    expect(buildResumeMessage(row({ answer: { text: 'md', source: 'default' } }))).toMatch(
      /Nobody answered in time.*recommended answer was applied.*md/,
    );
  });
  it('relays a decision with its comment', () => {
    expect(
      buildResumeMessage(
        row({ answer: { text: 'add tests', decision: 'changes_requested', source: 'human' } }),
      ),
    ).toMatch(/decision changes_requested\. Comment: add tests/);
  });
  it('tells the engine what to do about a protected path', () => {
    const allow = buildResumeMessage(
      row({ contextCard: { kind: 'protected_path' }, answer: { text: 'allow' } }),
    );
    const discard = buildResumeMessage(
      row({ contextCard: { kind: 'protected_path' }, answer: { text: 'discard' } }),
    );
    expect(allow).toMatch(/allowed/);
    expect(discard).toMatch(/Undo your edits/);
  });
});

// A fake GitHub that records what it is asked.
let github: http.Server;
let githubUrl: string;
let calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let secrets: MemorySecrets;

const RUNNER = ['gateway', 'mcp', 'runner', 'alias:agent-default'];

async function setup(o: Parameters<typeof createRunFixture>[1] = {}) {
  const f = await createRunFixture(db, { scopes: RUNNER, ...o });
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  await db
    .update(repositoryEntry)
    .set({ protectedPaths: ['.github/workflows/**', 'scripts/**'] })
    .where(eq(repositoryEntry.id, repo!.id));
  await db.delete(githubApp);
  for (const kind of ['agent', 'gate']) {
    await db.insert(githubApp).values({
      kind,
      appId: 99,
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

// fetch's json() is typed unknown. These tests read many shapes, so they read them loosely.
const j = async (r: Response): Promise<any> => r.json();

const get = (token: string | undefined, url: string) =>
  fetch(`${base}${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (token: string | undefined, url: string, body: unknown) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  github = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method ?? '', url: req.url ?? '', body });
    const json = (status: number, b: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b));
    };
    if (req.url?.endsWith('/access_tokens'))
      return json(201, {
        token: 'ghs_fake',
        expires_at: '2026-10-17T23:00:00Z',
        repository_selection: 'selected',
        permissions: body.permissions ?? {},
      });
    if (req.method === 'POST' && /\/repos\/.+\/pulls$/.test(req.url ?? '')) {
      return json(201, {
        number: 7,
        html_url: 'https://github.com/o/r/pull/7',
        state: 'open',
        merged: false,
        head: { sha: 'abc123', ref: body.head },
        base: { ref: body.base },
      });
    }
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));
  githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-rr-'));
  devDb = await startDevDb({ dataDir, port: 56336 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  secrets = new MemorySecrets();
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
      GATEWAY_URL: 'http://127.0.0.1:8787',
      RULES_FILE: path.join(root, 'rules/triggers.yaml'),
    }),
    deps: made,
    workers: false,
    secrets,
    github: new GitHubClient(githubUrl),
    agents: await loadAgents(path.join(root, 'agents')),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await new Promise((r) => github?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

beforeEach(() => {
  calls = [];
});

describe('the rules file', () => {
  it('loads and has the protected-path hard stop', async () => {
    const rules = await loadRules(path.join(root, 'rules/triggers.yaml'));
    expect(rules.triggers.find((t) => t.id === 'protected-path')?.action).toBe('hard_stop');
    expect(rules.pre_approved_change_types[0]?.id).toBe('docs-only');
  });
});

describe('who may call the runner routes', () => {
  it('needs a run token with the runner scope', async () => {
    expect((await get(undefined, '/runner/spec')).status).toBe(401);
    expect((await get('sdlc_nope', '/runner/spec')).status).toBe(401);
    const f = await setup({ scopes: ['gateway', 'mcp'] });
    expect((await get(f.token, '/runner/spec')).status).toBe(401);
  });

  it('refuses a run that has finished, which tells the runner to stop', async () => {
    const f = await setup({ state: 'cancelled' });
    const r = await post(f.token, '/runner/events', { events: [{ type: 'x' }] });
    expect(r.status).toBe(403);
    expect((await j(r)).error.code).toBe('run_not_active');
  });
});

describe('GET /runner/spec', () => {
  it('returns everything the runner needs, with a git token limited to the one repository', async () => {
    const f = await setup({ state: 'starting' });
    await db
      .update(agentRun)
      .set({ task: 'Add a /health endpoint' })
      .where(eq(agentRun.id, f.runId));
    const res = await get(f.token, '/runner/spec');
    expect(res.status).toBe(200);
    const spec = runSpecSchema.parse(await j(res));
    expect(spec).toMatchObject({
      runId: f.runId,
      role: 'backend_engineer',
      engine: 'claude-code',
      resume: null,
      definition: { id: 'backend-engineer', version: 1 },
      model: { alias: 'agent-default' },
      gateway: { baseUrl: 'http://127.0.0.1:8787' },
      git: { token: 'ghs_fake' },
      repo: {
        fullName: f.repo.fullName,
        integrationBranch: 'main',
        writeMode: 'branch_pr',
        verifyCommand: 'npm run verify',
        protectedPaths: ['.github/workflows/**', 'scripts/**'],
      },
      limits: { maxTurns: 100, maxVerifyAttempts: 3 },
      tools: { denied: ['web_fetch'] },
    });
    expect(spec.repo.branch).toBe(`agent/${f.runId}/add-a-health-endpoint`);
    expect(spec.task).toContain('Add a /health endpoint');
    expect(spec.task).toContain('fixture goal');
    expect(spec.systemPrompt).toContain('ask_human');
    expect(spec.mcp.url).toMatch(/\/mcp$/);

    const tokenCall = calls.find((c) => c.url.endsWith('/access_tokens'))!;
    expect(tokenCall.body).toEqual({
      repositories: [f.repo.fullName.split('/')[1]],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run!.branch).toBe(spec.repo.branch);
  });

  it('keeps the same branch on a later call', async () => {
    const f = await setup({ state: 'starting' });
    const a = runSpecSchema.parse(await (await get(f.token, '/runner/spec')).json());
    const b = runSpecSchema.parse(await (await get(f.token, '/runner/spec')).json());
    expect(b.repo.branch).toBe(a.repo.branch);
  });

  it('adds the resume message when a parked run is resuming', async () => {
    const f = await setup({ state: 'resuming' });
    const [q] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'question',
        title: 'Which database?',
        roleNeeded: 'backend_engineer',
      })
      .returning();
    await settleWithAnswer(db, q!.id, { answer: 'PostgreSQL', by: f.personId, via: 'workspace' });
    await db.update(agentRun).set({ parkReason: q!.id }).where(eq(agentRun.id, f.runId));
    const spec = runSpecSchema.parse(await (await get(f.token, '/runner/spec')).json());
    expect(spec.resume?.message).toBe(
      'A person answered on your question "Which database?": PostgreSQL',
    );
  });

  it('says so when the GitHub App is not installed on the repository', async () => {
    const f = await setup({ state: 'starting' });
    await db.update(githubApp).set({ installedOn: [] });
    const res = await get(f.token, '/runner/spec');
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatchObject({
      code: 'github_not_ready',
      message: expect.stringMatching(/not installed on/),
    });
  });
});

describe('events and state', () => {
  it('appends events in order and rejects a bad body', async () => {
    const f = await setup({ state: 'running' });
    const ok = await post(f.token, '/runner/events', {
      events: [
        { type: 'message', payload: { text: 'hi' } },
        { type: 'tool.call', payload: { name: 'Write' } },
      ],
    });
    expect(await j(ok)).toEqual({ ok: true, accepted: 2 });
    const rows = await db.select().from(runEvent).where(eq(runEvent.runId, f.runId));
    expect(rows.map((r) => [r.seq, r.type])).toEqual([
      [1, 'message'],
      [2, 'tool.call'],
    ]);
    expect((await post(f.token, '/runner/events', { events: [] })).status).toBe(400);
  });

  it('moves starting to running', async () => {
    const f = await setup({ state: 'starting' });
    await post(f.token, '/runner/state', { state: 'running' });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run!.state).toBe('running');
    expect(run!.startedAt).not.toBeNull();
  });

  it('finishing succeeds the run, revokes its token, and logs it', async () => {
    const f = await setup({ state: 'running' });
    const r = await post(f.token, '/runner/state', {
      state: 'finished',
      exitReason: 'finished',
      summary: 'Added /health.',
    });
    expect(await j(r)).toEqual({ ok: true, state: 'succeeded' });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run).toMatchObject({ state: 'succeeded', exitReason: 'finished' });
    expect(run!.finishedAt).not.toBeNull();
    expect(await authenticateRunToken(db, f.token)).toBeNull();
    const events = await db.select().from(runEvent).where(eq(runEvent.runId, f.runId));
    expect(events.map((e) => e.type)).toEqual(['run.summary', 'run.finished']);
    const log = await db.select().from(activityEvent).where(eq(activityEvent.runId, f.runId));
    expect(log.map((l) => l.action)).toEqual(['run.succeeded']);
  });

  it.each([
    ['verify_failed', 'failed'],
    ['error', 'failed'],
    ['budget', 'budget_exceeded'],
    ['timeout', 'timed_out'],
    ['cancelled', 'cancelled'],
  ])('maps the exit reason %s to the state %s', async (exitReason, state) => {
    const f = await setup({ state: 'running' });
    await post(f.token, '/runner/state', { state: 'finished', exitReason });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run!.state).toBe(state);
  });

  it('a parked exit keeps the run parked and the token valid for the resume', async () => {
    const f = await setup({ state: 'parked' });
    await post(f.token, '/runner/state', { state: 'finished', exitReason: 'parked' });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run).toMatchObject({ state: 'parked', exitReason: 'parked', finishedAt: null });
  });
});

describe('triggers', () => {
  it('a protected-path change becomes a hard-stop decision and parks the run', async () => {
    const f = await setup({ state: 'running' });
    const res = await post(f.token, '/runner/trigger', {
      kind: 'protected_path',
      summary: 'Edited the CI workflow',
      paths: ['.github/workflows/ci.yml'],
    });
    const { interactionId } = await j(res);
    const [row] = await db.select().from(interaction).where(eq(interaction.id, interactionId));
    expect(row).toMatchObject({
      type: 'decision',
      hardStop: true,
      state: 'open',
      recommendation: 'discard',
      roleNeeded: 'backend_engineer',
    });
    expect(row!.title).toContain('.github/workflows/ci.yml');
    expect(row!.options).toEqual([
      expect.objectContaining({ id: 'allow' }),
      expect.objectContaining({ id: 'discard' }),
    ]);
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run).toMatchObject({ state: 'parked', parkReason: interactionId });
  });

  it('repeated verification failures become a question and park the run', async () => {
    const f = await setup({ state: 'running' });
    const res = await post(f.token, '/runner/trigger', {
      kind: 'verify_failed',
      summary: 'smoke check failed three times',
    });
    const [row] = await db
      .select()
      .from(interaction)
      .where(eq(interaction.id, (await j(res)).interactionId));
    expect(row).toMatchObject({ type: 'question', hardStop: false });
  });
});

describe('POST /runner/pull-request', () => {
  const diff = (o = {}) => ({
    changedPaths: ['src/server.js', 'test/server.test.js'],
    linesChanged: 24,
    dependencyAdded: false,
    testsDeletedOrSkipped: false,
    protectedPathsTouched: [],
    ...o,
  });
  const pr = (d = diff()) => ({
    title: 'Add /health endpoint',
    body: 'Adds the endpoint and a test.',
    diff: d,
    verify: {
      ok: true,
      command: 'npm run verify',
      attempts: 1,
      durationMs: 1800,
      summary: '2 tests passed, smoke check passed',
    },
    summary: 'Added /health.',
  });

  it('opens the PR as the Agent App and asks for a review', async () => {
    const f = await setup({ state: 'running' });
    await db
      .update(agentRun)
      .set({ branch: `agent/${f.runId}/x` })
      .where(eq(agentRun.id, f.runId));
    const res = await post(f.token, '/runner/pull-request', pr());
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body).toMatchObject({ number: 7, url: 'https://github.com/o/r/pull/7', triggers: [] });

    const opened = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))!;
    expect(opened.url).toBe(`/repos/${f.repo.fullName}/pulls`);
    expect(opened.body).toEqual({
      title: 'Add /health endpoint',
      body: 'Adds the endpoint and a test.',
      head: `agent/${f.runId}/x`,
      base: 'main',
    });

    const [review] = await db
      .select()
      .from(interaction)
      .where(eq(interaction.id, body.interactionId));
    expect(review).toMatchObject({
      type: 'review',
      checkpointId: 'G3',
      state: 'open',
      roleNeeded: 'backend_engineer',
      hardStop: false,
    });
    expect(review!.contextCard).toMatchObject({
      kind: 'pull_request',
      prNumber: 7,
      headSha: 'abc123',
      verify: { ok: true },
      triggers: [],
      preApprovedType: null,
    });
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, f.runId));
    expect(run!.prNumber).toBe(7);
  });

  describe('by autonomy mode', () => {
    async function open(mode: string, d = diff()) {
      const f = await setup({ state: 'running' });
      await db
        .update(agentRun)
        .set({ branch: `agent/${f.runId}/x` })
        .where(eq(agentRun.id, f.runId));
      await db
        .update(initiative)
        .set({ autonomyMode: mode })
        .where(eq(initiative.id, f.initiativeId));
      const body = await j(await post(f.token, '/runner/pull-request', pr(d)));
      const [review] = await db
        .select()
        .from(interaction)
        .where(eq(interaction.id, body.interactionId));
      return { body, review: review!, f };
    }
    const docsOnly = diff({ changedPaths: ['README.md', 'docs/guide.md'] });

    it('balanced: a pre-approved type is approved by rule, with nobody asked', async () => {
      const { body, review } = await open('balanced', docsOnly);
      expect(body.autoMerge).toBe(true);
      expect(review).toMatchObject({ state: 'answered', answeredVia: 'auto', answeredBy: null });
      expect(review.answer).toMatchObject({
        decision: 'approved',
        source: 'policy',
        rule: 'docs-only',
      });
      expect(review.contextCard).toMatchObject({
        autoMerge: { mode: 'balanced', auto: true, rule: 'docs-only' },
      });
    });

    it('balanced: other changes wait for a person, and the review says why', async () => {
      const { body, review } = await open('balanced');
      expect(body.autoMerge).toBe(false);
      expect(review.state).toBe('open');
      expect(review.contextCard).toMatchObject({
        autoMerge: { auto: false, reason: expect.stringContaining('only pre-approved') },
      });
    });

    it('guided: everything waits for a person, even a pre-approved type', async () => {
      const { review } = await open('guided', docsOnly);
      expect(review.state).toBe('open');
    });

    it('autopilot: a change no trigger fired on still waits for the security review, and nothing is approved by rule before it ran', async () => {
      const { body, review } = await open('autopilot');
      expect(body.triggers).toEqual([]);
      expect(review.state).toBe('open');
    });

    it('autopilot: a fired trigger still goes to a person', async () => {
      const { body, review } = await open('autopilot', diff({ dependencyAdded: true }));
      expect(body.autoMerge).toBe(false);
      expect(review.state).toBe('open');
    });

    it('autopilot: a change that writes unescaped text into the page goes to a person, and says why', async () => {
      const { body, review } = await open('autopilot', diff({ unsafeHtml: true }));
      expect(body.autoMerge).toBe(false);
      expect(body.triggers.map((t: { id: string }) => t.id)).toEqual(['unsafe-html']);
      expect(review.state).toBe('open');
      expect(review.contextCard).toMatchObject({
        triggers: [
          expect.objectContaining({
            id: 'unsafe-html',
            description: expect.stringContaining('cross-site scripting'),
          }),
        ],
      });
    });

    it('autopilot: a runner that does not report the check at all is taken to mean no', async () => {
      const old = diff() as Record<string, unknown>;
      delete old.unsafeHtml;
      const { body } = await open('autopilot', old as ReturnType<typeof diff>);
      expect(body.triggers).toEqual([]);
    });

    it('a spec from the Product agent is always decided by a person (G1), even in autopilot', async () => {
      const f = await setup({ state: 'running' });
      await db
        .update(agentRun)
        .set({ branch: `agent/${f.runId}/x`, agentRole: 'product' })
        .where(eq(agentRun.id, f.runId));
      await db
        .update(initiative)
        .set({ autonomyMode: 'autopilot' })
        .where(eq(initiative.id, f.initiativeId));
      const body = await j(await post(f.token, '/runner/pull-request', pr(docsOnly)));
      const [review] = await db
        .select()
        .from(interaction)
        .where(eq(interaction.id, body.interactionId));
      expect(body.autoMerge).toBe(false);
      expect(review).toMatchObject({
        checkpointId: 'G1',
        state: 'open',
        roleNeeded: 'product_owner',
      });
      expect(review!.contextCard).toMatchObject({
        autoMerge: { auto: false, reason: expect.stringContaining('checkpoint G1') },
      });
    });

    it('a failure at GitHub does not undo the pull request or the report', async () => {
      // The fake GitHub has no review or merge endpoints, so the Gate cannot finish. The run's report still succeeds.
      const { body, review } = await open('balanced', docsOnly);
      expect(body.number).toBe(7);
      expect((review.contextCard as { gate?: { state?: string } }).gate?.state).toBe('failed');
    });
  });

  it('shows the triggers that fired on the review', async () => {
    const f = await setup({ state: 'running' });
    await db
      .update(agentRun)
      .set({ branch: `agent/${f.runId}/x` })
      .where(eq(agentRun.id, f.runId));
    const res = await post(
      f.token,
      '/runner/pull-request',
      pr(diff({ dependencyAdded: true, changedPaths: ['package.json', 'src/auth/login.js'] })),
    );
    const body = await j(res);
    expect(body.triggers.map((t: { id: string }) => t.id).sort()).toEqual([
      'auth-code',
      'new-dependency',
    ]);
  });

  it('refuses a hard stop and opens no PR', async () => {
    const f = await setup({ state: 'running' });
    await db
      .update(agentRun)
      .set({ branch: `agent/${f.runId}/x` })
      .where(eq(agentRun.id, f.runId));
    const res = await post(
      f.token,
      '/runner/pull-request',
      pr(diff({ protectedPathsTouched: ['.github/workflows/ci.yml'] })),
    );
    expect(res.status).toBe(409);
    expect((await j(res)).error.code).toBe('hard_stop');
    expect(calls.some((c) => c.url.endsWith('/pulls'))).toBe(false);
  });

  it('recognises a documentation-only change as pre-approved', async () => {
    const f = await setup({ state: 'running' });
    await db
      .update(agentRun)
      .set({ branch: `agent/${f.runId}/x` })
      .where(eq(agentRun.id, f.runId));
    const res = await post(
      f.token,
      '/runner/pull-request',
      pr(diff({ changedPaths: ['README.md', 'docs/guide.md'] })),
    );
    const [review] = await db
      .select()
      .from(interaction)
      .where(eq(interaction.id, (await j(res)).interactionId));
    expect((review!.contextCard as { preApprovedType: string }).preApprovedType).toBe('docs-only');
  });
});
