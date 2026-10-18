import { describe, expect, it } from 'vitest';
import { cacheReadShare, formatUsd, monthStart, monthlyBudget } from './costs.js';

const AT = new Date('2026-10-18T14:00:00Z');

describe('monthlyBudget', () => {
  it('has no level when there is no budget', () => {
    expect(monthlyBudget(12, 0, AT)).toMatchObject({
      level: 'none',
      percent: null,
      budgetUsd: null,
    });
    expect(monthlyBudget(12, null, AT).level).toBe('none');
    expect(monthlyBudget(12, undefined, AT).level).toBe('none');
  });

  it('is ok below the alert line, warns from 80%, and is exceeded at 100%', () => {
    expect(monthlyBudget(79.9, 100, AT).level).toBe('ok');
    expect(monthlyBudget(80, 100, AT)).toMatchObject({ level: 'warning', percent: 80 });
    expect(monthlyBudget(99.99, 100, AT).level).toBe('warning');
    expect(monthlyBudget(100, 100, AT).level).toBe('exceeded');
    expect(monthlyBudget(250, 100, AT)).toMatchObject({ level: 'exceeded', percent: 250 });
  });

  it('can warn earlier or later than 80%', () => {
    expect(monthlyBudget(50, 100, AT, 50).level).toBe('warning');
    expect(monthlyBudget(89, 100, AT, 90).level).toBe('ok');
  });

  it('names the month it covers', () => {
    expect(monthlyBudget(1, 10, AT).month).toBe('2026-10-01');
    expect(monthStart(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });
});

describe('cacheReadShare and formatUsd', () => {
  it('is the cached share of the prompt, and zero for nothing', () => {
    expect(cacheReadShare({ inputTokens: 100, cacheWriteTokens: 0, cachedTokens: 300 })).toBe(0.75);
    expect(cacheReadShare({ inputTokens: 0, cacheWriteTokens: 0, cachedTokens: 0 })).toBe(0);
  });
  it('shows more places for small amounts', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.266)).toBe('$0.266');
    expect(formatUsd(12.3456)).toBe('$12.35');
  });
});
