import { and, eq, lte, or, sql } from 'drizzle-orm';
import { agentRun, appendRunEvent, initiative, interaction, standingDecision } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { defaultRoleForAgent } from '@sdlc/core';
import type { Decision, InteractionType, Role } from '@sdlc/core';
import { recordActivity } from './activity.js';

export type InteractionRow = typeof interaction.$inferSelect;

export interface NewInteraction {
  initiativeId: string;
  runId: string | null;
  type: InteractionType;
  checkpointId?: string;
  title: string;
  contextCard: Record<string, unknown>;
  options?: unknown;
  recommendation?: string;
  defaultValue?: string;
  dueAt?: Date;
  /** Runs that are waiting on this interaction. */
  blocks: Array<{ runId: string }>;
  topicKey?: string;
  roleNeeded: Role;
  hardStop?: boolean;
}

export type StandingRow = typeof standingDecision.$inferSelect;

/** The active standing decision on this topic that applies to the initiative: its own, its repository's, or a global one. */
export async function findStandingDecision(
  db: Db,
  initiativeId: string,
  topic: string,
): Promise<StandingRow | undefined> {
  const [init] = await db
    .select({ repositoryId: initiative.repositoryId })
    .from(initiative)
    .where(eq(initiative.id, initiativeId));
  const rows = await db
    .select()
    .from(standingDecision)
    .where(
      and(
        eq(standingDecision.active, true),
        sql`lower(${standingDecision.topic}) = lower(${topic})`,
        or(
          eq(standingDecision.scope, 'global'),
          and(eq(standingDecision.scope, 'initiative'), eq(standingDecision.scopeId, initiativeId)),
          init
            ? and(
                eq(standingDecision.scope, 'repository'),
                eq(standingDecision.scopeId, init.repositoryId),
              )
            : undefined,
        ),
      ),
    );
  // The narrowest scope wins.
  const rank = { initiative: 0, repository: 1, global: 2 } as Record<string, number>;
  return rows.sort((a, b) => (rank[a.scope] ?? 9) - (rank[b.scope] ?? 9))[0];
}

/**
 * Creates an interaction. Three things can happen instead:
 * a standing decision already answers it (nobody is asked), or an open ask on the same topic is joined.
 */
export async function createInteraction(
  db: Db,
  input: NewInteraction,
): Promise<{
  interaction: InteractionRow;
  duplicate: boolean;
  standing?: StandingRow;
}> {
  if (
    input.topicKey &&
    (input.type === 'question' || input.type === 'decision') &&
    !input.hardStop
  ) {
    const sd = await findStandingDecision(db, input.initiativeId, input.topicKey);
    if (sd) {
      const [row] = await db
        .insert(interaction)
        .values({
          initiativeId: input.initiativeId,
          runId: input.runId,
          type: input.type,
          title: input.title,
          contextCard: input.contextCard,
          options: input.options ?? null,
          recommendation: input.recommendation ?? null,
          blocks: input.blocks,
          topicKey: input.topicKey,
          roleNeeded: input.roleNeeded,
          state: 'answered',
          answer: { text: sd.text, decision: null, source: 'standing', standingDecisionId: sd.id },
          answeredVia: 'standing',
          answeredAt: new Date(),
          standingDecisionId: sd.id,
        })
        .returning();
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: input.initiativeId,
        runId: input.runId,
        interactionId: row!.id,
        action: 'interaction.answered_by_standing_decision',
        detail: { standingDecisionId: sd.id, topic: sd.topic },
      });
      return { interaction: row!, duplicate: false, standing: sd };
    }
  }
  if (input.topicKey) {
    const [existing] = await db
      .select()
      .from(interaction)
      .where(
        and(
          eq(interaction.initiativeId, input.initiativeId),
          eq(interaction.topicKey, input.topicKey),
          eq(interaction.state, 'open'),
        ),
      );
    if (existing) {
      const joined = input.blocks.filter(
        (b) => !existing.blocks.some((x) => (x as { runId?: string }).runId === b.runId),
      );
      let row = existing;
      if (joined.length > 0) {
        const [updated] = await db
          .update(interaction)
          .set({ blocks: [...existing.blocks, ...joined] })
          .where(eq(interaction.id, existing.id))
          .returning();
        row = updated!;
      }
      await recordActivity(db, {
        actorType: input.runId ? 'agent' : 'system',
        actorId: input.runId,
        initiativeId: input.initiativeId,
        runId: input.runId,
        interactionId: existing.id,
        action: 'interaction.deduplicated',
        detail: { topicKey: input.topicKey },
      });
      return { interaction: row, duplicate: true };
    }
  }

  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: input.initiativeId,
      runId: input.runId,
      type: input.type,
      checkpointId: input.checkpointId ?? null,
      title: input.title,
      contextCard: input.contextCard,
      options: input.options ?? null,
      recommendation: input.recommendation ?? null,
      defaultValue: input.defaultValue ?? null,
      dueAt: input.dueAt ?? null,
      blocks: input.blocks,
      topicKey: input.topicKey ?? null,
      roleNeeded: input.roleNeeded,
      hardStop: input.hardStop ?? false,
    })
    .returning();
  await recordActivity(db, {
    actorType: input.runId ? 'agent' : 'system',
    actorId: input.runId,
    initiativeId: input.initiativeId,
    runId: input.runId,
    interactionId: row!.id,
    action: 'interaction.raised',
    detail: { type: input.type, title: input.title, checkpoint: input.checkpointId ?? null },
  });
  return { interaction: row!, duplicate: false };
}

