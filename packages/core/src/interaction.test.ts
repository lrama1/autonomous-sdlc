import { describe, expect, it } from 'vitest';
import {
  checkAnswer,
  defaultApplies,
  defaultRoleForAgent,
  rankInteractions,
} from './interaction.js';
import type { InteractionFacts, Person } from './interaction.js';

const now = new Date('2026-10-17T12:00:00Z');
const past = new Date('2026-10-17T11:59:00Z');
const future = new Date('2026-10-17T12:01:00Z');

const base: InteractionFacts = {
  type: 'question',
  state: 'open',
  defaultValue: 'md',
  dueAt: past,
  hardStop: false,
  roleNeeded: 'backend_engineer',
  assignedPersonId: null,
};

describe('defaultApplies', () => {
  it('applies to an open question whose deadline passed', () => {
    expect(defaultApplies(base, now)).toBe(true);
  });
  it('applies exactly at the deadline', () => {
    expect(defaultApplies({ ...base, dueAt: now }, now)).toBe(true);
  });
  it('waits until the deadline', () => {
    expect(defaultApplies({ ...base, dueAt: future }, now)).toBe(false);
  });
  it('needs a default and a deadline', () => {
    expect(defaultApplies({ ...base, defaultValue: null }, now)).toBe(false);
    expect(defaultApplies({ ...base, dueAt: null }, now)).toBe(false);
  });
  it('applies to a decision request', () => {
    expect(defaultApplies({ ...base, type: 'decision' }, now)).toBe(true);
  });
  it.each(['checkpoint', 'review', 'notice'] as const)('never applies to a %s', (type) => {
    expect(defaultApplies({ ...base, type }, now)).toBe(false);
  });
  it('never applies to a hard stop', () => {
    expect(defaultApplies({ ...base, hardStop: true }, now)).toBe(false);
  });
  it('does not apply twice', () => {
    expect(defaultApplies({ ...base, state: 'defaulted' }, now)).toBe(false);
    expect(defaultApplies({ ...base, state: 'answered' }, now)).toBe(false);
  });
});

describe('checkAnswer', () => {
  const bob: Person = { id: 'bob', roles: ['backend_engineer'] };
  const alice: Person = { id: 'alice', roles: ['product_owner'] };
  const run = { sponsorPersonId: 'alice', contributors: ['carol'] };

  it('lets the person holding the needed hat answer a question', () => {
    expect(checkAnswer(base, bob, run, {})).toEqual({ ok: true });
  });
  it('lets a sponsor answer a question about their own run', () => {
    expect(checkAnswer({ ...base, roleNeeded: 'product_owner' }, alice, run, {})).toEqual({
      ok: true,
    });
  });
  it('refuses someone without the hat', () => {
    expect(checkAnswer(base, alice, run, {})).toEqual({ ok: false, reason: 'wrong_role' });
  });
  it('accepts an assigned person without the hat', () => {
    expect(checkAnswer({ ...base, assignedPersonId: 'alice' }, alice, run, {})).toEqual({
      ok: true,
    });
  });
  it('refuses once settled', () => {
    expect(checkAnswer({ ...base, state: 'answered' }, bob, run, {})).toEqual({
      ok: false,
      reason: 'not_open',
    });
  });

  describe('reviews and checkpoints', () => {
    const review = { ...base, type: 'review' as const };
    it('need a decision', () => {
      expect(checkAnswer(review, bob, run, {})).toEqual({ ok: false, reason: 'decision_required' });
    });
    it('accept a decision from an independent person', () => {
      expect(checkAnswer(review, bob, run, { decision: 'approved' })).toEqual({ ok: true });
    });
    it('refuse the sponsor of the run (independent review)', () => {
      const sponsor: Person = { id: 'alice', roles: ['backend_engineer'] };
      expect(checkAnswer(review, sponsor, run, { decision: 'approved' })).toEqual({
        ok: false,
        reason: 'independent_review',
      });
    });
    it('refuse a contributor to the run', () => {
      const contributor: Person = { id: 'carol', roles: ['backend_engineer'] };
      expect(checkAnswer(review, contributor, run, { decision: 'approved' })).toEqual({
        ok: false,
        reason: 'independent_review',
      });
    });
    it('allow the sponsor when the rule is off (solo mode)', () => {
      const sponsor: Person = { id: 'alice', roles: ['backend_engineer'] };
      expect(
        checkAnswer(review, sponsor, run, { decision: 'approved' }, { independentReview: false }),
      ).toEqual({ ok: true });
    });
  });

  it('refuses a decision on a plain question', () => {
    expect(checkAnswer(base, bob, run, { decision: 'approved' })).toEqual({
      ok: false,
      reason: 'decision_not_allowed',
    });
  });
});

describe('defaultRoleForAgent', () => {
  it('routes engineers to a peer and others to their own role', () => {
    expect(defaultRoleForAgent('product')).toBe('product_owner');
    expect(defaultRoleForAgent('architect')).toBe('architect');
    expect(defaultRoleForAgent('tester')).toBe('qa');
    expect(defaultRoleForAgent('backend_engineer')).toBe('backend_engineer');
    expect(defaultRoleForAgent('frontend_engineer')).toBe('frontend_engineer');
  });
});

describe('rankInteractions', () => {
  const item = (
    name: string,
    o: Partial<{ hardStop: boolean; blocks: unknown[]; dueAt: Date | null; priority: number }> = {},
  ) => ({
    name,
    hardStop: false,
    blocks: [] as unknown[],
    dueAt: null as Date | null,
    priority: 0,
    ...o,
  });

  it('puts hard stops first, then priority, then what blocks more, then the earliest deadline', () => {
    const ranked = rankInteractions([
      item('late', { dueAt: future }),
      item('blocks2', { blocks: [1, 2] }),
      item('stop', { hardStop: true }),
      item('soon', { dueAt: past }),
      item('prio', { priority: 5 }),
    ]).map((i) => i.name);
    expect(ranked).toEqual(['stop', 'prio', 'blocks2', 'soon', 'late']);
  });

  it('does not change the input array', () => {
    const input = [item('b', { priority: 1 }), item('a')];
    rankInteractions(input);
    expect(input.map((i) => i.name)).toEqual(['b', 'a']);
  });
});
