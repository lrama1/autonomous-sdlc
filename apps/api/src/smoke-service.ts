import { and, desc, eq } from 'drizzle-orm';
import { buildPlan, buildTask, interaction, person, smokeRun } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import {
  describeSmokeCheck,
  missingChecks,
  needsSecurityReview,
  parsePreviewConfig,
  PREVIEW_CONFIG_PATH,
} from '@sdlc/core';
import type { DesignSmoke } from '@sdlc/core';
import type { SmokeCheck } from '@sdlc/core';
import { recordActivity } from './activity.js';
import type { PreviewHost } from './docker-preview.js';
import type { GitHubService } from './github-service.js';
import type { PreviewService } from './previews.js';
import { getInteraction } from './interactions.js';
import type { InteractionRow } from './interactions.js';
import { runSmoke } from './smoke.js';
import type { SmokeResult } from './smoke.js';

type SmokeGitHub = Pick<GitHubService, 'getPullRequest' | 'readFile'>;
export type SmokeRow = typeof smokeRun.$inferSelect;

export type SmokeStartResult =
  | { ok: true; row: SmokeRow; existing: boolean }
  | { ok: false; status: number; code: string; message: string };

/** Whether a repository asks for smoke checks at a commit. */
export type SmokeRequirement =
  | { kind: 'none' }
  | { kind: 'required'; checks: number; missing?: SmokeCheck[] }
  | { kind: 'invalid'; message: string };

export type SmokeOverrideResult =
  { ok: true; row: SmokeRow } | { ok: false; status: number; code: string; message: string };

interface PrCard {
  kind?: string;
  repository?: string;
  prNumber?: number;
  headSha?: string;
  diff?: { changedPaths?: string[] };
}

const fail = (status: number, code: string, message: string): SmokeStartResult => ({
  ok: false,
  status,
  code,
  message,
});

/**
 * Runs the smoke checks a repository lists in .sdlc/preview.yaml against one pull request's code, at one commit
 * (mvp-contract section 16, smoke test). It uses the same sandbox as a preview: if a preview of that commit is already
 * running it checks that one and leaves it running, and otherwise it starts one and removes it as soon as the checks
 * are done. A result belongs to a commit, so a new commit starts again.
 */
export class SmokeService {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      db: Db;
      github: SmokeGitHub;
      previews: Pick<PreviewService, 'start' | 'stop' | 'get'>;
      host: Pick<PreviewHost, 'exec'>;
      /** How long to wait for the preview to be ready, install included. */
      readyTimeoutMs?: number;
      pollMs?: number;
      getTimeoutMs?: number;
      runTimeoutMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  private readonly required_ = new Map<string, SmokeRequirement>();
  private readonly listed_ = new Map<string, SmokeCheck[]>();

  /** Marks tests that were running when an earlier process stopped: nobody is running them now. */
  async recover(): Promise<void> {
    await this.deps.db
      .update(smokeRun)
      .set({
        state: 'error',
        detail: 'The platform restarted during the smoke test. Run it again.',
        finishedAt: new Date(),
      })
      .where(eq(smokeRun.state, 'running'));
  }

