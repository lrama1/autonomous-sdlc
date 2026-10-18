import { and, eq, sql } from 'drizzle-orm';
import { appendRunEvent, interaction, repositoryEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { recordActivity } from './activity.js';
import type { GitHubService } from './github-service.js';
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
}

export interface GateOptions {
  db: Db;
  github: GitHubService;
  /** How long to wait for the required check before giving up. */
  waitForCiMs?: number;
  log?: (line: string) => void;
}

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
      await github.gateApprove(
        card.repository,
        card.prNumber,
        `Approved by the platform: a person approved this change${a.text ? ` ("${a.text.slice(0, 200)}")` : ''} and "${required}" passed. Review ${row.id}.`,
      );
      const merged = await github.gateMerge(
        card.repository,
        card.prNumber,
        `${row.title.replace(/^Review PR #\d+: /, '')} (#${card.prNumber})`,
      );
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
