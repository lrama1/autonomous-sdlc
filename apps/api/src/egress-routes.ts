import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@sdlc/db';
import { confirmedHosts } from './integrations.js';

/** True when two strings are equal, in time that does not depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The hosts agents may reach, for the egress proxy to read (Fargate: the proxy is a separate service, so it cannot see
 * the Integration Register). The fixed list from configuration plus every confirmed entry's hosts, the same list the
 * Docker runner builds. Guarded by a shared secret that only the proxy holds; off when none is configured.
 */
export function registerEgressRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { token: string | undefined; fixed: string },
): void {
  app.get('/api/internal/egress-allow', async (request, reply) => {
    if (!opts.token)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    const given = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
    if (!sameSecret(given, opts.token))
      return reply
        .code(401)
        .send({ error: { code: 'unauthenticated', message: 'A valid token is required.' } });
    const fixed = opts.fixed
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return { hosts: [...new Set([...fixed, ...(await confirmedHosts(db))])].sort() };
  });
}
