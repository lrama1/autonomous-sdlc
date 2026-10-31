import { redactDeep } from '@sdlc/core';
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
          // The log is shown to anyone with a role, so secrets a tool printed are taken out before they are kept.
          payload: redactDeep(payload),
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

// What fills the log: the steps of an agent. The rest (a run started, finished, parked, its summary) is kept, because
// the platform reads it to decide things.
const STEP_TYPES = ['message', 'tool.call', 'tool.result', 'file.changed', 'progress'];

/** Deletes the steps of runs that ended more than `days` ago. Returns how many rows went. */
export async function pruneRunSteps(db: Db, days: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const list = sql.join(
    STEP_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  const res = await db.execute(sql`
    delete from run_event
    where ts < ${cutoff}
      and type in (${list})
      and run_id in (
        select id from agent_run
        where state in ('succeeded', 'failed', 'cancelled', 'budget_exceeded', 'timed_out')
      )`);
  return res.rowCount ?? 0;
}
