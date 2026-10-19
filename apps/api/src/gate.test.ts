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
import type { SmokeGuard } from './gate.js';
import { answerAsPerson } from './answering.js';
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
  /** The base branch moved: merging answers 405 until the Gate updates the branch. */
  behind: boolean;
  /** Another change merged first and edited the same lines. */
  dirty: boolean;
  /** What updating the branch does: a plain merge commit, a commit that is not one, GitHub refusing, or moving again. */
  update: 'merge' | 'other' | 'refuse' | 'again';
  updates: number;
  calls: Array<{ method: string; url: string; body: any }>;
}
let world: World;
const reset = (): World =>
  (world = {
    pr: { state: 'open', merged: false, sha: 'sha-reviewed' },
    ci: 'success',
    mergeStatus: 200,
    behind: false,
    dirty: false,
    update: 'merge',
    updates: 0,
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
        mergeable_state: world.dirty ? 'dirty' : world.behind ? 'behind' : 'clean',
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
    if (req.method === 'PUT' && url.endsWith('/update-branch')) {
      if (world.update === 'refuse') return json(422, { message: 'merge conflict' });
      world.updates++;
      world.pr.sha = `sha-updated-${world.updates}`;
      world.behind = world.update === 'again';
      return json(202, { message: 'Updating pull request branch.' });
    }
    if (req.method === 'GET' && /\/commits\/sha-updated-\d+$/.test(url)) {
      const parent = world.updates > 1 ? `sha-updated-${world.updates - 1}` : 'sha-reviewed';
      return json(200, {
        parents:
          world.update === 'other' ? [{ sha: parent }] : [{ sha: parent }, { sha: 'main-tip' }],
      });
    }
    if (req.method === 'PUT' && url.endsWith('/merge') && world.behind)
      return json(405, { message: 'Head branch is not up to date with the base branch' });
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
  createGate({ db, github: service, log: () => {}, catchUpPollMs: 0, ...o });

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

describe('when the base branch moved on', () => {
  it('has GitHub bring the branch up to date, waits for the checks on the new commit, and then merges', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.behind = true;
    expect(await gate().afterDecision(row)).toBe('waiting_ci');
    const update = world.calls.find((c) => c.url.endsWith('/update-branch'))!;
    expect(update.body).toEqual({ expected_head_sha: 'sha-reviewed' });
    expect((await card(row.id)).headSha).toBe('sha-updated-1');
    expect((await card(row.id)).gate).toMatchObject({ state: 'waiting_ci', catchUps: 1 });
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.interactionId, row.id));
    expect(log.map((l) => l.action)).toContain('gate.caught_up');

    world.calls.length = 0;
    expect(await gate().tick()).toBeGreaterThanOrEqual(1);
    expect(calledPaths()).toContain('GET /commits/sha-updated-1/check-runs');
    expect(calledPaths()).toContain('PUT /pulls/7/merge');
    expect((await card(row.id)).gate).toMatchObject({ state: 'merged', mergedSha: 'merge-sha-1' });
  });

  it('does not merge when the new commit is more than a merge of the base branch', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.behind = true;
    world.update = 'other';
    expect(await gate().afterDecision(row)).toBe('stale');
    expect((await card(row.id)).gate.state).toBe('stale');
    expect(world.calls.filter((c) => c.url.endsWith('/merge'))).toHaveLength(1);
  });

  it('says so when GitHub cannot update the branch', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.behind = true;
    world.update = 'refuse';
    expect(await gate().afterDecision(row)).toBe('failed');
    expect((await card(row.id)).gate.detail).toContain('could not be updated');
  });

  it('gives up when the base branch keeps moving', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.behind = true;
    world.update = 'again';
    const g = gate();
    await g.afterDecision(row);
    for (let i = 0; i < 8 && (await card(row.id)).gate.state === 'waiting_ci'; i++) await g.tick();
    expect((await card(row.id)).gate).toMatchObject({ state: 'failed', catchUps: 5 });
    expect((await card(row.id)).gate.detail).toContain('moved 5 times');
  });
});

