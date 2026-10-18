import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'sdlc_session';
const SESSION_TTL_S = 8 * 60 * 60;

// Stateless signed cookie: "<personId>.<expiresAtEpochSeconds>". The cookie plugin adds the signature.
// There is no server-side revocation yet. Logout clears the cookie and the TTL is short.
export function startSession(reply: FastifyReply, personId: string, secure: boolean): void {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  reply.setCookie(SESSION_COOKIE, `${personId}.${expires}`, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_S,
  });
}

export function endSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Returns the signed-in person's id, or null when there is no valid session. */
export function readSession(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const [personId, expires] = unsigned.value.split('.');
  if (!personId || !expires || Number(expires) < Date.now() / 1000) return null;
  return personId;
}
