/* eslint-disable @typescript-eslint/no-explicit-any */
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
  addRunToFixture,
  createDb,
  createRunFixture,
  githubApp,
  hat,
  interaction,
  person,
  repositoryEntry,
  runEvent,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createGate } from './gate.js';
import { GitHubClient, secretName } from './github-app.js';
import { GitHubService } from './github-service.js';
import { settleWithAnswer } from './interactions.js';
import { MemorySecrets } from './secrets.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// A fake GitHub whose answers each test controls.
interface World {
  pr: { state: string; merged: boolean; sha: string };
  ci: string | null; // check conclusion, 'in_progress' for running, null for no such check
  mergeStatus: number;
  calls: Array<{ method: string; url: string; body: any }>;
}
let world: World;
const reset = (): World =>
  (world = {
    pr: { state: 'open', merged: false, sha: 'sha-reviewed' },
    ci: 'success',
    mergeStatus: 200,
    calls: [],
  });

let github: http.Server;
let githubUrl: string;
let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let service: GitHubService;
let n = 0;

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

/** A review interaction as the runner's pull-request route creates it, already approved by a person. */
async function approvedReview(
  f: Awaited<ReturnType<typeof setup>>,
  decision: 'approved' | 'changes_requested' | 'rejected' = 'approved',
  text = 'LGTM',
) {
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: 'Review PR #7: Add /health endpoint',
      roleNeeded: 'backend_engineer',
      contextCard: {
        kind: 'pull_request',
        repository: f.repo.fullName,
        prNumber: 7,
        prUrl: 'https://github.com/o/r/pull/7',
        headSha: 'sha-reviewed',
      },
    })
    .returning();
  const settled = await settleWithAnswer(db, row!.id, {
    answer: text,
    decision,
    by: f.personId,
    via: 'workspace',
  });
  return settled!;
}

const card = async (id: string) =>
  (await db.select().from(interaction).where(eq(interaction.id, id)))[0]!.contextCard as any;
const calledPaths = () =>
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
    if (req.method === 'GET' && /\/pulls\/7$/.test(url))
      return json(200, {
        number: 7,
        state: world.pr.state,
        merged: world.pr.merged,
        head: { sha: world.pr.sha, ref: 'agent/x' },
        base: { ref: 'main' },
      });
    if (req.method === 'GET' && url.includes('/check-runs')) {
      return json(200, {
        check_runs:
          world.ci === null
            ? []
            : [
                {
                  name: 'verify',
                  status: world.ci === 'in_progress' ? 'in_progress' : 'completed',
                  conclusion: world.ci === 'in_progress' ? null : world.ci,
                },
              ],
      });
    }
    if (req.method === 'POST' && url.endsWith('/reviews')) return json(200, { id: 1 });
    if (req.method === 'PUT' && url.endsWith('/merge'))
      return world.mergeStatus === 200
        ? json(200, { sha: 'merge-sha-1', merged: true })
        : json(world.mergeStatus, { message: 'Pull Request is not mergeable' });
    if (req.method === 'POST' && url.endsWith('/comments')) return json(201, { id: 2 });
    if (req.method === 'PATCH' && /\/pulls\/7$/.test(url)) return json(200, {});
    return json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));
  githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-gate-'));
  devDb = await startDevDb({ dataDir, port: 56337 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const secrets = new MemorySecrets();
  for (const kind of ['agent', 'gate'] as const)
    await secrets.put(secretName(kind, 'private_key'), privateKey);
  service = new GitHubService(db, secrets, new GitHubClient(githubUrl));
  reset();
}, 180_000);

