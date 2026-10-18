import { and, count, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  activityEvent,
  agentRun,
  assumption,
  hat,
  initiative,
  interaction,
  person,
  standingDecision,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { computeInterruptionMetrics, defaultRoleForAgent } from '@sdlc/core';
import type { AskRow, AttentionPolicy, Hours, OutOfOffice } from '@sdlc/core';
import {
  assumptionSchema,
  attentionProfileSchema,
  interruptionMetricsSchema,
  roleSchema,
  standingDecisionCreateSchema,
  standingDecisionPatchSchema,
  standingDecisionSchema,
} from '@sdlc/schemas';
import { z } from 'zod';
import { recordActivity } from './activity.js';
import { createInteraction } from './interactions.js';
import { requirePerson } from './people.js';
import type { Signed } from './people.js';

const notFound = (what: string) => ({ error: { code: 'not_found', message: `No such ${what}.` } });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const hoursSchema = z
  .object({
    tz: z.string().max(60).optional(),
    days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    start: hhmm,
    end: hhmm,
  })
  .refine(
    (h) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: h.tz ?? 'UTC' });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown time zone' },
  );

const oooSchema = z
  .object({
    from: z.string().datetime(),
    until: z.string().datetime(),
    delegateTo: z.string().uuid().nullable().optional(),
  })
  .refine((o) => new Date(o.from) < new Date(o.until), { message: 'until must be after from' });

const hatPatchSchema = z.object({
  deputyPersonId: z.string().uuid().nullable().optional(),
  hours: hoursSchema.nullable().optional(),
  outOfOffice: oooSchema.nullable().optional(),
});

const isAdmin = (me: Signed) => me.roles.includes('platform_admin');

/** What an ask was about, so repeated asks can be grouped and a standing decision suggested. */
function situationOf(r: typeof interaction.$inferSelect): string {
  if (r.topicKey) return r.topicKey;
  const card = r.contextCard as { kind?: string; triggers?: Array<{ id?: string }> };
  if (card.triggers?.[0]?.id) return `trigger: ${card.triggers[0].id}`;
  if (card.kind === 'pull_request') return 'pull request review';
  if (card.kind) return card.kind.replace(/_/g, ' ');
  return 'untagged questions';
}

