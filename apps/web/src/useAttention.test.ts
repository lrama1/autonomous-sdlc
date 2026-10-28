import { describe, expect, it } from 'vitest';
import { summarize } from './useAttention';

const ask = (snoozedUntil: string | null = null, hardStop = false) => ({ snoozedUntil, hardStop });
const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('counting what waits on a person', () => {
  it('is zero when nothing waits', () => {
    expect(summarize([], NOW)).toEqual({ count: 0, urgent: false });
  });

  it('counts every ask, and marks urgent when one is a hard stop', () => {
    expect(summarize([ask(), ask()], NOW)).toEqual({ count: 2, urgent: false });
    expect(summarize([ask(), ask(null, true)], NOW)).toEqual({ count: 2, urgent: true });
  });

  it('leaves out an ask that is snoozed until later, and counts it once its time has come', () => {
    expect(summarize([ask('2026-10-27T13:00:00Z')], NOW)).toEqual({ count: 0, urgent: false });
    expect(summarize([ask('2026-10-27T11:00:00Z')], NOW)).toEqual({ count: 1, urgent: false });
  });

  it('does not let a snoozed hard stop make the badge urgent', () => {
    expect(summarize([ask('2026-10-27T13:00:00Z', true), ask()], NOW)).toEqual({
      count: 1,
      urgent: false,
    });
  });
});
