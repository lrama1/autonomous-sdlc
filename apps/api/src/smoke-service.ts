import { and, desc, eq } from 'drizzle-orm';
import { interaction, smokeRun } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { parsePreviewConfig, PREVIEW_CONFIG_PATH } from '@sdlc/core';
import type { SmokeCheck } from '@sdlc/core';
import { recordActivity } from './activity.js';
import type { PreviewHost } from './docker-preview.js';
import type { GitHubService } from './github-service.js';
import type { PreviewService } from './previews.js';
import { runSmoke } from './smoke.js';
import type { SmokeResult } from './smoke.js';

type SmokeGitHub = Pick<GitHubService, 'getPullRequest' | 'readFile'>;
export type SmokeRow = typeof smokeRun.$inferSelect;

export type SmokeStartResult =
  | { ok: true; row: SmokeRow; existing: boolean }
  | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): SmokeStartResult => ({
  ok: false,
  status,
  code,
  message,
});

/**
 * Runs the smoke checks a repository lists in .sdlc/preview.yaml against one pull request's code, at one commit
 * (mvp-contract section 16, smoke test). It uses the same sandbox as a preview: if a preview of that commit is already
 * running it checks that one and leaves it running, and otherwise it starts one and removes it as soon as the checks
 * are done. A result belongs to a commit, so a new commit starts again.
 */
export class SmokeService {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      db: Db;
      github: SmokeGitHub;
      previews: Pick<PreviewService, 'start' | 'stop' | 'get'>;
      host: Pick<PreviewHost, 'exec'>;
      /** How long to wait for the preview to be ready, install included. */
      readyTimeoutMs?: number;
      pollMs?: number;
      getTimeoutMs?: number;
      runTimeoutMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  /** Waits for runs in progress. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /** The newest result for this pull request, whatever commit it was for. */
  async forPullRequest(repository: string, prNumber: number): Promise<SmokeRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(smokeRun)
      .where(and(eq(smokeRun.repository, repository), eq(smokeRun.prNumber, prNumber)))
      .orderBy(desc(smokeRun.createdAt))
      .limit(1);
    return row ?? null;
  }

  async start(interactionId: string, by: string | null): Promise<SmokeStartResult> {
    const { db, github } = this.deps;
    const [review] = await db.select().from(interaction).where(eq(interaction.id, interactionId));
    const card = review?.contextCard as
      { kind?: string; repository?: string; prNumber?: number } | undefined;
    if (!review || card?.kind !== 'pull_request' || !card.repository || !card.prNumber)
      return fail(404, 'not_found', 'That is not a pull request review.');
    if (review.state !== 'open')
      return fail(
        409,
        'review_decided',
        'That review has been decided, so there is nothing to test.',
      );
    const { repository, prNumber } = card;

    const pr = await github.getPullRequest(repository, prNumber);
    if (pr.state !== 'open')
      return fail(409, 'pull_request_closed', 'That pull request is no longer open.');

    const text = await github.readFile(repository, PREVIEW_CONFIG_PATH, pr.head.sha);
    if (text === null)
      return fail(
        422,
        'no_config',
        `This repository has no ${PREVIEW_CONFIG_PATH}, so there is nothing to run or check.`,
      );
    const parsed = parsePreviewConfig(text);
    if (!parsed.ok)
      return fail(422, 'bad_config', `${PREVIEW_CONFIG_PATH}: ${parsed.errors.join('; ')}`);
    if (parsed.config.smoke.length === 0)
      return fail(
        422,
        'no_smoke_checks',
        `${PREVIEW_CONFIG_PATH} has no smoke: checks. Add a list of get: and run: checks.`,
      );

    const [again] = await db
      .select()
      .from(smokeRun)
      .where(
        and(
          eq(smokeRun.repository, repository),
          eq(smokeRun.prNumber, prNumber),
          eq(smokeRun.headSha, pr.head.sha),
          eq(smokeRun.state, 'running'),
        ),
      );
    if (again) return { ok: true, row: again, existing: true };

    const [row] = await db
      .insert(smokeRun)
      .values({
        interactionId: review.id,
        initiativeId: review.initiativeId,
        repository,
        prNumber,
        headSha: pr.head.sha,
        startedBy: by,
        detail: 'Starting the preview.',
      })
      .returning();
    await recordActivity(db, {
      actorType: by ? 'person' : 'system',
      actorId: by ?? undefined,
      initiativeId: review.initiativeId,
      interactionId: review.id,
      action: 'smoke.started',
      detail: { repository, prNumber, sha: pr.head.sha, checks: parsed.config.smoke.length },
    });
    const job = this.execute(row!, parsed.config.smoke, interactionId, by).finally(() =>
      this.running.delete(job),
    );
    this.running.add(job);
    return { ok: true, row: row!, existing: false };
  }

  private async finish(
    row: SmokeRow,
    state: 'passed' | 'failed' | 'error',
    results: SmokeResult[],
    detail: string | null,
  ): Promise<void> {
    const { db } = this.deps;
    await db
      .update(smokeRun)
      .set({ state, results, detail, finishedAt: new Date() })
      .where(eq(smokeRun.id, row.id));
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: row.initiativeId ?? undefined,
      interactionId: row.interactionId ?? undefined,
      action: `smoke.${state}`,
      detail: {
        repository: row.repository,
        prNumber: row.prNumber,
        sha: row.headSha,
        passed: results.filter((r) => r.ok).length,
        of: results.length,
        ...(detail ? { reason: detail.slice(0, 300) } : {}),
      },
    });
  }

  private async execute(
    row: SmokeRow,
    checks: SmokeCheck[],
    interactionId: string,
    by: string | null,
  ): Promise<void> {
    const { previews, host } = this.deps;
    let startedHere = false;
    let previewId: string | null = null;
    try {
      const started = await previews.start(interactionId, by);
      if (!started.ok) return await this.finish(row, 'error', [], started.message);
      startedHere = !started.existing;
      previewId = started.row.id;
      if (started.row.headSha !== row.headSha)
        return await this.finish(
          row,
          'error',
          [],
          'The pull request has a new commit. Run it again.',
        );

      const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 300_000);
      let preview = started.row;
      while (preview.state === 'starting') {
        if (Date.now() > deadline) {
          return await this.finish(row, 'error', [], 'The preview did not become ready in time.');
        }
        await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 500));
        const now = await previews.get(previewId);
        if (!now) return await this.finish(row, 'error', [], 'The preview disappeared.');
        preview = now;
      }
      if (preview.state !== 'ready')
        return await this.finish(
          row,
          'error',
          [],
          preview.detail ?? `The preview ended as ${preview.state}.`,
        );

      const base = (preview.target ?? preview.url ?? '').replace(/\/+$/, '');
      const id = preview.id;
      const { passed, results } = await runSmoke({
        baseUrl: base,
        checks,
        exec: host.exec ? (command, ms) => host.exec!(id, command, ms) : undefined,
        getTimeoutMs: this.deps.getTimeoutMs,
        runTimeoutMs: this.deps.runTimeoutMs,
      });
      await this.finish(row, passed ? 'passed' : 'failed', results, null);
    } catch (e) {
      await this.finish(
        row,
        'error',
        [],
        `could not run the smoke test: ${e instanceof Error ? e.message : String(e)}`,
      ).catch(() => {});
    } finally {
      // A preview someone else started stays up for them. One this run started goes as soon as the checks are done.
      if (startedHere && previewId)
        await previews
          .stop(previewId, 'stopped', 'The smoke test finished.')
          .catch((e) => this.deps.log?.(`[smoke] stop failed: ${String(e)}`));
    }
  }
}
