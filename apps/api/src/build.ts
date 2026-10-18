import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { agentRun, buildPlan, buildTask, initiative, interaction } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { parseDesignTasks, planProgress, readyTasks, taskPrompt } from '@sdlc/core';
import type { DesignTask, TaskState } from '@sdlc/core';
import { recordActivity } from './activity.js';
import type { LoadedAgent } from './agents.js';
import type { GitHubService } from './github-service.js';
import { RunError, cancelRun, createRun } from './runs.js';

// The build plan (mvp-contract section 16, step 4): when a design is approved and merged, its task list becomes a plan.
// Tasks start in dependency order. A task starts only once everything it depends on is merged (or skipped).

export type PlanRow = typeof buildPlan.$inferSelect;
export type TaskRow = typeof buildTask.$inferSelect;

export interface BuildDeps {
  db: Db;
  github: Pick<GitHubService, 'readFile'>;
  agents: Map<string, LoadedAgent>;
  /** Runs one initiative may have going at once. */
  maxActive: number;
  /** A design approved longer ago than this waits for a person to start it, whatever the mode. */
  autoStartMinutes?: number;
  log?: (line: string) => void;
}

const DESIGN_FILE = /^docs\/design\/[^/]+\.md$/;
const RUN_FAILED = new Set(['failed', 'cancelled', 'budget_exceeded', 'timed_out']);
const GATE_STOPPED = new Set(['ci_failed', 'failed', 'stale', 'closed', 'timed_out']);

interface DesignCard {
  repository?: string;
  diff?: { changedPaths?: string[] };
  gate?: { state?: string; mergedSha?: string };
}

