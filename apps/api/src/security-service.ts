import { and, desc, eq } from 'drizzle-orm';
import { person, securityReview } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import {
  blockingFindings,
  buildReviewPacket,
  needsSecurityReview,
  parseSecurityReply,
  relativeImports,
  severityCounts,
} from '@sdlc/core';
import type { SecurityFinding } from '@sdlc/core';
import { recordActivity } from './activity.js';
import type { LoadedAgent } from './agents.js';
import type { GitHubService } from './github-service.js';
import type { InlineModel } from './inline-model.js';
import { getInteraction } from './interactions.js';
import type { InteractionRow } from './interactions.js';
import { finishInlineRun, startInlineRun } from './runs.js';

export type SecurityRow = typeof securityReview.$inferSelect;

type SecurityGitHub = Pick<GitHubService, 'getPullRequest' | 'readFile' | 'pullRequestFiles'>;

export type SecurityStartResult =
  | { ok: true; row: SecurityRow; existing: boolean }
  | { ok: false; status: number; code: string; message: string };

export type DismissResult =
  { ok: true; row: SecurityRow } | { ok: false; status: number; code: string; message: string };

interface PrCard {
  kind?: string;
  repository?: string;
  prNumber?: number;
  headSha?: string;
  diff?: { changedPaths?: string[] };
}

const fail = (status: number, code: string, message: string): SecurityStartResult => ({
  ok: false,
  status,
  code,
  message,
});

const MAX_CONTEXT_FILES = 25;
const MAX_IMPORTED_FILES = 10;
// Text that is not worth the agent's attention or the cost: lock files, generated and binary-like files.
const SKIP_FILE =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.min\.(?:js|css)|.*\.(?:png|jpe?g|gif|ico|svg|woff2?|ttf|pdf|zip|gz|mp4|map))$/i;

/**
 * The Security agent's review of one pull request at one commit (mvp-contract section 16, security review). A person
 * clicks it; the platform reads the diff and the changed files from GitHub, gives them to the agent through the gateway,
 * and records what it found. High and critical findings hold the approval until a person has fixed or dismissed each.
 */
