import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentRun, bugReport, initiative, person, stageStart } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { bugCreateSchema, bugSchema } from '@sdlc/schemas';
import type { BugDto } from '@sdlc/schemas';
import type { LoadedAgent } from './agents.js';
import { requirePerson } from './people.js';
import { reportBug } from './stages.js';

async function bugDtos(db: Db, where?: ReturnType<typeof eq>): Promise<BugDto[]> {
  const rows = await db
    .select({
      bug: bugReport,
      initiativeTitle: initiative.title,
      reporter: person.displayName,
      step: stageStart,
      run: agentRun,
    })
    .from(bugReport)
    .innerJoin(initiative, eq(initiative.id, bugReport.initiativeId))
    .innerJoin(person, eq(person.id, bugReport.reportedBy))
    .leftJoin(stageStart, eq(stageStart.id, bugReport.stageStartId))
    .leftJoin(agentRun, eq(agentRun.id, stageStart.runId))
    .where(where)
    .orderBy(desc(bugReport.createdAt))
    .limit(200);
  return rows.map(({ bug, initiativeTitle, reporter, step, run }) =>
    bugSchema.parse({
      id: bug.id,
      initiativeId: bug.initiativeId,
      initiativeTitle,
      title: bug.title,
      description: bug.description,
      steps: bug.steps,
      severity: bug.severity,
      reportedBy: reporter,
      state: bug.state,
      detail: bug.detail,
      runId: run?.id ?? null,
      prNumber: run?.prNumber ?? null,
      stageStartId: step?.id ?? null,
      stageState: step?.state ?? null,
      createdAt: bug.createdAt.toISOString(),
    }),
  );
}

export function registerBugRoutes(
  app: FastifyInstance,
  db: Db,
  agents: Map<string, LoadedAgent>,
): void {
  app.get('/api/bugs', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    const q = z.object({ initiativeId: z.string().uuid().optional() }).parse(request.query);
    return bugDtos(db, q.initiativeId ? eq(bugReport.initiativeId, q.initiativeId) : undefined);
  });

  // Anyone signed in can report a bug.
  app.post('/api/initiatives/:id/bugs', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = bugCreateSchema.parse(request.body ?? {});
    const [init] = await db.select().from(initiative).where(eq(initiative.id, id));
    if (!init) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such initiative.' } });
    }
    if (init.state === 'done' || init.state === 'cancelled') {
      return reply.code(409).send({
        error: {
          code: 'initiative_not_active',
          message: `The initiative is ${init.state}. Report the bug against an active one.`,
        },
      });
    }
    const bug = await reportBug(db, agents, init, me, body);
    const [dto] = await bugDtos(db, eq(bugReport.id, bug.id));
    return reply.code(201).send(dto);
  });
}
