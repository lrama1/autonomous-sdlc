import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { interaction, previewRun } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { choosePreview } from '@sdlc/core';
import type { PreviewCandidate } from '@sdlc/core';
import { mainPreviewSchema, previewSchema } from '@sdlc/schemas';
import type { PreviewDto } from '@sdlc/schemas';
import { GitHubError } from './github-app.js';
import type { GitHubService } from './github-service.js';
import { requirePerson } from './people.js';
import type { PreviewRow, PreviewService } from './previews.js';

const CACHE_MS = 15_000;

type Looked = Awaited<ReturnType<GitHubService['previewCandidates']>>;

const platformCandidate = (row: PreviewRow): PreviewCandidate | null => {
  const state = { starting: 'pending', ready: 'success', failed: 'failure' }[
    row.state as 'starting' | 'ready' | 'failed'
  ] as PreviewCandidate['state'] | undefined;
  if (!state) return null;
  return {
    source: 'platform',
    sha: row.headSha,
    state,
    url: row.url ?? undefined,
    label: 'Run by the platform',
    at: (row.readyAt ?? row.createdAt).toISOString(),
  };
};

/**
 * The preview of a pull request under review (mvp-contract section 16, previews). Two sources: what the repository's
 * pipeline reported to GitHub, which the platform only reads, and a preview the platform runs itself in a sandbox when
 * a reviewer asks (or in autopilot). The review pack shows whichever is newest for the current commit.
 */
export function registerPreviewRoutes(
  app: FastifyInstance,
  db: Db,
  github: Pick<GitHubService, 'previewCandidates'>,
  previews: () => PreviewService | null = () => null,
  opts: { ttlMinutes?: number } = {},
  now: () => number = Date.now,
): void {
  const cache = new Map<string, { at: number; value: Looked }>();
  const ttlMinutes = opts.ttlMinutes ?? 30;

  async function loadReview(id: string) {
    const [row] = await db.select().from(interaction).where(eq(interaction.id, id));
    const card = row?.contextCard as
      { kind?: string; repository?: string; prNumber?: number } | undefined;
    if (!row || card?.kind !== 'pull_request' || !card.repository || !card.prNumber) return null;
    return { row, repository: card.repository, prNumber: card.prNumber };
  }

  app.get('/api/interactions/:id/preview', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const review = await loadReview(id);
    if (!review) {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'That is not a pull request review.' } });
    }
    const { repository, prNumber } = review;

    const key = `${repository}#${prNumber}`;
    let looked = cache.get(key);
    if (!looked || now() - looked.at >= CACHE_MS) {
      try {
        looked = { at: now(), value: await github.previewCandidates(repository, prNumber) };
        cache.set(key, looked);
      } catch (e) {
        request.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'preview lookup failed',
        );
        return reply.code(502).send({
          error: {
            code: 'github_unavailable',
            message:
              e instanceof GitHubError
                ? 'GitHub did not answer the preview lookup.'
                : 'Could not look up the preview.',
          },
        });
      }
    }

    // What the platform runs is read fresh each time, so Start and Stop show at once.
    const svc = previews();
    const mine = svc ? await svc.forPullRequest(repository, prNumber) : null;
    const extra = mine ? platformCandidate(mine) : null;
    const r = looked.value;
    const chosen = choosePreview(
      r.headSha,
      extra ? [...r.candidates, extra] : r.candidates,
      r.deploymentsReadable,
    );
    const value: PreviewDto = previewSchema.parse({
      ...chosen,
      platform: {
        available: svc !== null,
        id: mine?.id ?? null,
        state: mine?.state ?? 'none',
        expiresAt: mine?.expiresAt?.toISOString() ?? null,
        detail: mine?.detail ?? null,
        ttlMinutes,
      },
    });
    return value;
  });

  const holdsAHat = (me: { roles: string[] }) => me.roles.length > 0;

  app.post('/api/interactions/:id/preview/start', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!holdsAHat(me))
      return reply.code(403).send({
        error: { code: 'wrong_role', message: 'Only a person with a role can start a preview.' },
      });
    const svc = previews();
    if (!svc)
      return reply.code(409).send({
        error: {
          code: 'previews_off',
          message: 'This platform is not set up to run previews (it needs the Docker runner).',
        },
      });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const out = await svc.start(id, me.id);
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(out.existing ? 200 : 202).send({ id: out.row.id, state: out.row.state });
  });

  // The same sandbox preview, of the tip of the branch the tasks merged into: the app the build produced.
  app.get('/api/initiatives/:id/preview', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const svc = previews();
    const mine = svc ? await svc.forMain(id) : null;
    const live = mine?.state === 'starting' || mine?.state === 'ready';
    return mainPreviewSchema.parse({
      available: svc !== null,
      id: mine?.id ?? null,
      state: mine?.state ?? 'none',
      url: live ? (mine?.url ?? null) : null,
      sha: mine?.headSha ?? null,
      expiresAt: mine?.expiresAt?.toISOString() ?? null,
      detail: mine?.detail ?? null,
      ttlMinutes,
    });
  });

  app.post('/api/initiatives/:id/preview/start', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!holdsAHat(me))
      return reply.code(403).send({
        error: { code: 'wrong_role', message: 'Only a person with a role can start a preview.' },
      });
    const svc = previews();
    if (!svc)
      return reply.code(409).send({
        error: {
          code: 'previews_off',
          message: 'This platform is not set up to run previews (it needs the Docker runner).',
        },
      });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const out = await svc.startMain(id, me.id);
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(out.existing ? 200 : 202).send({ id: out.row.id, state: out.row.state });
  });

  app.post('/api/previews/:id/stop', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!holdsAHat(me))
      return reply.code(403).send({
        error: { code: 'wrong_role', message: 'Only a person with a role can stop a preview.' },
      });
    const svc = previews();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await db.select().from(previewRun).where(eq(previewRun.id, id));
    if (!svc || !row)
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such preview.' } });
    const out = await svc.stop(id, 'stopped', 'Stopped by a person.');
    return { id, state: out?.state ?? row.state };
  });
}