/** Turns each approved and merged design that has no plan yet into one. Returns how many it made. */
export async function ensurePlans(deps: BuildDeps): Promise<number> {
  const { db } = deps;
  const rows = await db
    .select({ i: interaction, init: initiative })
    .from(interaction)
    .innerJoin(agentRun, eq(agentRun.id, interaction.runId))
    .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
    .leftJoin(buildPlan, eq(buildPlan.designInteractionId, interaction.id))
    .where(
      and(
        eq(interaction.type, 'review'),
        eq(interaction.checkpointId, 'G1'),
        eq(interaction.state, 'answered'),
        eq(agentRun.agentRole, 'architect'),
        isNull(buildPlan.id),
        sql`${interaction.contextCard} -> 'gate' ->> 'state' = 'merged'`,
      ),
    );

  let made = 0;
  for (const { i, init } of rows) {
    const card = i.contextCard as DesignCard;
    const sha = card.gate?.mergedSha;
    const designPath = card.diff?.changedPaths?.find((p) => DESIGN_FILE.test(p));
    const base = {
      initiativeId: init.id,
      designInteractionId: i.id,
      designPath: designPath ?? '',
      designSha: sha ?? '',
      startedBy: i.answeredBy,
    };

    // Starting on its own is for a design that was just approved. An old one may no longer be what anyone wants.
    const fresh =
      !i.answeredAt ||
      Date.now() - i.answeredAt.getTime() < (deps.autoStartMinutes ?? 120) * 60_000;
    let state: PlanRow['state'] =
      init.autonomyMode === 'guided' || !fresh ? 'awaiting_start' : 'active';
    let errors: string[] = [];
    let tasks: DesignTask[] = [];

    if (!designPath || !sha || !card.repository) {
      state = 'invalid';
      errors = ['The approved pull request has no design file under docs/design/.'];
    } else {
      let text: string | null;
      try {
        text = await deps.github.readFile(card.repository, designPath, sha);
      } catch (e) {
        // GitHub or the App is unavailable. Try again on the next pass.
        deps.log?.(
          `build plan: could not read ${designPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      if (text === null) {
        state = 'invalid';
        errors = [`${designPath} is not in the repository at the merged commit.`];
      } else {
        const parsed = parseDesignTasks(text);
        if (!parsed.ok) {
          state = 'invalid';
          errors = parsed.errors;
        } else {
          tasks = parsed.tasks;
          const unstaffed = [...new Set(tasks.map((t) => t.role))].filter(
            (r) => !deps.agents.has(r),
          );
          if (unstaffed.length > 0) {
            state = 'invalid';
            errors = unstaffed.map(
              (r) =>
                `No agent builds the role "${r}" yet. Ask the Architect to use a role that has one.`,
            );
          }
        }
      }
    }

    const [plan] = await db
      .insert(buildPlan)
      .values({
        ...base,
        state,
        errors,
        detail:
          state === 'invalid'
            ? 'The design cannot be built as written.'
            : state === 'awaiting_start'
              ? init.autonomyMode !== 'guided' && !fresh
                ? 'This design was approved a while ago. A person starts the build.'
                : 'The design is approved. A person starts the build.'
              : 'The design is approved. Tasks start as their dependencies merge.',
      })
      .onConflictDoNothing()
      .returning();
    if (!plan) continue;
    if (tasks.length > 0) {
      await db.insert(buildTask).values(
        tasks.map((t, position) => ({
          planId: plan.id,
          key: t.id,
          position,
          title: t.title,
          role: t.role,
          stories: t.stories,
          dependsOn: t.dependsOn,
          paths: t.paths,
          doneWhen: t.doneWhen,
        })),
      );
    }
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: init.id,
      interactionId: i.id,
      action: 'build_plan.created',
      detail: { planId: plan.id, state, tasks: tasks.length, path: designPath, errors },
    });
    made++;
  }
  return made;
}

/** What a task's run and review say about where it is. Null means no change. */
function settle(
  task: TaskRow,
  run: typeof agentRun.$inferSelect | undefined,
  review: typeof interaction.$inferSelect | undefined,
): { state: TaskState; detail: string | null } | null {
  if (!run) return { state: 'failed', detail: 'The run for this task is missing.' };
  if (RUN_FAILED.has(run.state)) {
    return {
      state: 'failed',
      detail: `The run ended as ${run.state}${run.exitReason ? ` (${run.exitReason})` : ''}.`,
    };
  }
  if (run.state !== 'succeeded')
    return task.state === 'running' ? null : { state: 'running', detail: null };

  if (!review) {
    return { state: 'failed', detail: 'The run finished without opening a pull request.' };
  }
  const card = review.contextCard as { gate?: { state?: string; detail?: string } };
  const decision = (review.answer as { decision?: string } | null)?.decision;
  if (card.gate?.state === 'merged') return { state: 'merged', detail: null };
  if (review.state === 'answered' && decision && decision !== 'approved') {
    return { state: 'failed', detail: `The reviewer chose "${decision}".` };
  }
  if (card.gate?.state && GATE_STOPPED.has(card.gate.state)) {
    return {
      state: 'failed',
      detail: `The merge stopped (${card.gate.state}${card.gate.detail ? `: ${card.gate.detail}` : ''}).`,
    };
  }
  return task.state === 'review' ? null : { state: 'review', detail: null };
}

async function spentMicros(db: Db, initiativeId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${agentRun.costMicros}), 0)` })
    .from(agentRun)
    .where(eq(agentRun.initiativeId, initiativeId));
  return Number(r?.s ?? 0);
}

async function advancePlan(deps: BuildDeps, plan: PlanRow): Promise<void> {
  const { db } = deps;
  const tasks = await db
    .select()
    .from(buildTask)
    .where(eq(buildTask.planId, plan.id))
    .orderBy(asc(buildTask.position));

  // 1. Where is each task that has a run?
  for (const task of tasks) {
    if (task.state !== 'running' && task.state !== 'review') continue;
    const [run] = task.runId
      ? await db.select().from(agentRun).where(eq(agentRun.id, task.runId))
      : [];
    const [review] = task.runId
      ? await db
          .select()
          .from(interaction)
          .where(and(eq(interaction.runId, task.runId), eq(interaction.type, 'review')))
          .orderBy(sql`${interaction.createdAt} desc`)
          .limit(1)
      : [];
    const next = settle(task, run, review);
    if (!next) continue;
    await db
      .update(buildTask)
      .set({ state: next.state, detail: next.detail })
      .where(eq(buildTask.id, task.id));
    task.state = next.state;
    task.detail = next.detail;
    if (next.state === 'merged' || next.state === 'failed') {
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: plan.initiativeId,
        runId: task.runId,
        action: next.state === 'merged' ? 'build_task.merged' : 'build_task.failed',
        detail: { planId: plan.id, task: task.key, detail: next.detail },
      });
    }
  }

  // 2. Is it over?
  const progress = planProgress(
    tasks.map((t) => ({ key: t.key, state: t.state as TaskState, dependsOn: t.dependsOn })),
  );
  if (progress.status === 'done') {
    await db
      .update(buildPlan)
      .set({ state: 'done', detail: 'Every task is merged or skipped.' })
      .where(eq(buildPlan.id, plan.id));
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: plan.initiativeId,
      action: 'build_plan.done',
      detail: { planId: plan.id },
    });
    return;
  }

  // 3. Start what can start.
  const [init] = await db.select().from(initiative).where(eq(initiative.id, plan.initiativeId));
  const sponsor = plan.startedBy ?? init?.createdBy;
  if (!init || !sponsor) return;
  const designs = tasks.map<DesignTask>((t) => ({
    id: t.key,
    title: t.title,
    role: t.role as DesignTask['role'],
    stories: t.stories,
    dependsOn: t.dependsOn,
    paths: t.paths,
    doneWhen: t.doneWhen,
  }));
  const ready = readyTasks(
    tasks.map((t) => ({ key: t.key, state: t.state as TaskState, dependsOn: t.dependsOn })),
    deps.maxActive,
  );
  for (const key of ready) {
    const task = tasks.find((t) => t.key === key)!;
    const def = designs.find((d) => d.id === key)!;
    const agent = deps.agents.get(task.role);
    if (!agent) continue;
    const budget = agent.definition.limits.budget_usd * 1_000_000;
    if (
      init.budgetMicros !== null &&
      (await spentMicros(db, init.id)) + budget > init.budgetMicros
    ) {
      await db
        .update(buildPlan)
        .set({ detail: 'The initiative budget would be exceeded, so no more tasks start.' })
        .where(eq(buildPlan.id, plan.id));
      return;
    }
    try {
      const run = await createRun(db, deps.agents, {
        initiativeId: init.id,
        role: task.role,
        task: taskPrompt({ path: plan.designPath }, def, designs),
        sponsorPersonId: sponsor,
      });
      await db
        .update(buildTask)
        .set({ state: 'running', runId: run.id, attempt: task.attempt + 1, detail: null })
        .where(eq(buildTask.id, task.id));
      task.state = 'running';
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: init.id,
        runId: run.id,
        action: 'build_task.started',
        detail: { planId: plan.id, task: task.key, attempt: task.attempt + 1 },
      });
    } catch (e) {
      if (!(e instanceof RunError)) throw e;
      if (e.code === 'initiative_not_active') {
        await cancelPlan(db, plan.id, sponsor, `The initiative is no longer active.`);
        return;
      }
      await db
        .update(buildTask)
        .set({ state: 'failed', detail: e.message })
        .where(eq(buildTask.id, task.id));
    }
  }
}

