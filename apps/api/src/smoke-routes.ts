import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { agentRun, person } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { checkAnswer } from '@sdlc/core';
import { smokeSchema } from '@sdlc/schemas';
import type { SmokeDto } from '@sdlc/schemas';
import { answerAsPerson, factsOf } from './answering.js';
import type { Gate } from './gate.js';
import { getInteraction } from './interactions.js';
import { requirePerson } from './people.js';
import type { SmokeService } from './smoke-service.js';
import type { SmokeDiagnosisService } from './smoke-diagnosis.js';

const MIN_REASON = 10;
const MAX_REASON = 500;

/**
 * The smoke test of a pull request under review (mvp-contract section 16). A person with a role starts it, the platform
 * runs the repository's checks in a sandbox, and the review cannot be approved until it passes or a person overrides it
 * with a reason. A platform that cannot run previews cannot run this, and does not ask for it.
 */
export function registerSmokeRoutes(
  app: FastifyInstance,
  db: Db,
  rules: { independentReview: boolean },
  smoke: () => SmokeService | null,
  diagnoser: () => SmokeDiagnosisService | null = () => null,
  gate?: Gate,
): void {
  async function loadReview(id: string) {
    const row = await getInteraction(db, id);
    const card = row?.contextCard as
      { kind?: string; repository?: string; prNumber?: number; headSha?: string } | undefined;
    if (
      !row ||
      card?.kind !== 'pull_request' ||
      !card.repository ||
      !card.prNumber ||
      !card.headSha
    )
      return null;
    return { row, repository: card.repository, prNumber: card.prNumber, headSha: card.headSha };
  }
  const notAReview = {
    error: { code: 'not_found', message: 'That is not a pull request review.' },
  };

  app.get('/api/interactions/:id/smoke', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const review = await loadReview(id);
    if (!review) return reply.code(404).send(notAReview);
    const svc = smoke();
    if (!svc) {
      const off: SmokeDto = {
        available: false,
        required: 'none',
        detail: null,
        commit: review.headSha,
        run: null,
        blocks: null,
      };
      return off;
    }
    let req;
    try {
      req = await svc.requirementFor(review.row);
    } catch (e) {
      request.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'smoke lookup failed');
      return reply.code(502).send({
        error: {
          code: 'github_unavailable',
          message: 'Could not read the smoke checks from GitHub.',
        },
      });
    }
    const latest = await svc.forCommit(review.repository, review.prNumber, review.headSha);
    const [who] = latest?.startedBy
      ? await db.select().from(person).where(eq(person.id, latest.startedBy))
      : [];
    const value: SmokeDto = smokeSchema.parse({
      available: true,
      required: req.kind,
      detail: req.kind === 'invalid' ? req.message : null,
      commit: review.headSha,
      run: latest
        ? {
            id: latest.id,
            state: latest.state,
            results: latest.results,
            detail: latest.detail,
            diagnosis: latest.diagnosis ?? null,
            by: who?.displayName ?? null,
            startedAt: latest.createdAt.toISOString(),
            finishedAt: latest.finishedAt?.toISOString() ?? null,
          }
        : null,
      blocks: await svc.blocks(review.row),
    });
    return value;
  });

  app.post('/api/interactions/:id/smoke/start', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (me.roles.length === 0)
      return reply.code(403).send({
        error: { code: 'wrong_role', message: 'Only a person with a role can run a smoke test.' },
      });
    const svc = smoke();
    if (!svc)
      return reply.code(409).send({
        error: {
          code: 'smoke_off',
          message: 'This platform is not set up to run previews, so it cannot run a smoke test.',
        },
      });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const out = await svc.start(id, me.id);
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(out.existing ? 200 : 202).send({ id: out.row.id, state: out.row.state });
  });

  // An AI's reading of why the smoke test failed. It advises, and anyone with a role may ask for it.
  app.post('/api/interactions/:id/smoke/diagnose', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (me.roles.length === 0)
      return reply.code(403).send({
        error: { code: 'wrong_role', message: 'Only a person with a role can ask for this.' },
      });
    const svc = diagnoser();
    if (!svc)
      return reply.code(409).send({
        error: {
          code: 'diagnosis_off',
          message: 'This platform has no Security agent switched on, which this needs.',
        },
      });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const out = await svc.diagnose(id, me.id);
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return out.diagnosis;
  });

  // One click turns the AI's reading into a change request for the engineer. What is sent is the stored reading and the
  // failed checks, never text from the browser. The usual rule on who may decide a review applies.
  app.post('/api/interactions/:id/smoke/send-back', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const svc = smoke();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const review = await loadReview(id);
    if (!review || !svc) return reply.code(404).send(notAReview);
    const latest = await svc.forCommit(review.repository, review.prNumber, review.headSha);
    const d = latest?.diagnosis;
    if (!latest || !d || (d.verdict !== 'code' && d.verdict !== 'checks') || !d.instruction)
      return reply.code(409).send({
        error: {
          code: 'no_diagnosis',
          message: 'There is no reading of this failure that says what the engineer should do.',
        },
      });
    const failed = latest.results.filter((r) => !r.ok);
    const text = [
      d.verdict === 'checks'
        ? 'The smoke test failed on this commit, and the smoke checks look out of date. A person read the reading below and sent it to you.'
        : 'The smoke test failed on this commit, and the code looks wrong. A person read the reading below and sent it to you.',
      '',
      d.instruction,
      '',
      'Failed checks:',
      ...failed.map((r) => `- ${r.label}: ${r.detail}`),
      '',
      `Reading (by an AI, not verified): ${d.summary}`,
    ]
      .join('\n')
      .slice(0, 3900);
    const out = await answerAsPerson(
      {
        db,
        rules,
        gate,
        onGateError: (e) => request.log.error({ err: e }, 'gate failed after a decision'),
      },
      id,
      me,
      'workspace',
      {
        answer: text,
        decision: 'changes_requested',
        makeStanding: false,
        standingScope: 'initiative',
        didntNeedToAsk: false,
      },
    );
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(201).send({ sent: failed.length });
  });
  app.post('/api/interactions/:id/smoke/override', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const svc = smoke();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ reason: z.string().trim().min(MIN_REASON).max(MAX_REASON) })
      .safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({
        error: {
          code: 'reason_required',
          message: `Say why, in ${MIN_REASON} to ${MAX_REASON} characters. The reason stays with the pull request.`,
        },
      });
    const review = await loadReview(id);
    if (!review || !svc) return reply.code(404).send(notAReview);
    // Whoever may approve this review may override its smoke test. Nobody else, and not a person who is barred from
    // reviewing their own run.
    const [run] = review.row.runId
      ? await db.select().from(agentRun).where(eq(agentRun.id, review.row.runId))
      : [undefined];
    const verdict = checkAnswer(
      factsOf(review.row),
      { id: me.id, roles: me.roles },
      run ? { sponsorPersonId: run.sponsorPersonId, contributors: run.contributors } : null,
      { decision: 'approved' },
      rules,
    );
    if (!verdict.ok)
      return reply.code(403).send({
        error: {
          code: 'wrong_role',
          message: 'Only a person who may approve this review can override its smoke test.',
        },
      });
    const out = await svc.override(id, me.id, body.data.reason);
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(201).send({ id: out.row.id, state: out.row.state });
  });
}