export class SecurityService {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      db: Db;
      github: SecurityGitHub;
      agent: LoadedAgent;
      model: InlineModel;
      log?: (line: string) => void;
    },
  ) {}

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /** A review that was running when an earlier process stopped will not finish. */
  async recover(): Promise<void> {
    await this.deps.db
      .update(securityReview)
      .set({
        state: 'error',
        detail: 'The platform restarted during the security review. Run it again.',
        finishedAt: new Date(),
      })
      .where(eq(securityReview.state, 'running'));
  }

  async forCommit(repository: string, prNumber: number, sha: string): Promise<SecurityRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(securityReview)
      .where(
        and(
          eq(securityReview.repository, repository),
          eq(securityReview.prNumber, prNumber),
          eq(securityReview.headSha, sha),
        ),
      )
      .orderBy(desc(securityReview.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Whether this review's change has anything for a security review to read. Documents alone do not. */
  required(row: InteractionRow): boolean {
    const card = row.contextCard as PrCard;
    return card.kind === 'pull_request' && needsSecurityReview(card.diff?.changedPaths ?? []);
  }

  async start(interactionId: string, by: string): Promise<SecurityStartResult> {
    const { db, github } = this.deps;
    const review = await getInteraction(db, interactionId);
    const card = review?.contextCard as PrCard | undefined;
    if (!review || card?.kind !== 'pull_request' || !card.repository || !card.prNumber)
      return fail(404, 'not_found', 'That is not a pull request review.');
    if (review.state !== 'open')
      return fail(
        409,
        'review_decided',
        'That review has been decided, so there is nothing to check.',
      );
    if (!this.required(review))
      return fail(
        422,
        'not_needed',
        'This change only touches documents, so there is nothing for a security review to read.',
      );
    const pr = await github.getPullRequest(card.repository, card.prNumber);
    if (pr.state !== 'open')
      return fail(409, 'pull_request_closed', 'That pull request is no longer open.');

    const [again] = await db
      .select()
      .from(securityReview)
      .where(
        and(
          eq(securityReview.repository, card.repository),
          eq(securityReview.prNumber, card.prNumber),
          eq(securityReview.headSha, pr.head.sha),
          eq(securityReview.state, 'running'),
        ),
      );
    if (again) return { ok: true, row: again, existing: true };

    const [row] = await db
      .insert(securityReview)
      .values({
        interactionId: review.id,
        initiativeId: review.initiativeId,
        repository: card.repository,
        prNumber: card.prNumber,
        headSha: pr.head.sha,
        startedBy: by,
        detail: 'Reading the change.',
      })
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: by,
      initiativeId: review.initiativeId,
      interactionId: review.id,
      action: 'security.started',
      detail: { repository: card.repository, prNumber: card.prNumber, sha: pr.head.sha },
    });
    const job = this.execute(row!, pr, by).finally(() => this.running.delete(job));
    this.running.add(job);
    return { ok: true, row: row!, existing: false };
  }

  /** What the agent reads: the diff of each file, and the changed files and what they import, in full. */
  private async gather(row: SecurityRow, pr: { title?: string; body?: string | null }) {
    const { github } = this.deps;
    const files = await github.pullRequestFiles(row.repository, row.prNumber);
    const contents: Array<{ path: string; text: string; imported: boolean }> = [];
    const have = new Set<string>();
    for (const f of files) {
      if (f.status === 'removed' || SKIP_FILE.test(f.path) || contents.length >= MAX_CONTEXT_FILES)
        continue;
      const text = await github.readFile(row.repository, f.path, row.headSha);
      if (text === null || text.includes('\0')) continue;
      contents.push({ path: f.path, text, imported: false });
      have.add(f.path);
    }
    let imported = 0;
    for (const c of [...contents]) {
      if (!/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(c.path)) continue;
      for (const rel of relativeImports(c.path, c.text)) {
        if (imported >= MAX_IMPORTED_FILES) break;
        const candidates = /\.[a-z]+$/i.test(rel)
          ? [rel]
          : [`${rel}.js`, `${rel}.ts`, `${rel}/index.js`];
        for (const path of candidates) {
          if (have.has(path) || SKIP_FILE.test(path)) continue;
          const text = await github.readFile(row.repository, path, row.headSha).catch(() => null);
          if (text === null) continue;
          contents.push({ path, text, imported: true });
          have.add(path);
          imported++;
          break;
        }
      }
    }
    return buildReviewPacket({
      title: pr.title ?? `Pull request #${row.prNumber}`,
      body: pr.body ?? '',
      files,
      contents,
    });
  }

  private async execute(
    row: SecurityRow,
    pr: { head: { sha: string }; title?: string; body?: string | null },
    by: string,
  ): Promise<void> {
    const { db, agent, model } = this.deps;
    let runId: string | null = null;
    try {
      const packet = await this.gather(row, pr);
      const started = await startInlineRun(db, agent, {
        initiativeId: row.initiativeId!,
        task: `Security review of ${row.repository}#${row.prNumber} at ${row.headSha.slice(0, 7)}`,
        sponsorPersonId: by,
      });
      runId = started.run.id;
      await db.update(securityReview).set({ runId }).where(eq(securityReview.id, row.id));
      const ask = (messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
        model.ask(started.token, {
          alias: agent.definition.model_alias,
          system: agent.prompt,
          messages,
        });
      const question = `${packet}\n\nReview this change now. Answer with the JSON object only.`;
      let reply = await ask([{ role: 'user', content: question }]);
      let parsed = parseSecurityReply(reply);
      if (!parsed.ok) {
        // One more try, telling it what was wrong.
        reply = await ask([
          { role: 'user', content: question },
          { role: 'assistant', content: reply },
          {
            role: 'user',
            content: `Your answer could not be read: ${parsed.errors.join('; ')}. Answer again with the JSON object only.`,
          },
        ]);
        parsed = parseSecurityReply(reply);
      }
      if (!parsed.ok) {
        await this.finish(
          row,
          'error',
          'an answer that reads',
          [],
          parsed.errors.join('; ').slice(0, 400),
        );
        await finishInlineRun(db, runId, { state: 'failed', exitReason: 'unreadable_answer' });
        return;
      }
      await this.finish(row, 'done', parsed.summary, parsed.findings, null);
      await finishInlineRun(db, runId, { state: 'succeeded', exitReason: 'completed' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.finish(
        row,
        'error',
        null,
        [],
        `could not run the security review: ${message}`.slice(0, 400),
      ).catch(() => {});
      if (runId)
        await finishInlineRun(db, runId, { state: 'failed', exitReason: 'error' }).catch(() => {});
    }
  }

  private async finish(
    row: SecurityRow,
    state: 'done' | 'error',
    summary: string | null,
    findings: SecurityFinding[],
    detail: string | null,
  ): Promise<void> {
    const { db } = this.deps;
    await db
      .update(securityReview)
      .set({ state, summary, findings, detail, finishedAt: new Date() })
      .where(eq(securityReview.id, row.id));
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: row.initiativeId ?? undefined,
      interactionId: row.interactionId ?? undefined,
      action: `security.${state}`,
      detail: {
        repository: row.repository,
        prNumber: row.prNumber,
        sha: row.headSha,
        findings: severityCounts(findings),
        ...(detail ? { reason: detail } : {}),
      },
    });
  }

  /**
   * Why this review may not be approved yet because of the security review, or null. The newest review of the commit
   * decides: it must have finished, and nothing critical or high may be left that nobody fixed or dismissed.
   */
  async blocks(row: InteractionRow): Promise<string | null> {
    const card = row.contextCard as PrCard;
    if (!this.required(row) || !card.repository || !card.prNumber || !card.headSha) return null;
    const latest = await this.forCommit(card.repository, card.prNumber, card.headSha);
    if (!latest)
      return 'This change has not had a security review on this commit. Run the security review first.';
    if (latest.state === 'running')
      return 'The security review is still running. Wait for it to finish.';
    if (latest.state === 'error')
      return `The security review could not finish (${latest.detail ?? 'no reason given'}). Run it again.`;
    const open = blockingFindings(latest.findings as SecurityFinding[]);
    if (open.length === 0) return null;
    return `The security review found ${open.length} high or critical finding${open.length === 1 ? '' : 's'} that nobody has fixed or dismissed: ${open
      .map((f) => `${f.id} ${f.title}`)
      .join('; ')}. Send them back to the engineer, or dismiss each with a reason.`;
  }

  /** One line for the approval on the pull request. */
  async evidence(row: InteractionRow): Promise<string | null> {
    const card = row.contextCard as PrCard;
    if (!this.required(row) || !card.repository || !card.prNumber || !card.headSha) return null;
    const latest = await this.forCommit(card.repository, card.prNumber, card.headSha);
    if (!latest || latest.state !== 'done') return null;
    const findings = latest.findings as SecurityFinding[];
    const dismissed = findings
      .filter((f) => f.dismissed)
      .map(
        (f) => `${f.id} dismissed by ${f.dismissed!.byName ?? 'a person'}: ${f.dismissed!.reason}`,
      );
    return `Security review: ${severityCounts(findings)}${dismissed.length > 0 ? ` (${dismissed.join('; ')})` : ''}.`;
  }

  /** The Gate merged the base branch into the pull request: a finished review (and its dismissals) follows the commit. */
  async carryOver(row: InteractionRow, fromSha: string, toSha: string): Promise<void> {
    const card = row.contextCard as PrCard;
    if (!card.repository || !card.prNumber) return;
    const latest = await this.forCommit(card.repository, card.prNumber, fromSha);
    if (!latest || latest.state !== 'done') return;
    const { db } = this.deps;
    await db.insert(securityReview).values({
      interactionId: latest.interactionId,
      initiativeId: latest.initiativeId,
      runId: latest.runId,
      repository: latest.repository,
      prNumber: latest.prNumber,
      headSha: toSha,
      state: 'done',
      summary: latest.summary,
      findings: latest.findings,
      detail: `carried over from ${fromSha.slice(0, 7)}: the Gate merged the base branch`,
      startedBy: latest.startedBy,
      finishedAt: new Date(),
    });
    await recordActivity(db, {
      actorType: 'system',
      initiativeId: latest.initiativeId ?? undefined,
      interactionId: latest.interactionId ?? undefined,
      action: 'security.carried_over',
      detail: { repository: card.repository, prNumber: card.prNumber, from: fromSha, to: toSha },
    });
  }

  /** A person says a finding does not need a fix, and why. The reason stays with the finding and goes on the approval. */
  async dismiss(
    interactionId: string,
    findingId: string,
    by: { id: string; displayName: string },
    reason: string,
  ): Promise<DismissResult> {
    const { db } = this.deps;
    const review = await getInteraction(db, interactionId);
    const card = review?.contextCard as PrCard | undefined;
    if (
      !review ||
      card?.kind !== 'pull_request' ||
      !card.repository ||
      !card.prNumber ||
      !card.headSha
    )
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        message: 'That is not a pull request review.',
      };
    if (review.state !== 'open')
      return {
        ok: false,
        status: 409,
        code: 'review_decided',
        message: 'That review has been decided.',
      };
    const latest = await this.forCommit(card.repository, card.prNumber, card.headSha);
    if (!latest || latest.state !== 'done')
      return {
        ok: false,
        status: 409,
        code: 'no_review',
        message: 'There is no finished security review of this commit.',
      };
    const findings = latest.findings as SecurityFinding[];
    const found = findings.find((f) => f.id === findingId);
    if (!found)
      return {
        ok: false,
        status: 404,
        code: 'no_such_finding',
        message: `The review has no finding ${findingId}.`,
      };
    if (found.dismissed)
      return {
        ok: false,
        status: 409,
        code: 'already_dismissed',
        message: 'That finding is already dismissed.',
      };
    const next = findings.map((f) =>
      f.id === findingId
        ? {
            ...f,
            dismissed: { by: by.id, byName: by.displayName, reason, at: new Date().toISOString() },
          }
        : f,
    );
    const [row] = await db
      .update(securityReview)
      .set({ findings: next })
      .where(eq(securityReview.id, latest.id))
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: by.id,
      initiativeId: review.initiativeId,
      interactionId: review.id,
      action: 'security.dismissed',
      detail: {
        repository: card.repository,
        prNumber: card.prNumber,
        finding: findingId,
        severity: found.severity,
        title: found.title,
        reason,
      },
    });
    return { ok: true, row: row! };
  }

  /** Who started it, for the panel. */
  async nameOf(personId: string | null): Promise<string | null> {
    if (!personId) return null;
    const [p] = await this.deps.db.select().from(person).where(eq(person.id, personId));
    return p?.displayName ?? null;
  }
}
