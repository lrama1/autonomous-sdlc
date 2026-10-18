import { and, eq, inArray, isNull } from 'drizzle-orm';
import { agentRun, appendRunEvent, initiative, repositoryEntry, runToken } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { generateToken, hashToken } from '@sdlc/core';
import type { LoadedAgent } from './agents.js';
import { recordActivity } from './activity.js';

export type RunRow = typeof agentRun.$inferSelect;

export const TERMINAL_STATES = [
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
] as const;
const LIVE_STATES = ['queued', 'starting', 'running', 'parked', 'resuming', 'paused'];

export class RunError extends Error {
  constructor(
    readonly code: 'no_agent' | 'budget_too_high' | 'initiative_not_active' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

export interface CreateRunInput {
  initiativeId: string;
  role: string;
  task: string;
  sponsorPersonId: string;
  budgetUsd?: number;
}

/** Creates a queued run for an initiative. The run token is issued later, when the run launches. */
export async function createRun(
  db: Db,
  agents: Map<string, LoadedAgent>,
  input: CreateRunInput,
): Promise<RunRow> {
  const agent = agents.get(input.role);
  if (!agent) throw new RunError('no_agent', `No agent definition for the role "${input.role}".`);
  const def = agent.definition;
  if (input.budgetUsd !== undefined && input.budgetUsd > def.limits.budget_usd) {
    throw new RunError(
      'budget_too_high',
      `The budget for a ${input.role} run is at most $${def.limits.budget_usd}.`,
    );
  }
  const [init] = await db.select().from(initiative).where(eq(initiative.id, input.initiativeId));
  if (!init) throw new RunError('not_found', 'No such initiative.');
  if (init.state === 'done' || init.state === 'cancelled') {
    throw new RunError('initiative_not_active', `The initiative is ${init.state}.`);
  }

  const [run] = await db
    .insert(agentRun)
    .values({
      initiativeId: init.id,
      agentRole: input.role,
      task: input.task,
      agentDefinitionId: def.id,
      agentDefinitionVersion: def.version,
      engine: def.engine,
      modelAlias: def.model_alias,
      state: 'queued',
      sponsorPersonId: input.sponsorPersonId,
      repositoryId: init.repositoryId,
      budgetMicros: Math.round((input.budgetUsd ?? def.limits.budget_usd) * 1_000_000),
    })
    .returning();
  if (init.state === 'draft')
    await db.update(initiative).set({ state: 'active' }).where(eq(initiative.id, init.id));
  await recordActivity(db, {
    actorType: 'person',
    actorId: input.sponsorPersonId,
    initiativeId: init.id,
    runId: run!.id,
    action: 'run.created',
    detail: {
      role: input.role,
      definition: `${def.id}@${def.version}`,
      budgetMicros: run!.budgetMicros,
    },
  });
  await appendRunEvent(db, run!.id, 'run.queued', { role: input.role });
  return run!;
}

/**
 * Issues the one token a run uses for the gateway and the platform tools.
 * Only its hash is stored. The plaintext goes to the runner and nowhere else.
 */
export async function issueRunToken(
  db: Db,
  run: Pick<RunRow, 'id' | 'modelAlias'>,
  opts: { ttlMs: number },
): Promise<string> {
  const token = generateToken();
  await db.insert(runToken).values({
    tokenHash: hashToken(token),
    runId: run.id,
    // agent-fast is always allowed: Claude Code uses a small model for background work.
    scopes: ['gateway', 'mcp', 'runner', `alias:${run.modelAlias}`, 'alias:agent-fast'],
    expiresAt: new Date(Date.now() + opts.ttlMs),
  });
  return token;
}

export async function revokeRunTokens(db: Db, runId: string): Promise<void> {
  await db
    .update(runToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(runToken.runId, runId), isNull(runToken.revokedAt)));
}

/** Cancels a run that has not finished. Returns null if it was already finished. */
export async function cancelRun(db: Db, runId: string, by: string): Promise<RunRow | null> {
  const [run] = await db
    .update(agentRun)
    .set({ state: 'cancelled', exitReason: 'cancelled', finishedAt: new Date() })
    .where(and(eq(agentRun.id, runId), inArray(agentRun.state, LIVE_STATES)))
    .returning();
  if (!run) return null;
  await revokeRunTokens(db, runId);
  await recordActivity(db, {
    actorType: 'person',
    actorId: by,
    initiativeId: run.initiativeId,
    runId,
    action: 'run.cancelled',
  });
  await appendRunEvent(db, runId, 'run.finished', { exitReason: 'cancelled' });
  return run;
}

export async function repositoryFor(db: Db, repositoryId: string) {
  const [r] = await db.select().from(repositoryEntry).where(eq(repositoryEntry.id, repositoryId));
  return r;
}
