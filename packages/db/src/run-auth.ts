import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from './client.js';
import { agentRun, runToken } from './schema-work.js';
import { hashToken } from '@sdlc/core';
import type { IncomingHttpHeaders } from 'node:http';

export interface RunContext {
  runId: string;
  initiativeId: string;
  state: string;
  modelAlias: string;
  costMicros: number;
  budgetMicros: number;
  scopes: string[];
}

export function bearerFrom(headers: IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim();
  const key = headers['x-api-key'];
  return typeof key === 'string' ? key : undefined;
}

/** Looks up a run token (the caller still checks scopes). Unknown, expired, and revoked tokens are indistinguishable to the caller. */
export async function authenticateRunToken(
  db: Db,
  token: string | undefined,
): Promise<RunContext | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      runId: agentRun.id,
      initiativeId: agentRun.initiativeId,
      state: agentRun.state,
      modelAlias: agentRun.modelAlias,
      costMicros: agentRun.costMicros,
      budgetMicros: agentRun.budgetMicros,
      scopes: runToken.scopes,
    })
    .from(runToken)
    .innerJoin(agentRun, eq(runToken.runId, agentRun.id))
    .where(
      and(
        eq(runToken.tokenHash, hashToken(token)),
        isNull(runToken.revokedAt),
        gt(runToken.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

/** States in which a run may still call the model or the platform tools. */
export const CALLABLE_STATES = new Set(['queued', 'starting', 'running', 'resuming']);
