import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { initiative, interaction } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import type { Role } from '@sdlc/core';
import { z } from 'zod';
import { loadStages } from './map-data.js';
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
    return {
      initiative: {
        id: init.id,
        title: init.title,
        goal: init.goal,
        referenceLinks: init.referenceLinks,
        autonomyMode: init.autonomyMode,
        kind: init.kind,
      },
      stages: (await loadStages(db, init)).stages,
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
