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
  'waiting_ci' | 'merged' | 'ci_failed' | 'stale' | 'closed' | 'timed_out' | 'failed';

export interface GateInfo {
  state: GateState;
  since: string;
  detail?: string;
  mergedSha?: string;
  /** How many times the Gate brought the branch up to date with the base branch. */
  catchUps?: number;
}

export interface GateOptions {
  db: Db;
  github: GitHubService;
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
      .where(eq(interaction.id, row.id));
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
    await setGate(row, {
      state: 'waiting_ci',
      since: new Date().toISOString(),
      detail: `brought up to date with the base branch; waiting for the check on ${next.slice(0, 7)}`,
      catchUps: done + 1,
    });
    return 'waiting_ci';
  }

  /** Looks at one approved review and moves it forward. Safe to call repeatedly. */
  async function evaluate(row: InteractionRow): Promise<GateState | null> {
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

      const a = answerOf(row);
      const byRule = (row.answer as { source?: string } | null)?.source === 'policy';
      await github.gateApprove(
        card.repository,
        card.prNumber,
        byRule
          ? `Approved by the platform's rules, not by a person. ${a.text ?? ''} "${required}" passed. Review ${row.id}.`
          : `Approved by the platform: a person approved this change${a.text ? ` ("${a.text.slice(0, 200)}")` : ''} and "${required}" passed. Review ${row.id}.`,
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

  return {
    evaluate,

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
      return waiting.length;
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
