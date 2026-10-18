import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { activityEvent } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { cacheReadShare, monthStart, monthlyBudget } from '@sdlc/core';
import type { CostsDto, MonthlyBudgetDto } from '@sdlc/schemas';
import { recordActivity } from './activity.js';

const usd = (micros: unknown) => Number(micros ?? 0) / 1_000_000;
const num = (v: unknown) => Number(v ?? 0);

export interface BudgetConfig {
  monthlyBudgetUsd: number;
  alertPercent: number;
}

/** Spend so far this month (UTC), across every initiative. */
export async function monthSpendUsd(db: Db, at = new Date()): Promise<number> {
  const rows = await db.execute(
    sql`select coalesce(sum(cost_micros), 0) as c from cost_record where created_at >= ${monthStart(at).toISOString()}`,
  );
  return usd(rows.rows[0]?.c);
}

export async function monthlyStatus(
  db: Db,
  cfg: BudgetConfig,
  at = new Date(),
): Promise<MonthlyBudgetDto> {
  const spent = await monthSpendUsd(db, at);
  return {
    ...monthlyBudget(spent, cfg.monthlyBudgetUsd, at, cfg.alertPercent),
    alertPercent: cfg.alertPercent,
  };
}

/**
 * Records, once per month and level, that spending crossed the alert line or the budget. The Costs page and a banner
 * for platform admins show the same status. Returns the level it recorded, if any.
 */
export async function checkBudgetAlert(
  db: Db,
  cfg: BudgetConfig,
  at = new Date(),
): Promise<'warning' | 'exceeded' | null> {
  const m = await monthlyStatus(db, cfg, at);
  if (m.level !== 'warning' && m.level !== 'exceeded') return null;
  const [seen] = await db
    .select({ id: activityEvent.id })
    .from(activityEvent)
    .where(
      and(
        eq(activityEvent.action, 'budget.alert'),
        sql`${activityEvent.detail} ->> 'month' = ${m.month}`,
        sql`${activityEvent.detail} ->> 'level' = ${m.level}`,
      ),
    )
    .limit(1);
  if (seen) return null;
  await recordActivity(db, {
    actorType: 'system',
    action: 'budget.alert',
    detail: {
      month: m.month,
      level: m.level,
      spentUsd: m.spentUsd,
      budgetUsd: m.budgetUsd,
      percent: m.percent,
    },
  });
  return m.level;
}

/** Spend by day, initiative, agent role, model, and run, over the last `days` days. */
export async function costReport(
  db: Db,
  opts: { days: number; initiativeId: string | null; budget: BudgetConfig; now?: Date },
): Promise<CostsDto> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - opts.days * 86_400_000);
  const inRange = sql`c.created_at >= ${from.toISOString()}`;
  const scope: SQL = opts.initiativeId
    ? sql`${inRange} and r.initiative_id = ${opts.initiativeId}`
    : inRange;
  // Records with no run (platform services) have no initiative, so a filter by initiative leaves them out.
  const base = sql`from cost_record c left join agent_run r on r.id = c.run_id where ${scope}`;

  const [totals, byDay, byInitiative, byRole, byModel, topRuns] = await Promise.all([
    db.execute(sql`select coalesce(sum(c.cost_micros),0) cost, count(*) calls, count(distinct c.run_id) runs,
      coalesce(sum(c.input_tokens),0) tin, coalesce(sum(c.output_tokens),0) tout,
      coalesce(sum(c.cached_tokens),0) tcached, coalesce(sum(c.cache_write_tokens),0) twrite ${base}`),
    db.execute(sql`select to_char(date_trunc('day', c.created_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
      sum(c.cost_micros) cost, count(*) calls ${base} group by 1 order by 1`),
    db.execute(sql`select i.id, i.title, i.budget_micros,
      sum(c.cost_micros) cost, count(distinct c.run_id) runs,
      (select coalesce(sum(x.cost_micros),0) from cost_record x join agent_run y on y.id = x.run_id where y.initiative_id = i.id) all_time
      from cost_record c join agent_run r on r.id = c.run_id join initiative i on i.id = r.initiative_id
      where ${scope} group by i.id, i.title, i.budget_micros order by cost desc limit 50`),
    db.execute(sql`select r.agent_role role, sum(c.cost_micros) cost, count(distinct c.run_id) runs
      from cost_record c join agent_run r on r.id = c.run_id where ${scope} group by 1 order by cost desc`),
    db.execute(sql`select c.alias, c.provider_model, sum(c.cost_micros) cost, count(*) calls,
      sum(c.input_tokens) tin, sum(c.output_tokens) tout, sum(c.cached_tokens) tcached, sum(c.cache_write_tokens) twrite
      ${base} group by 1, 2 order by cost desc`),
    db.execute(sql`select r.id, r.agent_role role, r.state, r.initiative_id, i.title initiative_title,
      split_part(r.task, E'\\n', 1) title, sum(c.cost_micros) cost
      from cost_record c join agent_run r on r.id = c.run_id join initiative i on i.id = r.initiative_id
      where ${scope} group by r.id, i.title order by cost desc limit 10`),
  ]);

  const t = totals.rows[0] ?? {};
  const tokens = {
    inputTokens: num(t.tin),
    outputTokens: num(t.tout),
    cachedTokens: num(t.tcached),
    cacheWriteTokens: num(t.twrite),
  };
  return {
    days: opts.days,
    from: from.toISOString(),
    initiativeId: opts.initiativeId,
    monthly: await monthlyStatus(db, opts.budget, now),
    totals: {
      costUsd: usd(t.cost),
      calls: num(t.calls),
      runs: num(t.runs),
      cacheReadShare: cacheReadShare(tokens),
      ...tokens,
    },
    byDay: byDay.rows.map((r) => ({
      day: String(r.day),
      costUsd: usd(r.cost),
      calls: num(r.calls),
    })),
    byInitiative: byInitiative.rows.map((r) => {
      const allTime = usd(r.all_time);
      const budget = r.budget_micros === null ? null : usd(r.budget_micros);
      return {
        id: String(r.id),
        title: String(r.title),
        costUsd: usd(r.cost),
        allTimeUsd: allTime,
        budgetUsd: budget,
        percentOfBudget: budget ? (allTime / budget) * 100 : null,
        runs: num(r.runs),
      };
    }),
    byRole: byRole.rows.map((r) => ({
      role: String(r.role),
      costUsd: usd(r.cost),
      runs: num(r.runs),
      avgPerRunUsd: num(r.runs) ? usd(r.cost) / num(r.runs) : 0,
    })),
    byModel: byModel.rows.map((r) => ({
      alias: String(r.alias),
      providerModel: String(r.provider_model),
      costUsd: usd(r.cost),
      calls: num(r.calls),
      inputTokens: num(r.tin),
      outputTokens: num(r.tout),
      cachedTokens: num(r.tcached),
      cacheWriteTokens: num(r.twrite),
    })),
    topRuns: topRuns.rows.map((r) => ({
      id: String(r.id),
      role: String(r.role),
      initiativeId: String(r.initiative_id),
      initiativeTitle: String(r.initiative_title),
      title: String(r.title ?? ''),
      state: String(r.state),
      costUsd: usd(r.cost),
    })),
  };
}
