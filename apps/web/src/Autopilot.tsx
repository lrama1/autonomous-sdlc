import { useCallback, useEffect, useState } from 'react';
import type { AutopilotDto } from '@sdlc/schemas';
import { ApiProblem, getAutopilot, setAutonomyMode } from './api';

type Mode = 'guided' | 'balanced' | 'autopilot';

const MODE_HELP: Record<Mode, string> = {
  guided: 'A person reviews every pull request.',
  balanced: 'Pre-approved change types merge when the checks are green. A person reviews the rest.',
  autopilot: 'Anything no trigger fired on merges when the checks are green.',
};

const DECIDED: Record<string, { chip: string; label: string }> = {
  rule: { chip: 'ok', label: 'Approved by rule' },
  person: { chip: '', label: 'Reviewed by a person' },
  waiting: { chip: 'warn', label: 'Held for a person' },
};

export function Autopilot() {
  const [data, setData] = useState<AutopilotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAutopilot());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Autopilot</h1>
          <p className="muted">
            What may merge without a review, what did, and what was held for a person. A trigger
            always sends a change to a person, in every mode. Hard stops are never automatic.
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="callout warn">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <div className="tiles three">
            <div className="card tile">
              <div className="n" data-testid="by-rule">
                {data.counts.byRule}
              </div>
              <div className="l">Approved by rule</div>
            </div>
            <div className="card tile">
              <div className="n" data-testid="by-person">
                {data.counts.byPerson}
              </div>
              <div className="l">Reviewed by a person</div>
            </div>
            <div className="card tile">
              <div className="n" data-testid="waiting">
                {data.counts.waiting}
              </div>
              <div className="l">Held for a person</div>
            </div>
          </div>

          <div className="grid">
            <div className="card flush">
              <h2>Recent pull requests</h2>
              <table className="t" data-testid="recent">
                <thead>
                  <tr>
                    <th>Pull request</th>
                    <th>Decision</th>
                    <th>Why</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
                        No pull requests in this period.
                      </td>
                    </tr>
                  )}
                  {data.recent.map((r) => (
                    <tr key={r.interactionId}>
                      <td>
                        {r.prUrl ? (
                          <a href={r.prUrl} target="_blank" rel="noreferrer">
                            #{r.prNumber}
                          </a>
                        ) : (
                          `#${r.prNumber ?? '?'}`
                        )}{' '}
                        {r.title.replace(/^Review PR #\d+: /, '')}
                        <div className="small muted">{r.initiativeTitle}</div>
                      </td>
                      <td>
                        <span className={`chip ${DECIDED[r.decidedBy]!.chip}`}>
                          {DECIDED[r.decidedBy]!.label}
                        </span>
                      </td>
                      <td className="small">{r.reason}</td>
                      <td className="small">{r.outcome.replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="stack">
              <div className="card">
                <h3>Pre-approved change types</h3>
                {data.rules.length === 0 && <p className="small muted">None.</p>}
                <ul className="checks small" data-testid="rules">
                  {data.rules.map((r) => (
                    <li key={r.id}>
                      <b>{r.id}</b>
                      <div className="muted">{r.paths}</div>
                      <div>
                        Owner {r.owner ?? 'n/a'}.{' '}
                        {r.reviewBy ? (
                          r.expired ? (
                            <span className="chip warn">
                              review date {r.reviewBy} has passed: not applied
                            </span>
                          ) : (
                            `Review by ${r.reviewBy}.`
                          )
                        ) : (
                          'No review date.'
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="small muted">
                  Rules are edited by hand in <code>rules/triggers.yaml</code>.
                </p>
              </div>
              <div className="card">
                <h3>How each initiative runs</h3>
                {data.initiatives.length === 0 && (
                  <p className="small muted">No initiatives yet.</p>
                )}
                {data.initiatives.map((i) => (
                  <div key={i.id} className="small" style={{ marginBottom: 10 }}>
                    <b>{i.title}</b>
                    <select
                      aria-label={`Autonomy mode for ${i.title}`}
                      value={i.autonomyMode}
                      onChange={async (e) => {
                        setProblem(null);
                        try {
                          await setAutonomyMode(i.id, e.target.value as Mode);
                          await load();
                        } catch (err) {
                          setProblem(
                            err instanceof ApiProblem ? err.message : 'Could not change it.',
                          );
                        }
                      }}
                    >
                      <option value="guided">Guided</option>
                      <option value="balanced">Balanced</option>
                      <option value="autopilot">Autopilot</option>
                    </select>
                    <div className="muted">{MODE_HELP[i.autonomyMode]}</div>
                  </div>
                ))}
                {problem && (
                  <p role="alert" className="callout warn">
                    {problem}
                  </p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
