import { createHash, randomBytes } from 'node:crypto';

/** A random bearer token. Only its hash is stored. */
export function generateToken(prefix = 'sdlc'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
