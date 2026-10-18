import { activityEvent } from '@sdlc/db';
import type { Db } from '@sdlc/db';

export interface ActivityInput {
  actorType: 'person' | 'agent' | 'system';
  actorId?: string | null;
  initiativeId?: string | null;
  runId?: string | null;
  interactionId?: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

/** Append one row to the activity log (spec section 10.6). */
export async function recordActivity(db: Db, input: ActivityInput): Promise<void> {
  await db.insert(activityEvent).values({
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    initiativeId: input.initiativeId ?? null,
    runId: input.runId ?? null,
    interactionId: input.interactionId ?? null,
    action: input.action,
    detail: input.detail ?? {},
  });
}
