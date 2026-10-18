import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { agentRun, hat, initiative, interaction, notification, person } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import {
  chatAnswerable,
  deliveryDecision,
  digestDue,
  escalationChain,
  needsDecision,
  nextAttentionAction,
  urgencyOf,
  withinHours,
} from '@sdlc/core';
import type { AttentionPolicy, Hours, InteractionType, OutOfOffice } from '@sdlc/core';
import { recordActivity } from './activity.js';
import { applyDueDefaults } from './interactions.js';
import type { InteractionRow } from './interactions.js';
import type { NotificationBody, NotificationKind, Notifier } from './notifier.js';

export interface AttentionDeps {
  db: Db;
  policy: AttentionPolicy;
  notifier: Notifier;
  /** Where the Workspace is, for deep links. */
  publicUrl: string;
  independentReview: boolean;
  log?: (line: string) => void;
}

export interface TickResult {
  assigned: number;
  reminded: number;
  escalated: number;
  defaulted: number;
  delivered: number;
  held: number;
  digests: number;
}

interface HatRow {
  personId: string;
  role: string;
  deputyPersonId: string | null;
  hours: Hours | null;
  outOfOffice: OutOfOffice | null;
}

interface World {
  people: Map<
    string,
    { id: string; displayName: string; active: boolean; slackUserId: string | null }
  >;
  hats: HatRow[];
}

async function loadWorld(db: Db): Promise<World> {
  const people = await db
    .select({
      id: person.id,
      displayName: person.displayName,
      active: person.active,
      slackUserId: person.slackUserId,
    })
    .from(person);
  const hats = await db.select().from(hat);
  return {
    people: new Map(people.map((p) => [p.id, p])),
    hats: hats.map((h) => ({
      personId: h.personId,
      role: h.role,
      deputyPersonId: h.deputyPersonId,
      hours: (h.hours as Hours | null) ?? null,
      outOfOffice: (h.outOfOffice as OutOfOffice | null) ?? null,
    })),
  };
}

/** Where this person's working hours come from for an ask: the hat for its role, else any hat that sets hours. */
function hoursFor(world: World, personId: string, role: string | null): Hours | null {
  const mine = world.hats.filter((h) => h.personId === personId);
  return (
    mine.find((h) => h.role === role && h.hours)?.hours ?? mine.find((h) => h.hours)?.hours ?? null
  );
}

export function buildBody(
  row: InteractionRow,
  kind: NotificationKind,
  deps: Pick<AttentionDeps, 'policy' | 'publicUrl'>,
  extra: { summary?: string; level?: number; appliedDefault?: string } = {},
): NotificationBody {
  const triggers = (row.contextCard as { triggers?: unknown }).triggers;
  const options = Array.isArray(row.options)
    ? (row.options as Array<{ id: string; label: string }>).map((o) => ({
        id: o.id,
        label: o.label,
      }))
    : undefined;
  const base = {
    type: row.type,
    hardStop: row.hardStop,
    blocksCount: row.blocks.length,
  };
  return {
    kind,
    urgency:
      kind === 'default_applied'
        ? 'digest'
        : urgencyOf({
            type: base.type,
            hardStop: base.hardStop,
            blocksCount: base.blocksCount,
          }),
    interactionId: row.id,
    title: row.title,
    ...base,
    summary: extra.summary,
    options,
    recommendation: row.recommendation,
    dueAt: row.dueAt?.toISOString() ?? null,
    chat: chatAnswerable(
      {
        type: row.type,
        hardStop: row.hardStop,
        triggered: Array.isArray(triggers) && triggers.length > 0,
      },
      deps.policy,
    ),
    link: `${deps.publicUrl}/#/queue/${row.id}`,
    level: extra.level,
    appliedDefault: extra.appliedDefault,
  };
}

/**
 * One pass of the human-injection engine: apply defaults that came due, hand out new asks, remind,
 * escalate along the hat's chain, and deliver what is waiting to be sent. Safe to run often and to run twice.
 */
