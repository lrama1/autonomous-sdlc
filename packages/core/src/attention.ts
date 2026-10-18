// Who gets an ask, when they are reminded, when it moves up the chain, and what may be answered in chat
// (spec 5.4 to 5.6, mvp-contract section 5). Pure: the caller passes the clock and the facts.

export interface Hours {
  /** IANA time zone, for example "America/New_York". Defaults to UTC. */
  tz?: string;
  /** ISO weekdays, 1 is Monday and 7 is Sunday. Every day when absent. */
  days?: number[];
  /** "HH:MM". A window that ends before it starts runs past midnight. */
  start: string;
  end: string;
}

export interface OutOfOffice {
  from: string;
  until: string;
  /** Who covers while this person is away. The deputy covers when absent. */
  delegateTo?: string | null;
}

export interface HatInfo {
  personId: string;
  deputyPersonId: string | null;
  outOfOffice: OutOfOffice | null;
}

export interface AttentionPolicy {
  /** First nudge, counted from when the current person was given the ask. */
  reminderAfterMs: number;
  /** Move to the next person in the chain. */
  escalateAfterMs: number;
  maxRemindersPerLevel: number;
  /** "HH:MM" in `tz`. Low-priority asks wait for this time. Absent means they go out at once. */
  digestAt: string | null;
  tz: string;
  /** Applies to people whose hat has no hours of its own. Absent means always reachable. */
  defaultHours: Hours | null;
  /** Interaction types that may be settled from chat. Reviews also need that no trigger fired. */
  chatApprove: Array<'question' | 'decision' | 'review'>;
}

export const DEFAULT_ATTENTION_POLICY: AttentionPolicy = {
  reminderAfterMs: 2 * 3600_000,
  escalateAfterMs: 4 * 3600_000,
  maxRemindersPerLevel: 3,
  digestAt: null,
  tz: 'UTC',
  defaultHours: null,
  chatApprove: ['question', 'decision'],
};

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The weekday, minutes since midnight and calendar date at `at` in `tz`. */
export function localParts(at: Date, tz = 'UTC'): { day: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: WEEKDAY[get('weekday')] ?? 1,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** True when `at` falls inside the working window. No hours means always reachable. */
export function withinHours(hours: Hours | null | undefined, at: Date): boolean {
  if (!hours) return true;
  const { day, minutes } = localParts(at, hours.tz ?? 'UTC');
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  if (start === end) return true;
  if (start < end) {
    return (!hours.days || hours.days.includes(day)) && minutes >= start && minutes < end;
  }
  // Past midnight: the late part belongs to the day the window started on.
  if (minutes >= start) return !hours.days || hours.days.includes(day);
  if (minutes < end) {
    const previous = day === 1 ? 7 : day - 1;
    return !hours.days || hours.days.includes(previous);
  }
  return false;
}

export function isOutOfOffice(ooo: OutOfOffice | null | undefined, at: Date): boolean {
  if (!ooo) return false;
  const t = at.getTime();
  return new Date(ooo.from).getTime() <= t && t < new Date(ooo.until).getTime();
}

/**
 * The people an ask goes to, in order: each holder of the hat (or whoever covers while they are away),
 * then that holder's deputy, then the team leads. Inactive people are skipped.
 */
export function escalationChain(
  holders: HatInfo[],
  leadPersonIds: string[],
  activePersonIds: ReadonlySet<string>,
  at: Date,
): string[] {
  const chain: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && activePersonIds.has(id) && !chain.includes(id)) chain.push(id);
  };
  for (const h of holders) {
    if (isOutOfOffice(h.outOfOffice, at)) {
      add(h.outOfOffice?.delegateTo ?? h.deputyPersonId);
    } else {
      add(h.personId);
      add(h.deputyPersonId);
    }
  }
  for (const id of leadPersonIds) add(id);
  return chain;
}

export interface AttentionFacts {
  state: string;
  type: string;
  assignedPersonId: string | null;
  escalationLevel: number;
  reminderCount: number;
  createdAt: Date;
  levelStartedAt: Date | null;
  lastRemindedAt: Date | null;
  snoozedUntil: Date | null;
}

export type AttentionAction = 'none' | 'assign' | 'remind' | 'escalate';

/** What the worker should do with an open ask right now. A reminder never approves anything. */
export function nextAttentionAction(
  i: AttentionFacts,
  chainLength: number,
  now: Date,
  policy: AttentionPolicy,
): AttentionAction {
  if (i.state !== 'open' || i.type === 'notice') return 'none';
  if (i.snoozedUntil && i.snoozedUntil.getTime() > now.getTime()) return 'none';
  if (!i.assignedPersonId) return chainLength > 0 ? 'assign' : 'none';

  const start = (i.levelStartedAt ?? i.createdAt).getTime();
  const elapsed = now.getTime() - start;
  if (elapsed >= policy.escalateAfterMs) {
    if (i.escalationLevel + 1 < chainLength) return 'escalate';
    // Nobody is left to move up to, so keep reminding the last person at the same pace.
    const last = (i.lastRemindedAt ?? i.levelStartedAt ?? i.createdAt).getTime();
    return now.getTime() - last >= policy.escalateAfterMs ? 'remind' : 'none';
  }
  if (
    i.reminderCount < policy.maxRemindersPerLevel &&
    elapsed >= policy.reminderAfterMs * (i.reminderCount + 1)
  ) {
    return 'remind';
  }
  return 'none';
}

export type Urgency = 'now' | 'digest';

/** Asks that block work, and every review, checkpoint or hard stop, go out at once. The rest can wait for the digest. */
export function urgencyOf(i: { type: string; hardStop: boolean; blocksCount: number }): Urgency {
  if (i.hardStop || i.type === 'checkpoint' || i.type === 'review') return 'now';
  if (i.type === 'notice') return 'digest';
  return i.blocksCount > 0 ? 'now' : 'digest';
}

export type Delivery = 'send' | 'hold';

/** Hard stops always reach a person. Everything else respects working hours, and low-priority asks wait for the digest. */
export function deliveryDecision(
  o: { urgency: Urgency; hardStop: boolean; hours: Hours | null | undefined },
  now: Date,
  policy: AttentionPolicy,
): Delivery {
  if (o.hardStop) return 'send';
  if (!withinHours(o.hours ?? policy.defaultHours, now)) return 'hold';
  if (o.urgency === 'digest' && policy.digestAt) return 'hold';
  return 'send';
}

/** True once today's digest time has passed and none went out today. */
export function digestDue(policy: AttentionPolicy, now: Date, lastDigestAt: Date | null): boolean {
  if (!policy.digestAt) return false;
  const here = localParts(now, policy.tz);
  if (here.minutes < minutesOf(policy.digestAt)) return false;
  return !lastDigestAt || localParts(lastDigestAt, policy.tz).date < here.date;
}

/** May this ask be settled from chat? Spec 5.5. */
export function chatAnswerable(
  i: { type: string; hardStop: boolean; triggered: boolean },
  policy: AttentionPolicy,
): boolean {
  if (i.hardStop || i.type === 'checkpoint' || i.type === 'notice') return false;
  if (i.type === 'review') return policy.chatApprove.includes('review') && !i.triggered;
  return (
    (i.type === 'question' || i.type === 'decision') &&
    policy.chatApprove.includes(i.type as 'question' | 'decision')
  );
}