export async function getInteraction(db: Db, id: string): Promise<InteractionRow | undefined> {
  const [row] = await db.select().from(interaction).where(eq(interaction.id, id));
  return row;
}

async function notifyRun(db: Db, row: InteractionRow, via: 'human' | 'default'): Promise<void> {
  if (!row.runId) return;
  await appendRunEvent(db, row.runId, 'interaction.settled', { interactionId: row.id, via });
}

export interface SettleInput {
  answer: string;
  decision?: Decision;
  by: string;
  via: 'workspace' | 'slack' | 'teams' | 'email';
  optionId?: string;
  makeStanding?: boolean;
  standingScope?: 'initiative' | 'repository' | 'global';
  didntNeedToAsk?: boolean;
}

/** "Use this answer from now on": records the answer as a standing decision and links it to the ask. */
export async function saveStandingDecision(
  db: Db,
  row: InteractionRow,
  text: string,
  by: string,
  scope: 'initiative' | 'repository' | 'global' = 'initiative',
): Promise<InteractionRow> {
  const [init] = await db
    .select({ repositoryId: initiative.repositoryId })
    .from(initiative)
    .where(eq(initiative.id, row.initiativeId));
  const [sd] = await db
    .insert(standingDecision)
    .values({
      scope,
      scopeId:
        scope === 'global' ? null : scope === 'repository' ? init?.repositoryId : row.initiativeId,
      topic: row.topicKey ?? row.title,
      text,
      createdFromInteractionId: row.id,
      createdBy: by,
    })
    .returning();
  const [linked] = await db
    .update(interaction)
    .set({ standingDecisionId: sd!.id })
    .where(eq(interaction.id, row.id))
    .returning();
  await recordActivity(db, {
    actorType: 'person',
    actorId: by,
    initiativeId: row.initiativeId,
    runId: row.runId,
    interactionId: row.id,
    action: 'standing_decision.created',
    detail: { standingDecisionId: sd!.id, scope, topic: sd!.topic },
  });
  return linked!;
}
/** Settles an open interaction. Returns null if somebody else settled it first. */
export async function settleWithAnswer(
  db: Db,
  id: string,
  input: SettleInput,
): Promise<InteractionRow | null> {
  const [row] = await db
    .update(interaction)
    .set({
      state: 'answered',
      answer: {
        text: input.answer,
        decision: input.decision ?? null,
        choice: input.optionId ?? null,
        source: 'human',
      },
      answeredBy: input.by,
      answeredVia: input.via,
      answeredAt: new Date(),
      didntNeedToAsk: input.didntNeedToAsk ?? false,
    })
    .where(and(eq(interaction.id, id), eq(interaction.state, 'open')))
    .returning();
  if (!row) return null;

  let settled = row;
  if (input.makeStanding && input.answer.trim()) {
    settled = await saveStandingDecision(db, row, input.answer, input.by, input.standingScope);
  }
  await recordActivity(db, {
    actorType: 'person',
    actorId: input.by,
    initiativeId: row.initiativeId,
    runId: row.runId,
    interactionId: row.id,
    action: input.decision ? `interaction.${input.decision}` : 'interaction.answered',
    detail: { via: input.via, standing: Boolean(settled.standingDecisionId) },
  });
  await notifyRun(db, settled, 'human');
  return settled;
}

/**
 * The platform approves a review by rule (an autonomy mode or a pre-approved change type). Nobody is asked.
 * Returns null if somebody settled it first.
 */
