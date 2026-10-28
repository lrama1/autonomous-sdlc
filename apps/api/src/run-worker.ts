import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import { agentRun, appendRunEvent, interaction, runEvent } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { recordActivity } from './activity.js';
import type { Launched, RunnerAdapter } from './launcher.js';
import { TERMINAL_STATES, issueRunToken, revokeRunTokens } from './runs.js';

const LIVE = ['starting', 'running', 'resuming'];
const STOP_PROCESS = ['cancelled', 'budget_exceeded', 'timed_out'];

export interface RunWorkerOptions {
  db: Db;
  adapter: RunnerAdapter;
  apiUrl: string;
  maxConcurrent: number;
  /** How long a run's token lives. Covers the run, not the human wait: a parked run gets a fresh one on resume. */
  tokenTtlMs?: number;
  log?: (line: string) => void;
  /**
   * How long a live run may be silent, with no runner of this process behind it, before it is treated as lost. A run's own
   * runner reports every few seconds while it works. Default 10 minutes.
   */
  staleMs?: number;
}

/** Starts queued runs, resumes parked runs whose question was settled, and cleans up after runners that die. */
export function createRunWorker(opts: RunWorkerOptions) {
  const { db, adapter, apiUrl, maxConcurrent } = opts;
  const ttl = opts.tokenTtlMs ?? 2 * 3600_000;
  const log = opts.log ?? ((l) => console.log(l));
  const children = new Map<string, Launched>();
  const staleMs = opts.staleMs ?? 10 * 60_000;
  let lastSweep = 0;
  let closing = false;

  /**
   * A runner ended, or an earlier API process left a run live. If a person is being asked, park the run on that
   * question so it resumes on the answer, in the same checkout and session. Otherwise close it, so nothing waits
   * forever. Does nothing to a run whose runner already reported its end.
   */
  async function handleLost(run: { id: string }, code: number | null): Promise<void> {
    const waitingOn = await db
      .select({ id: interaction.id })
      .from(interaction)
      .where(
        and(
          eq(interaction.state, 'open'),
          sql`${interaction.blocks} @> ${JSON.stringify([{ runId: run.id }])}::jsonb`,
        ),
      )
      .orderBy(asc(interaction.createdAt))
      .limit(1);
    if (waitingOn[0]) {
      const parked = await db
        .update(agentRun)
        .set({ state: 'parked', parkReason: waitingOn[0].id })
        .where(and(eq(agentRun.id, run.id), inArray(agentRun.state, LIVE)))
        .returning({ id: agentRun.id });
      if (parked.length > 0) {
        await appendRunEvent(db, run.id, 'run.parked', {
          interactionId: waitingOn[0].id,
          cause: 'runner_lost',
        });
        log(
          `[worker] runner for ${run.id} was lost while waiting for a person; parked on ${waitingOn[0].id}`,
        );
        return;
      }
    }
    const failed = await db
      .update(agentRun)
      .set({ state: 'failed', exitReason: 'error', finishedAt: new Date() })
      .where(and(eq(agentRun.id, run.id), inArray(agentRun.state, LIVE)))
      .returning({ initiativeId: agentRun.initiativeId });
    if (failed.length > 0) {
      await revokeRunTokens(db, run.id);
      await appendRunEvent(db, run.id, 'run.finished', {
        exitReason: 'error',
        detail: `runner exited with code ${code}`,
      });
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: failed[0]!.initiativeId,
        runId: run.id,
        action: 'run.failed',
        detail: { runnerExitCode: code },
      });
      log(`[worker] runner for ${run.id} ended unexpectedly (code ${code})`);
    }
  }

  /** A run that can never resume no longer needs its checkout. */
  async function releaseIfOver(runId: string): Promise<void> {
    if (!adapter.release) return;
    const [r] = await db
      .select({ state: agentRun.state })
      .from(agentRun)
      .where(eq(agentRun.id, runId));
    if (r && (TERMINAL_STATES as readonly string[]).includes(r.state)) {
      await adapter
        .release(runId)
        .catch((e) => log(`[worker] could not release ${runId}: ${String(e)}`));
    }
  }

  async function start(
    run: { id: string; modelAlias: string },
    mode: 'start' | 'resume',
  ): Promise<void> {
    try {
      const token = await issueRunToken(db, run, { ttlMs: ttl });
      const launched = await adapter.launch({ runId: run.id, token, apiUrl });
      children.set(run.id, launched);
      log(`[worker] ${mode} run ${run.id}`);
      void launched.done.then(async ({ code }) => {
        // A runner that stopped after the run was answered and started again is not this run's runner any more.
        if (children.get(run.id) !== launched) return;
        children.delete(run.id);
        await handleLost(run, code);
        await releaseIfOver(run.id);
      });
    } catch (e) {
      log(`[worker] could not launch ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
      await db
        .update(agentRun)
        .set({ state: 'failed', exitReason: 'error', finishedAt: new Date() })
        .where(eq(agentRun.id, run.id));
      await appendRunEvent(db, run.id, 'run.finished', {
        exitReason: 'error',
        detail: 'could not launch the runner',
      });
      await releaseIfOver(run.id);
    }
  }

  /**
   * Runs at start-up. An earlier API process may have died with runs live. Their sandboxes are removed, and each run
   * is parked on its open question or failed. Nothing is running yet, so every live run is a leftover.
   */
  async function recover(): Promise<void> {
    await adapter.reconcile?.();
    const live = await db
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(inArray(agentRun.state, LIVE));
    for (const run of live) {
      if (!children.has(run.id)) await handleLost(run, null);
    }
  }

  /**
   * A live run that no runner of this process is behind, and that has been silent for a long time, is lost: its runner was
   * stopped (a deploy that restarted the API takes the runners it started with it) or died without telling anyone. Close
   * it, so a person sees it failed and can run it again, instead of "in progress" forever. A run another API process is
   * running keeps reporting, so it is left alone.
   */
  async function sweepLost(): Promise<void> {
    const live = await db
      .select({ id: agentRun.id, updatedAt: agentRun.updatedAt })
      .from(agentRun)
      .where(inArray(agentRun.state, LIVE));
    for (const run of live) {
      if (children.has(run.id)) continue;
      const [last] = await db
        .select({ at: max(runEvent.ts) })
        .from(runEvent)
        .where(eq(runEvent.runId, run.id));
      const quietSince = Math.max(
        run.updatedAt.getTime(),
        last?.at ? new Date(last.at).getTime() : 0,
      );
      if (Date.now() - quietSince < staleMs) continue;
      log(
        `[worker] run ${run.id} has been silent for over ${Math.round(staleMs / 60_000)} min with no runner; closing it`,
      );
      await handleLost(run, null);
    }
  }

  async function tick(): Promise<void> {
    if (closing) return;
    if (Date.now() - lastSweep >= 30_000) {
      lastSweep = Date.now();
      await sweepLost();
    }
    // Stop processes whose run was cancelled or ran out of budget.
    for (const [runId, child] of children) {
      const [r] = await db
        .select({ state: agentRun.state })
        .from(agentRun)
        .where(eq(agentRun.id, runId));
      if (r && STOP_PROCESS.includes(r.state)) child.kill();
    }

    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRun)
      .where(inArray(agentRun.state, LIVE))) as [{ n: number }];
    let free = maxConcurrent - n;
    if (free <= 0) return;

    // Parked runs whose interaction is no longer open come first: a person is waiting for them to continue.
    const ready = await db
      .select({ id: agentRun.id, modelAlias: agentRun.modelAlias })
      .from(agentRun)
      .innerJoin(interaction, eq(interaction.id, sql`${agentRun.parkReason}::uuid`))
      .where(and(eq(agentRun.state, 'parked'), sql`${interaction.state} <> 'open'`))
      .orderBy(asc(agentRun.updatedAt))
      .limit(free);
    for (const r of ready) {
      const claimed = await db
        .update(agentRun)
        .set({ state: 'resuming' })
        .where(and(eq(agentRun.id, r.id), eq(agentRun.state, 'parked')))
        .returning({ id: agentRun.id });
      if (claimed.length === 0) continue;
      free--;
      await start(r, 'resume');
    }

    if (free <= 0) return;
    const queued = await db
      .select({ id: agentRun.id, modelAlias: agentRun.modelAlias })
      .from(agentRun)
      .where(eq(agentRun.state, 'queued'))
      .orderBy(asc(agentRun.createdAt))
      .limit(free);
    for (const r of queued) {
      const claimed = await db
        .update(agentRun)
        .set({ state: 'starting' })
        .where(and(eq(agentRun.id, r.id), eq(agentRun.state, 'queued')))
        .returning({ id: agentRun.id });
      if (claimed.length === 0) continue;
      await start(r, 'start');
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  return {
    tick,
    recover,
    start() {
      busy = true;
      recover()
        .catch((e) =>
          log(`[worker] recovery failed: ${e instanceof Error ? e.message : String(e)}`),
        )
        .finally(() => {
          busy = false;
          timer = setInterval(() => {
            if (busy) return;
            busy = true;
            tick()
              .catch((e) =>
                log(`[worker] tick failed: ${e instanceof Error ? e.message : String(e)}`),
              )
              .finally(() => {
                busy = false;
              });
          }, 1000);
        });
    },
    stop() {
      clearInterval(timer);
      for (const c of children.values()) c.kill();
    },
    /**
     * The API is going away (a deploy, a restart). Stop taking work, stop the runners this process started, and close their
     * runs, so nothing is left live with no runner behind it. A run waiting on a person is parked and resumes on the answer.
     */
    async shutdown() {
      closing = true;
      clearInterval(timer);
      const mine = [...children.entries()];
      for (const [, c] of mine) c.kill();
      for (const [id] of mine) await handleLost({ id }, null).catch(() => {});
    },
    running: () => [...children.keys()],
  };
}
