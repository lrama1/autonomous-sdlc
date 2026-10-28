import { and, desc, eq } from 'drizzle-orm';
import { smokeRun } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import {
  PREVIEW_CONFIG_PATH,
  SMOKE_DIAGNOSIS_SYSTEM,
  buildDiagnosisPacket,
  parseDiagnosisReply,
} from '@sdlc/core';
import type { SmokeDiagnosis } from '@sdlc/core';
import { recordActivity } from './activity.js';
import type { LoadedAgent } from './agents.js';
import type { GitHubService } from './github-service.js';
import type { InlineModel } from './inline-model.js';
import { getInteraction } from './interactions.js';
import { finishInlineRun, startInlineRun } from './runs.js';

export type DiagnoseResult =
  | { ok: true; diagnosis: SmokeDiagnosis & { at: string }; existing: boolean }
  | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): DiagnoseResult => ({
  ok: false,
  status,
  code,
  message,
});

interface PrCard {
  kind?: string;
  repository?: string;
  prNumber?: number;
  headSha?: string;
  summary?: string;
  diff?: { changedPaths?: string[] };
}

/**
 * Says why a smoke test failed (mvp-contract, smoke diagnosis). One call to the model through the gateway, as the security
 * review makes, so the agent's model, budget and cost record apply. It reads what the platform already has (the failed
 * checks, the smoke file, the engineer's summary, the changed paths) and cannot run anything. A person reads the answer
 * and decides. Nothing here approves, overrides or merges.
 */
export class SmokeDiagnosisService {
  private readonly working = new Set<string>();

  constructor(
    private readonly deps: {
      db: Db;
      github: Pick<GitHubService, 'readFile'>;
      agent: LoadedAgent;
      model: InlineModel;
    },
  ) {}

  async diagnose(interactionId: string, by: string): Promise<DiagnoseResult> {
    const { db, github, agent, model } = this.deps;
    const review = await getInteraction(db, interactionId);
    const card = review?.contextCard as PrCard | undefined;
    if (
      !review ||
      card?.kind !== 'pull_request' ||
      !card.repository ||
      !card.prNumber ||
      !card.headSha
    )
      return fail(404, 'not_found', 'That is not a pull request review.');
    if (review.state !== 'open')
      return fail(409, 'review_decided', 'That review has been decided.');

    const [latest] = await db
      .select()
      .from(smokeRun)
      .where(
        and(
          eq(smokeRun.repository, card.repository),
          eq(smokeRun.prNumber, card.prNumber),
          eq(smokeRun.headSha, card.headSha),
        ),
      )
      .orderBy(desc(smokeRun.createdAt))
      .limit(1);
    if (!latest || (latest.state !== 'failed' && latest.state !== 'error'))
      return fail(409, 'nothing_to_explain', 'There is no failed smoke test on this commit.');
    if (latest.diagnosis) return { ok: true, diagnosis: latest.diagnosis, existing: true };
    if (this.working.has(latest.id))
      return fail(409, 'already_working', 'It is already being explained. Wait a moment.');

    this.working.add(latest.id);
    let runId: string | null = null;
    try {
      const previewFile = await github
        .readFile(card.repository, PREVIEW_CONFIG_PATH, card.headSha)
        .catch(() => null);
      const packet = buildDiagnosisPacket({
        title: review.title,
        summary: card.summary ?? '',
        changedPaths: card.diff?.changedPaths ?? [],
        previewFile,
        results: latest.results,
        note: latest.state === 'error' ? latest.detail : null,
      });
      const started = await startInlineRun(db, agent, {
        initiativeId: review.initiativeId,
        task: `Smoke test diagnosis of ${card.repository}#${card.prNumber} at ${card.headSha.slice(0, 7)}`,
        sponsorPersonId: by,
      });
      runId = started.run.id;
      const ask = (messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
        model.ask(started.token, {
          alias: agent.definition.model_alias,
          system: SMOKE_DIAGNOSIS_SYSTEM,
          messages,
          maxTokens: 1500,
        });
      let reply = await ask([{ role: 'user', content: packet }]);
      let parsed = parseDiagnosisReply(reply);
      if (!parsed.ok) {
        reply = await ask([
          { role: 'user', content: packet },
          { role: 'assistant', content: reply },
          {
            role: 'user',
            content: `Your answer could not be read: ${parsed.errors.join('; ')}. Answer again with the JSON object only.`,
          },
        ]);
        parsed = parseDiagnosisReply(reply);
      }
      if (!parsed.ok) {
        await finishInlineRun(db, runId, { state: 'failed', exitReason: 'unreadable_answer' });
        return fail(
          502,
          'unreadable',
          'The model gave an answer that could not be read. Try again.',
        );
      }
      const diagnosis = { ...parsed.diagnosis, at: new Date().toISOString() };
      await db.update(smokeRun).set({ diagnosis }).where(eq(smokeRun.id, latest.id));
      await finishInlineRun(db, runId, { state: 'succeeded', exitReason: 'completed' });
      await recordActivity(db, {
        actorType: 'person',
        actorId: by,
        initiativeId: review.initiativeId,
        interactionId: review.id,
        runId,
        action: 'smoke.diagnosed',
        detail: { smokeRunId: latest.id, verdict: diagnosis.verdict },
      });
      return { ok: true, diagnosis, existing: false };
    } catch (e) {
      if (runId)
        await finishInlineRun(db, runId, { state: 'failed', exitReason: 'error' }).catch(() => {});
      return fail(
        502,
        'model_failed',
        `Could not explain the failure: ${e instanceof Error ? e.message : String(e)}`.slice(
          0,
          300,
        ),
      );
    } finally {
      this.working.delete(latest.id);
    }
  }
}
