import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { agentRun, initiative, interaction, securityReview, smokeRun } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { recordActivity } from './activity.js';
import type { PreviewService } from './previews.js';
import type { SecurityService } from './security-service.js';
import type { SmokeService } from './smoke-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Starts the checks a review needs. A timer runs it; tests call it. */
    autoChecks: AutoChecks;
  }
}

interface Card {
  repository?: string;
  prNumber?: number;
  headSha?: string;
}

/** A review older than this was left alone by a person, and is not started for them now. */
const FRESH_HOURS = 48;
const MAX_REVIEWS = 50;
const KEEP = 4000;

/**
 * Starts the checks a pull request review needs before it can be approved, so nobody has to click to begin them.
 *
 * - The security review starts in every autonomy mode. It reads the change through the model and costs a few cents.
 * - The smoke test starts in balanced and autopilot. It runs the app in a sandbox, so it only starts when a preview slot
 *   is free, and one per pass. In guided mode a person starts it.
 *
 * Each check starts at most once for a commit. A failed or errored one is never started again by the platform: a person
 * reads it, fixes it, or overrides it, and a new commit gets its own turn.
 */
export class AutoChecks {
  private readonly tried = new Set<string>();

  constructor(
    private readonly deps: {
      db: Db;
      security: () => SecurityService | null;
      smoke: () => SmokeService | null;
      previews: () => PreviewService | null;
      now?: () => Date;
      log?: (line: string) => void;
    },
  ) {}

  private remember(key: string): boolean {
    if (this.tried.has(key)) return false;
    if (this.tried.size > KEEP) this.tried.clear();
    this.tried.add(key);
    return true;
  }

  async tick(): Promise<void> {
    const { db } = this.deps;
    const security = this.deps.security();
    const smoke = this.deps.smoke();
    if (!security && !smoke) return;
    const since = new Date((this.deps.now?.() ?? new Date()).getTime() - FRESH_HOURS * 3_600_000);
    const open = await db
      .select({ row: interaction, mode: initiative.autonomyMode })
      .from(interaction)
      .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
      .where(
        and(
          eq(interaction.type, 'review'),
          eq(interaction.state, 'open'),
          gt(interaction.createdAt, since),
          sql`${interaction.contextCard} ->> 'kind' = 'pull_request'`,
        ),
      )
      .orderBy(asc(interaction.createdAt))
      .limit(MAX_REVIEWS);

    let smokeStarted = false;
    for (const { row, mode } of open) {
      const card = row.contextCard as Card;
      if (!card.repository || !card.prNumber || !card.headSha) continue;
      const { repository, prNumber, headSha } = card;

      if (security && security.required(row)) {
        const [had] = await db
          .select({ id: securityReview.id })
          .from(securityReview)
          .where(
            and(
              eq(securityReview.repository, repository),
              eq(securityReview.prNumber, prNumber),
              eq(securityReview.headSha, headSha),
            ),
          )
          .limit(1);
        const [run] = row.runId
          ? await db
              .select({ sponsor: agentRun.sponsorPersonId })
              .from(agentRun)
              .where(eq(agentRun.id, row.runId))
          : [];
        // The run is paid for by a person, so a review of a run nobody sponsored waits for a click.
        if (!had && run?.sponsor && this.remember(`sec:${row.id}:${headSha}`)) {
          const out = await security.start(row.id, run.sponsor).catch((e) => ({
            ok: false as const,
            message: e instanceof Error ? e.message : String(e),
          }));
          this.deps.log?.(
            out.ok
              ? `[checks] security review started for ${repository}#${prNumber}`
              : `[checks] security review not started for ${repository}#${prNumber}: ${out.message}`,
          );
          if (out.ok)
            await recordActivity(db, {
              actorType: 'system',
              initiativeId: row.initiativeId,
              interactionId: row.id,
              action: 'checks.auto_started',
              detail: { check: 'security', repository, prNumber, sha: headSha },
            });
        }
      }

      if (smoke && !smokeStarted && mode !== 'guided') {
        const [had] = await db
          .select({ id: smokeRun.id })
          .from(smokeRun)
          .where(
            and(
              eq(smokeRun.repository, repository),
              eq(smokeRun.prNumber, prNumber),
              eq(smokeRun.headSha, headSha),
            ),
          )
          .limit(1);
        if (had || this.tried.has(`smoke:${row.id}:${headSha}`)) continue;
        const req = await smoke.requirementFor(row).catch(() => null);
        // An unreadable smoke file waits for a person: starting it would only fail.
        if (req?.kind !== 'required') continue;
        // No free slot now is not a failure. The review is looked at again on the next pass.
        const previews = this.deps.previews();
        if (!previews || !(await previews.hasFreeSlot())) continue;
        this.remember(`smoke:${row.id}:${headSha}`);
        const out = await smoke.start(row.id, null).catch((e) => ({
          ok: false as const,
          message: e instanceof Error ? e.message : String(e),
        }));
        smokeStarted = true;
        this.deps.log?.(
          out.ok
            ? `[checks] smoke test started for ${repository}#${prNumber}`
            : `[checks] smoke test not started for ${repository}#${prNumber}: ${out.message}`,
        );
        if (out.ok)
          await recordActivity(db, {
            actorType: 'system',
            initiativeId: row.initiativeId,
            interactionId: row.id,
            action: 'checks.auto_started',
            detail: { check: 'smoke', repository, prNumber, sha: headSha },
          });
      }
    }
  }
}
