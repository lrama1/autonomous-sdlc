import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentRun, initiative, interaction, stageStart } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { recordActivity } from './activity.js';
import type { LoadedAgent } from './agents.js';
import type { GitHubService } from './github-service.js';
import { RunError, createRun } from './runs.js';

// The steps before the build (mvp-contract section 16): the spec is drafted from the initiative's goal, then the
// approved spec is designed. Each step ends at its own checkpoint, decided by a person. This only starts the runs.

export type StageStartRow = typeof stageStart.$inferSelect;

export interface StageDeps {
  db: Db;
  agents: Map<string, LoadedAgent>;
  /** A step that follows an approval older than this waits for a person to start it, whatever the mode. */
  autoStartMinutes?: number;
  /** Used to close a pull request that a revision replaces. */
  github?: Pick<GitHubService, 'comment' | 'closePullRequest'>;
  log?: (line: string) => void;
}

const SPEC_FILE = /^docs\/spec\/[^/]+\.md$/;
const DESIGN_FILE = /^docs\/design\/[^/]+\.md$/;
/** How many times a spec or a design is revised on request before a person takes over. */
const MAX_REVISIONS = 3;

export const specTask = (i: { title: string; goal: string }) =>
  [
    `Draft the spec: ${i.title}`.slice(0, 100),
    '',
    `Draft the spec for this goal, and write it to docs/spec/<short-slug>.md following your instructions.`,
    '',
    `Goal: ${i.goal}`,
  ].join('\n');

