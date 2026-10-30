import { desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { initiative, interaction } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import type { RuleSet } from '@sdlc/core';
import { autonomyModeSchema, autopilotSchema } from '@sdlc/schemas';
import { z } from 'zod';
import { recordActivity } from './activity.js';
import { ALONGSIDE_WARNING, repositoryHasWork } from './repository-work.js';
import { requirePerson } from './people.js';

interface PrCard {
  prNumber?: number;
  prUrl?: string;
  autoMerge?: { auto: boolean; reason: string; rule: string | null };
  gate?: { state?: string; detail?: string };
}

const describePaths = (when: Record<string, unknown>): string =>
  Object.entries(when)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('; ');

/** What may merge without a review, what did, and what was held for a person, with the reasons (spec 6.2). */
export function registerAutopilotRoutes(app: FastifyInstance, db: Db, rules: RuleSet): void {
  app.get('/api/autopilot', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(request.query);
    const from = new Date(Date.now() - days * 86_400_000);

    const inits = await db
      .select({ id: initiative.id, title: initiative.title, autonomyMode: initiative.autonomyMode })
      .from(initiative)
      .orderBy(desc(initiative.createdAt));
    const reviews = await db
      .select({ i: interaction, initiativeTitle: initiative.title })
      .from(interaction)
      .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
      .where(
        sql`${interaction.type} = 'review' and ${interaction.contextCard} ->> 'kind' = 'pull_request' and ${gte(interaction.createdAt, from)}`,
      )
      .orderBy(desc(interaction.createdAt));

    const recent = reviews.map(({ i, initiativeTitle }) => {
      const c = i.contextCard as PrCard;
      const answer = i.answer as { source?: string; rule?: string | null } | null;
      const decidedBy =
        i.state === 'open' ? 'waiting' : answer?.source === 'policy' ? 'rule' : 'person';
      return {
        interactionId: i.id,
        title: i.title,
        prNumber: c.prNumber ?? null,
        prUrl: c.prUrl ?? null,
        initiativeTitle,
        decidedBy,
        reason:
          c.autoMerge?.reason ??
          (decidedBy === 'person' ? 'A person reviewed it.' : 'Waiting for a person.'),
        rule: c.autoMerge?.rule ?? null,
        outcome:
          i.state === 'open'
            ? 'waiting for a person'
            : (c.gate?.state ?? (i.answer as { decision?: string } | null)?.decision ?? i.state),
        at: i.createdAt.toISOString(),
      } as const;
    });

    return autopilotSchema.parse({
      rules: rules.pre_approved_change_types.map((p) => {
        const reviewBy = p.review_by ? new Date(p.review_by) : null;
        return {
          id: p.id,
          owner: p.owner ?? null,
          reviewBy: reviewBy ? reviewBy.toISOString().slice(0, 10) : null,
          expired: reviewBy ? reviewBy.getTime() < Date.now() : false,
          paths: describePaths(p.when as Record<string, unknown>),
        };
      }),
      initiatives: inits,
      recent,
      counts: {
        byRule: recent.filter((r) => r.decidedBy === 'rule').length,
        byPerson: recent.filter((r) => r.decidedBy === 'person').length,
        waiting: recent.filter((r) => r.decidedBy === 'waiting').length,
      },
    });
  });

  // Who may loosen or tighten how much runs on its own.
  app.patch('/api/initiatives/:id', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!me.roles.includes('platform_admin') && !me.roles.includes('product_owner')) {
      return reply.code(403).send({
        error: {
          code: 'wrong_role',
          message:
            'Only a Product Owner or a Platform Admin can change the autonomy mode or the kind.',
        },
      });
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        autonomyMode: autonomyModeSchema.optional(),
        kind: z.enum(['new_app', 'feature', 'change']).optional(),
        acknowledgeSharedRepository: z.boolean().optional(),
      })
      .refine((b) => b.autonomyMode !== undefined || b.kind !== undefined, {
        message: 'Say what to change: autonomyMode or kind.',
      })
      .safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({
        error: { code: 'bad_request', message: body.error.issues[0]?.message ?? 'Bad request.' },
      });
    const [before] = await db
      .select({
        mode: initiative.autonomyMode,
        kind: initiative.kind,
        createdAt: initiative.createdAt,
      })
      .from(initiative)
      .where(eq(initiative.id, id));
    if (!before)
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such initiative.' } });
    const { autonomyMode, kind } = body.data;
    // Only a new app next to another app is built apart from it.
    const [repoOf] = kind
      ? await db
          .select({ repositoryId: initiative.repositoryId })
          .from(initiative)
          .where(eq(initiative.id, id))
      : [];
    const alongside =
      kind === 'new_app' && repoOf
        ? await repositoryHasWork(db, repoOf.repositoryId, { id, createdAt: before.createdAt })
        : false;
    if (alongside && before.kind !== 'new_app' && !body.data.acknowledgeSharedRepository)
      return reply.code(409).send({
        error: {
          code: 'shared_repository',
          message: `${ALONGSIDE_WARNING} To go ahead anyway, confirm that you understand this.`,
        },
      });
    await db
      .update(initiative)
      .set({
        ...(autonomyMode ? { autonomyMode } : {}),
        ...(kind ? { kind, alongside } : {}),
      })
      .where(eq(initiative.id, id));
    if (autonomyMode)
      await recordActivity(db, {
        actorType: 'person',
        actorId: me.id,
        initiativeId: id,
        action: 'initiative.autonomy_changed',
        detail: { from: before.mode, to: autonomyMode },
      });
    // Steps and tasks already written keep the words they were given. Later ones use the new kind.
    if (kind)
      await recordActivity(db, {
        actorType: 'person',
        actorId: me.id,
        initiativeId: id,
        action: 'initiative.kind_changed',
        detail: { from: before.kind, to: kind },
      });
    return { id, autonomyMode: autonomyMode ?? before.mode, kind: kind ?? before.kind };
  });
}
