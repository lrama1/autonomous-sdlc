import { useCallback, useEffect, useState } from 'react';
import type { Me } from '@sdlc/schemas';
import {
  ApiProblem,
  createInitiative,
  getInitiatives,
  getMap,
  getReleases,
  getRepositories,
  prepareRelease,
  startRun,
} from './api';
import type { InitiativeMap, Stage } from './api';
import { roleLabel } from './labels';

const STATUS: Record<Stage['status'], { label: string; cls: string }> = {
  not_started: { label: 'Not started', cls: 'none' },
  working: { label: 'In progress', cls: 'info' },
  waiting_human: { label: 'Waiting on a person', cls: 'wait' },
  blocked: { label: 'Blocked', cls: 'stop' },
  done: { label: 'Done', cls: 'done' },
};

const RUN_ROLES: Array<{ id: string; label: string }> = [
  { id: 'product', label: 'Product agent: draft the spec (checkpoint G1)' },
  { id: 'architect', label: 'Architect agent: design it and list the tasks (checkpoint G1)' },
  { id: 'backend_engineer', label: 'Backend Engineer agent: build and open a PR' },
];

function StageBox({ s, initiativeId }: { s: Stage; initiativeId: string }) {
  const st = STATUS[s.status];
  return (
    <div className={`stage ${s.status}`} data-testid={`stage-${s.id}`} data-status={s.status}>
      <div className="small muted">{s.checkpoint}</div>
      <h3>{s.title}</h3>
      <span className={`pill ${st.cls}`}>{st.label}</span>
      {s.waitingOn.length > 0 && (
        <p className="small">
          Waiting on <b>{s.waitingOn.map(roleLabel).join(', ')}</b>
        </p>
      )}
      <p className="small muted">{s.detail}</p>
      <ul className="checks small">
        {s.items.slice(0, 4).map((i) => (
          <li key={i.id}>
            {i.kind === 'ask' ? (
              <a href={`#/queue/${i.id}`}>{i.title}</a>
            ) : (
              <span>
                {roleLabel(i.title)} run: {i.state}
              </span>
            )}
          </li>
        ))}
      </ul>
      <span hidden>{initiativeId}</span>
    </div>
  );
}

function NewInitiative({ onCreated }: { onCreated: (id: string) => void }) {
  const [repos, setRepos] = useState<Array<{ id: string; fullName: string }>>([]);
  const [f, setF] = useState({
    title: '',
    goal: '',
    repositoryId: '',
    autonomyMode: 'balanced' as 'guided' | 'balanced' | 'autopilot',
  });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getRepositories().then(
      (r) => {
        setRepos(r.map((x) => ({ id: x.id, fullName: x.fullName })));
        setF((x) => ({ ...x, repositoryId: x.repositoryId || r[0]?.id || '' }));
      },
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
          const made = await createInitiative(f);
          setF({ ...f, title: '', goal: '' });
          onCreated(made.id);
        } catch (err) {
          setProblem(err instanceof ApiProblem ? err.message : 'Could not create it.');
        }
      }}
    >
      <h3>New initiative</h3>
      <div className="row wrap">
        <input
          aria-label="Title"
          placeholder="Title"
          value={f.title}
          onChange={(e) => setF({ ...f, title: e.target.value })}
          required
        />
        <select
          aria-label="Repository"
          value={f.repositoryId}
          onChange={(e) => setF({ ...f, repositoryId: e.target.value })}
          required
        >
          {repos.length === 0 && <option value="">No repository is registered</option>}
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
        <select
          aria-label="How much runs on its own"
          value={f.autonomyMode}
          onChange={(e) => setF({ ...f, autonomyMode: e.target.value as typeof f.autonomyMode })}
        >
          <option value="guided">Guided: a person reviews every PR</option>
          <option value="balanced">Balanced: pre-approved types merge</option>
          <option value="autopilot">Autopilot: no trigger, no review</option>
        </select>
      </div>
      <textarea
        aria-label="Goal"
        placeholder="The goal, in a few sentences"
        value={f.goal}
        onChange={(e) => setF({ ...f, goal: e.target.value })}
        required
      />
      <button className="primary" type="submit" disabled={!f.repositoryId}>
        Create
      </button>
      {problem && (
        <p role="alert" className="callout warn">
          {problem}
        </p>
      )}
    </form>
  );
}

