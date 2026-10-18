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

// The people who decide the spec and the design, plus an admin, start or skip those steps. Engineers start bug fixes.
const CONTROL_ROLES = ['product_owner', 'architect', 'platform_admin'];
const BUG_ROLES = ['backend_engineer', 'frontend_engineer', 'platform_admin'];

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
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const [current] = await db.select().from(stageStart).where(eq(stageStart.id, id));
      if (!current) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'No such step.' } });
      }
      const allowed = current.stage === 'bug' ? BUG_ROLES : CONTROL_ROLES;
      if (!me.roles.some((r) => allowed.includes(r))) {
        return reply.code(403).send({
          error: {
            code: 'wrong_role',
            message:
              current.stage === 'bug'
                ? 'An engineer or a Platform Admin starts a bug fix.'
                : 'A Product Owner, an Architect or a Platform Admin starts this step.',
          },
        });
      }
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
