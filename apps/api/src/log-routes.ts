import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { redactDeep } from '@sdlc/core';
import { agentRun, buildTask, initiative, runEvent } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { logSchema } from '@sdlc/schemas';
import { requirePerson } from './people.js';

/**
 * The live log: what the agents are doing, as events from every run (or one initiative, or one run), newest last.
 * Anyone who holds a role may read it. The events were redacted when they were written.
 *
 * The first look (no `after`) returns the latest `limit` events. Each later look passes the id of the last event it
 * has, and gets what came after. The gid only grows, in the order events were stored, so it is the cursor across runs.
 */
export function registerLogRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/log', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (me.roles.length === 0)
      return reply.code(403).send({
        error: { code: 'wrong_role', message: 'Only a person with a role can read the log.' },
      });
    const q = z
      .object({
        after: z.coerce.number().int().min(0).optional(),
        initiativeId: z.string().uuid().optional(),
        runId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(request.query);

    const where = and(
      q.after !== undefined ? gt(runEvent.gid, q.after) : undefined,
      q.runId ? eq(runEvent.runId, q.runId) : undefined,
      q.initiativeId ? eq(agentRun.initiativeId, q.initiativeId) : undefined,
    );
    const base = db
      .select({ e: runEvent })
      .from(runEvent)
      .innerJoin(agentRun, eq(agentRun.id, runEvent.runId))
      .where(where);
    // Asking for one more than the limit says whether there is more.
    const tail = q.after !== undefined;
    const found = tail
      ? await base.orderBy(asc(runEvent.gid)).limit(q.limit + 1)
      : (await base.orderBy(desc(runEvent.gid)).limit(q.limit + 1)).reverse();
    const more = tail ? found.length > q.limit : false;
    const rows = tail ? found.slice(0, q.limit) : found.slice(-q.limit);

    const runIds = [...new Set(rows.map((r) => r.e.runId))];
    const runs = runIds.length
      ? await db
          .select({
            id: agentRun.id,
            role: agentRun.agentRole,
            state: agentRun.state,
            initiativeId: agentRun.initiativeId,
            initiativeTitle: initiative.title,
            taskKey: buildTask.key,
            taskTitle: buildTask.title,
          })
          .from(agentRun)
          .innerJoin(initiative, eq(initiative.id, agentRun.initiativeId))
          .leftJoin(buildTask, eq(buildTask.runId, agentRun.id))
          .where(inArray(agentRun.id, runIds))
      : [];
    return logSchema.parse({
      events: rows.map(({ e }) => ({
        id: e.id,
        gid: e.gid,
        runId: e.runId,
        seq: e.seq,
        ts: e.ts.toISOString(),
        type: e.type,
        // Redacted when stored, and again here, for events stored before that was done.
        payload: redactDeep(e.payload),
      })),
      runs,
      more,
    });
  });
}
