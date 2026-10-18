import { useCallback, useEffect, useState } from 'react';
import type { AssumptionDto, StandingDecisionDto } from '@sdlc/schemas';
import {
  ApiProblem,
  createStandingDecision,
  decideAssumption,
  getAssumptions,
  getInitiatives,
  getStandingDecisions,
  retireStandingDecision,
} from './api';
import { roleLabel } from './labels';

const SCOPE_LABEL: Record<string, string> = {
  global: 'Everywhere',
  repository: 'A repository',
  initiative: 'An initiative',
};

function AddStanding({ onAdded }: { onAdded: () => void }) {
  const [initiatives, setInitiatives] = useState<Array<{ id: string; title: string }>>([]);
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getInitiatives().then(
      (r) => setInitiatives(r.map((i) => ({ id: i.id, title: i.title }))),
      () => {},
    );
  }, []);

  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setProblem(null);
        try {
          await createStandingDecision(
            scopeId
              ? { scope: 'initiative', scopeId, topic, text }
              : { scope: 'global', topic, text },
          );
          setTopic('');
          setText('');
          onAdded();
        } catch (err) {
          setProblem(err instanceof ApiProblem ? err.message : 'Could not save it.');
        }
      }}
    >
      <h3>Add a standing decision</h3>
      <p className="small muted">
        Agents search these before they ask. The topic is the key an agent uses when it asks, for
        example
        <code> date-library</code>.
      </p>
      <div className="row wrap">
        <input
          aria-label="Topic"
          placeholder="Topic, for example date-library"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          required
        />
        <input
          aria-label="Decision"
          placeholder="Use date-fns for dates and times"
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          className="wide"
        />
        <select
          aria-label="Applies to"
          value={scopeId}
          onChange={(e) => setScopeId(e.target.value)}
        >
          <option value="">Everywhere</option>
          {initiatives.map((i) => (
            <option key={i.id} value={i.id}>
              {i.title}
            </option>
          ))}
        </select>
        <button className="primary" type="submit">
          Save
        </button>
      </div>
      {problem && (
        <p role="alert" className="callout warn">
          {problem}
        </p>
      )}
    </form>
  );
}

export function Assumptions() {
  const [tab, setTab] = useState<'assumptions' | 'standing'>('assumptions');
  const [assumptions, setAssumptions] = useState<AssumptionDto[] | null>(null);
  const [standing, setStanding] = useState<StandingDecisionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([getAssumptions(), getStandingDecisions()]);
      setAssumptions(a);
      setStanding(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (a: AssumptionDto, verb: 'accept' | 'reject') => {
    await decideAssumption(a.id, verb);
    setResult(
      verb === 'accept'
        ? `“${a.text}” is accepted.`
        : `“${a.text}” is rejected. The person who started the run has been asked what to redo.`,
    );
    await load();
  };

  return (
    <>
      <div className="page-head">
        <div className="row">
          <h1>Assumptions and decisions</h1>
          {assumptions && assumptions.length > 0 && (
            <span className="pill wait">{assumptions.length} to review</span>
          )}
        </div>
        <p className="muted">
          Agents make small calls and say so. You can accept or reject them any time, and agents
          stop asking about things you have already settled.
        </p>
      </div>
      {error && (
        <p role="alert" className="callout warn">
          {error}
        </p>
      )}
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'assumptions'}
          onClick={() => setTab('assumptions')}
        >
          Assumptions <span className="count">{assumptions?.length ?? 0}</span>
        </button>
        <button role="tab" aria-selected={tab === 'standing'} onClick={() => setTab('standing')}>
          Standing decisions <span className="count">{standing?.length ?? 0}</span>
        </button>
      </div>

      {tab === 'assumptions' && (
        <>
          <table className="t" data-testid="assumptions">
            <thead>
              <tr>
                <th>Assumption</th>
                <th>Declared by</th>
                <th>Initiative</th>
                <th>Your call</th>
              </tr>
            </thead>
            <tbody>
              {assumptions?.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Nothing to review.
                  </td>
                </tr>
              )}
              {assumptions?.map((a) => (
                <tr key={a.id}>
                  <td>{a.text}</td>
                  <td>
                    <span className="chip agent">{roleLabel(a.agentRole)}</span>
                  </td>
                  <td className="small">{a.initiativeTitle}</td>
                  <td>
                    <button onClick={() => decide(a, 'accept')}>Accept</button>{' '}
                    <button onClick={() => decide(a, 'reject')}>Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result && (
            <p className="callout ok" data-testid="result">
              {result}
            </p>
          )}
          <p className="small muted">
            Accepting records the call. Rejecting asks the person who started the run what to redo,
            so nothing is forgotten.
          </p>
        </>
      )}

      {tab === 'standing' && (
        <>
          <table className="t" data-testid="standing">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Decision</th>
                <th>Applies to</th>
                <th>Set by</th>
                <th>Answered since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {standing?.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    None yet. Answer an ask and tick “Use this answer from now on”.
                  </td>
                </tr>
              )}
              {standing?.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.topic}</td>
                  <td>{s.text}</td>
                  <td className="small">{SCOPE_LABEL[s.scope] ?? s.scope}</td>
                  <td className="small">{s.createdByName ?? 'n/a'}</td>
                  <td>{s.answeredSince}</td>
                  <td>
                    <button
                      onClick={async () => {
                        await retireStandingDecision(s.id);
                        await load();
                      }}
                    >
                      Retire
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddStanding onAdded={load} />
        </>
      )}
    </>
  );
}
