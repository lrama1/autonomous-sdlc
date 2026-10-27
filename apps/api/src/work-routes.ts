import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentRun, githubApp, initiative, repositoryEntry, runEvent } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { initiativeCreateSchema, repositoryCreateSchema, runCreateSchema } from '@sdlc/schemas';
import { recordActivity } from './activity.js';
import { planSpecStart } from './stages.js';
import type { LoadedAgent } from './agents.js';
import { requirePerson } from './people.js';
import { RunError, cancelRun, createRun } from './runs.js';
import type { RunRow } from './runs.js';

const id = z.object({ id: z.string().uuid() });
const notFound = (what: string) => ({ error: { code: 'not_found', message: `No such ${what}.` } });

export const repoDto = (r: typeof repositoryEntry.$inferSelect) => ({
  id: r.id,
  fullName: r.fullName,
  access: r.access,
  writeMode: r.writeMode,
  integrationBranch: r.integrationBranch,
  protectedPaths: r.protectedPaths,
  modelPolicy: r.modelPolicy,
  verifyCommand: r.verifyCommand,
  requiredCheck: r.requiredCheck,
});

const initiativeDto = (i: typeof initiative.$inferSelect) => ({
  id: i.id,
  title: i.title,
  goal: i.goal,
  repositoryId: i.repositoryId,
  autonomyMode: i.autonomyMode,
  autoStages: i.autoStages,
  referenceLinks: i.referenceLinks,
  state: i.state,
  budgetUsd: i.budgetMicros === null ? null : i.budgetMicros / 1_000_000,
  createdAt: i.createdAt.toISOString(),
});

