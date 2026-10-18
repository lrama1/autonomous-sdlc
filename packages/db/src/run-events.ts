import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { runEvent } from './schema-work.js';

/**
 * Appends one event to a run's log with the next gapless seq (mvp-contract section 7).
 * Two writers can pick the same seq. The unique (run_id, seq) constraint rejects the loser, which retries.
 */
export async function appendRunEvent(
  db: Db,
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const rows = await db
        .insert(runEvent)
        .values({
          runId,
          type,
          payload,
          seq: sql<number>`(select coalesce(max(seq), 0) + 1 from run_event where run_id = ${runId})`,
        })
        .returning({ seq: runEvent.seq });
      return rows[0]!.seq;
    } catch (e) {
      const code =
        (e as { code?: string; cause?: { code?: string } }).code ??
        (e as { cause?: { code?: string } }).cause?.code;
      if (code !== '23505') throw e;
    }
  }
  throw new Error(`could not append event to run ${runId}: too much contention`);
}
