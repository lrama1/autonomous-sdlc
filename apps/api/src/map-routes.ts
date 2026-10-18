import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { agentRun, buildPlan, buildTask, initiative, interaction } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { buildMap } from '@sdlc/core';
import type { MapAsk, MapPlan, Role } from '@sdlc/core';
import { z } from 'zod';
import { requirePerson } from './people.js';
import { prepareRelease } from './releases.js';
import type { GitHubService } from './github-service.js';

/** The SDLC map of an initiative, and releases (checkpoint G6). */
export function registerMapRoutes(
  app: FastifyInstance,
  db: Db,
  github: GitHubService,
  opts: { approverRole: Role },
): void {
  app.get('/api/initiatives/:id/map', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [init] = await db.select().from(initiative).where(eq(initiative.id, id));
    if (!init)
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such initiative.' } });
    const runs = await db.select().from(agentRun).where(eq(agentRun.initiativeId, id));
    const asks = await db
      .select({ i: interaction, role: agentRun.agentRole })
      .from(interaction)
      .leftJoin(agentRun, eq(agentRun.id, interaction.runId))
      .where(eq(interaction.initiativeId, id))
      .orderBy(desc(interaction.createdAt));
    const mapAsks: MapAsk[] = asks.map(({ i, role }) => {
      const card = i.contextCard as { gate?: { state?: string }; release?: { state?: string } };
      return {
        id: i.id,
        type: i.type,
        checkpointId: i.checkpointId,
        state: i.state,
        title: i.title,
        roleNeeded: i.roleNeeded,
        hardStop: i.hardStop,
        decision: (i.answer as { decision?: string | null } | null)?.decision ?? null,
        runRole: role,
        gate: card.gate?.state ?? null,
        released: card.release?.state === 'released',
      };
    });
    const [planRow] = await db
      .select()
      .from(buildPlan)
      .where(eq(buildPlan.initiativeId, id))
      .orderBy(desc(buildPlan.createdAt))
      .limit(1);
    let plan: MapPlan | undefined;
    if (planRow) {
      const tasks = await db.select().from(buildTask).where(eq(buildTask.planId, planRow.id));
      plan = {
        state: planRow.state as MapPlan['state'],
        total: tasks.length,
        merged: tasks.filter((t) => t.state === 'merged' || t.state === 'skipped').length,
        failed: tasks.filter((t) => t.state === 'failed').length,
      };
    }
    return {
      initiative: {
        id: init.id,
        title: init.title,
        goal: init.goal,
        autonomyMode: init.autonomyMode,
      },
      stages: buildMap({
        runs: runs.map((r) => ({ id: r.id, agentRole: r.agentRole, state: r.state })),
        asks: mapAsks,
        plan,
      }),
    };
  });

  app.get('/api/initiatives/:id/releases', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await db
      .select()
      .from(interaction)
      .where(eq(interaction.initiativeId, id))
      .orderBy(desc(interaction.createdAt));
    return rows
      .filter((r) => r.checkpointId === 'G6')
      .map((r) => {
        const c = r.contextCard as {
          version?: string;
          tag?: string;
          notes?: string;
          release?: { state?: string; url?: string; detail?: string };
        };
        return {
          interactionId: r.id,
          version: c.version ?? '',
          tag: c.tag ?? '',
          notes: c.notes ?? '',
          state: r.state === 'open' ? 'waiting' : (c.release?.state ?? 'decided'),
          url: c.release?.url ?? null,
          detail: c.release?.detail ?? null,
          createdAt: r.createdAt.toISOString(),
        };
      });
  });

  // Releases are prepared by the people who own them. Approval is a separate person's decision on the checkpoint.
  app.post('/api/initiatives/:id/releases', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!me.roles.some((r) => ['product_owner', 'devops_release', 'platform_admin'].includes(r))) {
      return reply.code(403).send({
        error: {
          code: 'wrong_role',
          message: 'A Product Owner, DevOps, or Platform Admin prepares a release.',
        },
      });
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { version } = z.object({ version: z.string() }).parse(request.body ?? {});
    const out = await prepareRelease(db, github, {
      initiativeId: id,
      version,
      approverRole: opts.approverRole,
      by: me.id,
    });
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(201).send({ interactionId: out.interaction.id });
  });
}