export const designTask = (specPath: string) => {
  const slug = specPath.replace(/^docs\/spec\//, '').replace(/\.md$/, '');
  return [
    `Design: ${slug}`.slice(0, 100),
    '',
    `Design the approved spec ${specPath}. Write the design to docs/design/${slug}.md following your instructions.`,
  ].join('\n');
};

/** What a revision run is told: the file, the reviewer's words, and that it starts from the current main branch. */
export function reviseTask(
  what: 'spec' | 'design',
  filePath: string,
  prNumber: number | undefined,
  comment: string,
  specPath?: string,
) {
  const name = filePath.split('/').pop()!.replace(/\.md$/, '');
  return [
    `Revise the ${what}: ${name}`.slice(0, 100),
    '',
    `A reviewer asked for changes to the ${what} at ${filePath}${prNumber ? ` (pull request #${prNumber}, now closed)` : ''}. Write the revised ${what} to the same path, from the current main branch, following your instructions. Rewrite the whole file, applying what the reviewer asked for and keeping what they did not mention.`,
    ...(specPath ? ['', `The approved spec it designs is ${specPath}.`] : []),
    '',
    `The reviewer said: ${comment.trim() || '(no comment was given)'}`,
  ].join('\n');
}

/** Called when an initiative is created with its steps on. The spec starts by itself, or waits for a click in guided mode. */
export async function planSpecStart(
  db: Db,
  agents: Map<string, LoadedAgent>,
  init: typeof initiative.$inferSelect,
  by: string,
): Promise<StageStartRow | null> {
  if (!init.autoStages) return null;
  const guided = init.autonomyMode === 'guided';
  const invalid = !agents.has('product');
  const [row] = await db
    .insert(stageStart)
    .values({
      initiativeId: init.id,
      key: 'spec',
      stage: 'spec',
      role: 'product',
      task: specTask(init),
      state: invalid ? 'invalid' : guided ? 'awaiting_start' : 'pending',
      detail: invalid
        ? 'No agent drafts specs.'
        : guided
          ? 'A person starts the spec.'
          : 'The spec starts by itself.',
      startedBy: by,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

interface SpecCard {
  diff?: { changedPaths?: string[] };
  gate?: { state?: string };
}

interface ReviewCard {
  repository?: string;
  prNumber?: number;
  diff?: { changedPaths?: string[] };
}

/**
 * A spec or design that a reviewer sent back with "changes requested" gets a revision step: a new run of the same
 * agent, started from the current main with the reviewer's words. The same person sponsors it as the first run, so the
 * reviewer can still decide the result. After three revisions of one kind a person takes over.
 */
export async function ensureRevisions(deps: StageDeps): Promise<number> {
  const { db } = deps;
  const rows = await db
    .select({ i: interaction, run: agentRun, init: initiative })
    .from(interaction)
    .innerJoin(agentRun, eq(agentRun.id, interaction.runId))
    .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
    .where(
      and(
        eq(interaction.type, 'review'),
        eq(interaction.checkpointId, 'G1'),
        eq(interaction.state, 'answered'),
        inArray(agentRun.agentRole, ['product', 'architect']),
        eq(initiative.autoStages, true),
        sql`${interaction.answer} ->> 'decision' = 'changes_requested'`,
        sql`not exists (select 1 from stage_start s where s.initiative_id = ${interaction.initiativeId} and s.key = 'revise:' || ${interaction.id}::text)`,
      ),
    );
  let made = 0;
  for (const { i, run, init } of rows) {
    const what = run.agentRole === 'product' ? 'spec' : 'design';
    const card = i.contextCard as ReviewCard;
    const file = card.diff?.changedPaths?.find((p) =>
      (what === 'spec' ? SPEC_FILE : DESIGN_FILE).test(p),
    );
    const comment = (i.answer as { text?: string } | null)?.text ?? '';
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(stageStart)
      .where(
        and(
          eq(stageStart.initiativeId, init.id),
          sql`${stageStart.key} like 'revise:%' and ${stageStart.stage} = ${what}`,
        ),
      )) as [{ n: number }];
    const fresh =
      !i.answeredAt ||
      Date.now() - i.answeredAt.getTime() < (deps.autoStartMinutes ?? 120) * 60_000;
    const problem = !file
      ? `The pull request has no ${what} file to revise.`
      : n >= MAX_REVISIONS
        ? `This ${what} was revised ${n} times already. A person takes over.`
        : null;
    const specPath =
      what === 'design' && file ? `docs/spec/${file.replace(/^docs\/design\//, '')}` : undefined;
    const [row] = await db
      .insert(stageStart)
      .values({
        initiativeId: init.id,
        key: `revise:${i.id}`,
        stage: what,
        role: run.agentRole,
        sourceInteractionId: i.id,
        task: file
          ? reviseTask(what, file, card.prNumber, comment, specPath)
          : `Revise the ${what}`,
        state: problem
          ? 'invalid'
          : init.autonomyMode === 'guided' || !fresh
            ? 'awaiting_start'
            : 'pending',
        detail:
          problem ??
          (init.autonomyMode === 'guided' || !fresh
            ? `Changes were requested. A person starts the revised ${what}.`
            : `Changes were requested. The revised ${what} starts by itself.`),
        startedBy: run.sponsorPersonId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: init.id,
      interactionId: i.id,
      action: 'stage.planned',
      detail: { stage: what, revision: true, state: row.state },
    });
    made++;
  }
  return made;
}

/** Each merged spec that has no design step yet gets one. */
export async function ensureDesignStarts(deps: StageDeps): Promise<number> {
  const { db } = deps;
  const rows = await db
    .select({ i: interaction, init: initiative })
    .from(interaction)
    .innerJoin(agentRun, eq(agentRun.id, interaction.runId))
    .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
    .where(
      and(
        eq(interaction.type, 'review'),
        eq(interaction.checkpointId, 'G1'),
        eq(interaction.state, 'answered'),
        eq(agentRun.agentRole, 'product'),
        eq(initiative.autoStages, true),
        sql`${interaction.contextCard} -> 'gate' ->> 'state' = 'merged'`,
        sql`not exists (select 1 from stage_start s where s.initiative_id = ${interaction.initiativeId} and s.key = 'design:' || ${interaction.id}::text)`,
      ),
    );
  let made = 0;
  for (const { i, init } of rows) {
    const card = i.contextCard as SpecCard;
    const specPath = card.diff?.changedPaths?.find((p) => SPEC_FILE.test(p));
    const fresh =
      !i.answeredAt ||
      Date.now() - i.answeredAt.getTime() < (deps.autoStartMinutes ?? 120) * 60_000;
    const missing = !specPath
      ? 'The approved pull request has no spec file under docs/spec/.'
      : !deps.agents.has('architect')
        ? 'No agent writes designs.'
        : null;
    const [row] = await db
      .insert(stageStart)
      .values({
        initiativeId: init.id,
        key: `design:${i.id}`,
        stage: 'design',
        role: 'architect',
        sourceInteractionId: i.id,
        task: specPath ? designTask(specPath) : 'Design',
        state: missing
          ? 'invalid'
          : init.autonomyMode === 'guided' || !fresh
            ? 'awaiting_start'
            : 'pending',
        detail:
          missing ??
          (init.autonomyMode === 'guided'
            ? 'The spec is approved. A person starts the design.'
            : fresh
              ? 'The spec is approved. The design starts by itself.'
              : 'This spec was approved a while ago. A person starts the design.'),
        startedBy: i.answeredBy,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: init.id,
      interactionId: i.id,
      action: 'stage.planned',
      detail: { stage: 'design', state: row.state, spec: specPath ?? null },
    });
    made++;
  }
  return made;
}

async function spentMicros(db: Db, initiativeId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${agentRun.costMicros}), 0)` })
    .from(agentRun)
    .where(eq(agentRun.initiativeId, initiativeId));
  return Number(r?.s ?? 0);
}

/** Starts the steps that are due. */
export async function startDueStages(deps: StageDeps): Promise<number> {
  const { db } = deps;
  const due = await db.select().from(stageStart).where(eq(stageStart.state, 'pending'));
  let started = 0;
  for (const s of due) {
    const [init] = await db.select().from(initiative).where(eq(initiative.id, s.initiativeId));
    const agent = deps.agents.get(s.role);
    const sponsor = s.startedBy ?? init?.createdBy;
    if (!init || !sponsor) continue;
    if (!agent) {
      await db
        .update(stageStart)
        .set({ state: 'invalid', detail: `No agent for ${s.role}.` })
        .where(eq(stageStart.id, s.id));
      continue;
    }
    const budget = agent.definition.limits.budget_usd * 1_000_000;
    if (
      init.budgetMicros !== null &&
      (await spentMicros(db, init.id)) + budget > init.budgetMicros
    ) {
      await db
        .update(stageStart)
        .set({ detail: 'The initiative budget would be exceeded, so this step waits.' })
        .where(eq(stageStart.id, s.id));
      continue;
    }
    // A revision replaces the pull request that was sent back.
    if (s.key.startsWith('revise:') && s.sourceInteractionId && deps.github) {
      const [src] = await db
        .select()
        .from(interaction)
        .where(eq(interaction.id, s.sourceInteractionId));
      const pr = src?.contextCard as ReviewCard | undefined;
      if (pr?.repository && pr.prNumber) {
        await deps.github
          .comment(
            pr.repository,
            pr.prNumber,
            'Closing this: a revised version is being written on the current main branch.',
          )
          .catch(() => {});
        await deps.github.closePullRequest(pr.repository, pr.prNumber).catch(() => {});
      }
    }
    try {
      const run = await createRun(db, deps.agents, {
        initiativeId: init.id,
        role: s.role,
        task: s.task,
        sponsorPersonId: sponsor,
      });
      await db
        .update(stageStart)
        .set({ state: 'started', runId: run.id, detail: null })
        .where(eq(stageStart.id, s.id));
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: init.id,
        runId: run.id,
        action: 'stage.started',
        detail: { stage: s.stage, key: s.key },
      });
      started++;
    } catch (e) {
      if (!(e instanceof RunError)) throw e;
      await db
        .update(stageStart)
        .set({ state: 'cancelled', detail: e.message })
        .where(eq(stageStart.id, s.id));
    }
  }
  return started;
}

export async function stageTick(deps: StageDeps): Promise<void> {
  await ensureRevisions(deps);
  await ensureDesignStarts(deps);
  await startDueStages(deps);
}

// ---- What a person can do ----

/** Starts a step that waits for a person. The next pass starts the run, with this person as its sponsor. */
export async function startStage(db: Db, id: string, by: string): Promise<StageStartRow | null> {
  const [row] = await db
    .update(stageStart)
    .set({ state: 'pending', startedBy: by, detail: 'Started by a person.' })
    .where(and(eq(stageStart.id, id), eq(stageStart.state, 'awaiting_start')))
    .returning();
  if (row) {
    await recordActivity(db, {
      actorType: 'person',
      actorId: by,
      initiativeId: row.initiativeId,
      action: 'stage.started_by_person',
      detail: { stage: row.stage, key: row.key },
    });
  }
  return row ?? null;
}

/** Drops a step that has not started. A person can still start that run by hand. */
export async function skipStage(db: Db, id: string, by: string): Promise<StageStartRow | null> {
  const [row] = await db
    .update(stageStart)
    .set({ state: 'cancelled', detail: 'Skipped by a person.' })
    .where(and(eq(stageStart.id, id), inArray(stageStart.state, ['awaiting_start', 'pending'])))
    .returning();
  if (row) {
    await recordActivity(db, {
      actorType: 'person',
      actorId: by,
      initiativeId: row.initiativeId,
      action: 'stage.skipped',
      detail: { stage: row.stage, key: row.key },
    });
  }
  return row ?? null;
}
