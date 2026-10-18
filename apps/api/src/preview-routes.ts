import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { interaction } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { choosePreview } from '@sdlc/core';
import { previewSchema } from '@sdlc/schemas';
import type { PreviewDto } from '@sdlc/schemas';
import { GitHubError } from './github-app.js';
import type { GitHubService } from './github-service.js';
import { requirePerson } from './people.js';

const CACHE_MS = 15_000;

/**
 * The preview of a pull request under review (mvp-contract section 16, previews). The repository's pipeline builds and
 * hosts it and reports it to GitHub. The platform only reads that report, so no agent and no platform process runs the
 * previewed code.
 */
export function registerPreviewRoutes(
  app: FastifyInstance,
  db: Db,
  github: Pick<GitHubService, 'previewCandidates'>,
  now: () => number = Date.now,
): void {
  const cache = new Map<string, { at: number; value: PreviewDto }>();

  app.get('/api/interactions/:id/preview', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await db.select().from(interaction).where(eq(interaction.id, id));
    const card = row?.contextCard as
      { kind?: string; repository?: string; prNumber?: number } | undefined;
    if (!row || card?.kind !== 'pull_request' || !card.repository || !card.prNumber) {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'That is not a pull request review.' } });
    }

    const key = `${card.repository}#${card.prNumber}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;

    try {
      const r = await github.previewCandidates(card.repository, card.prNumber);
      const value = previewSchema.parse(
        choosePreview(r.headSha, r.candidates, r.deploymentsReadable),
      );
      cache.set(key, { at: now(), value });
      return value;
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
  });
}
