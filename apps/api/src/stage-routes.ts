import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stageStart } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { stageStartSchema } from '@sdlc/schemas';
import type { StageStartDto } from '@sdlc/schemas';
import { requirePerson } from './people.js';
import { skipStage, startStage } from './stages.js';
import type { StageStartRow } from './stages.js';

// The people who decide the spec and the design, plus an admin, start or skip a step.
const CONTROL_ROLES = ['product_owner', 'architect', 'platform_admin'];

export const stageDto = (s: StageStartRow): StageStartDto =>
  stageStartSchema.parse({
    id: s.id,
    initiativeId: s.initiativeId,
    stage: s.stage,
    state: s.state,
    detail: s.detail,
    runId: s.runId,
    title: s.task.split('\n')[0],
    createdAt: s.createdAt.toISOString(),
  });

export function registerStageRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/initiatives/:id/stages', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await db
      .select()
      .from(stageStart)
      .where(eq(stageStart.initiativeId, id))
      .orderBy(asc(stageStart.createdAt));
    return rows.map(stageDto);
  });

  for (const verb of ['start', 'skip'] as const) {
    app.post(`/api/stages/:id/${verb}`, async (request, reply) => {
      const me = await requirePerson(db, request, reply);
      if (!me) return;
      if (!me.roles.some((r) => CONTROL_ROLES.includes(r))) {
        return reply.code(403).send({
          error: {
            code: 'wrong_role',
            message: 'A Product Owner, an Architect or a Platform Admin starts these steps.',
          },
        });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const row = await (verb === 'start' ? startStage : skipStage)(db, id, me.id);
      if (!row) {
        return reply.code(409).send({
          error: {
            code: 'wrong_state',
            message:
              verb === 'start'
                ? 'That step is not waiting to be started.'
                : 'That step has already started or was dropped.',
          },
        });
      }
      return stageDto(row);
    });
  }
}
