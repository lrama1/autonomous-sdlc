import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTENTION_POLICY,
  chatAnswerable,
  deliveryDecision,
  digestDue,
  escalationChain,
  isOutOfOffice,
  nextAttentionAction,
  urgencyOf,
  withinHours,
} from './attention.js';
import type { AttentionFacts, AttentionPolicy, Hours } from './attention.js';

const H = 3600_000;
const policy: AttentionPolicy = { ...DEFAULT_ATTENTION_POLICY };
// A Wednesday.
const at = (iso: string) => new Date(iso);

describe('withinHours', () => {
  const office: Hours = {
    tz: 'America/New_York',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '17:00',
  };

  it('has no limits without hours', () => {
    expect(withinHours(null, at('2026-10-17T03:00:00Z'))).toBe(true);
  });

  it('reads the time in the hat time zone', () => {
    // 13:00 UTC is 09:00 in New York (daylight time).
    expect(withinHours(office, at('2026-10-14T13:00:00Z'))).toBe(true);
    expect(withinHours(office, at('2026-10-14T12:59:00Z'))).toBe(false);
    expect(withinHours(office, at('2026-10-14T20:59:00Z'))).toBe(true);
    expect(withinHours(office, at('2026-10-14T21:00:00Z'))).toBe(false);
  });

  it('skips days that are not worked', () => {
    // Saturday 2026-10-17 at noon in New York.
    expect(withinHours(office, at('2026-10-17T16:00:00Z'))).toBe(false);
  });

  it('handles a window that runs past midnight', () => {
    const night: Hours = { tz: 'UTC', days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' };
    expect(withinHours(night, at('2026-10-14T23:00:00Z'))).toBe(true); // Wednesday evening
    expect(withinHours(night, at('2026-10-15T05:00:00Z'))).toBe(true); // Thursday early morning
    expect(withinHours(night, at('2026-10-15T07:00:00Z'))).toBe(false);
    // Saturday early morning belongs to Friday's shift, Sunday early morning to Saturday's (not worked).
    expect(withinHours(night, at('2026-10-17T03:00:00Z'))).toBe(true);
    expect(withinHours(night, at('2026-10-18T03:00:00Z'))).toBe(false);
  });
});

describe('isOutOfOffice', () => {
  const ooo = { from: '2026-10-10T00:00:00Z', until: '2026-10-20T00:00:00Z' };
  it('covers the dates given and not the end instant', () => {
    expect(isOutOfOffice(ooo, at('2026-10-15T00:00:00Z'))).toBe(true);
    expect(isOutOfOffice(ooo, at('2026-10-20T00:00:00Z'))).toBe(false);
    expect(isOutOfOffice(null, at('2026-10-15T00:00:00Z'))).toBe(false);
  });
});

describe('escalationChain', () => {
  const now = at('2026-10-14T12:00:00Z');
  const active = new Set(['bob', 'sofia', 'lead', 'zed']);

  it('goes holder, deputy, then team leads', () => {
    const chain = escalationChain(
      [{ personId: 'bob', deputyPersonId: 'sofia', outOfOffice: null }],
      ['lead'],
      active,
      now,
    );
    expect(chain).toEqual(['bob', 'sofia', 'lead']);
  });

  it('skips someone who is away and uses their delegate, then the deputy', () => {
    const away = { from: '2026-10-10T00:00:00Z', until: '2026-10-20T00:00:00Z' };
    expect(
      escalationChain(
        [{ personId: 'bob', deputyPersonId: 'sofia', outOfOffice: { ...away, delegateTo: 'zed' } }],
        ['lead'],
        active,
        now,
      ),
    ).toEqual(['zed', 'lead']);
    expect(
      escalationChain(
        [{ personId: 'bob', deputyPersonId: 'sofia', outOfOffice: away }],
        ['lead'],
        active,
        now,
      ),
    ).toEqual(['sofia', 'lead']);
  });

  it('drops inactive people and duplicates', () => {
    const chain = escalationChain(
      [{ personId: 'bob', deputyPersonId: 'ghost', outOfOffice: null }],
      ['bob', 'lead'],
      active,
      now,
    );
    expect(chain).toEqual(['bob', 'lead']);
  });

  it('is empty when nobody holds the hat and there are no leads', () => {
    expect(escalationChain([], [], active, now)).toEqual([]);
  });
});

describe('nextAttentionAction', () => {
  const t0 = at('2026-10-14T09:00:00Z');
  const base: AttentionFacts = {
    state: 'open',
    type: 'question',
    assignedPersonId: 'bob',
    escalationLevel: 0,
    reminderCount: 0,
    createdAt: t0,
    levelStartedAt: t0,
    lastRemindedAt: null,
    snoozedUntil: null,
  };
  const later = (h: number) => new Date(t0.getTime() + h * H);

  it('assigns an unassigned ask when someone can take it', () => {
    expect(nextAttentionAction({ ...base, assignedPersonId: null }, 2, t0, policy)).toBe('assign');
    expect(nextAttentionAction({ ...base, assignedPersonId: null }, 0, t0, policy)).toBe('none');
  });

  it('leaves a fresh ask alone, then reminds, then escalates', () => {
    expect(nextAttentionAction(base, 3, later(1), policy)).toBe('none');
    expect(nextAttentionAction(base, 3, later(2), policy)).toBe('remind');
    expect(nextAttentionAction({ ...base, reminderCount: 1 }, 3, later(3), policy)).toBe('none');
    expect(nextAttentionAction({ ...base, reminderCount: 1 }, 3, later(4), policy)).toBe(
      'escalate',
    );
  });

  it('keeps reminding the last person in the chain, at the escalation pace', () => {
    const last = { ...base, escalationLevel: 2, reminderCount: 1 };
    expect(nextAttentionAction(last, 3, later(4), policy)).toBe('remind');
    const reminded = { ...last, lastRemindedAt: later(4) };
    expect(nextAttentionAction(reminded, 3, later(6), policy)).toBe('none');
    expect(nextAttentionAction(reminded, 3, later(8), policy)).toBe('remind');
  });

  it('stops at the reminder cap', () => {
    const p = { ...policy, maxRemindersPerLevel: 1, escalateAfterMs: 20 * H };
    expect(nextAttentionAction({ ...base, reminderCount: 1 }, 3, later(8), p)).toBe('none');
  });

  it('does nothing for settled asks, notices, and snoozed asks', () => {
    expect(nextAttentionAction({ ...base, state: 'answered' }, 3, later(9), policy)).toBe('none');
    expect(nextAttentionAction({ ...base, type: 'notice' }, 3, later(9), policy)).toBe('none');
    expect(nextAttentionAction({ ...base, snoozedUntil: later(10) }, 3, later(9), policy)).toBe(
      'none',
    );
    expect(nextAttentionAction({ ...base, snoozedUntil: later(10) }, 3, later(10), policy)).toBe(
      'escalate',
    );
  });
});

describe('urgency and delivery', () => {
  it('sends blocking asks, reviews and hard stops at once and leaves the rest for the digest', () => {
    expect(urgencyOf({ type: 'question', hardStop: false, blocksCount: 1 })).toBe('now');
    expect(urgencyOf({ type: 'question', hardStop: false, blocksCount: 0 })).toBe('digest');
    expect(urgencyOf({ type: 'review', hardStop: false, blocksCount: 0 })).toBe('now');
    expect(urgencyOf({ type: 'decision', hardStop: true, blocksCount: 0 })).toBe('now');
    expect(urgencyOf({ type: 'notice', hardStop: false, blocksCount: 0 })).toBe('digest');
  });

  const quiet: AttentionPolicy = {
    ...policy,
    digestAt: '17:00',
    tz: 'UTC',
    defaultHours: { tz: 'UTC', start: '08:00', end: '20:00' },
  };
  const noon = at('2026-10-14T12:00:00Z');
  const night = at('2026-10-14T22:00:00Z');

  it('holds during quiet hours except for hard stops', () => {
    expect(deliveryDecision({ urgency: 'now', hardStop: false, hours: null }, night, quiet)).toBe(
      'hold',
    );
    expect(deliveryDecision({ urgency: 'now', hardStop: true, hours: null }, night, quiet)).toBe(
      'send',
    );
    expect(deliveryDecision({ urgency: 'now', hardStop: false, hours: null }, noon, quiet)).toBe(
      'send',
    );
  });

  it('prefers the hat hours over the team default', () => {
    const late: Hours = { tz: 'UTC', start: '14:00', end: '23:00' };
    expect(deliveryDecision({ urgency: 'now', hardStop: false, hours: late }, noon, quiet)).toBe(
      'hold',
    );
    expect(deliveryDecision({ urgency: 'now', hardStop: false, hours: late }, night, quiet)).toBe(
      'send',
    );
  });

  it('holds low-priority asks for the digest only when a digest time is set', () => {
    expect(deliveryDecision({ urgency: 'digest', hardStop: false, hours: null }, noon, quiet)).toBe(
      'hold',
    );
    expect(
      deliveryDecision({ urgency: 'digest', hardStop: false, hours: null }, noon, policy),
    ).toBe('send');
  });
});

describe('digestDue', () => {
  const p: AttentionPolicy = { ...policy, digestAt: '17:00', tz: 'UTC' };
  it('is due after the digest time, once a day', () => {
    expect(digestDue(p, at('2026-10-14T16:59:00Z'), null)).toBe(false);
    expect(digestDue(p, at('2026-10-14T17:00:00Z'), null)).toBe(true);
    expect(digestDue(p, at('2026-10-14T18:00:00Z'), at('2026-10-14T17:00:30Z'))).toBe(false);
    expect(digestDue(p, at('2026-10-15T17:00:00Z'), at('2026-10-14T17:00:30Z'))).toBe(true);
    expect(digestDue(policy, at('2026-10-14T18:00:00Z'), null)).toBe(false);
  });
});

describe('chatAnswerable', () => {
  const ask = { hardStop: false, triggered: false };
  it('allows questions and decisions by default', () => {
    expect(chatAnswerable({ ...ask, type: 'question' }, policy)).toBe(true);
    expect(chatAnswerable({ ...ask, type: 'decision' }, policy)).toBe(true);
  });
  it('never allows checkpoints, notices, or hard stops', () => {
    expect(chatAnswerable({ ...ask, type: 'checkpoint' }, policy)).toBe(false);
    expect(chatAnswerable({ ...ask, type: 'notice' }, policy)).toBe(false);
    expect(chatAnswerable({ ...ask, type: 'decision', hardStop: true }, policy)).toBe(false);
  });
  it('allows a review only when the team allows it and no trigger fired', () => {
    const open: AttentionPolicy = { ...policy, chatApprove: ['question', 'decision', 'review'] };
    expect(chatAnswerable({ ...ask, type: 'review' }, policy)).toBe(false);
    expect(chatAnswerable({ ...ask, type: 'review' }, open)).toBe(true);
    expect(chatAnswerable({ ...ask, type: 'review', triggered: true }, open)).toBe(false);
  });
});
