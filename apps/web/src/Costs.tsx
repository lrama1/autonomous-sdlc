import { useEffect, useState } from 'react';
import type { CostsDto, MonthlyBudgetDto } from '@sdlc/schemas';
import { getBudget, getCosts, getInitiatives } from './api';

const LEVEL: Record<MonthlyBudgetDto['level'], { label: string; cls: string }> = {
  none: { label: 'No budget set', cls: 'none' },
  ok: { label: 'Within budget', cls: 'done' },
  warning: { label: 'Close to the budget', cls: 'wait' },
  exceeded: { label: 'Over the budget', cls: 'stop' },
};

/** Tells a Platform Admin, on every page, when this month's spend nears or passes the monthly budget. */
export function BudgetBanner() {
  const [b, setB] = useState<MonthlyBudgetDto | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      getBudget().then(
        (x) => !stop && setB(x),
        () => {},
      );
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  if (!b || (b.level !== 'warning' && b.level !== 'exceeded')) return null;
  return (
    <p
      role="alert"
      className={`callout ${b.level === 'exceeded' ? 'warn' : ''}`}
      data-testid="budget-banner"
      data-level={b.level}
    >
      {b.level === 'exceeded'
        ? 'The monthly model budget is used up: '
        : 'Close to the monthly model budget: '}
      {formatUsd(b.spentUsd)} of {formatUsd(b.budgetUsd ?? 0)} ({Math.round(b.percent ?? 0)}%).{' '}
      <a href="#/costs">See the costs</a>
    </p>
  );
}

/** Dollars, with more places for small amounts. */
const formatUsd = (usd: number) => {
  const abs = Math.abs(usd);
  return `$${usd.toFixed(abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2)}`;
};
const pct = (n: number) => `${Math.round(n)}%`;
const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

