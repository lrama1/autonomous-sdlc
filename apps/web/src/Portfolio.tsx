import { useEffect, useState } from 'react';
import type { PortfolioDto } from '@sdlc/schemas';
import { getPortfolio } from './api';
import { formatSpan, roleLabel } from './labels';

type Row = PortfolioDto['initiatives'][number];

const STATUS: Record<NonNullable<Row['stage']>['status'], { label: string; cls: string }> = {
  not_started: { label: 'Not started', cls: 'none' },
  working: { label: 'In progress', cls: 'info' },
  waiting_human: { label: 'Waiting on a person', cls: 'wait' },
  blocked: { label: 'Blocked', cls: 'stop' },
  done: { label: 'Done', cls: 'done' },
};

const usd = (n: number) => `$${n.toFixed(n === 0 ? 2 : n < 1 ? 3 : 2)}`;
const ago = (iso: string) => `${formatSpan(Date.now() - new Date(iso).getTime())} ago`;
const month = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Every initiative in one list, and the releases that went out, newest month first. */
export function Portfolio() {
  const [p, setP] = useState<PortfolioDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      getPortfolio().then(
        (x) => !stop && setP(x),
        (e) =>
          !stop && setProblem(e instanceof Error ? e.message : 'Could not load the portfolio.'),
      );
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (problem)
    return (
      <p role="alert" className="callout warn">
        {problem}
      </p>
    );
  if (!p) return <p className="muted">Loading.</p>;

  const waiting = p.initiatives.filter(
    (i) => i.stage?.status === 'waiting_human' || i.stage?.status === 'blocked',
  ).length;
  const byMonth = new Map<string, PortfolioDto['releases']>();
  for (const r of p.releases) byMonth.set(month(r.at), [...(byMonth.get(month(r.at)) ?? []), r]);

  return (
    <div className="stack" data-testid="portfolio">
      <h2>Portfolio</h2>
      <div className="tiles">
        <div className="card tile">
          <div className="n">{p.initiatives.length}</div>
          <div className="l">initiatives</div>
        </div>
        <div className="card tile" data-testid="tile-waiting">
          <div className="n">{waiting}</div>
          <div className="l">need a person</div>
        </div>
        <div className="card tile">
          <div className="n">{usd(p.initiatives.reduce((s, i) => s + i.spentUsd, 0))}</div>
          <div className="l">spent in all</div>
        </div>
        <div className="card tile">
          <div className="n">{p.initiatives.reduce((s, i) => s + i.openBugs, 0)}</div>
          <div className="l">open bugs</div>
        </div>
      </div>

      <div className="card" data-testid="initiatives">
        <table className="small">
          <thead>
            <tr>
              <th>Initiative</th>
              <th>Where it is</th>
              <th>Build</th>
              <th>Spent</th>
              <th>Bugs</th>
              <th>Last activity</th>
              <th>Released</th>
            </tr>
          </thead>
          <tbody>
            {p.initiatives.map((i) => (
              <tr key={i.id} data-testid={`row-${i.id}`}>
                <td>
                  <a href={`#/map/${i.id}`}>{i.title}</a>
                  <div className="muted">
                    {i.repository}, {i.autonomyMode}
                  </div>
                </td>
                <td>
                  {i.stage ? (
                    <>
                      <span className={`pill ${STATUS[i.stage.status].cls}`}>
                        {STATUS[i.stage.status].label}
                      </span>{' '}
                      {i.stage.title}
                      {i.stage.waitingOn.length > 0 && (
                        <div className="muted">
                          Waiting on {i.stage.waitingOn.map((r) => roleLabel(r)).join(', ')}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="pill done">Released</span>
                  )}
                </td>
                <td>
                  {i.plan
                    ? `${i.plan.merged} of ${i.plan.total}${i.plan.failed ? `, ${i.plan.failed} failed` : ''}`
                    : '-'}
                </td>
                <td>
                  {usd(i.spentUsd)}
                  {i.budgetUsd !== null && <div className="muted">of {usd(i.budgetUsd)}</div>}
                </td>
                <td>{i.openBugs || '-'}</td>
                <td>{ago(i.lastActivityAt)}</td>
                <td>{i.lastRelease ? i.lastRelease.version : '-'}</td>
              </tr>
            ))}
            {p.initiatives.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No initiatives yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card" data-testid="releases">
        <h3>Releases</h3>
        {p.releases.length === 0 && <p className="muted">Nothing has been released yet.</p>}
        {[...byMonth.entries()].map(([m, items]) => (
          <div key={m}>
            <h4>{m}</h4>
            <ul className="plain">
              {items.map((r) => (
                <li key={`${r.initiativeId}-${r.tag}-${r.at}`}>
                  <b>{day(r.at)}</b> {r.initiativeTitle} <b>{r.version}</b>{' '}
                  {r.url && (
                    <a href={r.url} target="_blank" rel="noreferrer">
                      release notes
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
