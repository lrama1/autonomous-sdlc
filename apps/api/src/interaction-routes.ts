import { and, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { agentRun, initiative, interaction, person } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { chatAnswerable, needsDecision, rankInteractions } from '@sdlc/core';
import type { AttentionPolicy, InteractionType } from '@sdlc/core';
import { answerRequestSchema, interactionSchema, interactionStateSchema } from '@sdlc/schemas';
import type { InteractionDto } from '@sdlc/schemas';
import { z } from 'zod';
import { recordActivity } from './activity.js';
import { REASONS, answerAsPerson } from './answering.js';
import type { Gate } from './gate.js';
import { getInteraction, markDidntNeedToAsk } from './interactions.js';
import type { InteractionRow } from './interactions.js';
import { requirePerson } from './people.js';

export const isTriggered = (r: InteractionRow): boolean => {
  const t = (r.contextCard as { triggers?: unknown }).triggers;
  return Array.isArray(t) && t.length > 0;
};

export function toDto(
  r: InteractionRow,
  extra: {
    policy?: AttentionPolicy;
    initiativeTitle?: string;
    agentRole?: string | null;
    assignedToName?: string | null;
    youMayNotDecide?: string | null;
  } = {},
): InteractionDto {
  return interactionSchema.parse({
    id: r.id,
    initiativeId: r.initiativeId,
    runId: r.runId,
    type: r.type,
    checkpointId: r.checkpointId,
    state: r.state,
    title: r.title,
    contextCard: r.contextCard,
    options: r.options,
    recommendation: r.recommendation,
    defaultValue: r.defaultValue,
    dueAt: r.dueAt?.toISOString() ?? null,
    blocks: r.blocks,
    roleNeeded: r.roleNeeded,
    hardStop: r.hardStop,
    answer: r.answer,
    answeredBy: r.answeredBy,
    answeredVia: r.answeredVia,
    answeredAt: r.answeredAt?.toISOString() ?? null,
    didntNeedToAsk: r.didntNeedToAsk,
    assignedPersonId: r.assignedPersonId,
    escalationLevel: r.escalationLevel,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    topicKey: r.topicKey,
    standingDecisionId: r.standingDecisionId,
    createdAt: r.createdAt.toISOString(),
    initiativeTitle: extra.initiativeTitle,
    agentRole: extra.agentRole,
    assignedToName: extra.assignedToName,
    youMayNotDecide: extra.youMayNotDecide,
    chatAnswerable: extra.policy
      ? chatAnswerable(
          { type: r.type, hardStop: r.hardStop, triggered: isTriggered(r) },
          extra.policy,
        )
      : undefined,
  });
}

const MAX_SNOOZE_MIN = 24 * 60;

/**
 * Why this person may not decide this ask, or null. The same rule the answer route applies: with independent review on,
 * whoever started or steered a run cannot decide its checkpoints and reviews. Told up front so the buttons can say so.
 */
export function youMayNotDecide(
  me: { id: string },
  row: { type: string },
  run: { sponsorPersonId: string; contributors: string[] } | null | undefined,
  rules: { independentReview: boolean },
): string | null {
  if (!rules.independentReview || !run || !needsDecision(row.type as InteractionType)) return null;
  return run.sponsorPersonId === me.id || run.contributors.includes(me.id)
    ? REASONS.independent_review!.message
    : null;
}

export function registerInteractionRoutes(
  app: FastifyInstance,
  db: Db,
  rules: { independentReview: boolean },
  gate?: Gate,
  policy?: AttentionPolicy,
  afterAnswer?: (row: InteractionRow) => Promise<void>,
): void {
  // The attention queue: what is waiting on me, ranked.
  app.get('/api/interactions', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const q = z
      .object({
        state: interactionStateSchema.default('open'),
        mine: z.enum(['true', 'false']).default('true'),
      })
      .parse(request.query);
    const mine =
      q.mine === 'true'
        ? or(
            eq(interaction.assignedPersonId, me.id),
            me.roles.length ? inArray(interaction.roleNeeded, me.roles) : undefined,
          )
        : undefined;
    const rows = await db
      .select({
        i: interaction,
        initiativeTitle: initiative.title,
        agentRole: agentRun.agentRole,
        assignedToName: person.displayName,
        sponsorPersonId: agentRun.sponsorPersonId,
        contributors: agentRun.contributors,
      })
      .from(interaction)
      .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
      .leftJoin(agentRun, eq(agentRun.id, interaction.runId))
      .leftJoin(person, eq(person.id, interaction.assignedPersonId))
      .where(and(eq(interaction.state, q.state), mine));
    const extras = new Map(rows.map((r) => [r.i.id, r]));
    return rankInteractions(rows.map((r) => r.i)).map((i) => {
      const e = extras.get(i.id)!;
      return toDto(i, {
        policy,
        initiativeTitle: e.initiativeTitle,
        agentRole: e.agentRole,
        assignedToName: e.assignedToName,
        youMayNotDecide: youMayNotDecide(
          me,
          e.i,
          e.sponsorPersonId
            ? { sponsorPersonId: e.sponsorPersonId, contributors: e.contributors ?? [] }
            : null,
          rules,
        ),
      });
    });
  });

  app.get('/api/interactions/:id', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await getInteraction(db, id);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'No such interaction.' } });
    const [run] = row.runId
      ? await db.select().from(agentRun).where(eq(agentRun.id, row.runId))
      : [undefined];
    return toDto(row, { policy, youMayNotDecide: youMayNotDecide(me, row, run, rules) });
  });

  app.post('/api/interactions/:id/answer', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = answerRequestSchema.parse(request.body ?? {});
    const out = await answerAsPerson(
      {
        db,
        rules,
        gate,
        afterAnswer,
        onGateError: (e) => request.log.error({ err: e }, 'gate failed after a decision'),
      },
      id,
      me,
      'workspace',
      body,
    );
    if (!out.ok)
      return reply.code(out.status).send({ error: { code: out.code, message: out.message } });
    return toDto(out.row, { policy });
  });

  // "Not now": the ask stays open and nobody is reminded until the time is up. A hard stop cannot be snoozed.
  app.post('/api/interactions/:id/snooze', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { minutes } = z
      .object({ minutes: z.number().int().min(5).max(MAX_SNOOZE_MIN).default(120) })
      .parse(request.body ?? {});
    const row = await getInteraction(db, id);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: REASONS.not_found!.message } });
    if (row.state !== 'open')
      return reply
        .code(409)
        .send({ error: { code: 'not_open', message: REASONS.not_open!.message } });
    const entitled = row.assignedPersonId === me.id || me.roles.includes(row.roleNeeded as never);
    if (!entitled)
      return reply
        .code(403)
        .send({ error: { code: 'wrong_role', message: REASONS.wrong_role!.message } });
    if (row.hardStop)
      return reply.code(409).send({
        error: { code: 'hard_stop', message: 'A hard stop cannot be snoozed.' },
      });
    const until = new Date(Date.now() + minutes * 60_000);
    const [updated] = await db
      .update(interaction)
      .set({ snoozedUntil: until })
      .where(and(eq(interaction.id, id), eq(interaction.state, 'open')))
      .returning();
    if (!updated)
      return reply
        .code(409)
        .send({ error: { code: 'not_open', message: REASONS.not_open!.message } });
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      initiativeId: row.initiativeId,
      runId: row.runId,
      interactionId: row.id,
      action: 'interaction.snoozed',
      detail: { until: until.toISOString() },
    });
    return toDto(updated, { policy });
  });

  app.post('/api/interactions/:id/didnt-need-to-ask', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await markDidntNeedToAsk(db, id, me.id);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'No such interaction.' } });
    return toDto(row, { policy });
  });
}
