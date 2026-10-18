import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hat, person } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { roleSchema } from '@sdlc/schemas';
import type { Role } from '@sdlc/schemas';
import { readSession } from './session.js';

export interface Signed {
  id: string;
  displayName: string;
  email: string;
  roles: Role[];
}

/** The signed-in person with their hats, or null. */
export async function currentPerson(db: Db, request: FastifyRequest): Promise<Signed | null> {
  const personId = readSession(request);
  if (!personId) return null;
  const [p] = await db.select().from(person).where(eq(person.id, personId));
  if (!p || !p.active) return null;
  const hats = await db.select({ role: hat.role }).from(hat).where(eq(hat.personId, p.id));
  return {
    id: p.id,
    displayName: p.displayName,
    email: p.email,
    roles: hats.map((h) => roleSchema.parse(h.role)),
  };
}

/** Sends 401 and returns null when nobody is signed in. */
export async function requirePerson(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Signed | null> {
  const who = await currentPerson(db, request);
  if (!who) {
    await reply
      .code(401)
      .send({ error: { code: 'unauthenticated', message: 'Sign in required.' } });
    return null;
  }
  return who;
}
