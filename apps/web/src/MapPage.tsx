import { useCallback, useEffect, useState } from 'react';
import type { BuildPlanDto, Me, StageStartDto } from '@sdlc/schemas';
import {
  ApiProblem,
  cancelBuildPlan,
  createInitiative,
  getBuildPlan,
  getInitiatives,
  getMap,
  getReleases,
  getRepositories,
  getStageStarts,
  prepareRelease,
  retryBuildTask,
  sendBackBuildPlan,
  skipStageStep,
  skipBuildTask,
  startBuildPlan,
  startStageStep,
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
  {
    id: 'frontend_engineer',
    label: 'Frontend Engineer agent: build a page or component and open a PR',
  },
];

/** The steps before the build that wait for a person, or are about to start. */
function NextSteps({
  steps,
  mayControl,
  act,
}: {
  steps: StageStartDto[];
  mayControl: boolean;
  act: (fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  // Bug fixes are on the Bugs page.
  const shown = steps.filter(
    (s) => s.stage !== 'bug' && ['pending', 'awaiting_start', 'invalid'].includes(s.state),
  );
  if (shown.length === 0) return null;
  return (
    <div className="card" data-testid="next-steps">
      <h3>Next steps</h3>
      <ul className="checks small">
        {shown.map((s) => (
          <li key={s.id} data-testid={`step-${s.stage}`} data-state={s.state}>
            <b>{s.title}</b>{' '}
            <span className={`pill ${s.state === 'invalid' ? 'stop' : 'wait'}`}>
              {s.state === 'awaiting_start'
                ? 'Waiting for a person'
                : s.state === 'pending'
                  ? 'Starting'
                  : 'Cannot start'}
            </span>
            {s.detail && <div className="muted">{s.detail}</div>}
            {mayControl && s.state === 'awaiting_start' && (
              <div className="row wrap">
                <button
                  className="primary"
                  onClick={() => void act(() => startStageStep(s.id), `${s.title} is starting.`)}
                >
                  Start
                </button>
                <button
                  onClick={() =>
                    void act(
                      () => skipStageStep(s.id),
                      'Skipped. You can still start that run by hand.',
                    )
                  }
                >
                  Skip
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const TASK_STATE: Record<BuildPlanDto['tasks'][number]['state'], { label: string; cls: string }> = {
  waiting: { label: 'Waiting', cls: 'none' },
  running: { label: 'Running', cls: 'wait' },
  review: { label: 'In review', cls: 'wait' },
  merged: { label: 'Merged', cls: 'done' },
  failed: { label: 'Failed', cls: 'stop' },
  skipped: { label: 'Skipped', cls: 'none' },
  cancelled: { label: 'Cancelled', cls: 'none' },
};

/** The approved design's tasks, and where each one is. People start it, retry, skip, or cancel here. */
function BuildPlan({
  plan,
  mayControl,
  act,
}: {
  plan: BuildPlanDto;
  mayControl: boolean;
  act: (fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const live = plan.state === 'active' || plan.state === 'awaiting_start';
  return (
    <div className="card" data-testid="build-plan" data-state={plan.state}>
      <h3>Build plan</h3>
      <p className="small muted">
        From <code>{plan.designPath}</code>. {plan.detail}
      </p>
      {plan.errors.length > 0 && (
        <ul className="small" data-testid="plan-errors">
          {plan.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <ul className="checks small">
        {plan.tasks.map((t) => (
          <li key={t.key} data-testid={`task-${t.key}`} data-state={t.state}>
            <b>{t.key}</b> {t.title}{' '}
            <span className={`pill ${TASK_STATE[t.state].cls}`}>{TASK_STATE[t.state].label}</span>
            {t.dependsOn.length > 0 && (
              <span className="muted"> after {t.dependsOn.join(', ')}</span>
            )}
            {t.prNumber !== null && <span className="muted"> ? PR #{t.prNumber}</span>}
            {t.attempt > 1 && <span className="muted"> ? attempt {t.attempt}</span>}
            {t.detail && <div className="muted">{t.detail}</div>}
            {t.stuckBehind.length > 0 && (
              <div className="muted">Stuck behind {t.stuckBehind.join(', ')}.</div>
            )}
            {mayControl && live && (t.state === 'failed' || t.state === 'waiting') && (
              <div className="row wrap">
                {t.state === 'failed' && (
                  <button
                    onClick={() =>
                      void act(() => retryBuildTask(plan.id, t.key), `${t.key} will run again.`)
                    }
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={() =>
                    void act(
                      () => skipBuildTask(plan.id, t.key),
                      `${t.key} is skipped. What waits for it can start.`,
                    )
                  }
                >
                  Skip
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {mayControl && plan.state === 'awaiting_start' && (
        <button
          className="primary"
          onClick={() =>
            void act(
              () => startBuildPlan(plan.id),
              'The build has started. Tasks start as their dependencies merge.',
            )
          }
        >
          Start the build
        </button>
      )}{' '}
      {mayControl && plan.state === 'invalid' && (
        <button
          className="primary"
          onClick={() =>
            void act(
              () => sendBackBuildPlan(plan.id),
              'Sent back to the Architect. A revised design is coming.',
            )
          }
        >
          Send back to the Architect
        </button>
      )}{' '}
      {mayControl && live && (
        <button
          onClick={() => void act(() => cancelBuildPlan(plan.id), 'The build plan is cancelled.')}
        >
          Cancel the plan
        </button>
      )}
    </div>
  );
}

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
    autoStages: true,
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
      <label className="row small">
        <input
          type="checkbox"
          checked={f.autoStages}
          onChange={(e) => setF({ ...f, autoStages: e.target.checked })}
        />
        Draft the spec now, then design and build after each approval (guided mode waits for a
        click)
      </label>
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
  const [plan, setPlan] = useState<BuildPlanDto | null>(null);
  const [steps, setSteps] = useState<StageStartDto[]>([]);

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
      const [m, r, p, st] = await Promise.all([
        getMap(initiativeId),
        getReleases(initiativeId),
        getBuildPlan(initiativeId),
        getStageStarts(initiativeId),
      ]);
      setMap(m);
      setReleases(r);
      setPlan(p);
      setSteps(st);
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
  const mayControlBuild = me.roles.some((r) =>
    ['product_owner', 'architect', 'platform_admin'].includes(r),
  );
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
              <NextSteps steps={steps} mayControl={mayControlBuild} act={act} />
              {plan && <BuildPlan plan={plan} mayControl={mayControlBuild} act={act} />}
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
