import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agentRun,
  bugReport,
  buildPlan,
  initiative,
  interaction,
  runEvent,
  stageStart,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { kindGuidance } from '@sdlc/core';
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

export const specTask = (i: { title: string; goal: string; kind?: string | null }) =>
  [
    `Draft the spec: ${i.title}`.slice(0, 100),
    '',
    `Draft the spec for this goal, and write it to docs/spec/<short-slug>.md following your instructions.`,
    '',
    `Goal: ${i.goal}`,
    ...(kindGuidance(i.kind, 'product') ? ['', kindGuidance(i.kind, 'product')!] : []),
  ].join('\n');

export const designTask = (specPath: string, kind?: string | null) => {
  const slug = specPath.replace(/^docs\/spec\//, '').replace(/\.md$/, '');
  return [
    `Design: ${slug}`.slice(0, 100),
    '',
    `Design the approved spec ${specPath}. Write the design to docs/design/${slug}.md following your instructions.`,
    ...(kindGuidance(kind, 'architect') ? ['', kindGuidance(kind, 'architect')!] : []),
  ].join('\n');
};

export interface BugInput {
  title: string;
  description: string;
  steps?: string | null;
  severity: string;
}

/** What the Bug Agent is told. The first line becomes the pull request title. */
export const bugTask = (b: BugInput, reporter: string) =>
  [
    `Fix bug: ${b.title}`.slice(0, 100),
    '',
    `A bug was reported (severity ${b.severity}, reported by ${reporter}). Reproduce it, find the cause, and fix it, following your instructions.`,
    '',
    `What happens, and what should happen:`,
    b.description,
    ...(b.steps ? ['', 'Steps to reproduce:', b.steps] : []),
  ].join('\n');

/**
 * Records a bug report and the step that starts its fix. The fix starts by itself in balanced and autopilot mode when
 * the initiative's steps are on, and otherwise waits for an engineer or admin to click start.
 */
export async function reportBug(
  db: Db,
  agents: Map<string, LoadedAgent>,
  init: typeof initiative.$inferSelect,
  reporter: { id: string; displayName: string },
  input: BugInput,
): Promise<typeof bugReport.$inferSelect> {
  const [bug] = await db
    .insert(bugReport)
    .values({
      initiativeId: init.id,
      title: input.title,
      description: input.description,
      steps: input.steps ?? null,
      severity: input.severity,
      reportedBy: reporter.id,
    })
    .returning();
  const noAgent = !agents.has('bug');
  const auto = init.autoStages && init.autonomyMode !== 'guided';
  const [step] = await db
    .insert(stageStart)
    .values({
      initiativeId: init.id,
      key: `bug:${bug!.id}`,
      stage: 'bug',
      role: 'bug',
      task: bugTask(input, reporter.displayName),
      state: noAgent ? 'invalid' : auto ? 'pending' : 'awaiting_start',
      detail: noAgent
        ? 'No agent fixes bugs.'
        : auto
          ? 'The fix starts by itself.'
          : 'A person starts the fix.',
      startedBy: reporter.id,
    })
    .returning();
  const [row] = await db
    .update(bugReport)
    .set({ stageStartId: step!.id, detail: step!.detail })
    .where(eq(bugReport.id, bug!.id))
    .returning();
  await recordActivity(db, {
    actorType: 'person',
    actorId: reporter.id,
    initiativeId: init.id,
    action: 'bug.reported',
    detail: { bugId: bug!.id, title: input.title, severity: input.severity, state: step!.state },
  });
  return row!;
}

/** Keeps each bug's state in line with its fix: started, merged, or in need of a person. */
export async function syncBugs(db: Db): Promise<void> {
  const open = await db
    .select({ bug: bugReport, step: stageStart })
    .from(bugReport)
    .innerJoin(stageStart, eq(stageStart.id, bugReport.stageStartId))
    .where(inArray(bugReport.state, ['open', 'fixing']));
  for (const { bug, step } of open) {
    let state = bug.state;
    let detail = bug.detail;
    if (step.state === 'cancelled' || step.state === 'invalid') {
      state = 'needs_attention';
      detail = step.detail ?? 'The fix was not started.';
    } else if (step.state === 'started' && step.runId) {
      const [run] = await db.select().from(agentRun).where(eq(agentRun.id, step.runId));
      const [review] = await db
        .select()
        .from(interaction)
        .where(and(eq(interaction.runId, step.runId), eq(interaction.type, 'review')))
        .orderBy(sql`${interaction.createdAt} desc`)
        .limit(1);
      const gate = (review?.contextCard as { gate?: { state?: string } } | undefined)?.gate?.state;
      const decision = (review?.answer as { decision?: string } | null)?.decision;
      if (gate === 'merged') {
        state = 'fixed';
        detail = 'The fix was reviewed and merged.';
      } else if (
        run &&
        ['failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(run.state)
      ) {
        state = 'needs_attention';
        detail = `The fix run ended as ${run.state}.`;
      } else if (run?.state === 'succeeded' && !review) {
        state = 'needs_attention';
        detail = `The agent finished without a fix to review. It may not have reproduced the bug.${await agentSaid(db, run.id)}`;
      } else if (review?.state === 'answered' && decision && decision !== 'approved') {
        state = 'needs_attention';
        detail = `The reviewer chose "${decision}".`;
      } else if (
        gate &&
        ['ci_failed', 'failed', 'stale', 'closed', 'timed_out', 'conflict'].includes(gate)
      ) {
        state = 'needs_attention';
        detail = `The merge stopped (${gate}).`;
      } else {
        state = 'fixing';
        const [asked] = review
          ? []
          : await db
              .select({ title: interaction.title })
              .from(interaction)
              .where(
                and(
                  eq(interaction.runId, step.runId),
                  inArray(interaction.type, ['question', 'decision']),
                  eq(interaction.state, 'open'),
                ),
              )
              .limit(1);
        detail = review
          ? 'The fix is in review.'
          : asked
            ? `The agent has a question and is waiting for an answer: ${asked.title.slice(0, 300)}`
            : 'The agent is working on it.';
      }
    }
    if (state !== bug.state || detail !== bug.detail) {
      await db.update(bugReport).set({ state, detail }).where(eq(bugReport.id, bug.id));
    }
  }
}

/** The agent's closing words, trimmed to a line, so a person need not open the run to see why it stopped. */
async function agentSaid(db: Db, runId: string): Promise<string> {
  const [said] = await db
    .select({ payload: runEvent.payload })
    .from(runEvent)
    .where(and(eq(runEvent.runId, runId), eq(runEvent.type, 'run.summary')))
    .orderBy(sql`${runEvent.seq} desc`)
    .limit(1);
  const text = String((said?.payload as { text?: string } | undefined)?.text ?? '')
    .replace(/[#*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return ' See the run for its summary.';
  return ` The agent said: ${text.slice(0, 400)}${text.length > 400 ? '...' : ''}`;
}

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

export type SendBackResult =
  { ok: true; step: StageStartRow } | { ok: false; status: number; code: string; message: string };

/**
 * An approved design that the platform cannot build (its plan is invalid) goes back to the Architect: the plan is closed
 * and a revision step starts a new Architect run from the current main, told what the platform reported. The revised
 * design is a new pull request that a person approves like any other, and it gets a new plan. Three tries, then a person
 * takes over.
 */
export async function sendPlanBack(
  db: Db,
  agents: Map<string, LoadedAgent>,
  planId: string,
  by: string,
): Promise<SendBackResult> {
  const fail = (status: number, code: string, message: string): SendBackResult => ({
    ok: false,
    status,
    code,
    message,
  });
  const [plan] = await db.select().from(buildPlan).where(eq(buildPlan.id, planId));
  if (!plan) return fail(404, 'not_found', 'No such build plan.');
  if (plan.state !== 'invalid')
    return fail(409, 'wrong_state', 'Only a plan that cannot be built can be sent back.');
  if (!agents.has('architect')) return fail(409, 'no_agent', 'There is no Architect agent.');
  if (!DESIGN_FILE.test(plan.designPath))
    return fail(409, 'no_design', 'The approved pull request has no design file to revise.');
  const [init] = await db.select().from(initiative).where(eq(initiative.id, plan.initiativeId));
  if (!init) return fail(404, 'not_found', 'No such initiative.');
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stageStart)
    .where(
      and(
        eq(stageStart.initiativeId, init.id),
        eq(stageStart.stage, 'design'),
        sql`${stageStart.key} like 'revise%'`,
      ),
    )) as [{ n: number }];
  if (n >= MAX_REVISIONS)
    return fail(
      409,
      'too_many',
      `This design was revised ${n} times already. A person takes over.`,
    );
  const guided = init.autonomyMode === 'guided';
  const [step] = await db
    .insert(stageStart)
    .values({
      initiativeId: init.id,
      key: `revise-plan:${plan.id}`,
      stage: 'design',
      role: 'architect',
      sourceInteractionId: plan.designInteractionId,
      task: reviseTask(
        'design',
        plan.designPath,
        undefined,
        `The design was approved, but the platform cannot build it from the task list: ${plan.errors.join(' / ')}. Fix what the platform reports and keep everything else as it is. Do not change the approved spec.`,
        `docs/spec/${plan.designPath.replace(/^docs\/design\//, '')}`,
      ),
      state: guided ? 'awaiting_start' : 'pending',
      detail: guided
        ? 'The design could not be built. A person starts the revised design.'
        : 'The design could not be built. The revised design starts by itself.',
      startedBy: by,
    })
    .onConflictDoNothing()
    .returning();
  if (!step) return fail(409, 'already_sent', 'This plan was already sent back.');
  await db
    .update(buildPlan)
    .set({ state: 'cancelled', detail: 'Sent back to the Architect: a revised design is coming.' })
    .where(eq(buildPlan.id, plan.id));
  await recordActivity(db, {
    actorType: 'person',
    actorId: by,
    initiativeId: init.id,
    action: 'build_plan.sent_back',
    detail: { planId: plan.id, errors: plan.errors },
  });
  return { ok: true, step };
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
        task: specPath ? designTask(specPath, init.kind) : 'Design',
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
  await syncBugs(deps.db);
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
