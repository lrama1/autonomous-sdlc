import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { initiative, interaction, previewRun, repositoryEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { parsePreviewConfig, PREVIEW_CONFIG_PATH } from '@sdlc/core';
import { recordActivity } from './activity.js';
import { PreviewStartError } from './docker-preview.js';
import type { PreviewHost } from './docker-preview.js';
import type { GitHubService } from './github-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The service that runs platform previews, or null when this platform has none. */
    previews: () => PreviewService | null;
  }
}

export interface PreviewSettings {
  maxActive: number;
  ttlMinutes: number;
  portBase: number;
  /** How many ports after the base may be used. */
  portCount?: number;
}

type PreviewGitHub = Pick<GitHubService, 'getPullRequest' | 'readFile' | 'archive' | 'branchHead'>;

/** The pull request number a preview of an integration branch is filed under. */
export const MAIN_PREVIEW = 0;
export type PreviewRow = typeof previewRun.$inferSelect;

export type StartResult =
  | { ok: true; row: PreviewRow; existing: boolean }
  | { ok: false; status: number; code: string; message: string };

const ACTIVE = ['starting', 'ready'] as const;
const NO_CONFIG = `This repository has no ${PREVIEW_CONFIG_PATH}, so the platform does not know how to run it. Add one with a start command (and a port, if it is not 3000).`;

/**
 * Runs a pull request's code for a reviewer, in a sandbox (mvp-contract section 16, platform previews). A reviewer
 * clicks Start; in an autopilot initiative it starts by itself. At most `maxActive` run at once, each stops by itself
 * after `ttlMinutes`, and each stops when its review is decided.
 */