export function registerAttentionRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { policy: AttentionPolicy; chatConfigured: boolean },
): void {
  const { policy } = opts;

  // ---------------------------------------------------------------- standing decisions
  app.get('/api/standing-decisions', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const q = z
      .object({ active: z.enum(['true', 'false', 'all']).default('true') })
      .parse(request.query);
    const rows = await db
      .select({ sd: standingDecision, by: person.displayName })
      .from(standingDecision)
      .leftJoin(person, eq(person.id, standingDecision.createdBy))
      .where(q.active === 'all' ? undefined : eq(standingDecision.active, q.active === 'true'))
      .orderBy(desc(standingDecision.createdAt));
    const used = await db
      .select({ id: interaction.standingDecisionId, n: count() })
      .from(interaction)
      .where(eq(interaction.answeredVia, 'standing'))
      .groupBy(interaction.standingDecisionId);
    const usedBy = new Map(used.map((u) => [u.id, u.n]));
    return rows.map((r) =>
      standingDecisionSchema.parse({
        id: r.sd.id,
        scope: r.sd.scope,
        scopeId: r.sd.scopeId,
        topic: r.sd.topic,
        text: r.sd.text,
        active: r.sd.active,
        createdBy: r.sd.createdBy,
        createdByName: r.by,
        createdAt: r.sd.createdAt.toISOString(),
        answeredSince: usedBy.get(r.sd.id) ?? 0,
      }),
    );
  });

  app.post('/api/standing-decisions', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (me.roles.length === 0)
      return reply.code(403).send({
        error: { code: 'no_hat', message: 'You need a role to set a standing decision.' },
      });
    const body = standingDecisionCreateSchema.parse(request.body ?? {});
    if (body.scope !== 'global' && !body.scopeId) {
      return reply.code(400).send({
        error: {
          code: 'scope_id_required',
          message: 'Choose the repository or initiative it applies to.',
        },
      });
    }
    const [row] = await db
      .insert(standingDecision)
      .values({
        scope: body.scope,
        scopeId: body.scope === 'global' ? null : body.scopeId,
        topic: body.topic,
        text: body.text,
        createdBy: me.id,
      })
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'standing_decision.created',
      detail: { standingDecisionId: row!.id, scope: row!.scope, topic: row!.topic },
    });
    return reply.code(201).send({ id: row!.id });
  });

  app.patch('/api/standing-decisions/:id', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = standingDecisionPatchSchema.parse(request.body ?? {});
    const [sd] = await db.select().from(standingDecision).where(eq(standingDecision.id, id));
    if (!sd) return reply.code(404).send(notFound('standing decision'));
    if (sd.createdBy !== me.id && !isAdmin(me)) {
      return reply.code(403).send({
        error: {
          code: 'not_yours',
          message: 'Only the person who set it, or an admin, can change it.',
        },
      });
    }
    await db
      .update(standingDecision)
      .set({
        ...(body.text !== undefined ? { text: body.text } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      })
      .where(eq(standingDecision.id, id));
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: body.active === false ? 'standing_decision.retired' : 'standing_decision.updated',
      detail: { standingDecisionId: id },
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- assumptions
  app.get('/api/assumptions', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const q = z
      .object({ state: z.enum(['declared', 'accepted', 'rejected', 'all']).default('declared') })
      .parse(request.query);
    const rows = await db
      .select({
        a: assumption,
        initiativeTitle: initiative.title,
        agentRole: agentRun.agentRole,
        decidedByName: person.displayName,
      })
      .from(assumption)
      .innerJoin(initiative, eq(initiative.id, assumption.initiativeId))
      .innerJoin(agentRun, eq(agentRun.id, assumption.runId))
      .leftJoin(person, eq(person.id, assumption.decidedBy))
      .where(q.state === 'all' ? undefined : eq(assumption.state, q.state))
      .orderBy(desc(assumption.createdAt));
    return rows.map((r) =>
      assumptionSchema.parse({
        id: r.a.id,
        initiativeId: r.a.initiativeId,
        initiativeTitle: r.initiativeTitle,
        runId: r.a.runId,
        agentRole: r.agentRole,
        text: r.a.text,
        impact: r.a.impact,
        state: r.a.state,
        decidedByName: r.decidedByName,
        createdAt: r.a.createdAt.toISOString(),
      }),
    );
  });

  for (const verb of ['accept', 'reject'] as const) {
    app.post(`/api/assumptions/:id/${verb}`, async (request, reply) => {
      const me = await requirePerson(db, request, reply);
      if (!me) return;
      if (me.roles.length === 0)
        return reply.code(403).send({
          error: { code: 'no_hat', message: 'You need a role to decide on an assumption.' },
        });
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const state = verb === 'accept' ? 'accepted' : 'rejected';
      const [row] = await db
        .update(assumption)
        .set({ state, decidedBy: me.id })
        .where(and(eq(assumption.id, id), eq(assumption.state, 'declared')))
        .returning();
      if (!row) {
        const [exists] = await db
          .select({ id: assumption.id })
          .from(assumption)
          .where(eq(assumption.id, id));
        return exists
          ? reply.code(409).send({
              error: { code: 'already_decided', message: 'Someone already decided on this.' },
            })
          : reply.code(404).send(notFound('assumption'));
      }
      await recordActivity(db, {
        actorType: 'person',
        actorId: me.id,
        initiativeId: row.initiativeId,
        runId: row.runId,
        action: `assumption.${state}`,
        detail: { assumptionId: row.id, text: row.text },
      });
      // A rejected assumption must not be forgotten: the person who started the run is asked to decide what to redo.
      if (verb === 'reject') {
        const [run] = await db.select().from(agentRun).where(eq(agentRun.id, row.runId));
        if (run) {
          const { interaction: task } = await createInteraction(db, {
            initiativeId: row.initiativeId,
            runId: run.id,
            type: 'question',
            title: `Assumption rejected: ${row.text}`.slice(0, 200),
            contextCard: {
              kind: 'assumption_rejected',
              assumptionId: row.id,
              question: 'What should replace this assumption, and which work needs to be redone?',
            },
            blocks: [],
            roleNeeded: defaultRoleForAgent(run.agentRole),
          });
          await db
            .update(interaction)
            .set({ assignedPersonId: run.sponsorPersonId, levelStartedAt: new Date() })
            .where(eq(interaction.id, task.id));
        }
      }
      return { ok: true, state };
    });
  }

  // ---------------------------------------------------------------- interruption metrics
  app.get('/api/metrics/interruptions', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const q = z
      .object({
        days: z.coerce.number().int().min(7).max(365).default(30),
        initiativeId: z.string().uuid().optional(),
      })
      .parse(request.query);
    const now = new Date();
    const from = new Date(now.getTime() - q.days * 86_400_000);
    const scoped = q.initiativeId ? eq(interaction.initiativeId, q.initiativeId) : undefined;

    const asks = await db
      .select({ i: interaction, agentRole: agentRun.agentRole })
      .from(interaction)
      .leftJoin(agentRun, eq(agentRun.id, interaction.runId))
      .where(and(gte(interaction.createdAt, from), scoped));
    const merged = await db
      .select({ at: activityEvent.ts, agentRole: agentRun.agentRole })
      .from(activityEvent)
      .leftJoin(agentRun, eq(agentRun.id, activityEvent.runId))
      .where(
        and(
          eq(activityEvent.action, 'pull_request.merged'),
          gte(activityEvent.ts, from),
          q.initiativeId ? eq(activityEvent.initiativeId, q.initiativeId) : undefined,
        ),
      );
    const runs = await db
      .select({ startedAt: agentRun.startedAt, endedAt: agentRun.finishedAt })
      .from(agentRun)
      .where(
        and(
          sql`${agentRun.startedAt} is not null`,
          or(isNull(agentRun.finishedAt), gte(agentRun.finishedAt, from)),
          q.initiativeId ? eq(agentRun.initiativeId, q.initiativeId) : undefined,
        ),
      );
    const standing = await db
      .select({ id: standingDecision.id, topic: standingDecision.topic })
      .from(standingDecision)
      .where(eq(standingDecision.active, true));

    const rows: AskRow[] = asks.map(({ i, agentRole }) => {
      const a = i.answer as { text?: string; choice?: string | null } | null;
      return {
        type: i.type,
        state: i.state,
        agentRole,
        createdAt: i.createdAt,
        answeredAt: i.answeredAt,
        answeredVia: i.answeredVia,
        recommendation: i.recommendation,
        choice: a?.choice ?? null,
        text: a?.text ?? null,
        didntNeedToAsk: i.didntNeedToAsk,
        blocking: i.blocks.length > 0,
        situation: situationOf(i),
        standingDecisionId: i.standingDecisionId,
      };
    });
    const metrics = computeInterruptionMetrics(
      {
        asks: rows,
        merges: merged.map((m) => ({ at: m.at, agentRole: m.agentRole })),
        runs: runs.map((r) => ({ startedAt: r.startedAt!, endedAt: r.endedAt })),
        standing,
      },
      now,
      q.days,
    );
    return interruptionMetricsSchema.parse(metrics);
  });

  // ---------------------------------------------------------------- people, hats, and chat links
  app.get('/api/people', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const people = await db.select().from(person).where(eq(person.active, true));
    const hats = await db
      .select({ personId: hat.personId, role: hat.role })
      .from(hat)
      .where(
        inArray(
          hat.personId,
          people.map((p) => p.id),
        ),
      );
    return people.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      roles: hats.filter((h) => h.personId === p.id).map((h) => h.role),
      slackLinked: Boolean(p.slackUserId),
      // Only an admin sees the Slack user id itself.
      ...(isAdmin(me) ? { slackUserId: p.slackUserId } : {}),
    }));
  });

  // A reply from chat is trusted only because an admin linked that chat user to this person.
  app.put('/api/people/:id/slack', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!isAdmin(me))
      return reply.code(403).send({
        error: { code: 'admin_only', message: 'Only a platform admin can link a Slack account.' },
      });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { slackUserId } = z
      .object({
        slackUserId: z
          .string()
          .regex(/^[UW][A-Z0-9]{2,}$/)
          .nullable(),
      })
      .parse(request.body ?? {});
    const [taken] = slackUserId
      ? await db.select({ id: person.id }).from(person).where(eq(person.slackUserId, slackUserId))
      : [undefined];
    if (taken && taken.id !== id)
      return reply.code(409).send({
        error: {
          code: 'already_linked',
          message: 'That Slack account is linked to someone else.',
        },
      });
    const [row] = await db
      .update(person)
      .set({ slackUserId })
      .where(eq(person.id, id))
      .returning({ id: person.id });
    if (!row) return reply.code(404).send(notFound('person'));
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: slackUserId ? 'person.slack_linked' : 'person.slack_unlinked',
      detail: { personId: id },
    });
    return { ok: true };
  });

  // Deputy, working hours and time away, per hat. People set their own. An admin can set anyone's.
  app.patch('/api/people/:id/hats/:role', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const params = z.object({ id: z.string().uuid(), role: roleSchema }).parse(request.params);
    if (params.id !== me.id && !isAdmin(me))
      return reply
        .code(403)
        .send({ error: { code: 'not_yours', message: 'You can change only your own hats.' } });
    const body = hatPatchSchema.parse(request.body ?? {});
    if (body.deputyPersonId) {
      const [d] = await db.select().from(person).where(eq(person.id, body.deputyPersonId));
      if (!d?.active || d.id === params.id)
        return reply.code(400).send({
          error: { code: 'bad_deputy', message: 'The deputy must be another active person.' },
        });
    }
    const set: Partial<typeof hat.$inferInsert> = {};
    if (body.deputyPersonId !== undefined) set.deputyPersonId = body.deputyPersonId;
    if (body.hours !== undefined) set.hours = body.hours;
    if (body.outOfOffice !== undefined) set.outOfOffice = body.outOfOffice;
    if (Object.keys(set).length === 0) return { ok: true };
    const [row] = await db
      .update(hat)
      .set(set)
      .where(and(eq(hat.personId, params.id), eq(hat.role, params.role)))
      .returning({ id: hat.id });
    if (!row) return reply.code(404).send(notFound('hat'));
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'hat.updated',
      detail: { personId: params.id, role: params.role, fields: Object.keys(set) },
    });
    return { ok: true };
  });

  // "How you are reached" on the attention queue.
  app.get('/api/attention/profile', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const hats = await db.select().from(hat).where(eq(hat.personId, me.id));
    const deputyIds = hats.map((h) => h.deputyPersonId).filter((x): x is string => Boolean(x));
    const deputies = deputyIds.length
      ? await db.select().from(person).where(inArray(person.id, deputyIds))
      : [];
    const [self] = await db.select().from(person).where(eq(person.id, me.id));
    return attentionProfileSchema.parse({
      hats: hats.map((h) => ({
        role: roleSchema.parse(h.role),
        deputyName: deputies.find((d) => d.id === h.deputyPersonId)?.displayName ?? null,
        hours: (h.hours as Hours | null) ?? null,
        outOfOffice: (h.outOfOffice as OutOfOffice | null) ?? null,
      })),
      slackLinked: Boolean(self?.slackUserId),
      chatConfigured: opts.chatConfigured,
      reminderAfterMin: Math.round(policy.reminderAfterMs / 60_000),
      escalateAfterMin: Math.round(policy.escalateAfterMs / 60_000),
      digestAt: policy.digestAt,
      workingHours: policy.defaultHours,
    });
  });
}