describe('when the change conflicts with what merged meanwhile', () => {
  it('stops at once, without waiting for checks that will never run, and says so on the pull request', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    world.dirty = true;
    world.ci = null;
    expect(await gate().afterDecision(row)).toBe('conflict');
    expect((await card(row.id)).gate).toMatchObject({ state: 'conflict' });
    expect(calledPaths()).not.toContain('GET /commits/sha-reviewed/check-runs');
    expect(world.calls.some((c) => c.url.endsWith('/merge') || c.url.endsWith('/reviews'))).toBe(
      false,
    );
    expect(world.calls.find((c) => c.url.endsWith('/comments'))!.body.body).toContain('conflicts');
  });
});

describe('approval by rule', () => {
  async function openReview(f: Awaited<ReturnType<typeof setup>>) {
    const [row] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'review',
        checkpointId: 'G3',
        title: 'Review PR #7: Fix typo in the README',
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
    return row!;
  }
  const why = {
    reason: 'It fits the pre-approved type "docs-only" and no trigger fired.',
    rule: 'docs-only',
  };

  it('approves in its own name, says so, and merges once the check is green', async () => {
    const f = await setup();
    const row = await openReview(f);
    expect(await gate().autoApprove(row, why)).toBe('merged');

    const [after] = await db.select().from(interaction).where(eq(interaction.id, row.id));
    expect(after).toMatchObject({ state: 'answered', answeredVia: 'auto', answeredBy: null });
    expect(after!.answer).toMatchObject({
      decision: 'approved',
      source: 'policy',
      rule: 'docs-only',
    });
    const review = world.calls.find((c) => c.url.endsWith('/reviews'))!;
    expect(review.body.body).toContain('not by a person');
    expect(review.body.body).toContain('docs-only');
    expect(calledPaths()).toContain('PUT /pulls/7/merge');
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.interactionId, row.id));
    expect(log.map((l) => l.action)).toEqual(
      expect.arrayContaining(['pull_request.auto_approved', 'pull_request.merged']),
    );
  });

  it('still waits for the check, and does not merge when it fails', async () => {
    const f = await setup();
    const waiting = await openReview(f);
    world.ci = 'in_progress';
    expect(await gate().autoApprove(waiting, why)).toBe('waiting_ci');
    expect(calledPaths()).not.toContain('PUT /pulls/7/merge');
    world.ci = 'success';
    const [fresh] = await db.select().from(interaction).where(eq(interaction.id, waiting.id));
    expect(await gate().evaluate(fresh!)).toBe('merged');

    reset();
    const failing = await openReview(await setup());
    world.ci = 'failure';
    expect(await gate().autoApprove(failing, why)).toBe('ci_failed');
    expect(calledPaths()).not.toContain('PUT /pulls/7/merge');
  });

  it('does not merge commits that were pushed after the platform looked', async () => {
    const f = await setup();
    const row = await openReview(f);
    world.pr.sha = 'sha-later';
    expect(await gate().autoApprove(row, why)).toBe('stale');
    expect(calledPaths()).not.toContain('PUT /pulls/7/merge');
  });

  it('does nothing to a review that someone already settled, or to something that is not a pull request', async () => {
    const f = await setup();
    const taken = await approvedReview(f);
    expect(await gate().autoApprove(taken, why)).toBeNull();
    expect(world.calls.filter((c) => c.url.endsWith('/reviews'))).toHaveLength(0);

    const [note] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        type: 'review',
        title: 'not a PR',
        roleNeeded: 'backend_engineer',
        contextCard: {},
      })
      .returning();
    expect(await gate().autoApprove(note!, why)).toBeNull();
  });
});

