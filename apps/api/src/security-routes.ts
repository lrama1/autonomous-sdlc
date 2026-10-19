import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { agentRun } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { checkAnswer, findingsAsChangeRequest } from '@sdlc/core';
import type { SecurityFinding } from '@sdlc/core';
import { securitySchema } from '@sdlc/schemas';
import type { SecurityDto } from '@sdlc/schemas';
import { answerAsPerson, factsOf } from './answering.js';
import type { Gate } from './gate.js';
import { getInteraction } from './interactions.js';
import type { InteractionRow } from './interactions.js';
import { requirePerson } from './people.js';
import type { SecurityService } from './security-service.js';

const MIN_REASON = 10;
const MAX_REASON = 500;

/**
 * The security review of a pull request under review (mvp-contract section 16). A person with a role starts it, the
 * Security agent reads the change, and a high or critical finding holds the approval until a person has sent it back to
 * the engineer or dismissed it with a reason. A platform without the agent or the gateway does not ask for it.
 */
export function registerSecurityRoutes(
  app: FastifyInstance,
  db: Db,
  rules: { independentReview: boolean },
  gate: Gate,
  security: () => SecurityService | null,
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

  /** Whoever may approve this review may dismiss a finding or send them back. Nobody else. */
  async function mayDecide(
    row: InteractionRow,
    me: { id: string; roles: Parameters<typeof checkAnswer>[1]['roles'] },
    decision: 'approved' | 'changes_requested',
  ) {
    const [run] = row.runId
      ? await db.select().from(agentRun).where(eq(agentRun.id, row.runId))
      : [undefined];
    return checkAnswer(
      factsOf(row),
      { id: me.id, roles: me.roles },
      run ? { sponsorPersonId: run.sponsorPersonId, contributors: run.contributors } : null,
      { decision },
      rules,
    ).ok;
  }

  app.get('/api/interactions/:id/security', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const review = await loadReview(id);
    if (!review) return reply.code(404).send(notAReview);
    const svc = security();
    if (!svc) {
      const off: SecurityDto = {
        available: false,
        required: false,
        commit: review.headSha,
        run: null,
        blocks: null,
      };
      return off;
    }
    const latest = await svc.forCommit(review.repository, review.prNumber, review.headSha);
    const value: SecurityDto = securitySchema.parse({
      available: true,
      required: svc.required(review.row),
      commit: review.headSha,
      run: latest
        ? {
            id: latest.id,
            state: latest.state,
            summary: latest.summary,
            findings: latest.findings,
            detail: latest.detail,
            by: await svc.nameOf(latest.startedBy),
            startedAt: latest.createdAt.toISOString(),
            finishedAt: latest.finishedAt?.toISOString() ?? null,
          }
        : null,
      blocks: await svc.blocks(review.row),
    });
    return value;
  });

  app.post('/api/interactions/:id/security/start', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (me.roles.length === 0)
      return reply.code(403).send({
        error: {
          code: 'wrong_role',
          message: 'Only a person with a role can run a security review.',
        },
      });
    const svc = security();
    if (!svc)
      return reply.code(409).send({
        error: {
          code: 'security_off',
          message: 'This platform has no Security agent or model gateway, so it cannot run one.',
        },
      });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const out = await svc.start(id, me.id);
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(out.existing ? 200 : 202).send({ id: out.row.id, state: out.row.state });
  });

  app.post('/api/interactions/:id/security/findings/:fid/dismiss', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const svc = security();
    const { id, fid } = z
      .object({ id: z.string().uuid(), fid: z.string().min(1).max(20) })
      .parse(request.params);
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
    if (!(await mayDecide(review.row, me, 'approved')))
      return reply.code(403).send({
        error: {
          code: 'wrong_role',
          message: 'Only a person who may approve this review can dismiss a finding.',
        },
      });
    const out = await svc.dismiss(id, fid, me, body.data.reason);
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(201).send({ id: out.row.id, state: out.row.state });
  });

  // One click turns the open findings into a change request: the engineer's revision loop takes it from there.
  app.post('/api/interactions/:id/security/send-back', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const svc = security();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const review = await loadReview(id);
    if (!review || !svc) return reply.code(404).send(notAReview);
    const latest = await svc.forCommit(review.repository, review.prNumber, review.headSha);
    if (!latest || latest.state !== 'done')
      return reply.code(409).send({
        error: {
          code: 'no_review',
          message: 'There is no finished security review of this commit.',
        },
      });
    const open = (latest.findings as SecurityFinding[]).filter((f) => !f.dismissed);
    const send = open.filter((f) => ['critical', 'high', 'medium'].includes(f.severity));
    if (send.length === 0)
      return reply.code(409).send({
        error: { code: 'nothing_to_send', message: 'There are no open findings to send back.' },
      });
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
        answer: findingsAsChangeRequest(send).slice(0, 3900),
        decision: 'changes_requested',
        makeStanding: false,
        standingScope: 'initiative',
        didntNeedToAsk: false,
      },
    );
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return reply.code(201).send({ sent: send.length });
  });
}