/** One pass of the build worker. */
export async function buildTick(deps: BuildDeps): Promise<void> {
  await ensurePlans(deps);
  const plans = await deps.db.select().from(buildPlan).where(eq(buildPlan.state, 'active'));
  for (const plan of plans) {
    await advancePlan(deps, plan).catch((e) =>
      deps.log?.(`build plan ${plan.id}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

// ---- What a person can do ----

export async function startPlan(db: Db, planId: string, by: string): Promise<PlanRow | null> {
  const [plan] = await db
    .update(buildPlan)
    .set({
      state: 'active',
      startedBy: by,
      detail: 'Started. Tasks start as their dependencies merge.',
    })
    .where(and(eq(buildPlan.id, planId), eq(buildPlan.state, 'awaiting_start')))
    .returning();
  if (plan) {
    await recordActivity(db, {
      actorType: 'person',
      actorId: by,
      initiativeId: plan.initiativeId,
      action: 'build_plan.started',
      detail: { planId },
    });
  }
  return plan ?? null;
}

/** Puts a failed task back in line. It gets a new run when its dependencies allow. */
export async function retryTask(
  db: Db,
  planId: string,
  key: string,
  by: string,
): Promise<TaskRow | null> {
  const [plan] = await db.select().from(buildPlan).where(eq(buildPlan.id, planId));
  if (!plan || plan.state !== 'active') return null;
  const [task] = await db
    .update(buildTask)
    .set({ state: 'waiting', detail: null })
    .where(and(eq(buildTask.planId, planId), eq(buildTask.key, key), eq(buildTask.state, 'failed')))
    .returning();
  if (task) {
    await recordActivity(db, {
      actorType: 'person',
      actorId: by,
      initiativeId: plan.initiativeId,
      action: 'build_task.retried',
      detail: { planId, task: key },
    });
  }
  return task ?? null;
}

/** Drops a task that waits or failed, so the tasks behind it can start. */
export async function skipTask(
  db: Db,
  planId: string,
  key: string,
  by: string,
): Promise<TaskRow | null> {
  const [plan] = await db.select().from(buildPlan).where(eq(buildPlan.id, planId));
  if (!plan || (plan.state !== 'active' && plan.state !== 'awaiting_start')) return null;
  const [task] = await db
    .update(buildTask)
    .set({ state: 'skipped', detail: 'Skipped by a person.' })
    .where(
      and(
        eq(buildTask.planId, planId),
        eq(buildTask.key, key),
        inArray(buildTask.state, ['waiting', 'failed']),
      ),
    )
    .returning();
  if (task) {
    await recordActivity(db, {
      actorType: 'person',
      actorId: by,
      initiativeId: plan.initiativeId,
      action: 'build_task.skipped',
      detail: { planId, task: key },
    });
  }
  return task ?? null;
}

/** Stops the plan: unfinished tasks are cancelled and any run still going is cancelled with them. */
export async function cancelPlan(
  db: Db,
  planId: string,
  by: string,
  detail = 'Cancelled by a person.',
): Promise<PlanRow | null> {
  const [plan] = await db
    .update(buildPlan)
    .set({ state: 'cancelled', detail })
    .where(and(eq(buildPlan.id, planId), inArray(buildPlan.state, ['awaiting_start', 'active'])))
    .returning();
  if (!plan) return null;
  const open = await db
    .update(buildTask)
    .set({ state: 'cancelled', detail })
    .where(
      and(
        eq(buildTask.planId, planId),
        inArray(buildTask.state, ['waiting', 'running', 'review', 'failed']),
      ),
    )
    .returning();
  for (const t of open) if (t.runId) await cancelRun(db, t.runId, by).catch(() => null);
  await recordActivity(db, {
    actorType: 'person',
    actorId: by,
    initiativeId: plan.initiativeId,
    action: 'build_plan.cancelled',
    detail: { planId, detail },
  });
  return plan;
}
