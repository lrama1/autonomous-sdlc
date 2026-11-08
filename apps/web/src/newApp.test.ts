import { describe, expect, it } from 'vitest';
import {
  GOAL_MAX,
  composeGoal,
  describeEstimate,
  describeProblems,
  estimateNewAppCost,
  splitLines,
} from './newApp';

const answers = { what: 'A booking site for a dog groomer.', mustDo: '', mustNot: '', feel: '' };

describe('splitLines', () => {
  it('drops blanks, bullets and numbers', () => {
    expect(splitLines('- one\n* two\n\n3. three\n  4) four  \n• five')).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
  });
});

describe('composeGoal', () => {
  it('is just the description when nothing else is given', () => {
    expect(composeGoal(answers)).toBe('A booking site for a dog groomer.');
  });

  it('writes each answered section, and leaves out the empty ones', () => {
    const goal = composeGoal({
      what: ' A booking site for a dog groomer. ',
      mustDo: '- Book a slot\n- Email a reminder',
      mustNot: '',
      feel: 'Friendly, works on a phone.',
    });
    expect(goal).toBe(
      [
        'A booking site for a dog groomer.',
        'It must:\n- Book a slot\n- Email a reminder',
        'Look, feel and where it runs:\nFriendly, works on a phone.',
      ].join('\n\n'),
    );
    expect(goal).not.toContain('must not');
  });

  it('lists what it must not do', () => {
    expect(composeGoal({ ...answers, mustNot: 'Take payments\nStore card numbers' })).toContain(
      'It must not, or leaves out:\n- Take payments\n- Store card numbers',
    );
  });
});

describe('describeProblems', () => {
  const ok = { ...answers, mustDo: 'Book a slot' };

  it('asks for a name, a description and one thing it must do', () => {
    const p = describeProblems('', { what: '', mustDo: '', mustNot: '', feel: '' }, '');
    expect(p.map((x) => x.field)).toEqual(['title', 'what', 'mustDo']);
  });

  it('is satisfied by a name, a description and one must-do', () => {
    expect(describeProblems('Groomer', ok, '')).toEqual([]);
  });

  it('rejects a link that is not https', () => {
    const p = describeProblems('Groomer', ok, 'https://docs.example.com/api\nhttp://insecure.test');
    expect(p).toEqual([
      { field: 'links', message: '“http://insecure.test” is not an https link.' },
    ]);
  });

  it('rejects a goal that is too long to store', () => {
    const p = describeProblems('Groomer', { ...ok, what: 'x'.repeat(GOAL_MAX) }, '');
    expect(p.some((x) => x.message.includes(String(GOAL_MAX)))).toBe(true);
  });
});

describe('estimateNewAppCost', () => {
  const built = (spentUsd: number, merged = 3) => ({
    kind: 'new_app',
    spentUsd,
    plan: { merged },
  });

  it('counts only new apps that merged build tasks', () => {
    const e = estimateNewAppCost([
      built(4),
      built(12),
      built(8),
      { kind: 'feature', spentUsd: 99, plan: { merged: 2 } },
      { kind: 'new_app', spentUsd: 1, plan: null },
      { kind: 'new_app', spentUsd: 2, plan: { merged: 0 } },
      { kind: 'new_app', spentUsd: 0, plan: { merged: 5 } },
    ]);
    expect(e).toEqual({ count: 3, low: 4, high: 12, median: 8 });
  });

  it('takes the middle of an even number', () => {
    expect(estimateNewAppCost([built(2), built(4), built(6), built(10)])!.median).toBe(5);
  });

  it('is null with nothing to go on', () => {
    expect(estimateNewAppCost([])).toBeNull();
    expect(estimateNewAppCost([{ kind: 'new_app', spentUsd: 3, plan: null }])).toBeNull();
  });
});

describe('describeEstimate', () => {
  it('admits when there is no history', () => {
    expect(describeEstimate(null)).toContain('nothing to compare with');
  });

  it('calls one or two examples a rough guide, not a trend', () => {
    expect(describeEstimate({ count: 1, low: 6.5, high: 6.5, median: 6.5 })).toContain(
      'cost $6.50',
    );
    expect(describeEstimate({ count: 1, low: 6.5, high: 6.5, median: 6.5 })).toContain(
      'not a trend',
    );
    expect(describeEstimate({ count: 2, low: 4, high: 9, median: 6.5 })).toContain(
      '$4.00 and $9.00',
    );
  });

  it('gives a range and a typical figure from three', () => {
    expect(describeEstimate({ count: 3, low: 4, high: 12, median: 8 })).toContain(
      'between $4.00 and $12',
    );
    expect(describeEstimate({ count: 3, low: 4, high: 12, median: 8 })).toContain('about $8.00');
  });
});
