import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { githubApp, initiative, repositoryEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { repositoryUpdateSchema } from '@sdlc/schemas';
import { recordActivity } from './activity.js';
import { requirePerson } from './people.js';
import type { Signed } from './people.js';
import { checkReadiness, firstCommitFor } from './repo-readiness.js';
import type { RepoReader } from './repo-readiness.js';

const id = z.object({ id: z.string().uuid() });
const refreshFlag = z.object({ refresh: z.enum(['0', '1']).optional() });

/** Managing the registry from the platform's own pages. Adding a repository is in work-routes. */
export function registerRegistryRoutes(
  app: FastifyInstance,
  db: Db,
  deps: {
    /** Asks GitHub which repositories the Apps can see now. */
    refreshApps: () => Promise<void>;
    github: RepoReader & {
      createFirstCommit(
        repo: string,
        f: { branch: string; path: string; content: string; message: string },
      ): Promise<{ sha: string }>;
    };
    dto: (r: typeof repositoryEntry.$inferSelect) => unknown;
  },
): void {
  async function admin(request: FastifyRequest, reply: FastifyReply): Promise<Signed | null> {
    const me = await requirePerson(db, request, reply);
    if (!me) return null;
    if (!me.roles.includes('platform_admin')) {
      await reply.code(403).send({
        error: { code: 'forbidden', message: 'Only a Platform Admin edits the registry.' },
      });
      return null;
    }
    return me;
  }

  async function refreshIfAsked(request: FastifyRequest, wanted: boolean): Promise<void> {
    if (!wanted) return;
    await deps
      .refreshApps()
      .catch((e) =>
        request.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'refresh failed'),
      );
  }

  // The repositories both Apps are installed on that nobody has registered yet: what a person can pick from.
  app.get('/api/repositories/available', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    await refreshIfAsked(request, refreshFlag.parse(request.query ?? {}).refresh === '1');
    const apps = await db.select().from(githubApp);
    const agent = apps.find((a) => a.kind === 'agent');
    const gate = apps.find((a) => a.kind === 'gate');
    if (!agent?.installationId || !gate?.installationId) {
      return {
        problem:
          'Both GitHub Apps must be created and installed first. Open GitHub setup and finish it.',
        available: [],
      };
    }
    const taken = new Set(
      (await db.select({ n: repositoryEntry.fullName }).from(repositoryEntry)).map((r) => r.n),
    );
    return {
      problem: null,
      available: agent.installedOn
        .filter((n) => gate.installedOn.includes(n) && !taken.has(n))
        .sort(),
    };
  });

  app.patch('/api/repositories/:id', async (request, reply) => {
    const me = await admin(request, reply);
    if (!me) return;
    const { id: repoId } = id.parse(request.params);
    const body = repositoryUpdateSchema.parse(request.body ?? {});
    const [before] = await db.select().from(repositoryEntry).where(eq(repositoryEntry.id, repoId));
    if (!before)
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such repository.' } });
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const [row] = await db
      .update(repositoryEntry)
      .set(changes)
      .where(eq(repositoryEntry.id, repoId))
      .returning();
    const was: Record<string, unknown> = {};
    for (const k of Object.keys(changes))
      was[k] = (before as unknown as Record<string, unknown>)[k];
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'registry.updated',
      detail: { fullName: before.fullName, changed: changes, was },
    });
    return deps.dto(row!);
  });

  // A repository with work on it stays: its history belongs to the people who approved that work.
  app.delete('/api/repositories/:id', async (request, reply) => {
    const me = await admin(request, reply);
    if (!me) return;
    const { id: repoId } = id.parse(request.params);
    const [repo] = await db.select().from(repositoryEntry).where(eq(repositoryEntry.id, repoId));
    if (!repo)
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such repository.' } });
    const [used] = await db
      .select({ id: initiative.id })
      .from(initiative)
      .where(eq(initiative.repositoryId, repoId))
      .limit(1);
    if (used)
      return reply.code(409).send({
        error: {
          code: 'in_use',
          message: `${repo.fullName} has initiatives, so it stays in the registry to keep their history.`,
        },
      });
    await db.delete(repositoryEntry).where(eq(repositoryEntry.id, repoId));
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'registry.removed',
      detail: { fullName: repo.fullName },
    });
    return reply.code(204).send();
  });

  // An empty repository has no branch for agents to start from. With a person's click, the Agent App makes the first commit.
  app.post('/api/repositories/:id/first-commit', async (request, reply) => {
    const me = await admin(request, reply);
    if (!me) return;
    const { id: repoId } = id.parse(request.params);
    const [repo] = await db.select().from(repositoryEntry).where(eq(repositoryEntry.id, repoId));
    if (!repo)
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such repository.' } });
    try {
      if (!(await deps.github.isEmpty(repo.fullName)))
        return reply.code(409).send({
          error: {
            code: 'not_empty',
            message: `${repo.fullName} already has commits, so the platform leaves it alone.`,
          },
        });
      const file = firstCommitFor(repo.fullName);
      const { sha } = await deps.github.createFirstCommit(repo.fullName, {
        branch: repo.integrationBranch,
        path: file.path,
        content: file.content,
        message: file.message,
      });
      await recordActivity(db, {
        actorType: 'person',
        actorId: me.id,
        action: 'registry.first_commit',
        detail: { fullName: repo.fullName, branch: repo.integrationBranch, sha, path: file.path },
      });
      return reply.code(201).send({ sha, branch: repo.integrationBranch, path: file.path });
    } catch (e) {
      return reply.code(502).send({
        error: {
          code: 'github_failed',
          message: `GitHub did not accept the first commit: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
    }
  });

  app.get('/api/repositories/:id/readiness', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const { id: repoId } = id.parse(request.params);
    await refreshIfAsked(request, refreshFlag.parse(request.query ?? {}).refresh === '1');
    const [repo] = await db.select().from(repositoryEntry).where(eq(repositoryEntry.id, repoId));
    if (!repo)
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such repository.' } });
    const apps = await db.select().from(githubApp);
    return { checks: await checkReadiness(repo, apps, deps.github) };
  });
}