export async function settleByPolicy(
  db: Db,
  id: string,
  input: { decision: Decision; reason: string; rule: string | null },
): Promise<InteractionRow | null> {
  const [row] = await db
    .update(interaction)
    .set({
      state: 'answered',
      answer: {
        text: input.reason,
        decision: input.decision,
        choice: null,
        source: 'policy',
        rule: input.rule,
      },
      answeredVia: 'auto',
      answeredAt: new Date(),
    })
    .where(and(eq(interaction.id, id), eq(interaction.state, 'open')))
    .returning();
  if (!row) return null;
  await recordActivity(db, {
    actorType: 'system',
    initiativeId: row.initiativeId,
    runId: row.runId,
    interactionId: row.id,
    action: 'pull_request.auto_approved',
    detail: { reason: input.reason, rule: input.rule },
  });
  return row;
}

/** Applies the default if this interaction is due. Mirrors defaultApplies() in packages/core. */
export async function settleDefaultIfDue(
  db: Db,
  id: string,
  now = new Date(),
): Promise<InteractionRow | null> {
  const [row] = await db
    .update(interaction)
    .set({
      state: 'defaulted',
      answer: sql`jsonb_build_object('text', ${interaction.defaultValue}, 'decision', null, 'source', 'default')`,
      answeredVia: 'default',
      answeredAt: now,
    })
    .where(
      and(
        eq(interaction.id, id),
        eq(interaction.state, 'open'),
        or(eq(interaction.type, 'question'), eq(interaction.type, 'decision')),
        eq(interaction.hardStop, false),
        lte(interaction.dueAt, now),
        sql`${interaction.defaultValue} is not null`,
      ),
    )
    .returning();
  if (!row) return null;
  await recordActivity(db, {
    actorType: 'system',
    initiativeId: row.initiativeId,
    runId: row.runId,
    interactionId: row.id,
    action: 'interaction.defaulted',
    detail: { default: row.defaultValue },
  });
  await notifyRun(db, row, 'default');
  return row;
}

/** Worker step: applies every default that has come due. */
export async function applyDueDefaults(
  db: Db,
  now = new Date(),
  onDefaulted?: (row: InteractionRow) => Promise<void>,
): Promise<number> {
  const due = await db
    .select({ id: interaction.id })
    .from(interaction)
    .where(
      and(
        eq(interaction.state, 'open'),
        or(eq(interaction.type, 'question'), eq(interaction.type, 'decision')),
        eq(interaction.hardStop, false),
        lte(interaction.dueAt, now),
        sql`${interaction.defaultValue} is not null`,
      ),
    );
  let n = 0;
  for (const d of due) {
    const row = await settleDefaultIfDue(db, d.id, now);
    if (!row) continue;
    n++;
    await onDefaulted?.(row);
  }
  return n;
}

export async function markDidntNeedToAsk(
  db: Db,
  id: string,
  by: string,
): Promise<InteractionRow | null> {
  const [row] = await db
    .update(interaction)
    .set({ didntNeedToAsk: true })
    .where(eq(interaction.id, id))
    .returning();
  if (row) {
    await recordActivity(db, {
      actorType: 'person',
      actorId: by,
      initiativeId: row.initiativeId,
      runId: row.runId,
      interactionId: row.id,
      action: 'interaction.didnt_need_to_ask',
    });
  }
  return row ?? null;
}

/** The interactions a run opened, or joined through de-duplication. */
export async function interactionsForRun(db: Db, runId: string): Promise<InteractionRow[]> {
  return db
    .select()
    .from(interaction)
    .where(
      or(
        eq(interaction.runId, runId),
        sql`${interaction.blocks} @> ${JSON.stringify([{ runId }])}::jsonb`,
      ),
    )
    .orderBy(interaction.createdAt);
}

export async function parkRun(db: Db, runId: string, interactionId: string): Promise<boolean> {
  const moved = await db
    .update(agentRun)
    .set({ state: 'parked', parkReason: interactionId })
    .where(
      and(
        eq(agentRun.id, runId),
        sql`${agentRun.state} in ('queued','starting','running','resuming')`,
      ),
    )
    .returning({ id: agentRun.id });
  if (moved.length === 0) return false;
  await appendRunEvent(db, runId, 'run.parked', { interactionId });
  return true;
}

/** Default recipient of an agent's questions, from the run's role. */
export async function roleForRun(db: Db, runId: string): Promise<Role> {
  const [run] = await db
    .select({ role: agentRun.agentRole })
    .from(agentRun)
    .where(eq(agentRun.id, runId));
  return defaultRoleForAgent(run?.role ?? 'backend_engineer');
}

export async function repositoryIdForInitiative(
  db: Db,
  initiativeId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ repositoryId: initiative.repositoryId })
    .from(initiative)
    .where(eq(initiative.id, initiativeId));
  return row?.repositoryId ?? null;
}
