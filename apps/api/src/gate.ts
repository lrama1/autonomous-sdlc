import { and, eq, sql } from 'drizzle-orm';
import { appendRunEvent, interaction, repositoryEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { recordActivity } from './activity.js';
import { GitHubError } from './github-app.js';
import type { GitHubService } from './github-service.js';
import { settleByPolicy } from './interactions.js';
import type { InteractionRow } from './interactions.js';

interface PrCard {
  kind?: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

export type GateState =
  'waiting_ci' | 'merged' | 'ci_failed' | 'stale' | 'closed' | 'timed_out' | 'failed' | 'conflict';

export interface GateInfo {
  state: GateState;
  since: string;
  detail?: string;
  mergedSha?: string;
  /** How many times the Gate brought the branch up to date with the base branch. */
  catchUps?: number;
}

/**
 * What the Gate asks of a check that must be settled before a pull request is approved or merged: the smoke test, the
 * security review (mvp-contract section 16). Null from the getter means the platform cannot run that check.
 */
export interface SmokeGuard {
  /** Why this review may not be approved or merged yet, or null. */
  blocks(row: InteractionRow): Promise<string | null>;
  /** One line about the smoke test for the approval on the pull request, or null. */
  evidence(row: InteractionRow): Promise<string | null>;
  /**
   * The Gate merged the base branch into the pull request, so the commit changed and nothing else did. A person's
   * approval carries over to it; so does the smoke test's result.
   */
  carryOver?(row: InteractionRow, fromSha: string, toSha: string): Promise<void>;
}

export interface GateOptions {
  db: Db;
  github: GitHubService;
  /** Late-bound: the smoke test service is made after the Gate, and only when the platform can run previews. */
  smoke?: () => SmokeGuard | null;
  /** Late-bound too: the security review needs the agent definition and the gateway. */
  security?: () => SmokeGuard | null;
  /** How long to wait for the required check before giving up. */
  waitForCiMs?: number;
  /** How long to wait between looks when GitHub updates a branch. */
  catchUpPollMs?: number;
  log?: (line: string) => void;
}

const MAX_CATCH_UPS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isPr = (row: InteractionRow): boolean =>
  (row.contextCard as { kind?: string }).kind === 'pull_request';
const answerOf = (row: InteractionRow) =>
  (row.answer ?? {}) as { text?: string; decision?: string | null };

/**
 * The Gate. When a person approves a pull request, the Gate App adds its own approving review and merges,
 * but only if the required check is green and the commit is the one the person reviewed (spec 6.5, spike 4).
 */
export function createGate({
  db,
  github,
  smoke = () => null,
  security = () => null,
  waitForCiMs = 30 * 60_000,
  catchUpPollMs = 1000,
  log = (l) => console.log(l),
}: GateOptions) {
  async function setGate(row: InteractionRow, info: GateInfo): Promise<void> {
    await db
      .update(interaction)
      .set({
        contextCard: sql`${interaction.contextCard} || jsonb_build_object('gate', ${JSON.stringify(info)}::jsonb)`,
      })
      .where(
        and(
          eq(interaction.id, row.id),
          // A pull request that is merged stays merged: a slower look that saw it before the merge must not undo that.
          info.state === 'merged'
            ? sql`true`
            : sql`coalesce(${interaction.contextCard} -> 'gate' ->> 'state', '') <> 'merged'`,
        ),
      );
  }

  async function finish(
    row: InteractionRow,
    info: GateInfo,
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await setGate(row, info);
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: row.initiativeId,
      runId: row.runId,
      interactionId: row.id,
      action,
      detail: { state: info.state, detail: info.detail ?? null, ...extra },
    });
    if (row.runId)
      await appendRunEvent(db, row.runId, action, {
        interactionId: row.id,
        state: info.state,
        ...extra,
      });
  }

  /**
   * The base branch moved on while the pull request waited, and the repository requires branches to be up to date.
   * The Gate has GitHub merge the base branch into the pull request's branch, then waits for the checks on the new
   * commit. Nothing the agent wrote changes: the only new commit must be that merge. Anything else is treated as
   * commits pushed after the review.
   */
  async function catchUp(
    row: InteractionRow,
    card: PrCard & { gate?: GateInfo },
    since: string,
  ): Promise<GateState> {
    const done = card.gate?.catchUps ?? 0;
    if (done >= MAX_CATCH_UPS) {
      await finish(
        row,
        {
          state: 'failed',
          since,
          detail: `the base branch moved ${done} times while this waited, so the Gate gave up`,
          catchUps: done,
        },
        'gate.failed',
      );
      return 'failed';
    }
    try {
      await github.updateBranch(card.repository, card.prNumber, card.headSha);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await finish(
        row,
        {
          state: 'failed',
          since,
          detail: `the branch is behind and could not be updated (conflicts?): ${message}`.slice(
            0,
            500,
          ),
          catchUps: done,
        },
        'gate.failed',
      );
      return 'failed';
    }
    let next = card.headSha;
    for (let i = 0; i < 15 && next === card.headSha; i++) {
      await sleep(catchUpPollMs);
      next = (await github.getPullRequest(card.repository, card.prNumber)).head.sha;
    }
    if (next === card.headSha) {
      // GitHub has not made the commit yet. The next pass will look again.
      await setGate(row, {
        state: 'waiting_ci',
        since,
        detail: 'asked GitHub to bring the branch up to date',
        catchUps: done,
      });
      return 'waiting_ci';
    }
    const parents = await github.commitParents(card.repository, next);
    if (parents.length !== 2 || !parents.includes(card.headSha)) {
      await finish(
        row,
        {
          state: 'stale',
          since,
          detail: `new commits were pushed after the review (${card.headSha.slice(0, 7)} to ${next.slice(0, 7)})`,
        },
        'gate.stale',
      );
      return 'stale';
    }
    await db
      .update(interaction)
      .set({
        contextCard: sql`jsonb_set(${interaction.contextCard}, '{headSha}', to_jsonb(${next}::text))`,
      })
      .where(eq(interaction.id, row.id));
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: row.initiativeId,
      runId: row.runId,
      interactionId: row.id,
      action: 'gate.caught_up',
      detail: { from: card.headSha, to: next, prNumber: card.prNumber },
    });
    for (const g of guards())
      await g
        .carryOver?.(row, card.headSha, next)
        .catch((e) => log(`[gate] could not carry a check result over: ${String(e)}`));
    await setGate(row, {
      state: 'waiting_ci',
      since: new Date().toISOString(),
      detail: `brought up to date with the base branch; waiting for the check on ${next.slice(0, 7)}`,
      catchUps: done + 1,
    });
    return 'waiting_ci';
  }

  /**
   * The pull request cannot merge because something merged meanwhile changed the same lines. GitHub does not run the
   * checks on such a pull request, so waiting for them would never end. Nobody can fix it by merging main in, so the
   * work has to be redone on the current main.
   */
  async function conflicted(row: InteractionRow, card: PrCard, since: string): Promise<GateState> {
    await finish(
      row,
      {
        state: 'conflict',
        since,
        detail:
          'the branch conflicts with the base branch: something merged meanwhile changed the same lines',
      },
      'gate.conflict',
    );
    await github
      .comment(
        card.repository,
        card.prNumber,
        'The platform did not merge this: it conflicts with changes that were merged after it was written. The work has to be redone on the current main branch.',
      )
      .catch(() => {});
    return 'conflict';
  }

  /** Looks at one approved review and moves it forward. Safe to call repeatedly. */
  async function evaluateOnce(row: InteractionRow): Promise<GateState | null> {
    if (!isPr(row)) return null;
    const card = row.contextCard as unknown as PrCard & { gate?: GateInfo };
    const since = card.gate?.since ?? new Date().toISOString();
    const [repo] = await db
      .select()
      .from(repositoryEntry)
      .where(eq(repositoryEntry.fullName, card.repository));
    const required = repo?.requiredCheck ?? 'verify';

    try {
      const pr = await github.getPullRequest(card.repository, card.prNumber);
      if (pr.merged) {
        await finish(
          row,
          { state: 'merged', since, detail: 'already merged' },
          'pull_request.merged',
        );
        return 'merged';
      }
      if (pr.state === 'closed') {
        await finish(
          row,
          { state: 'closed', since, detail: 'the pull request was closed' },
          'gate.closed',
        );
        return 'closed';
      }
      if (pr.head.sha !== card.headSha) {
        await finish(
          row,
          {
            state: 'stale',
            since,
            detail: `new commits were pushed after the review (${card.headSha.slice(0, 7)} to ${pr.head.sha.slice(0, 7)})`,
          },
          'gate.stale',
        );
        await github
          .comment(
            card.repository,
            card.prNumber,
            'The platform did not merge this: commits were pushed after the review. It needs a new review.',
          )
          .catch(() => {});
        return 'stale';
      }

      if (pr.mergeable_state === 'dirty') return conflicted(row, card, since);

      const ci = await github.checkConclusion(card.repository, card.headSha, required);
      if (ci === 'pending') {
        if (Date.now() - new Date(since).getTime() > waitForCiMs) {
          await finish(
            row,
            { state: 'timed_out', since, detail: `the check "${required}" did not finish in time` },
            'gate.timed_out',
          );
          return 'timed_out';
        }
        if (card.gate?.state !== 'waiting_ci')
          await setGate(row, {
            state: 'waiting_ci',
            since,
            detail: `waiting for the check "${required}"`,
          });
        return 'waiting_ci';
      }
      if (ci !== 'success') {
        await finish(
          row,
          { state: 'ci_failed', since, detail: `the check "${required}" ended as ${ci}` },
          'gate.ci_failed',
        );
        await github
          .comment(
            card.repository,
            card.prNumber,
            `The platform did not merge this: the required check "${required}" ended as \`${ci}\`.`,
          )
          .catch(() => {});
        return 'ci_failed';
      }

      // The review was held until each check had passed or a person had settled it. This is the same question asked again
      // at the last moment, so an approval that slipped past (or a result that changed) still cannot merge.
      const held = await heldBy(row);
      if (held) {
        await finish(
          row,
          {
            state: 'failed',
            since,
            detail: `the merge is held: ${held}`.slice(0, 500),
          },
          'gate.held',
        );
        return 'failed';
      }
      const proof = (await Promise.all(guards().map((g) => g.evidence(row))))
        .filter((p): p is string => Boolean(p))
        .join(' ');

      const a = answerOf(row);
      const byRule = (row.answer as { source?: string } | null)?.source === 'policy';
      await github.gateApprove(
        card.repository,
        card.prNumber,
        `${
          byRule
            ? `Approved by the platform's rules, not by a person. ${a.text ?? ''} "${required}" passed. Review ${row.id}.`
            : `Approved by the platform: a person approved this change${a.text ? ` ("${a.text.slice(0, 200)}")` : ''} and "${required}" passed. Review ${row.id}.`
        }${proof ? ` ${proof}` : ''}`,
      );
      let merged: { sha: string };
      try {
        merged = await github.gateMerge(
          card.repository,
          card.prNumber,
          `${row.title.replace(/^Review PR #\d+: /, '')} (#${card.prNumber})`,
        );
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 405 || e.status === 409)) {
          const fresh = await github.getPullRequest(card.repository, card.prNumber);
          if (fresh.mergeable_state === 'behind') return catchUp(row, card, since);
          if (fresh.mergeable_state === 'dirty') return conflicted(row, card, since);
        }
        throw e;
      }
      await finish(row, { state: 'merged', since, mergedSha: merged.sha }, 'pull_request.merged', {
        mergedSha: merged.sha,
        prNumber: card.prNumber,
      });
      return 'merged';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`[gate] ${card.repository}#${card.prNumber}: ${message}`);
      await finish(row, { state: 'failed', since, detail: message.slice(0, 500) }, 'gate.failed');
      return 'failed';
    }
  }

  /**
   * One look at a time per review. A person's approval and the worker's next pass can arrive together, and two looks that
   * each approve and merge on GitHub, then disagree about what happened, leave the review in the wrong state.
   */
  const guards = (): SmokeGuard[] =>
    [smoke(), security()].filter((g): g is SmokeGuard => g !== null);
  /** The first reason any check gives for holding this review back, or null. */
  async function heldBy(row: InteractionRow): Promise<string | null> {
    for (const g of guards()) {
      const reason = await g.blocks(row);
      if (reason) return reason;
    }
    return null;
  }

  const looking = new Map<string, Promise<GateState | null>>();
  function evaluate(row: InteractionRow): Promise<GateState | null> {
    const running = looking.get(row.id);
    if (running) return running;
    const p = evaluateOnce(row).finally(() => looking.delete(row.id));
    looking.set(row.id, p);
    return p;
  }

  /** How long to leave a failed review alone before asking GitHub whether it merged after all. */
  const FAILED_RECHECK_MS = 60_000;
  const lastChecked = new Map<string, number>();

  return {
    evaluate,

    /** Why a person may not approve this review yet (the smoke test, the security review), or null. */
    async approvalBlocks(row: InteractionRow): Promise<string | null> {
      if (row.type !== 'review' || !isPr(row)) return null;
      return heldBy(row);
    },

    /**
     * The platform approves a pull request by rule (spec 6.1, 6.2), then the same checks as for a person apply:
     * the required check must be green and the commit must be the one that was reviewed.
     * Returns null if the review was no longer open.
     */
    async autoApprove(
      row: InteractionRow,
      why: { reason: string; rule: string | null },
    ): Promise<GateState | null> {
      if (row.type !== 'review' || !isPr(row)) return null;
      // A change with smoke checks, or code for a security review to read, always waits for a person to run them: the rules
      // do not click for anyone.
      if (await heldBy(row)) return null;
      const settled = await settleByPolicy(db, row.id, {
        decision: 'approved',
        reason: why.reason,
        rule: why.rule,
      });
      if (!settled) return null;
      await setGate(settled, { state: 'waiting_ci', since: new Date().toISOString() });
      const [fresh] = await db.select().from(interaction).where(eq(interaction.id, row.id));
      return evaluate(fresh!);
    },

    /** Called after a person settles any interaction. Only pull request reviews matter here. */
    async afterDecision(row: InteractionRow): Promise<GateState | 'ignored' | null> {
      if (row.type !== 'review' || !isPr(row)) return 'ignored';
      const card = row.contextCard as unknown as PrCard;
      const a = answerOf(row);
      if (a.decision === 'approved') {
        await setGate(row, { state: 'waiting_ci', since: new Date().toISOString() });
        const [fresh] = await db.select().from(interaction).where(eq(interaction.id, row.id));
        return evaluate(fresh!);
      }
      if (a.decision === 'changes_requested') {
        await github
          .comment(
            card.repository,
            card.prNumber,
            `A reviewer asked for changes: ${a.text || '(no comment)'}`,
          )
          .catch(() => {});
      } else if (a.decision === 'rejected') {
        await github
          .comment(
            card.repository,
            card.prNumber,
            `A reviewer rejected this change: ${a.text || '(no comment)'}`,
          )
          .catch(() => {});
        await github.closePullRequest(card.repository, card.prNumber).catch(() => {});
      }
      return null;
    },

    /** Worker step: re-check every approved review that is still waiting for CI. */
    async tick(): Promise<number> {
      const waiting = await db
        .select()
        .from(interaction)
        .where(
          and(
            eq(interaction.type, 'review'),
            eq(interaction.state, 'answered'),
            sql`${interaction.contextCard} -> 'gate' ->> 'state' = 'waiting_ci'`,
          ),
        );
      for (const row of waiting) await evaluate(row);

      // A review that says it failed may have been merged anyway (a look that failed after another one merged).
      // Ask GitHub, not often, and only about whether it merged.
      const failed = await db
        .select()
        .from(interaction)
        .where(
          and(
            eq(interaction.type, 'review'),
            eq(interaction.state, 'answered'),
            sql`${interaction.contextCard} -> 'gate' ->> 'state' = 'failed'`,
          ),
        );
      for (const row of failed) {
        if (Date.now() - (lastChecked.get(row.id) ?? 0) < FAILED_RECHECK_MS) continue;
        lastChecked.set(row.id, Date.now());
        const card = row.contextCard as unknown as PrCard & { gate?: GateInfo };
        if (!isPr(row)) continue;
        const pr = await github.getPullRequest(card.repository, card.prNumber).catch(() => null);
        if (pr?.merged)
          await finish(
            row,
            {
              state: 'merged',
              since: card.gate?.since ?? new Date().toISOString(),
              detail: 'merged (found merged after a failure was recorded)',
            },
            'pull_request.merged',
            { prNumber: card.prNumber, reconciled: true },
          );
      }
      return waiting.length;
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
