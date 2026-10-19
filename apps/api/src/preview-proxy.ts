import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { previewRun } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { requirePerson } from './people.js';

// The signed-in door to a preview that runs on Fargate. The previewed code is unreviewed, so it is served from a
// different origin than the platform (a second CloudFront address): code on that origin cannot read the platform's
// cookies or call its API as the reviewer. The platform hands a signed-in reviewer a short-lived link; the preview
// origin trades it for a cookie that works for that one preview, and passes everything else to the preview.

/** The header CloudFront adds to say which address a request came in on. A viewer cannot set it. */
export const SURFACE_HEADER = 'x-sdlc-surface';

type Kind = 'open' | 'cookie';
interface Claim {
  k: Kind;
  id: string;
  /** The person it was issued to. */
  sub: string;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signAccess(secret: string, claim: Claim): string {
  const body = b64(JSON.stringify(claim));
  const key = createHmac('sha256', secret).update('preview-access').digest();
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}

export function verifyAccess(
  secret: string,
  token: string | undefined,
  kind: Kind,
  id: string,
  nowSec: number,
): Claim | null {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const key = createHmac('sha256', secret).update('preview-access').digest();
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claim;
    return c.k === kind && c.id === id && typeof c.sub === 'string' && c.exp > nowSec ? c : null;
  } catch {
    return null;
  }
}

export const cookieName = (id: string) => `sdlc_pv_${id.replace(/-/g, '')}`;

/** The cookies the preview's own program set, without the platform's. */
export function appCookies(header: string | undefined): string | undefined {
  const kept = (header ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith('sdlc_'));
  return kept.length ? kept.join('; ') : undefined;
}

/** A cookie the preview set is kept to the preview's own folder on this origin, and never given a domain. */
export function rewriteSetCookie(cookie: string, id: string): string {
  const parts = cookie.split(';').map((p) => p.trim());
  const out = [parts[0]!];
  let path = '/';
  for (const p of parts.slice(1)) {
    const name = p.split('=')[0]!.toLowerCase();
    if (name === 'domain') continue;
    if (name === 'path') path = p.slice(p.indexOf('=') + 1) || '/';
    else out.push(p);
  }
  out.push(`Path=/${id}${path.startsWith('/') ? path : `/${path}`}`);
  return out.join('; ');
}

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers that are the platform's or CloudFront's, not the preview's to see. */
const NOT_FORWARDED =
  /^(host|cookie|x-sdlc-|x-origin-verify|x-forwarded-|x-amz-cf-|cloudfront-|via$)/i;

const PATH = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/[^?]*)?(\?.*)?$/;

export interface PreviewProxyOptions {
  secret: string;
  /** The preview origin, such as https://dxyz.cloudfront.net. Without it nothing can be opened. */
  origin?: string;
  openTtlSec?: number;
  cookieTtlSec?: number;
  now?: () => number;
  upstreamTimeoutMs?: number;
}

export function registerPreviewProxy(
  app: FastifyInstance,
  db: Db,
  opts: PreviewProxyOptions,
): void {
  const nowSec = () => Math.floor((opts.now?.() ?? Date.now()) / 1000);

  // The platform's door: a signed-in person asks to open a running preview and is sent to the preview origin with a link.
  app.get('/api/previews/:id/open', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const id = (request.params as { id: string }).id;
    if (!opts.origin)
      return reply.code(409).send({
        error: { code: 'previews_not_reachable', message: 'This platform has no preview address.' },
      });
    const [row] = await db.select().from(previewRun).where(eq(previewRun.id, id));
    if (!row || row.state !== 'ready' || !row.target)
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'That preview is not running.' } });
    const token = signAccess(opts.secret, {
      k: 'open',
      id,
      sub: me.id,
      exp: nowSec() + (opts.openTtlSec ?? 300),
    });
    return reply.redirect(`${opts.origin}/${id}/?t=${token}`, 302);
  });

  // On the preview origin nothing but a preview is served: not the API, not the web app.
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers[SURFACE_HEADER] !== 'preview') return;
    await handle(request, reply);
    return reply;
  });

  const text = (reply: FastifyReply, status: number, message: string) =>
    reply
      .code(status)
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(message);

  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const m = PATH.exec(request.raw.url ?? '');
    if (!m) return void (await text(reply, 404, 'Not found.'));
    const [, id = '', rest, query = ''] = m;
    if (!rest) return void reply.redirect(`/${id}/${query}`, 302);

    const [row] = await db.select().from(previewRun).where(eq(previewRun.id, id));
    if (!row || row.state !== 'ready' || !row.target)
      return void (await text(reply, 404, 'This preview is not running.'));

    const cookies = Object.fromEntries(
      (request.headers.cookie ?? '').split(';').map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
      }),
    );
    const now = nowSec();
    if (!verifyAccess(opts.secret, cookies[cookieName(id)], 'cookie', id, now)) {
      const params = new URLSearchParams(query);
      const link = verifyAccess(opts.secret, params.get('t') ?? undefined, 'open', id, now);
      if (!link)
        return void (await text(
          reply,
          401,
          'Open this preview from the platform: it signs you in to it.',
        ));
      // A good link becomes a cookie for this one preview, and the link is dropped from the address.
      const maxAge = opts.cookieTtlSec ?? 8 * 3600;
      const cookie = signAccess(opts.secret, { k: 'cookie', id, sub: link.sub, exp: now + maxAge });
      params.delete('t');
      const q = params.toString();
      return void reply
        .header(
          'set-cookie',
          `${cookieName(id)}=${cookie}; Path=/${id}/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
        )
        .header('cache-control', 'no-store')
        .redirect(`/${id}${rest}${q ? `?${q}` : ''}`, 302);
    }

    proxy(request, reply, id, row.target, rest, query);
  }

  function proxy(
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    target: string,
    rest: string,
    query: string,
  ): void {
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(request.headers))
      if (!HOP.has(k) && !NOT_FORWARDED.test(k)) headers[k] = v;
    const cookie = appCookies(request.headers.cookie);
    if (cookie) headers.cookie = cookie;
    headers['x-forwarded-prefix'] = `/${id}`;
    headers['x-forwarded-proto'] = 'https';
    if (opts.origin) headers['x-forwarded-host'] = new URL(opts.origin).host;

    reply.hijack();
    const res = reply.raw;
    const url = new URL(target);
    const up = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: request.method,
        path: `${rest}${query}`,
        headers,
        timeout: opts.upstreamTimeoutMs ?? 55_000,
      },
      (back) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(back.headers)) {
          if (HOP.has(k) || v === undefined) continue;
          if (k === 'set-cookie') out[k] = (v as string[]).map((c) => rewriteSetCookie(c, id));
          else if (
            k === 'location' &&
            typeof v === 'string' &&
            v.startsWith('/') &&
            !v.startsWith('//')
          )
            out[k] = `/${id}${v}`;
          else out[k] = v;
        }
        out['referrer-policy'] = 'no-referrer';
        out['x-content-type-options'] = 'nosniff';
        res.writeHead(back.statusCode ?? 502, out);
        back.pipe(res);
      },
    );
    const fail = () => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('The preview did not answer.');
    };
    up.on('timeout', () => up.destroy());
    up.on('error', fail);
    request.raw.on('aborted', () => up.destroy());
    request.raw.pipe(up);
  }
}