export const runDto = (r: RunRow) => ({
  id: r.id,
  initiativeId: r.initiativeId,
  role: r.agentRole,
  task: r.task,
  state: r.state,
  engine: r.engine,
  modelAlias: r.modelAlias,
  definition: `${r.agentDefinitionId}@${r.agentDefinitionVersion}`,
  sponsorPersonId: r.sponsorPersonId,
  branch: r.branch,
  prNumber: r.prNumber,
  parkReason: r.parkReason,
  budgetUsd: r.budgetMicros / 1_000_000,
  costUsd: r.costMicros / 1_000_000,
  exitReason: r.exitReason,
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

export function registerWorkRoutes(
  app: FastifyInstance,
  db: Db,
  agents: Map<string, LoadedAgent>,
  /** Asks GitHub which repositories the Apps can see now. Called once when a repository seems not to be installed. */
  refreshApps: () => Promise<void> = async () => {},
  /** Whether the repository's integration branch exists. `unknown` when GitHub cannot be asked, which never blocks the work. */
  branchState: (repo: {
    fullName: string;
    integrationBranch: string;
  }) => Promise<'exists' | 'missing' | 'unknown'> = async () => 'unknown',
): void {
  // ---- Repository Registry (spec 6.5) ----
  app.get('/api/repositories', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    return (await db.select().from(repositoryEntry).orderBy(asc(repositoryEntry.fullName))).map(
      repoDto,
    );
  });

  app.post('/api/repositories', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!me.roles.includes('platform_admin')) {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'Only a Platform Admin edits the registry.' },
      });
    }
    const body = repositoryCreateSchema.parse(request.body ?? {});

    // Both Apps must be installed on the repository before agents may use it (spec 6.6). A repository a person added to
    // an installation a moment ago is not known here yet, so look again before saying no.
    let apps = await db.select().from(githubApp);
    if (apps.some((a) => a.installationId && !a.installedOn.includes(body.fullName))) {
      await refreshApps().catch((e) =>
        request.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'refresh failed'),
      );
      apps = await db.select().from(githubApp);
    }
    for (const kind of ['agent', 'gate']) {
      const a = apps.find((x) => x.kind === kind);
      if (!a || !a.installationId) {
        return reply.code(409).send({
          error: {
            code: 'github_not_ready',
            message: `The ${kind} GitHub App is not registered and installed yet (see /admin/github).`,
          },
        });
      }
      if (!a.installedOn.includes(body.fullName)) {
        return reply.code(409).send({
          error: {
            code: 'not_installed',
            message: `The ${kind} GitHub App is not installed on ${body.fullName}.`,
          },
        });
      }
    }

    const [existing] = await db
      .select()
      .from(repositoryEntry)
      .where(eq(repositoryEntry.fullName, body.fullName));
    if (existing)
      return reply.code(409).send({
        error: { code: 'exists', message: `${body.fullName} is already in the registry.` },
      });
    const [row] = await db.insert(repositoryEntry).values(body).returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'registry.added',
      detail: { fullName: body.fullName, writeMode: body.writeMode },
    });
    return reply.code(201).send(repoDto(row!));
  });

  // ---- Initiatives ----
  app.get('/api/initiatives', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    return (await db.select().from(initiative).orderBy(desc(initiative.createdAt))).map(
      initiativeDto,
    );
  });

  app.post('/api/initiatives', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const body = initiativeCreateSchema.parse(request.body ?? {});
    const [repo] = await db
      .select()
      .from(repositoryEntry)
      .where(eq(repositoryEntry.id, body.repositoryId));
    if (!repo)
      return reply.code(400).send({
        error: { code: 'unknown_repository', message: 'Choose a repository from the registry.' },
      });
    // An empty repository has no branch for the agents to start from. Say so now, instead of failing in the runner.
    if ((await branchState(repo)) === 'missing')
      return reply.code(409).send({
        error: {
          code: 'branch_missing',
          message: `${repo.fullName} has no "${repo.integrationBranch}" branch yet, so agents have nothing to start from. A Platform Admin can see what is missing on the Repositories page (Check readiness), and for an empty repository create the first commit there.`,
        },
      });
    const [row] = await db
      .insert(initiative)
      .values({
        title: body.title,
        goal: body.goal,
        repositoryId: repo.id,
        autonomyMode: body.autonomyMode,
        autoStages: body.autoStages,
        referenceLinks: [...new Set(body.referenceLinks)],
        createdBy: me.id,
        budgetMicros: body.budgetUsd === undefined ? null : Math.round(body.budgetUsd * 1_000_000),
      })
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      initiativeId: row!.id,
      action: 'initiative.created',
      detail: { title: body.title, repository: repo.fullName },
    });
    await planSpecStart(db, agents, row!, me.id);
    return reply.code(201).send(initiativeDto(row!));
  });

  app.get('/api/initiatives/:id', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    const { id: initId } = id.parse(request.params);
    const [row] = await db.select().from(initiative).where(eq(initiative.id, initId));
    if (!row) return reply.code(404).send(notFound('initiative'));
    const runs = await db
      .select()
      .from(agentRun)
      .where(eq(agentRun.initiativeId, initId))
      .orderBy(desc(agentRun.createdAt));
    return { ...initiativeDto(row), runs: runs.map(runDto) };
  });

  // ---- Runs ----
  app.post('/api/initiatives/:id/runs', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id: initId } = id.parse(request.params);
    const body = runCreateSchema.parse(request.body ?? {});
    try {
      const run = await createRun(db, agents, {
        initiativeId: initId,
        role: body.role,
        task: body.task,
        sponsorPersonId: me.id,
        budgetUsd: body.budgetUsd,
      });
      return reply.code(201).send(runDto(run));
    } catch (e) {
      if (e instanceof RunError) {
        const status =
          e.code === 'not_found' ? 404 : e.code === 'initiative_not_active' ? 409 : 400;
        return reply.code(status).send({ error: { code: e.code, message: e.message } });
      }
      throw e;
    }
  });

  app.get('/api/runs/:id', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    const { id: runId } = id.parse(request.params);
    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, runId));
    if (!row) return reply.code(404).send(notFound('run'));
    return runDto(row);
  });

  app.get('/api/runs/:id/events', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    const { id: runId } = id.parse(request.params);
    const q = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(request.query);
    const rows = await db
      .select()
      .from(runEvent)
      .where(and(eq(runEvent.runId, runId), gt(runEvent.seq, q.after)))
      .orderBy(asc(runEvent.seq))
      .limit(q.limit);
    return rows.map((e) => ({
      seq: e.seq,
      ts: e.ts.toISOString(),
      type: e.type,
      payload: e.payload,
    }));
  });

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id: runId } = id.parse(request.params);
    const [exists] = await db
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(eq(agentRun.id, runId));
    if (!exists) return reply.code(404).send(notFound('run'));
    const run = await cancelRun(db, runId, me.id);
    if (!run)
      return reply
        .code(409)
        .send({ error: { code: 'already_finished', message: 'This run has already finished.' } });
    return runDto(run);
  });
}
