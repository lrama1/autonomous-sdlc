import { useCallback, useEffect, useState } from 'react';
import type { BugDto, Me } from '@sdlc/schemas';
import {
  ApiProblem,
  getBugs,
  getInitiatives,
  reportBug,
  skipStageStep,
  startStageStep,
} from './api';

const STATE: Record<BugDto['state'], { label: string; cls: string }> = {
  open: { label: 'Reported', cls: 'none' },
  fixing: { label: 'Being fixed', cls: 'wait' },
  fixed: { label: 'Fixed', cls: 'done' },
  needs_attention: { label: 'Needs a person', cls: 'stop' },
};

const SEVERITY: Record<BugDto['severity'], string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** Reporting bugs, and following each fix from the report to the merged pull request. */
export function Bugs({ me }: { me: Me }) {
  const [bugs, setBugs] = useState<BugDto[]>([]);
  const [initiatives, setInitiatives] = useState<Array<{ id: string; title: string }>>([]);
  const [f, setF] = useState({
    initiativeId: '',
    title: '',
    description: '',
    steps: '',
    severity: 'medium' as BugDto['severity'],
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBugs(await getBugs());
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 5000);
    return () => clearInterval(poll);
  }, [load]);
  useEffect(() => {
    getInitiatives().then(
      (list) => {
        setInitiatives(list.map((i) => ({ id: i.id, title: i.title })));
        setF((x) => ({ ...x, initiativeId: x.initiativeId || list[0]?.id || '' }));
      },
      () => {},
    );
  }, []);

  const mayStart = me.roles.some((r) =>
    ['backend_engineer', 'frontend_engineer', 'platform_admin'].includes(r),
  );
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setProblem(null);
    setNote(null);
    try {
      await fn();
      setNote(done);
      await load();
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bugs</h1>
          <p className="muted">
            Report what is wrong. The Bug Agent reproduces it with a failing test, finds the cause,
            and opens a fix for an engineer to review.
          </p>
        </div>
      </div>
      {problem && (
        <p role="alert" className="callout warn">
          {problem}
        </p>
      )}
      {note && (
        <p className="callout ok" data-testid="note">
          {note}
        </p>
      )}
      <div className="grid">
        <form
          className="card form"
          data-testid="bug-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await act(async () => {
              await reportBug(f.initiativeId, {
                title: f.title,
                description: f.description,
                steps: f.steps || undefined,
                severity: f.severity,
              });
              setF({ ...f, title: '', description: '', steps: '' });
            }, 'Thank you. The report is recorded.');
          }}
        >
          <h3>Report a bug</h3>
          <select
            aria-label="Initiative"
            value={f.initiativeId}
            onChange={(e) => setF({ ...f, initiativeId: e.target.value })}
            required
          >
            {initiatives.length === 0 && <option value="">No initiative yet</option>}
            {initiatives.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
          <input
            aria-label="Title"
            placeholder="What is wrong, in a line"
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            required
            minLength={3}
          />
          <textarea
            aria-label="What happens, and what should happen"
            placeholder="What happens, and what should happen"
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            required
            minLength={10}
          />
          <textarea
            aria-label="Steps to reproduce"
            placeholder="Steps to reproduce (optional)"
            value={f.steps}
            onChange={(e) => setF({ ...f, steps: e.target.value })}
          />
          <select
            aria-label="Severity"
            value={f.severity}
            onChange={(e) => setF({ ...f, severity: e.target.value as BugDto['severity'] })}
          >
            <option value="low">Low: a nuisance</option>
            <option value="medium">Medium: something does not work</option>
            <option value="high">High: users are blocked or data is wrong</option>
          </select>
          <button className="primary" type="submit" disabled={!f.initiativeId}>
            Report
          </button>
        </form>
        <div className="card" data-testid="bug-list">
          <h3>Reported bugs</h3>
          {bugs.length === 0 && <p className="small muted">None yet.</p>}
          <ul className="checks small">
            {bugs.map((b) => (
              <li key={b.id} data-testid="bug" data-state={b.state}>
                <b>{b.title}</b>{' '}
                <span className={`pill ${STATE[b.state].cls}`}>{STATE[b.state].label}</span>{' '}
                <span className="chip">{SEVERITY[b.severity]}</span>
                <div className="muted">
                  {b.initiativeTitle} · reported by {b.reportedBy}
                  {b.prNumber !== null && ` · PR #${b.prNumber}`}
                </div>
                {b.detail && <div className="muted">{b.detail}</div>}
                {mayStart && b.stageStartId && b.stageState === 'awaiting_start' && (
                  <div className="row wrap">
                    <button
                      className="primary"
                      onClick={() =>
                        void act(() => startStageStep(b.stageStartId!), 'The fix is starting.')
                      }
                    >
                      Start the fix
                    </button>
                    <button
                      onClick={() =>
                        void act(() => skipStageStep(b.stageStartId!), 'The fix was dropped.')
                      }
                    >
                      Drop
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