function Bars({ days }: { days: CostsDto['byDay'] }) {
  const max = Math.max(0.0001, ...days.map((d) => d.costUsd));
  if (days.length === 0) return <p className="small muted">No spend in this period.</p>;
  return (
    <div className="bars" role="img" aria-label="Spend by day" data-testid="by-day">
      {days.map((d) => (
        <div
          className="bar-col"
          key={d.day}
          title={`${d.day}: ${formatUsd(d.costUsd)} (${d.calls} calls)`}
        >
          <div className="bar" style={{ height: `${Math.max(2, (d.costUsd / max) * 100)}%` }} />
          <span className="bar-label">{d.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

/** What the models cost: this month against the budget, and where the spend goes. */
export function Costs() {
  const [days, setDays] = useState(30);
  const [initiativeId, setInitiativeId] = useState<string>('');
  const [list, setList] = useState<Array<{ id: string; title: string }>>([]);
  const [r, setR] = useState<CostsDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getInitiatives().then(
      (l) => setList(l.map((i) => ({ id: i.id, title: i.title }))),
      () => {},
    );
  }, []);
  useEffect(() => {
    let stop = false;
    const load = () =>
      getCosts(days, initiativeId || null).then(
        (x) => {
          if (stop) return;
          setR(x);
          setProblem(null);
        },
        (e) => !stop && setProblem(e instanceof Error ? e.message : String(e)),
      );
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [days, initiativeId]);

  const m = r?.monthly;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Costs</h1>
          <p className="muted">
            What the models cost, from the gateway&apos;s records of every call.
          </p>
        </div>
        <div className="row wrap">
          <select
            aria-label="Initiative"
            value={initiativeId}
            onChange={(e) => setInitiativeId(e.target.value)}
          >
            <option value="">All initiatives</option>
            {list.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>
      {problem && (
        <p role="alert" className="callout warn">
          {problem}
        </p>
      )}
      {r && m && (
        <>
          <div className="card" data-testid="monthly" data-level={m.level}>
            <h3>
              This month{' '}
              <span className={`pill ${LEVEL[m.level].cls}`}>{LEVEL[m.level].label}</span>
            </h3>
            {m.budgetUsd === null ? (
              <p>
                <b>{formatUsd(m.spentUsd)}</b> spent in {m.month.slice(0, 7)}. No monthly budget is
                set (the platform setting MONTHLY_BUDGET_USD).
              </p>
            ) : (
              <>
                <p>
                  <b>{formatUsd(m.spentUsd)}</b> of {formatUsd(m.budgetUsd)} ({pct(m.percent ?? 0)}
                  ). Admins are warned at {m.alertPercent}%. Nothing stops at the budget: it is a
                  warning, not a limit.
                </p>
                <div className="meter" aria-hidden>
                  <i className={m.level} style={{ width: `${Math.min(100, m.percent ?? 0)}%` }} />
                </div>
              </>
            )}
          </div>

          <div className="tiles" data-testid="totals">
            <div className="card tile">
              <div className="n">{formatUsd(r.totals.costUsd)}</div>
              <div className="l">spent in the period</div>
            </div>
            <div className="card tile">
              <div className="n">{r.totals.runs}</div>
              <div className="l">runs</div>
            </div>
            <div className="card tile">
              <div className="n">{r.totals.calls}</div>
              <div className="l">model calls</div>
            </div>
            <div className="card tile">
              <div className="n">{pct(r.totals.cacheReadShare * 100)}</div>
              <div className="l">of the prompt read from cache</div>
            </div>
            <div className="card tile">
              <div className="n">
                {tokens(r.totals.inputTokens + r.totals.cachedTokens + r.totals.cacheWriteTokens)} /{' '}
                {tokens(r.totals.outputTokens)}
              </div>
              <div className="l">tokens in / out</div>
            </div>
          </div>

          <div className="card">
            <h3>By day</h3>
            <Bars days={r.byDay} />
          </div>

          <div className="grid">
            <div className="card" data-testid="by-initiative">
              <h3>By initiative</h3>
              <table className="small">
                <thead>
                  <tr>
                    <th>Initiative</th>
                    <th>Period</th>
                    <th>All time</th>
                    <th>Of budget</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byInitiative.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <a href={`#/map/${i.id}`}>{i.title}</a>
                      </td>
                      <td>{formatUsd(i.costUsd)}</td>
                      <td>{formatUsd(i.allTimeUsd)}</td>
                      <td>{i.percentOfBudget === null ? '-' : pct(i.percentOfBudget)}</td>
                    </tr>
                  ))}
                  {r.byInitiative.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
                        Nothing yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="card" data-testid="by-role">
              <h3>By agent</h3>
              <table className="small">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Spent</th>
                    <th>Runs</th>
                    <th>Per run</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byRole.map((x) => (
                    <tr key={x.role}>
                      <td>{x.role}</td>
                      <td>{formatUsd(x.costUsd)}</td>
                      <td>{x.runs}</td>
                      <td>{formatUsd(x.avgPerRunUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid">
            <div className="card" data-testid="by-model">
              <h3>By model</h3>
              <table className="small">
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Model</th>
                    <th>Spent</th>
                    <th>Calls</th>
                    <th>Cached</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byModel.map((x) => (
                    <tr key={`${x.alias}/${x.providerModel}`}>
                      <td>{x.alias}</td>
                      <td>{x.providerModel}</td>
                      <td>{formatUsd(x.costUsd)}</td>
                      <td>{x.calls}</td>
                      <td>{tokens(x.cachedTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card" data-testid="top-runs">
              <h3>Most expensive runs</h3>
              <ul className="checks small">
                {r.topRuns.map((x) => (
                  <li key={x.id}>
                    <b>{formatUsd(x.costUsd)}</b> {x.role} · {x.title || '(no title)'}
                    <div className="muted">
                      <a href={`#/map/${x.initiativeId}`}>{x.initiativeTitle}</a> · {x.state}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </>
  );
}
