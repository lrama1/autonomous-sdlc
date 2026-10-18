import { useEffect, useState } from 'react';
import type { InterruptionMetricsDto } from '@sdlc/schemas';
import { getInterruptions } from './api';
import { formatSpan, percent, roleLabel } from './labels';

const SUGGESTION: Record<string, { chip: string; text: string }> = {
  covered: { chip: 'ok', text: 'Covered by a standing decision' },
  make_standing: {
    chip: 'ok',
    text: 'Always answered with the recommendation. Make it a standing decision.',
  },
  ask_less: {
    chip: 'warn',
    text: 'Often marked “didn’t need to ask”. Consider a rule or a prompt change.',
  },
  keep: { chip: '', text: 'Keep asking' },
};

const num = (n: number | null, d = 1) => (n === null ? 'n/a' : n.toFixed(d));

export function Interruptions() {
  const [days, setDays] = useState(30);
  const [m, setM] = useState<InterruptionMetricsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setM(null);
    getInterruptions(days).then(
      (r) => {
        setM(r);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [days]);

  const peak = m ? Math.max(0.0001, ...m.weekly.map((w) => w.perPr ?? 0)) : 1;
  const trend =
    m && m.weekly.length >= 2 && m.weekly.at(-1)!.perPr !== null && m.weekly[0]!.perPr !== null
      ? m.weekly.at(-1)!.perPr! < m.weekly[0]!.perPr!
        ? 'falling'
        : 'not falling'
      : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Interruptions</h1>
          <p className="muted">
            How often agents ask, how useful the asks were, and what to tune. You change the rules
            by hand. Nothing changes on its own.
          </p>
        </div>
        <div className="row">
          {[7, 30, 90].map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
              Last {d} days
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="callout warn">
          {error}
        </p>
      )}
      {!m && !error && <p className="muted">Loading…</p>}
      {m && (
        <>
          <div className="tiles" data-testid="tiles">
            <div className="card tile">
              <div className="n" data-testid="per-pr">
                {num(m.questionsPerMergedPr)}
              </div>
              <div className="l">
                Questions per merged PR{' '}
                {trend && (
                  <span className={`chip ${trend === 'falling' ? 'ok' : 'warn'}`}>{trend}</span>
                )}
              </div>
              <div className="small muted">
                {m.asks} asks, {m.mergedPrs} merged
              </div>
            </div>
            <div className="card tile">
              <div className="n" data-testid="unchanged">
                {percent(m.unchangedShare)}
              </div>
              <div className="l">Answered with the recommendation unchanged</div>
            </div>
            <div className="card tile">
              <div className="n" data-testid="didnt-need">
                {percent(m.didntNeedShare)}
              </div>
              <div className="l">Marked “didn’t need to ask”</div>
            </div>
            <div className="card tile">
              <div className="n" data-testid="median">
                {m.medianAnswerMs === null ? 'n/a' : formatSpan(m.medianAnswerMs)}
              </div>
              <div className="l">
                Median time to answer · agent time blocked {percent(m.blockedShare)}
              </div>
            </div>
          </div>
          <p className="small muted">
            {m.defaulted} answered by a default after the deadline. {m.avoidedByStanding} never
            reached a person because a standing decision answered them.
          </p>

          <div className="grid">
            <div className="card flush">
              <h2>Where asks come from</h2>
              <p className="small muted">Suggestions only. Nothing is applied for you.</p>
              <table className="t" data-testid="situations">
                <thead>
                  <tr>
                    <th>Situation</th>
                    <th>Asked</th>
                    <th>Unchanged</th>
                    <th>Didn’t need to ask</th>
                    <th>Suggestion</th>
                  </tr>
                </thead>
                <tbody>
                  {m.situations.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No asks in this period.
                      </td>
                    </tr>
                  )}
                  {m.situations.map((s) => (
                    <tr key={s.situation}>
                      <td>{s.situation}</td>
                      <td>{s.asked}</td>
                      <td>{s.unchanged}</td>
                      <td>{s.didntNeed}</td>
                      <td>
                        <span className={`chip ${SUGGESTION[s.suggestion]!.chip}`}>
                          {SUGGESTION[s.suggestion]!.text}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="stack">
              <div className="card">
                <h3>Questions per merged PR</h3>
                {m.weekly.map((w) => (
                  <div className="seg" key={w.weekStart}>
                    <b>Week of {w.weekStart.slice(5)}</b>
                    <div className="meter">
                      <i style={{ width: `${((w.perPr ?? 0) / peak) * 100}%` }} />
                    </div>
                    <span>{num(w.perPr)}</span>
                  </div>
                ))}
                <p className="small muted">
                  Falls as standing decisions pile up. If this line stops falling, the rules need
                  work.
                </p>
              </div>
              <div className="card">
                <h3>By agent</h3>
                {m.byAgent.length === 0 && <p className="small muted">No data yet.</p>}
                <ul className="checks small">
                  {m.byAgent.map((a) => (
                    <li key={a.agentRole}>
                      <b>{roleLabel(a.agentRole)}</b>: {num(a.perPr)} per PR ({a.asks} asks,{' '}
                      {a.merged} merged), {percent(a.unchangedShare)} unchanged
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