describe('smoke test', () => {
  /** A smoke test service that answers from what the test says. */
  const guard = (state: {
    blocks: string | null;
    evidence?: string | null;
  }): (() => SmokeGuard) => {
    const g: SmokeGuard = {
      blocks: async () => state.blocks,
      evidence: async () => state.evidence ?? null,
    };
    return () => g;
  };
  const withSmoke = (smoke: (() => SmokeGuard | null) | undefined) =>
    createGate({ db, github: service, log: () => {}, catchUpPollMs: 0, smoke });
  const why = { reason: 'It fits the pre-approved type "docs-only".', rule: 'docs-only' };

  async function openReview(f: Awaited<ReturnType<typeof setup>>) {
    const [row] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'review',
        checkpointId: 'G3',
        title: 'Review PR #7: Add a page',
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
    return row!;
  }

  it('leaves a review that the rules would approve for a person when the smoke test has not passed', async () => {
    const f = await setup();
    const row = await openReview(f);
    expect(
      await withSmoke(guard({ blocks: 'The smoke test has not run.' })).autoApprove(row, why),
    ).toBeNull();
    const [after] = await db.select().from(interaction).where(eq(interaction.id, row.id));
    expect(after).toMatchObject({ state: 'open' });
    expect(world.calls.filter((c) => c.url.endsWith('/reviews'))).toHaveLength(0);

    // Once it is let through, the rules approve as before.
    expect(await withSmoke(guard({ blocks: null })).autoApprove(row, why)).toBe('merged');
  });

  it('does not change a repository that has no smoke checks, or a platform that cannot run one', async () => {
    const f = await setup();
    expect(await withSmoke(guard({ blocks: null })).autoApprove(await openReview(f), why)).toBe(
      'merged',
    );
    reset();
    const g = withSmoke(() => null);
    expect(await g.autoApprove(await openReview(await setup()), why)).toBe('merged');
    expect(await g.smokeBlocks(await openReview(await setup()))).toBeNull();
  });

  it('refuses to approve through the answer path until it is satisfied, and says why', async () => {
    const f = await setup();
    const row = await openReview(f);
    const held = withSmoke(
      guard({ blocks: 'Run the smoke test first, or override it with a reason.' }),
    );
    const me = { id: f.personId, roles: ['backend_engineer' as const] };
    const rest = {
      makeStanding: false,
      standingScope: 'initiative' as const,
      didntNeedToAsk: false,
    };
    const body = { answer: 'looks fine', decision: 'approved' as const, ...rest };
    const refused = await answerAsPerson(
      { db, rules: { independentReview: false }, gate: held },
      row.id,
      me,
      'workspace',
      body,
    );
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'smoke_required' });
    expect(refused.ok === false && refused.message).toContain('Run the smoke test first');
    expect((await db.select().from(interaction).where(eq(interaction.id, row.id)))[0]!.state).toBe(
      'open',
    );
    // Asking for changes or rejecting is not held up by a smoke test.
    const changes = await answerAsPerson(
      { db, rules: { independentReview: false }, gate: held },
      row.id,
      me,
      'workspace',
      { answer: 'not yet', decision: 'changes_requested', ...rest },
    );
    expect(changes.ok).toBe(true);
  });

  it('approves and merges once satisfied, and puts what the smoke test said on the approval', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    const g = withSmoke(guard({ blocks: null, evidence: 'Smoke test passed (3 checks).' }));
    expect(await g.afterDecision(row)).toBe('merged');
    const review = world.calls.find((c) => c.url.endsWith('/reviews'))!;
    expect(review.body.body).toContain('Smoke test passed (3 checks).');
  });

  it('does not merge at the last moment when the smoke test is no longer satisfied', async () => {
    const f = await setup();
    const row = await approvedReview(f);
    expect(
      await withSmoke(guard({ blocks: 'The smoke test failed on this commit.' })).afterDecision(
        row,
      ),
    ).toBe('failed');
    expect(calledPaths()).not.toContain('PUT /pulls/7/merge');
    expect(world.calls.filter((c) => c.url.endsWith('/reviews'))).toHaveLength(0);
    expect((await card(row.id)).gate.detail).toContain('the smoke test has not passed');
    const log = await db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.interactionId, row.id));
    expect(log.map((l) => l.action)).toContain('gate.smoke_held');
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