export async function attentionTick(deps: AttentionDeps, now = new Date()): Promise<TickResult> {
  const { db, policy } = deps;
  const result: TickResult = {
    assigned: 0,
    reminded: 0,
    escalated: 0,
    defaulted: 0,
    delivered: 0,
    held: 0,
    digests: 0,
  };
  const world = await loadWorld(db);
  const activeIds = new Set([...world.people.values()].filter((p) => p.active).map((p) => p.id));
  const leads = world.hats.filter((h) => h.role === 'platform_admin').map((h) => h.personId);

  const describe = new Map<string, string>();
  const summaryOf = async (row: InteractionRow): Promise<string> => {
    const hit = describe.get(row.id);
    if (hit) return hit;
    const [init] = await db
      .select({ title: initiative.title })
      .from(initiative)
      .where(eq(initiative.id, row.initiativeId));
    const [run] = row.runId
      ? await db
          .select({ role: agentRun.agentRole })
          .from(agentRun)
          .where(eq(agentRun.id, row.runId))
      : [undefined];
    const text = [run?.role?.replace(/_/g, ' '), init?.title].filter(Boolean).join(' · ');
    describe.set(row.id, text);
    return text;
  };

  const chainOf = async (row: InteractionRow): Promise<string[]> => {
    const holders = world.hats
      .filter((h) => h.role === row.roleNeeded)
      .sort((a, b) => a.personId.localeCompare(b.personId))
      .map((h) => ({
        personId: h.personId,
        deputyPersonId: h.deputyPersonId,
        outOfOffice: h.outOfOffice,
      }));
    let chain = escalationChain(holders, leads, activeIds, now);
    // Whoever started or steered a run cannot review it, so the ask never goes to them.
    if (deps.independentReview && row.runId && needsDecision(row.type as InteractionType)) {
      const [run] = await db.select().from(agentRun).where(eq(agentRun.id, row.runId));
      if (run) {
        const barred = new Set([run.sponsorPersonId, ...run.contributors]);
        chain = chain.filter((id) => !barred.has(id));
      }
    }
    return chain;
  };

  const enqueue = async (
    personId: string,
    row: InteractionRow,
    kind: NotificationKind,
    extra: { level?: number; appliedDefault?: string } = {},
  ) => {
    await db.insert(notification).values({
      personId,
      interactionId: row.id,
      kind,
      channel: deps.notifier.channel,
      status: 'pending',
      body: buildBody(row, kind, deps, { ...extra, summary: await summaryOf(row) }),
    });
  };

  // 1. Defaults that came due. The person who owned the ask is told what was applied.
  result.defaulted = await applyDueDefaults(db, now, async (row) => {
    const to = row.assignedPersonId ?? (await chainOf(row))[0];
    if (to) await enqueue(to, row, 'default_applied', { appliedDefault: row.defaultValue ?? '' });
  });

  // 2. Hand out, remind, escalate.
  const open = await db
    .select()
    .from(interaction)
    .where(and(eq(interaction.state, 'open'), ne(interaction.type, 'notice')));
  for (const row of open) {
    const chain = await chainOf(row);
    // If the assignee is not in the chain any more (hat changed), count from where they would be.
    const at = row.assignedPersonId ? chain.indexOf(row.assignedPersonId) : -1;
    const level = at >= 0 ? at : row.escalationLevel;
    const action = nextAttentionAction(
      { ...row, escalationLevel: level },
      chain.length,
      now,
      policy,
    );

    if (action === 'assign' && chain[0]) {
      const [moved] = await db
        .update(interaction)
        .set({ assignedPersonId: chain[0], escalationLevel: 0, levelStartedAt: now })
        .where(
          and(
            eq(interaction.id, row.id),
            eq(interaction.state, 'open'),
            sql`${interaction.assignedPersonId} is null`,
          ),
        )
        .returning();
      if (!moved) continue;
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: row.initiativeId,
        runId: row.runId,
        interactionId: row.id,
        action: 'interaction.assigned',
        detail: { to: chain[0], role: row.roleNeeded },
      });
      await enqueue(chain[0], moved, 'ask');
      result.assigned++;
    } else if (action === 'remind' && row.assignedPersonId) {
      const [moved] = await db
        .update(interaction)
        .set({ reminderCount: row.reminderCount + 1, lastRemindedAt: now })
        .where(
          and(
            eq(interaction.id, row.id),
            eq(interaction.state, 'open'),
            eq(interaction.reminderCount, row.reminderCount),
          ),
        )
        .returning();
      if (!moved) continue;
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: row.initiativeId,
        runId: row.runId,
        interactionId: row.id,
        action: 'interaction.reminded',
        detail: { to: row.assignedPersonId, count: moved.reminderCount, level },
      });
      await enqueue(row.assignedPersonId, moved, 'reminder', { level });
      result.reminded++;
    } else if (action === 'escalate') {
      const next = chain[level + 1];
      if (!next) continue;
      const [moved] = await db
        .update(interaction)
        .set({
          assignedPersonId: next,
          escalationLevel: level + 1,
          levelStartedAt: now,
          reminderCount: 0,
          lastRemindedAt: null,
        })
        .where(
          and(
            eq(interaction.id, row.id),
            eq(interaction.state, 'open'),
            eq(interaction.escalationLevel, row.escalationLevel),
          ),
        )
        .returning();
      if (!moved) continue;
      await recordActivity(db, {
        actorType: 'system',
        initiativeId: row.initiativeId,
        runId: row.runId,
        interactionId: row.id,
        action: 'interaction.escalated',
        detail: { from: row.assignedPersonId, to: next, level: level + 1 },
      });
      await enqueue(next, moved, 'escalation', { level: level + 1 });
      result.escalated++;
    }
  }

  // 3. Deliver. Quiet hours and the digest hold messages back. A hard stop is never held.
  const waiting = await db
    .select()
    .from(notification)
    .where(inArray(notification.status, ['pending', 'held']))
    .orderBy(notification.createdAt)
    .limit(200);
  const heldForDigest = new Map<string, Array<(typeof waiting)[number]>>();
  for (const n of waiting) {
    const body = n.body as NotificationBody;
    const who = world.people.get(n.personId);
    const [row] = n.interactionId
      ? await db.select().from(interaction).where(eq(interaction.id, n.interactionId))
      : [undefined];
    const stale =
      !who?.active ||
      (row &&
        body.kind !== 'default_applied' &&
        body.kind !== 'digest' &&
        (row.state !== 'open' || row.assignedPersonId !== n.personId));
    if (stale) {
      await db
        .update(notification)
        .set({ status: 'skipped', error: 'settled before it was sent' })
        .where(eq(notification.id, n.id));
      continue;
    }
    const hours = hoursFor(world, n.personId, row?.roleNeeded ?? null);
    const decision = deliveryDecision(
      { urgency: body.urgency, hardStop: Boolean(body.hardStop), hours },
      now,
      policy,
    );
    if (decision === 'hold') {
      if (n.status !== 'held')
        await db.update(notification).set({ status: 'held' }).where(eq(notification.id, n.id));
      if (body.urgency === 'digest')
        heldForDigest.set(n.personId, [...(heldForDigest.get(n.personId) ?? []), n]);
      result.held++;
      continue;
    }
    await send(deps, world, n);
    result.delivered++;
  }

  // 4. One digest per person per day, for what was held back for it.
  if (policy.digestAt) {
    for (const [personId, items] of heldForDigest) {
      const who = world.people.get(personId);
      if (!who) continue;
      const [last] = await db
        .select({ at: notification.createdAt })
        .from(notification)
        .where(and(eq(notification.personId, personId), eq(notification.kind, 'digest')))
        .orderBy(desc(notification.createdAt))
        .limit(1);
      if (!digestDue(policy, now, last?.at ?? null)) continue;
      if (!withinHours(hoursFor(world, personId, null) ?? policy.defaultHours, now)) continue;
      const body: NotificationBody = {
        kind: 'digest',
        urgency: 'now',
        title: 'Digest',
        chat: false,
        link: `${deps.publicUrl}/#/queue`,
        // An ask that was reminded about while it waited is listed once.
        items: [...new Map(items.map((i) => [i.interactionId ?? i.id, i])).values()].map((i) => ({
          title: (i.body as NotificationBody).title,
          link: (i.body as NotificationBody).link,
        })),
      };
      const [made] = await db
        .insert(notification)
        .values({
          personId,
          kind: 'digest',
          channel: deps.notifier.channel,
          status: 'pending',
          body,
        })
        .returning();
      await send(deps, world, made!);
      await db
        .update(notification)
        .set({ status: 'skipped', error: 'included in the digest' })
        .where(
          inArray(
            notification.id,
            items.map((i) => i.id),
          ),
        );
      result.digests++;
    }
  }
  return result;
}

async function send(
  deps: AttentionDeps,
  world: World,
  n: typeof notification.$inferSelect,
): Promise<void> {
  const who = world.people.get(n.personId)!;
  try {
    const out = await deps.notifier.deliver(
      { personId: who.id, displayName: who.displayName, slackUserId: who.slackUserId },
      n.body as NotificationBody,
    );
    if ('skipped' in out) {
      await deps.db
        .update(notification)
        .set({ status: 'skipped', error: out.skipped })
        .where(eq(notification.id, n.id));
    } else {
      await deps.db
        .update(notification)
        .set({ status: 'sent', sentAt: new Date(), externalRef: out.ref ?? null })
        .where(eq(notification.id, n.id));
    }
  } catch (e) {
    deps.log?.(`notification ${n.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    await deps.db
      .update(notification)
      .set({ status: 'failed', error: e instanceof Error ? e.message : String(e) })
      .where(eq(notification.id, n.id));
  }
}