  /** Waits for runs in progress. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /** The newest result for this pull request, whatever commit it was for. */
  async forPullRequest(repository: string, prNumber: number): Promise<SmokeRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(smokeRun)
      .where(and(eq(smokeRun.repository, repository), eq(smokeRun.prNumber, prNumber)))
      .orderBy(desc(smokeRun.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Whether the repository lists smoke checks at this commit. A commit never changes, so the answer is kept. A repository
   * with no .sdlc/preview.yaml asks for nothing. One whose file cannot be read as a config is "invalid": its checks may
   * be hidden in the mistake, so it counts as required until someone fixes it or overrides.
   */
  async requirement(repository: string, sha: string): Promise<SmokeRequirement> {
    const key = `${repository}@${sha}`;
    const known = this.required_.get(key);
    if (known) return known;
    const text = await this.deps.github.readFile(repository, PREVIEW_CONFIG_PATH, sha);
    let out: SmokeRequirement = { kind: 'none' };
    if (text !== null) {
      const parsed = parsePreviewConfig(text);
      if (!parsed.ok) out = { kind: 'invalid', message: parsed.errors.join('; ') };
      else if (parsed.config.smoke.length > 0)
        out = { kind: 'required', checks: parsed.config.smoke.length };
      if (parsed.ok) this.listed_.set(key, parsed.config.smoke);
    }
    if (this.required_.size > 500) {
      this.required_.clear();
      this.listed_.clear();
    }
    this.required_.set(key, out);
    return out;
  }

  /**
   * The checks the approved design requires that this pull request's smoke list does not have. Only the pull request that
   * finishes the build is held to the whole list: an earlier task may leave a check to a later one. Nothing is required of
   * a pull request that is not a build task, or of a plan made before designs stated their checks.
   */
  async designGap(review: InteractionRow, sha: string): Promise<SmokeCheck[]> {
    const { db } = this.deps;
    const card = review.contextCard as PrCard;
    if (!review.runId || !card.repository) return [];
    const [task] = await db.select().from(buildTask).where(eq(buildTask.runId, review.runId));
    if (!task) return [];
    const [plan] = await db.select().from(buildPlan).where(eq(buildPlan.id, task.planId));
    const smoke = plan?.smoke as DesignSmoke | null | undefined;
    if (!plan || !smoke || smoke.kind !== 'checks') return [];
    const all = await db.select().from(buildTask).where(eq(buildTask.planId, plan.id));
    if (!all.every((t) => t.id === task.id || t.state === 'merged' || t.state === 'skipped'))
      return [];
    await this.requirement(card.repository, sha);
    return missingChecks(smoke.checks, this.listed_.get(`${card.repository}@${sha}`) ?? []);
  }

  /** What the repository asks for at this review's commit, and what the design asks for on top of that. */
  async requirementFor(review: InteractionRow): Promise<SmokeRequirement> {
    const card = review.contextCard as PrCard;
    // A change made only of documents (a spec, a design) has no program to start.
    const paths = card.diff?.changedPaths ?? [];
    if (paths.length > 0 && !needsSecurityReview(paths)) return { kind: 'none' };
    const base = await this.requirement(card.repository!, card.headSha!);
    if (base.kind === 'invalid') return base;
    const missing = await this.designGap(review, card.headSha!);
    if (missing.length === 0) return base;
    return { kind: 'required', checks: base.kind === 'required' ? base.checks : 0, missing };
  }

  /** The newest result for one commit of a pull request. */
  async forCommit(repository: string, prNumber: number, sha: string): Promise<SmokeRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(smokeRun)
      .where(
        and(
          eq(smokeRun.repository, repository),
          eq(smokeRun.prNumber, prNumber),
          eq(smokeRun.headSha, sha),
        ),
      )
      .orderBy(desc(smokeRun.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Why this review may not be approved yet, or null when it may. The review's own commit is the one that counts, and
   * the newest result for it decides: a pass or an override lets it through; nothing else does.
   */
  async blocks(row: InteractionRow): Promise<string | null> {
    const card = row.contextCard as PrCard;
    if (card.kind !== 'pull_request' || !card.repository || !card.prNumber || !card.headSha)
      return null;
    let req: SmokeRequirement;
    try {
      req = await this.requirementFor(row);
    } catch (e) {
      return `Could not check whether this repository requires a smoke test (${e instanceof Error ? e.message : String(e)}). Try again.`;
    }
    if (req.kind === 'none') return null;
    const latest = await this.forCommit(card.repository, card.prNumber, card.headSha);
    if (latest?.state === 'passed' || latest?.state === 'overridden') return null;
    const how = 'Run the smoke test again, or override it with a reason.';
    if (req.kind === 'invalid')
      return `${PREVIEW_CONFIG_PATH} cannot be read, so its smoke checks cannot run (${req.message}). Fix it, or override the smoke test with a reason.`;
    if (!latest && req.missing)
      return `The design requires ${req.missing.length} smoke check${req.missing.length === 1 ? '' : 's'} that ${PREVIEW_CONFIG_PATH} does not list (${req.missing.map(describeSmokeCheck).join('; ')}), and this is the pull request that finishes the build. Run the smoke test to see the whole result, or override it with a reason.`;
    if (!latest)
      return `This repository has ${req.checks} smoke check${req.checks === 1 ? '' : 's'}, and none has run on this commit. Run the smoke test first, or override it with a reason.`;
    if (latest.state === 'running')
      return 'The smoke test is still running. Wait for it to finish.';
    if (latest.state === 'failed') return `The smoke test failed on this commit. ${how}`;
    return `The smoke test could not run (${latest.detail ?? 'no reason given'}). ${how}`;
  }

  /** One line for the pull request's approval: what the smoke test said about the commit that is being merged. */
  async evidence(row: InteractionRow): Promise<string | null> {
    const card = row.contextCard as PrCard;
    if (card.kind !== 'pull_request' || !card.repository || !card.prNumber || !card.headSha)
      return null;
    const latest = await this.forCommit(card.repository, card.prNumber, card.headSha);
    if (!latest) return null;
    if (latest.state === 'passed')
      return `Smoke test passed (${latest.results.length} check${latest.results.length === 1 ? '' : 's'}).`;
    if (latest.state === 'overridden') {
      const [who] = latest.startedBy
        ? await this.deps.db.select().from(person).where(eq(person.id, latest.startedBy))
        : [];
      return `Smoke test overridden${who ? ` by ${who.displayName}` : ''}: ${latest.detail ?? ''}`.trim();
    }
    return null;
  }

  /**
   * The Gate brought the pull request up to date by merging the base branch into it. The reviewed code did not change, and
   * a person's approval carries over to the new commit; so does a pass or an override, written as its own row for the new
   * commit and saying so. A failed or missing result does not carry over: it was not letting anything through.
   */
  async carryOver(row: InteractionRow, fromSha: string, toSha: string): Promise<void> {
    const card = row.contextCard as PrCard;
    if (card.kind !== 'pull_request' || !card.repository || !card.prNumber) return;
    const latest = await this.forCommit(card.repository, card.prNumber, fromSha);
    if (!latest || (latest.state !== 'passed' && latest.state !== 'overridden')) return;
    const { db } = this.deps;
    await db.insert(smokeRun).values({
      interactionId: latest.interactionId,
      initiativeId: latest.initiativeId,
      repository: latest.repository,
      prNumber: latest.prNumber,
      headSha: toSha,
      state: latest.state,
      results: latest.results,
      detail: [
        latest.detail,
        `carried over from ${fromSha.slice(0, 7)}: the Gate merged the base branch`,
      ]
        .filter(Boolean)
        .join(' - '),
      startedBy: latest.startedBy,
      finishedAt: new Date(),
    });
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: latest.initiativeId ?? undefined,
      interactionId: latest.interactionId ?? undefined,
      action: 'smoke.carried_over',
      detail: {
        repository: card.repository,
        prNumber: card.prNumber,
        from: fromSha,
        to: toSha,
        state: latest.state,
      },
    });
  }

  /** A person lets this commit through without a passing smoke test, and says why. Kept with the commit it is for. */
  async override(
    interactionId: string,
    personId: string,
    reason: string,
  ): Promise<SmokeOverrideResult> {
    const { db } = this.deps;
    const review = await getInteraction(db, interactionId);
    const card = review?.contextCard as PrCard | undefined;
    if (
      !review ||
      card?.kind !== 'pull_request' ||
      !card.repository ||
      !card.prNumber ||
      !card.headSha
    )
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        message: 'That is not a pull request review.',
      };
    if (review.state !== 'open')
      return {
        ok: false,
        status: 409,
        code: 'review_decided',
        message: 'That review has been decided, so there is nothing to override.',
      };
    const req = await this.requirementFor(review);
    if (req.kind === 'none')
      return {
        ok: false,
        status: 409,
        code: 'not_required',
        message: 'This commit has no smoke checks, so there is nothing to override.',
      };
    const latest = await this.forCommit(card.repository, card.prNumber, card.headSha);
    if (latest?.state === 'running')
      return {
        ok: false,
        status: 409,
        code: 'running',
        message: 'The smoke test is still running. Wait for it, or stop it by letting it finish.',
      };
    if (latest?.state === 'passed' || latest?.state === 'overridden')
      return {
        ok: false,
        status: 409,
        code: 'not_needed',
        message: 'This commit is already let through.',
      };
    const [row] = await db
      .insert(smokeRun)
      .values({
        interactionId: review.id,
        initiativeId: review.initiativeId,
        repository: card.repository,
        prNumber: card.prNumber,
        headSha: card.headSha,
        state: 'overridden',
        detail: reason,
        startedBy: personId,
        finishedAt: new Date(),
      })
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: personId,
      initiativeId: review.initiativeId,
      interactionId: review.id,
      action: 'smoke.overridden',
      detail: {
        repository: card.repository,
        prNumber: card.prNumber,
        sha: card.headSha,
        reason,
        was: latest?.state ?? 'not run',
      },
    });
    return { ok: true, row: row! };
  }

  async start(interactionId: string, by: string | null): Promise<SmokeStartResult> {
    const { db, github } = this.deps;
    const [review] = await db.select().from(interaction).where(eq(interaction.id, interactionId));
    const card = review?.contextCard as
      { kind?: string; repository?: string; prNumber?: number } | undefined;
    if (!review || card?.kind !== 'pull_request' || !card.repository || !card.prNumber)
      return fail(404, 'not_found', 'That is not a pull request review.');
    if (review.state !== 'open')
      return fail(
        409,
        'review_decided',
        'That review has been decided, so there is nothing to test.',
      );
    const { repository, prNumber } = card;

    const pr = await github.getPullRequest(repository, prNumber);
    if (pr.state !== 'open')
      return fail(409, 'pull_request_closed', 'That pull request is no longer open.');

    const gap = await this.designGap(review, pr.head.sha);
    const text = await github.readFile(repository, PREVIEW_CONFIG_PATH, pr.head.sha);
    if (text === null && gap.length === 0)
      return fail(
        422,
        'no_config',
        `This repository has no ${PREVIEW_CONFIG_PATH}, so there is nothing to run or check.`,
      );
    const parsed = text === null ? null : parsePreviewConfig(text);
    if (parsed && !parsed.ok)
      return fail(422, 'bad_config', `${PREVIEW_CONFIG_PATH}: ${parsed.errors.join('; ')}`);
    const listed = parsed?.ok ? parsed.config.smoke : [];
    if (listed.length === 0 && gap.length === 0)
      return fail(
        422,
        'no_smoke_checks',
        `${PREVIEW_CONFIG_PATH} has no smoke: checks. Add a list of get: and run: checks.`,
      );

    const [again] = await db
      .select()
      .from(smokeRun)
      .where(
        and(
          eq(smokeRun.repository, repository),
          eq(smokeRun.prNumber, prNumber),
          eq(smokeRun.headSha, pr.head.sha),
          eq(smokeRun.state, 'running'),
        ),
      );
    if (again) return { ok: true, row: again, existing: true };

    const [row] = await db
      .insert(smokeRun)
      .values({
        interactionId: review.id,
        initiativeId: review.initiativeId,
        repository,
        prNumber,
        headSha: pr.head.sha,
        startedBy: by,
        detail: 'Starting the preview.',
      })
      .returning();
    await recordActivity(db, {
      actorType: by ? 'person' : 'system',
      actorId: by ?? undefined,
      initiativeId: review.initiativeId,
      interactionId: review.id,
      action: 'smoke.started',
      detail: {
        repository,
        prNumber,
        sha: pr.head.sha,
        checks: listed.length,
        ...(gap.length > 0 ? { missingFromDesign: gap.map(describeSmokeCheck) } : {}),
      },
    });
    const job = this.execute(row!, listed, gap, interactionId, by).finally(() =>
      this.running.delete(job),
    );
    this.running.add(job);
    return { ok: true, row: row!, existing: false };
  }

  private async finish(
    row: SmokeRow,
    state: 'passed' | 'failed' | 'error',
    results: SmokeResult[],
    detail: string | null,
  ): Promise<void> {
    const { db } = this.deps;
    await db
      .update(smokeRun)
      .set({ state, results, detail, finishedAt: new Date() })
      .where(eq(smokeRun.id, row.id));
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: row.initiativeId ?? undefined,
      interactionId: row.interactionId ?? undefined,
      action: `smoke.${state}`,
      detail: {
        repository: row.repository,
        prNumber: row.prNumber,
        sha: row.headSha,
        passed: results.filter((r) => r.ok).length,
        of: results.length,
        ...(detail ? { reason: detail.slice(0, 300) } : {}),
      },
    });
  }

  /**
   * Runs one smoke test to its end. The sandbox this run started is removed before the result is recorded, so a person
   * who sees "passed" knows nothing is still running. One somebody else started stays up for them.
   */
  private async execute(
    row: SmokeRow,
    checks: SmokeCheck[],
    gap: SmokeCheck[],
    interactionId: string,
    by: string | null,
  ): Promise<void> {
    const { previews } = this.deps;
    const started: { here: boolean; id: string | null } = { here: false, id: null };
    let outcome: SmokeOutcome;
    try {
      // With nothing listed there is nothing to run: only what the design requires and the file lacks is reported.
      outcome =
        checks.length === 0
          ? { state: 'passed', results: [], detail: null }
          : await this.check(row, checks, interactionId, by, started);
    } catch (e) {
      outcome = {
        state: 'error',
        results: [],
        detail: `could not run the smoke test: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (gap.length > 0 && outcome.state !== 'error')
      outcome = {
        state: 'failed',
        results: [
          ...outcome.results,
          ...gap.map((c) => ({
            kind: c.kind,
            label: c.kind === 'get' ? `GET ${c.path}` : `run ${c.command}`,
            ok: false,
            detail: `the design requires it, and ${PREVIEW_CONFIG_PATH} does not list it`,
            ms: 0,
          })),
        ],
        detail: null,
      };
    if (started.here && started.id)
      await previews
        .stop(started.id, 'stopped', 'The smoke test finished.')
        .catch((e) => this.deps.log?.(`[smoke] stop failed: ${String(e)}`));
    await this.finish(row, outcome.state, outcome.results, outcome.detail).catch((e) =>
      this.deps.log?.(`[smoke] could not record the result: ${String(e)}`),
    );
  }

  private async check(
    row: SmokeRow,
    checks: SmokeCheck[],
    interactionId: string,
    by: string | null,
    started: { here: boolean; id: string | null },
  ): Promise<SmokeOutcome> {
    const { previews, host } = this.deps;
    const error = (detail: string): SmokeOutcome => ({ state: 'error', results: [], detail });
    const begun = await previews.start(interactionId, by);
    if (!begun.ok) return error(begun.message);
    started.here = !begun.existing;
    started.id = begun.row.id;
    if (begun.row.headSha !== row.headSha)
      return error('The pull request has a new commit. Run it again.');

    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 300_000);
    let preview = begun.row;
    while (preview.state === 'starting') {
      if (Date.now() > deadline) return error('The preview did not become ready in time.');
      await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 500));
      const now = await previews.get(begun.row.id);
      if (!now) return error('The preview disappeared.');
      preview = now;
    }
    if (preview.state !== 'ready')
      return error(preview.detail ?? `The preview ended as ${preview.state}.`);

    const id = preview.id;
    const { passed, results } = await runSmoke({
      baseUrl: (preview.target ?? preview.url ?? '').replace(/\/+$/, ''),
      checks,
      exec: host.exec ? (command, ms) => host.exec!(id, command, ms) : undefined,
      getTimeoutMs: this.deps.getTimeoutMs,
      runTimeoutMs: this.deps.runTimeoutMs,
    });
    return { state: passed ? 'passed' : 'failed', results, detail: null };
  }
}

interface SmokeOutcome {
  state: 'passed' | 'failed' | 'error';
  results: SmokeResult[];
  detail: string | null;
}