export function MapPage({ initiativeId, me }: { initiativeId: string | null; me: Me }) {
  const [list, setList] = useState<Array<{ id: string; title: string }>>([]);
  const [map, setMap] = useState<InitiativeMap | null>(null);
  const [releases, setReleases] = useState<Awaited<ReturnType<typeof getReleases>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [role, setRole] = useState(RUN_ROLES[0]!.id);
  const [task, setTask] = useState('');
  const [version, setVersion] = useState('0.1.0');

  const loadList = useCallback(async () => {
    try {
      setList((await getInitiatives()).map((i) => ({ id: i.id, title: i.title })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadMap = useCallback(async () => {
    if (!initiativeId) return setMap(null);
    try {
      const [m, r] = await Promise.all([getMap(initiativeId), getReleases(initiativeId)]);
      setMap(m);
      setReleases(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [initiativeId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    void loadMap();
    const poll = setInterval(() => void loadMap(), 5000);
    return () => clearInterval(poll);
  }, [loadMap]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setNote(null);
    setError(null);
    try {
      await fn();
      setNote(done);
      await loadMap();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.message : String(e));
    }
  };
  const mayRelease = me.roles.some((r) =>
    ['product_owner', 'devops_release', 'platform_admin'].includes(r),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Map</h1>
          <p className="muted">
            Where each initiative is, and who it is waiting on. Spec and design, build and review,
            then release.
          </p>
        </div>
        <select
          aria-label="Initiative"
          value={initiativeId ?? ''}
          onChange={(e) =>
            (window.location.hash = e.target.value ? `#/map/${e.target.value}` : '#/map')
          }
        >
          <option value="">Choose an initiative</option>
          {list.map((i) => (
            <option key={i.id} value={i.id}>
              {i.title}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="callout warn">
          {error}
        </p>
      )}
      {note && (
        <p className="callout ok" data-testid="note">
          {note}
        </p>
      )}

      {map ? (
        <>
          <p>
            <b>{map.initiative.title}</b>{' '}
            <span className="chip">{map.initiative.autonomyMode}</span>
            <br />
            <span className="muted">{map.initiative.goal}</span>
          </p>
          <div className="flow" data-testid="flow">
            {map.stages.map((s, n) => (
              <div className="flow-item" key={s.id}>
                {n > 0 && <span className="arrow">→</span>}
                <StageBox s={s} initiativeId={map.initiative.id} />
              </div>
            ))}
          </div>

          <div className="grid">
            <div className="stack">
              <form
                className="card form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  await act(
                    () => startRun(map.initiative.id, { role, task, budgetUsd: 1 }),
                    'The run is queued. Questions and reviews will arrive in the attention queue.',
                  );
                  setTask('');
                }}
              >
                <h3>Start a run</h3>
                <select aria-label="Agent" value={role} onChange={(e) => setRole(e.target.value)}>
                  {RUN_ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <textarea
                  aria-label="Task"
                  placeholder="What should it do?"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  required
                />
                <button className="primary" type="submit">
                  Start
                </button>
              </form>
            </div>
            <div className="stack">
              <div className="card" data-testid="releases">
                <h3>Releases</h3>
                {releases.length === 0 && <p className="small muted">None yet.</p>}
                <ul className="checks small">
                  {releases.map((r) => (
                    <li key={r.interactionId}>
                      <b>{r.version}</b>{' '}
                      {r.state === 'released' && r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer">
                          published
                        </a>
                      ) : (
                        <span className="chip">{r.state}</span>
                      )}
                      {r.state === 'waiting' && (
                        <>
                          {' '}
                          <a href={`#/queue/${r.interactionId}`}>decide</a>
                        </>
                      )}
                      {r.detail && <div className="muted">{r.detail}</div>}
                    </li>
                  ))}
                </ul>
                {mayRelease && (
                  <form
                    className="row wrap"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await act(
                        () => prepareRelease(map.initiative.id, version),
                        `Release ${version} is waiting for the approver in the attention queue.`,
                      );
                    }}
                  >
                    <input
                      aria-label="Version"
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                      pattern="\d+\.\d+\.\d+"
                      required
                    />
                    <button type="submit">Prepare a release</button>
                  </form>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        !initiativeId && (
          <p className="muted">
            {list.length === 0
              ? 'No initiatives yet. Create the first one below.'
              : 'Choose an initiative.'}
          </p>
        )
      )}
      <NewInitiative
        onCreated={(id) => {
          void loadList();
          window.location.hash = `#/map/${id}`;
        }}
      />
    </>
  );
}