afterAll(async () => {
  await new Promise((r) => github?.close(r));
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

beforeEach(() => reset());

const gate = (o: { waitForCiMs?: number } = {}) =>
  createGate({ db, github: service, log: () => {}, ...o });

describe('approval', () => {
  it('the Gate App approves and merges when a person approved, the check is green, and the commit is the reviewed one', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    expect(await gate().afterDecision(row)).toBe('merged');

    expect(calledPaths()).toEqual([
      'GET /pulls/7',
      'GET /commits/sha-reviewed/check-runs',
      'POST /pulls/7/reviews',
      'PUT /pulls/7/merge',
    ]);
    const review = world.calls.find((c) => c.url.endsWith('/reviews'))!;
    expect(review.body.event).toBe('APPROVE');
    expect(review.body.body).toContain('LGTM');
    const merge = world.calls.find((c) => c.url.endsWith('/merge'))!;
    expect(merge.body).toEqual({
      merge_method: 'squash',
      commit_title: 'Add /health endpoint (#7)',
    });

    expect((await card(row.id)).gate).toMatchObject({ state: 'merged', mergedSha: 'merge-sha-1' });
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.interactionId, row.id));
    expect(log.map((l) => l.action)).toContain('pull_request.merged');
    const events = await db.select().from(runEvent).where(eq(runEvent.runId, f.runId));
    expect(events.map((e) => e.type)).toContain('pull_request.merged');
  });

  it('waits while the check is still running, then merges on a later tick', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.ci = 'in_progress';
    expect(await gate().afterDecision(row)).toBe('waiting_ci');
    expect(world.calls.some((c) => c.url.endsWith('/merge'))).toBe(false);
    expect((await card(row.id)).gate.state).toBe('waiting_ci');

    world.ci = 'success';
    expect(await gate().tick()).toBeGreaterThanOrEqual(1);
    expect((await card(row.id)).gate).toMatchObject({ state: 'merged' });
  });

  it('keeps waiting when the check has not appeared yet', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.ci = null;
    expect(await gate().afterDecision(row)).toBe('waiting_ci');
  });

  it('gives up after the wait limit', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.ci = 'in_progress';
    const g = gate({ waitForCiMs: 1 });
    await g.afterDecision(row);
    await new Promise((r) => setTimeout(r, 20));
    await g.tick();
    expect((await card(row.id)).gate.state).toBe('timed_out');
  });

  it('does not merge when the check failed, and says so on the pull request', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.ci = 'failure';
    expect(await gate().afterDecision(row)).toBe('ci_failed');
    expect(world.calls.some((c) => c.url.endsWith('/merge') || c.url.endsWith('/reviews'))).toBe(
      false,
    );
    expect(world.calls.find((c) => c.url.endsWith('/comments'))!.body.body).toContain('failure');
  });

  it('does not merge commits the person did not review', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.pr.sha = 'sha-pushed-later';
    expect(await gate().afterDecision(row)).toBe('stale');
    expect(world.calls.some((c) => c.url.endsWith('/merge') || c.url.endsWith('/reviews'))).toBe(
      false,
    );
    expect((await card(row.id)).gate.detail).toMatch(/new commits/);
  });

  it('recognises a pull request that was already merged or closed', async () => {
    const f = await setup();
    world.pr.merged = true;
    expect(await gate().afterDecision(await approvedReview(f))).toBe('merged');
    reset();
    world.pr.state = 'closed';
    expect(await gate().afterDecision(await approvedReview(f))).toBe('closed');
  });

  it('records a GitHub refusal instead of throwing', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.mergeStatus = 405;
    expect(await gate().afterDecision(row)).toBe('failed');
    expect((await card(row.id)).gate).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('405'),
    });
  });
});

describe('other decisions', () => {
  it('changes requested only leaves a comment', async () => {
    const f = await setup();
    await gate().afterDecision(await approvedReview(f, 'changes_requested', 'add a test'));
    expect(calledPaths()).toEqual(['POST /issues/7/comments']);
    expect(world.calls[world.calls.length - 1]!.body.body).toContain('add a test');
  });

  it('rejected comments and closes the pull request', async () => {
    const f = await setup();
    await gate().afterDecision(await approvedReview(f, 'rejected', 'wrong approach'));
    expect(calledPaths()).toEqual(['POST /issues/7/comments', 'PATCH /pulls/7']);
    expect(world.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ state: 'closed' });
  });

  it('ignores interactions that are not pull request reviews', async () => {
    const f = await setup();
    const [q] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'question',
        title: 'q',
        roleNeeded: 'backend_engineer',
      })
      .returning();
    const settled = await settleWithAnswer(db, q!.id, {
      answer: 'x',
      by: f.personId,
      via: 'workspace',
    });
    expect(await gate().afterDecision(settled!)).toBe('ignored');
    expect(world.calls).toHaveLength(0);
  });
});

describe('through the answer route', () => {
  it('a different person approving the review makes the Gate merge it', async () => {
    const f = await setup();
    const sponsorRun = await addRunToFixture(db, f);
    const [review] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: sponsorRun.runId,
        type: 'review',
        checkpointId: 'G3',
        title: 'Review PR #7: Add /health endpoint',
        roleNeeded: 'backend_engineer',
        contextCard: {
          kind: 'pull_request',
          repository: f.repo.fullName,
          prNumber: 7,
          prUrl: 'https://github.com/o/r/pull/7',
          headSha: 'sha-reviewed',
        },
      })
      .returning();
    const k = `${Date.now()}-${++n}`;
    const [reviewer] = await db
      .insert(person)
      .values({ displayName: `R${k}`, email: `r${k}@example.test`, oidcSubject: `r${k}` })
      .returning();
    await db.insert(hat).values({ personId: reviewer!.id, role: 'backend_engineer' });

    const own = createDb(devDb.url);
    const app = await buildApp({
      config: loadConfig({
        DATABASE_URL: devDb.url,
        OIDC_ISSUER: 'http://localhost:9000',
        OIDC_CLIENT_ID: 'x',
        OIDC_CLIENT_SECRET: 'x',
        SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
        GITHUB_API_URL: githubUrl,
      }),
      deps: own,
      workers: false,
      secrets: (() => {
        const s = new MemorySecrets();
        void s.put(secretName('agent', 'private_key'), privateKey);
        void s.put(secretName('gate', 'private_key'), privateKey);
        return s;
      })(),
      github: new GitHubClient(githubUrl),
      agents: new Map(),
    });
    try {
      const cookie = `sdlc_session=${app.signCookie(`${reviewer!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`;
      const res = await app.inject({
        method: 'POST',
        url: `/api/interactions/${review!.id}/answer`,
        headers: { cookie },
        payload: { decision: 'approved', answer: 'looks good' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe('answered');
      expect((await card(review!.id)).gate).toMatchObject({
        state: 'merged',
        mergedSha: 'merge-sha-1',
      });
      expect(world.calls.some((c) => c.url.endsWith('/merge'))).toBe(true);
    } finally {
      await app.close();
      await own.pool.end();
    }
  });
});
