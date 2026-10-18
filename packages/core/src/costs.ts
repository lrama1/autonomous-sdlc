// Cost views (spec 6.8). Pure helpers over the cost records the gateway writes.

export type BudgetLevel = 'none' | 'ok' | 'warning' | 'exceeded';

export interface MonthlyBudget {
  budgetUsd: number | null;
  spentUsd: number;
  /** Spend as a share of the budget, 0 to beyond 100. Null when there is no budget. */
  percent: number | null;
  level: BudgetLevel;
  /** The first day of the month this covers (UTC, ISO date). */
  month: string;
}

/** The UTC month a moment falls in, as its first day: 2026-10-01. */
export function monthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * Where this month's spend stands against the monthly budget. A budget of zero or less means there is none.
 * "warning" starts at `alertPercent` (default 80) and "exceeded" at 100.
 */
export function monthlyBudget(
  spentUsd: number,
  budgetUsd: number | null | undefined,
  at: Date,
  alertPercent = 80,
): MonthlyBudget {
  const month = monthStart(at).toISOString().slice(0, 10);
  if (!budgetUsd || budgetUsd <= 0) {
    return { budgetUsd: null, spentUsd, percent: null, level: 'none', month };
  }
  const percent = (spentUsd / budgetUsd) * 100;
  const level: BudgetLevel =
    percent >= 100 ? 'exceeded' : percent >= alertPercent ? 'warning' : 'ok';
  return { budgetUsd, spentUsd, percent, level, month };
}

/** The share of the prompt the provider served from its cache. 0 when nothing was sent. */
export function cacheReadShare(t: {
  inputTokens: number;
  cacheWriteTokens: number;
  cachedTokens: number;
}): number {
  const all = t.inputTokens + t.cacheWriteTokens + t.cachedTokens;
  return all === 0 ? 0 : t.cachedTokens / all;
}

/** Whole-dollar-and-cents text for an amount in dollars, with more places for small amounts. */
export function formatUsd(usd: number): string {
  const abs = Math.abs(usd);
  const places = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `$${usd.toFixed(places)}`;
}