export class PreviewService {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      db: Db;
      github: PreviewGitHub;
      host: PreviewHost;
      settings: PreviewSettings;
      log?: (line: string) => void;
      now?: () => Date;
    },
  ) {}

  private get now() {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string) {
    this.deps.log?.(line);
  }

  /** Whether another preview can start now. A person's own request is never held back by this, but an automatic one is. */
  async hasFreeSlot(): Promise<boolean> {
    const active = await this.deps.db
      .select({ id: previewRun.id })
      .from(previewRun)
      .where(inArray(previewRun.state, [...ACTIVE]));
    return active.length < this.deps.settings.maxActive;
  }

  /** Waits for starts that are in progress. For tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  /** At start-up: whatever an earlier process left running is removed, and its rows say so. */
  async recover(): Promise<void> {
    await this.deps.host.reconcile();
    await this.deps.db
      .update(previewRun)
      .set({
        state: 'stopped',
        stoppedAt: this.now,
        url: null,
        detail: 'The platform restarted, which stopped this preview.',
      })
      .where(inArray(previewRun.state, [...ACTIVE]));
  }

  /** The latest preview the platform ran or tried for a pull request. */
  async forPullRequest(repository: string, prNumber: number): Promise<PreviewRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(previewRun)
      .where(and(eq(previewRun.repository, repository), eq(previewRun.prNumber, prNumber)))
      .orderBy(desc(previewRun.createdAt))
      .limit(1);
    return row ?? null;
  }

  async get(id: string): Promise<PreviewRow | null> {
    const [row] = await this.deps.db.select().from(previewRun).where(eq(previewRun.id, id));
    return row ?? null;
  }

  async start(interactionId: string, by: string | null): Promise<StartResult> {
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
        'That review has been decided, so there is nothing to preview.',
      );
    const { repository, prNumber } = card;

    const pr = await github.getPullRequest(repository, prNumber);
    if (pr.state !== 'open')
      return fail(409, 'pull_request_closed', 'That pull request is no longer open.');

    return this.begin({
      repository,
      prNumber,
      sha: pr.head.sha,
      interactionId: review.id,
      initiativeId: review.initiativeId,
      by,
      moved: 'The pull request has a new commit.',
    });
  }

  /** The repository and integration branch an initiative builds on. */
  private async repositoryOf(initiativeId: string) {
    const [init] = await this.deps.db
      .select({ repositoryId: initiative.repositoryId })
      .from(initiative)
      .where(eq(initiative.id, initiativeId));
    if (!init) return null;
    const [repo] = await this.deps.db
      .select()
      .from(repositoryEntry)
      .where(eq(repositoryEntry.id, init.repositoryId));
    return repo ?? null;
  }

  /** The latest preview of an initiative's integration branch (what the build produced), if there was one. */
  async forMain(initiativeId: string): Promise<PreviewRow | null> {
    const repo = await this.repositoryOf(initiativeId);
    return repo ? this.forPullRequest(repo.fullName, MAIN_PREVIEW) : null;
  }

  /** Runs the tip of the integration branch, which is what the merged tasks built. */
  async startMain(initiativeId: string, by: string): Promise<StartResult> {
    const repo = await this.repositoryOf(initiativeId);
    if (!repo) return fail(404, 'not_found', 'That initiative has no registered repository.');
    let sha: string;
    try {
      sha = await this.deps.github.branchHead(repo.fullName, repo.integrationBranch);
    } catch {
      return fail(
        409,
        'no_branch',
        `GitHub has no commit on ${repo.integrationBranch} of ${repo.fullName} to run.`,
      );
    }
    return this.begin({
      repository: repo.fullName,
      prNumber: MAIN_PREVIEW,
      sha,
      interactionId: null,
      initiativeId,
      by,
      moved: `${repo.integrationBranch} has a new commit.`,
    });
  }

  /** The part of a start that a pull request and a branch share: reuse, replace, limit, and launch. */
  private async begin(o: {
    repository: string;
    prNumber: number;
    sha: string;
    interactionId: string | null;
    initiativeId: string;
    by: string | null;
    moved: string;
  }): Promise<StartResult> {
    const { db, settings } = this.deps;
    const { repository, prNumber, by } = o;

    const active = await db
      .select()
      .from(previewRun)
      .where(inArray(previewRun.state, [...ACTIVE]));
    const mine = active.filter((r) => r.repository === repository && r.prNumber === prNumber);
    const same = mine.find((r) => r.headSha === o.sha);
    if (same) return { ok: true, row: same, existing: true };
    // The code moved on. The old preview shows code nobody is looking at any more.
    for (const r of mine) await this.stop(r.id, 'stopped', o.moved);

    const others = active.filter((r) => !mine.includes(r));
    if (others.length >= settings.maxActive)
      return fail(
        429,
        'busy',
        `${settings.maxActive} previews are already running. Stop one, or wait for one to finish (each stops after ${settings.ttlMinutes} minutes).`,
      );

    const used = new Set(others.map((r) => r.hostPort));
    const hostPort = this.pickPort(used);
    if (hostPort === null) return fail(503, 'no_port', 'No port is free for a preview.');

    const [row] = await db
      .insert(previewRun)
      .values({
        interactionId: o.interactionId,
        initiativeId: o.initiativeId,
        repository,
        prNumber,
        headSha: o.sha,
        state: 'starting',
        hostPort,
        startedBy: by,
        detail: 'Fetching the code and starting it.',
      })
      .returning();
    await recordActivity(db, {
      actorType: by ? 'person' : 'system',
      actorId: by ?? undefined,
      initiativeId: o.initiativeId,
      interactionId: o.interactionId ?? undefined,
      action: 'preview.started',
      detail: { repository, prNumber, sha: o.sha, by: by ? 'a person' : 'autopilot' },
    });
    const job = this.launch(row!, by === null).finally(() => this.running.delete(job));
    this.running.add(job);
    return { ok: true, row: row!, existing: false };
  }

  private pickPort(used: Set<number | null>, from = 0): number | null {
    const { portBase, portCount = 100 } = this.deps.settings;
    for (let i = from; i < portCount; i++) if (!used.has(portBase + i)) return portBase + i;
    return null;
  }

  private async update(id: string, patch: Partial<typeof previewRun.$inferInsert>) {
    await this.deps.db.update(previewRun).set(patch).where(eq(previewRun.id, id));
  }

  private async settle(
    row: PreviewRow,
    state: 'failed' | 'unavailable',
    detail: string,
  ): Promise<void> {
    await this.update(row.id, { state, detail, url: null, stoppedAt: this.now });
    await recordActivity(this.deps.db, {
      actorType: 'system',
      initiativeId: row.initiativeId ?? undefined,
      interactionId: row.interactionId ?? undefined,
      action: state === 'failed' ? 'preview.failed' : 'preview.unavailable',
      detail: { repository: row.repository, prNumber: row.prNumber, reason: detail.slice(0, 300) },
    });
  }

  private async launch(row: PreviewRow, automatic: boolean): Promise<void> {
    const { github, host, settings } = this.deps;
    try {
      const text = await github.readFile(row.repository, PREVIEW_CONFIG_PATH, row.headSha);
      if (text === null)
        return await this.settle(row, automatic ? 'unavailable' : 'failed', NO_CONFIG);
      const parsed = parsePreviewConfig(text);
      if (!parsed.ok)
        return await this.settle(
          row,
          'failed',
          `${PREVIEW_CONFIG_PATH}: ${parsed.errors.join('; ')}`,
        );
      const archive = await github.archive(row.repository, row.headSha);

      let port = row.hostPort!;
      let url: string | null = null;
      let target: string | null = null;
      for (let attempt = 0; attempt < 5 && url === null; attempt++) {
        try {
          const started = await host.start({
            id: row.id,
            archive,
            config: parsed.config,
            hostPort: port,
          });
          url = started.url;
          target = started.target ?? null;
        } catch (e) {
          if (!(e instanceof PreviewStartError && e.portBusy) || attempt === 4) throw e;
          const active = await this.deps.db
            .select({ p: previewRun.hostPort })
            .from(previewRun)
            .where(inArray(previewRun.state, [...ACTIVE]));
          const next = this.pickPort(
            new Set([...active.map((a) => a.p), port]),
            port - settings.portBase + 1,
          );
          if (next === null) throw e;
          port = next;
          await this.update(row.id, { hostPort: port });
        }
      }

      // A person may have stopped it, or the review may have been decided, while it was starting.
      const [now] = await this.deps.db.select().from(previewRun).where(eq(previewRun.id, row.id));
      if (now?.state !== 'starting') {
        await host.stop(row.id);
        return;
      }
      const readyAt = this.now;
      await this.update(row.id, {
        state: 'ready',
        url,
        target,
        hostPort: port,
        readyAt,
        expiresAt: new Date(readyAt.getTime() + settings.ttlMinutes * 60_000),
        detail: null,
      });
      this.log(`[preview] ${row.repository}#${row.prNumber} ready at ${url}`);
    } catch (e) {
      await host.stop(row.id).catch(() => {});
      const message =
        e instanceof PreviewStartError
          ? e.message
          : `could not start the preview: ${e instanceof Error ? e.message : String(e)}`;
      const [now] = await this.deps.db.select().from(previewRun).where(eq(previewRun.id, row.id));
      if (now?.state === 'starting') await this.settle(row, 'failed', message.slice(0, 1500));
    }
  }

  async stop(
    id: string,
    state: 'stopped' | 'expired' = 'stopped',
    detail = 'Stopped.',
  ): Promise<PreviewRow | null> {
    const [row] = await this.deps.db.select().from(previewRun).where(eq(previewRun.id, id));
    if (!row) return null;
    if (!(ACTIVE as readonly string[]).includes(row.state)) return row;
    await this.update(id, { state, detail, url: null, stoppedAt: this.now });
    await this.deps.host.stop(id).catch((e) => this.log(`[preview] stop failed: ${String(e)}`));
    await recordActivity(this.deps.db, {
      actorType: 'system',
      initiativeId: row.initiativeId ?? undefined,
      interactionId: row.interactionId ?? undefined,
      action: 'preview.stopped',
      detail: { repository: row.repository, prNumber: row.prNumber, state, reason: detail },
    });
    return { ...row, state, detail, url: null };
  }

  /** Called every few seconds: stops what has run its time or whose review is over, and starts previews in autopilot. */
  async tick(): Promise<void> {
    const { db } = this.deps;
    const now = this.now;
    const active = await db
      .select({ p: previewRun, review: interaction.state })
      .from(previewRun)
      .leftJoin(interaction, eq(interaction.id, previewRun.interactionId))
      .where(inArray(previewRun.state, [...ACTIVE]));
    for (const { p, review } of active) {
      if (p.state === 'ready' && p.expiresAt && p.expiresAt <= now)
        await this.stop(p.id, 'expired', `Stopped after ${this.deps.settings.ttlMinutes} minutes.`);
      else if (review && review !== 'open')
        await this.stop(p.id, 'stopped', 'The review was decided.');
    }

    // Autopilot initiatives start a preview for each open pull request review, once.
    const waiting = await db
      .select({ id: interaction.id })
      .from(interaction)
      .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
      .where(
        and(
          eq(interaction.type, 'review'),
          eq(interaction.state, 'open'),
          eq(initiative.autonomyMode, 'autopilot'),
          sql`${interaction.contextCard} ->> 'kind' = 'pull_request'`,
          sql`not exists (select 1 from preview_run p where p.interaction_id = ${interaction.id})`,
        ),
      );
    for (const w of waiting) {
      const r = await this.start(w.id, null).catch((e) => {
        this.log(`[preview] automatic start failed: ${String(e)}`);
        return null;
      });
      if (r && !r.ok && r.code === 'busy') break;
    }
  }
}

function fail(status: number, code: string, message: string): StartResult {
  return { ok: false, status, code, message };
}
