import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentRun, buildPlan, buildTask } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { stuckBehind } from '@sdlc/core';
import type { TaskState } from '@sdlc/core';
import { buildPlanSchema } from '@sdlc/schemas';
import type { BuildPlanDto } from '@sdlc/schemas';
import { cancelPlan, retryTask, skipTask, startPlan } from './build.js';
import type { PlanRow } from './build.js';
import { requirePerson } from './people.js';

// Who may start, cancel, retry or skip. They decide what gets built, so they are the people who decide the spec and
// the design, plus an admin.
const CONTROL_ROLES = ['product_owner', 'architect', 'platform_admin'];

export async function planDto(db: Db, plan: PlanRow): Promise<BuildPlanDto> {
  const tasks = await db
    .select()
    .from(buildTask)
    .where(eq(buildTask.planId, plan.id))
    .orderBy(asc(buildTask.position));
  const runIds = tasks.flatMap((t) => (t.runId ? [t.runId] : []));
  const runs = runIds.length
    ? await db.select().from(agentRun).where(inArray(agentRun.id, runIds))
    : [];
  const behind = stuckBehind(
    tasks.map((t) => ({ key: t.key, state: t.state as TaskState, dependsOn: t.dependsOn })),
  );
  return buildPlanSchema.parse({
    id: plan.id,
    initiativeId: plan.initiativeId,
    state: plan.state,
    designPath: plan.designPath,
    detail: plan.detail,
    errors: plan.errors,
    createdAt: plan.createdAt.toISOString(),
    tasks: tasks.map((t) => ({
      key: t.key,
      title: t.title,
      role: t.role,
      stories: t.stories,
      dependsOn: t.dependsOn,
      paths: t.paths,
      doneWhen: t.doneWhen,
      state: t.state,
      runId: t.runId,
      prNumber: runs.find((r) => r.id === t.runId)?.prNumber ?? null,
      attempt: t.attempt,
      detail: t.detail,
      stuckBehind: behind[t.key] ?? [],
    })),
  });
}

export function registerBuildRoutes(app: FastifyInstance, db: Db): void {
  const notFound = { error: { code: 'not_found', message: 'No such build plan.' } };

  app.get('/api/initiatives/:id/plan', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [plan] = await db
      .select()
      .from(buildPlan)
      .where(eq(buildPlan.initiativeId, id))
      .orderBy(desc(buildPlan.createdAt))
      .limit(1);
    return { plan: plan ? await planDto(db, plan) : null };
  });

  const control = async (
    request: Parameters<typeof requirePerson>[1],
    reply: Parameters<typeof requirePerson>[2],
  ) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return null;
    if (!me.roles.some((r) => CONTROL_ROLES.includes(r))) {
      reply.code(403).send({
        error: {
          code: 'wrong_role',
          message: 'A Product Owner, an Architect or a Platform Admin controls the build.',
        },
      });
      return null;
    }
    return me;
  };
  const conflict = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    what: string,
  ) => reply.code(409).send({ error: { code: 'wrong_state', message: what } });

  app.post('/api/plans/:id/start', async (request, reply) => {
    const me = await control(request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const plan = await startPlan(db, id, me.id);
    if (!plan) return conflict(reply, 'The plan is not waiting to be started.');
    return planDto(db, plan);
  });

  app.post('/api/plans/:id/cancel', async (request, reply) => {
    const me = await control(request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const plan = await cancelPlan(db, id, me.id);
    if (!plan) return conflict(reply, 'The plan is already finished or cancelled.');
    return planDto(db, plan);
  });

  for (const verb of ['retry', 'skip'] as const) {
    app.post(`/api/plans/:id/tasks/:key/${verb}`, async (request, reply) => {
      const me = await control(request, reply);
      if (!me) return;
      const { id, key } = z
        .object({ id: z.string().uuid(), key: z.string().regex(/^T\d{1,3}$/) })
        .parse(request.params);
      const task = await (verb === 'retry' ? retryTask : skipTask)(db, id, key, me.id);
      if (!task) {
        return conflict(
          reply,
          verb === 'retry'
            ? 'Only a failed task of an active plan can be retried.'
            : 'Only a waiting or failed task of a live plan can be skipped.',
        );
      }
      const [plan] = await db.select().from(buildPlan).where(eq(buildPlan.id, id));
      return plan ? planDto(db, plan) : reply.code(404).send(notFound);
    });
  }
}
