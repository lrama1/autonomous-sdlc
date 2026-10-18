import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssumptionDto, AttentionProfile, InteractionDto, PreviewDto } from '@sdlc/schemas';
import {
  ApiProblem,
  answerInteraction,
  decideAssumption,
  didntNeedToAsk,
  getAssumptions,
  getPreview,
  startPlatformPreview,
  stopPlatformPreview,
  getProfile,
  getQueue,
  snoozeInteraction,
} from './api';
import { TYPE_LABEL, formatSpan, roleLabel } from './labels';

interface Option {
  id: string;
  label: string;
  impact?: string;
}

const optionsOf = (i: InteractionDto): Option[] =>
  Array.isArray(i.options)
    ? (i.options as Option[]).filter((o) => o && typeof o.id === 'string')
    : [];

const card = (i: InteractionDto) =>
  i.contextCard as {
    context?: string | null;
    whyNow?: string | null;
    summary?: string;
    kind?: string;
    prUrl?: string;
    prNumber?: number;
    triggers?: Array<{ id: string; description?: string }>;
    autoMerge?: { auto: boolean; reason: string };
    verify?: { passed?: boolean; attempts?: number };
    diff?: { files?: number; additions?: number; deletions?: number };
  };

const PREVIEW_WORDS: Record<PreviewDto['state'], string> = {
  ready: 'Preview',
  building: 'Preview (building)',
  failed: 'Preview (failed)',
  stale: 'Preview (out of date)',
  none: 'No preview',
  not_permitted: 'No preview',
};

/**
 * The preview of this pull request: what the repository's pipeline published, or one the platform runs in a sandbox
 * when a person asks. The platform runs the pull request's own code only on that click (or in autopilot).
 */
function PreviewLine({ id }: { id: string }) {
  const [p, setP] = useState<PreviewDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await getPreview(id);
        if (stop) return;
        setP(next);
        setFailed(false);
        // Keep looking while a preview may still appear or finish starting. The platform's own is asked for more often.
        if (next.platform.state === 'starting') timer = setTimeout(load, 2_000);
        else if (next.state === 'building' || next.state === 'none' || next.state === 'stale')
          timer = setTimeout(load, 20_000);
      } catch {
        if (!stop) setFailed(true);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, tick]);

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await what();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  if (failed && !p) {
    return (
      <div data-testid="preview">
        <b>Preview</b>
        Could not ask GitHub just now.
      </div>
    );
  }
  if (!p) return null;
  return (
    <div data-testid="preview" data-state={p.state}>
      <b>{PREVIEW_WORDS[p.state]}</b>
      {p.url && (
        <>
          <a href={p.url} target="_blank" rel="noreferrer noopener">
            {p.label ?? 'Open the preview'}
          </a>{' '}
        </>
      )}
      <span className="muted">{p.detail}</span>
      {p.platform.available && (
        <span className="row wrap" data-testid="platform-preview" data-state={p.platform.state}>
          {(p.platform.state === 'starting' || p.platform.state === 'ready') && p.platform.id ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => stopPlatformPreview(p.platform.id!))}
            >
              Stop the preview
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => startPlatformPreview(id))}
            >
              {p.platform.state === 'none' || p.platform.state === 'unavailable'
                ? 'Run it here'
                : 'Run it again'}
            </button>
          )}
          {p.platform.state === 'ready' && p.platform.expiresAt && (
            <span className="muted">
              The platform stops it at{' '}
              {new Date(p.platform.expiresAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </span>
          )}
          {p.platform.state === 'none' && (
            <span className="muted">
              Runs this pull request's own code in a sandbox for {p.platform.ttlMinutes} minutes. It
              has no secrets and almost no network.
            </span>
          )}
          {(p.platform.state === 'failed' || p.platform.state === 'unavailable') &&
            p.platform.detail && (
              <span role="alert" className="callout warn" data-testid="platform-preview-error">
                {p.platform.detail}
              </span>
            )}
        </span>
      )}
      {problem && (
        <span role="alert" className="callout warn">
          {problem}
        </span>
      )}
    </div>
  );
}

function Waiting({ i }: { i: InteractionDto }) {
  const n = i.blocks.length;
  if (i.type === 'review') return <span className="pill wait">Blocks the merge</span>;
  if (i.hardStop) return <span className="pill stop">Hard stop</span>;
  return n > 0 ? (
    <span className="pill wait">
      Blocks {n} run{n === 1 ? '' : 's'}
    </span>
  ) : (
    <span className="pill none">Not blocking</span>
  );
}

function Due({ i, now }: { i: InteractionDto; now: number }) {
  if (!i.dueAt || i.defaultValue === null) return null;
  const left = new Date(i.dueAt).getTime() - now;
  return (
    <span className="chip right" data-testid="due">
      {left > 0 ? `Default in ${formatSpan(left)}` : 'Default being applied'}
    </span>
  );
}

function Ask({
  i,
  rank,
  now,
  highlight,
  onChanged,
  onAnswered,
}: {
  i: InteractionDto;
  rank: number;
  now: number;
  highlight: boolean;
  onChanged: () => void;
  onAnswered: (note: string) => void;
}) {
  const options = optionsOf(i);
  const c = card(i);
  const [picked, setPicked] = useState<string>(i.recommendation ?? options[0]?.id ?? '');
  const [text, setText] = useState('');
  const [standing, setStanding] = useState(false);
  const [scope, setScope] = useState<'initiative' | 'repository' | 'global'>('initiative');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [marked, setMarked] = useState(i.didntNeedToAsk);
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlight]);

  const send = async (body: Parameters<typeof answerInteraction>[1], note: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await answerInteraction(i.id, body);
      onAnswered(note);
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : 'Could not send your answer.');
    } finally {
      setBusy(false);
    }
  };

  const snooze = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await snoozeInteraction(i.id, 120);
      onChanged();
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : 'Could not snooze.');
    } finally {
      setBusy(false);
    }
  };

  const isDecision = i.type === 'review' || i.type === 'checkpoint';
  const recommended = options.find((o) => o.id === i.recommendation);

  return (
    <article
      ref={ref}
      className={`ask${highlight ? ' highlight' : ''}${i.hardStop ? ' hard' : ''}`}
      data-testid="ask"
      data-id={i.id}
    >
      <div className="row wrap">
        <span className="rank">{rank}</span>
        <span className="chip warn">{TYPE_LABEL[i.type] ?? i.type}</span>
        <span className="chip agent">
          {roleLabel(i.agentRole)}
          {i.runId ? ` · RUN-${i.runId.slice(-4).toUpperCase()}` : ''}
        </span>
        <Waiting i={i} />
        {i.escalationLevel > 0 && (
          <span className="pill stop" data-testid="escalated">
            Escalated to you
          </span>
        )}
        {i.snoozedUntil && new Date(i.snoozedUntil).getTime() > now && (
          <span className="chip">
            Snoozed for {formatSpan(new Date(i.snoozedUntil).getTime() - now)}
          </span>
        )}
        <Due i={i} now={now} />
      </div>
      <h3>{i.title}</h3>
      {i.initiativeTitle && <p className="muted small">{i.initiativeTitle}</p>}

      {isDecision ? (
        <div className="ctx">
          {c.summary && (
            <div>
              <b>What happened</b>
              {c.summary}
            </div>
          )}
          {c.triggers && c.triggers.length > 0 && (
            <div>
              <b>Why it needs you</b>
              {c.triggers.map((t) => t.description ?? t.id).join('; ')}
            </div>
          )}
          {c.autoMerge && !c.autoMerge.auto && (
            <div>
              <b>Why a person reviews it</b>
              {c.autoMerge.reason}
            </div>
          )}
          {c.verify && (
            <div>
              <b>Checks</b>
              {c.verify.passed
                ? 'The checks passed before the pull request opened.'
                : 'The checks did not pass.'}
              {c.diff ? ` ${c.diff.files} file(s), +${c.diff.additions} −${c.diff.deletions}.` : ''}
            </div>
          )}
          {c.prUrl && (
            <div>
              <b>Pull request</b>
              <a href={c.prUrl} target="_blank" rel="noreferrer">
                #{c.prNumber} on GitHub
              </a>
            </div>
          )}
          {c.prUrl && <PreviewLine id={i.id} />}
        </div>
      ) : (
        <div className="ctx">
          {(c.context ?? c.summary) && (
            <div>
              <b>What it was doing</b>
              {c.context ?? c.summary}
            </div>
          )}
          {c.whyNow && (
            <div>
              <b>Why it needs you</b>
              {c.whyNow}
            </div>
          )}
          <div>
            <b>What is waiting</b>
            {i.blocks.length > 0
              ? `${i.blocks.length} run${i.blocks.length === 1 ? ' is' : 's are'} waiting for this.`
              : 'Nothing. The agent continues without it.'}
          </div>
        </div>
      )}

      {isDecision ? (
        <>
          <textarea
            aria-label="Comment"
            placeholder="Comment (optional)"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row wrap">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                send(
                  { decision: 'approved', answer: text },
                  'Approved. The change can merge once the checks are green.',
                )
              }
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() =>
                send(
                  { decision: 'changes_requested', answer: text },
                  'Changes requested. The agent will be told.',
                )
              }
            >
              Request changes
            </button>
            <button
              disabled={busy}
              onClick={() => send({ decision: 'rejected', answer: text }, 'Rejected.')}
            >
              Reject
            </button>
            {!i.hardStop && (
              <button disabled={busy} onClick={() => snooze()} className="right">
                Snooze 2 h
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {options.length > 0 ? (
            <fieldset className="opts" disabled={busy}>
              {options.map((o) => (
                <label key={o.id}>
                  <input
                    type="radio"
                    name={`q-${i.id}`}
                    value={o.id}
                    checked={picked === o.id}
                    onChange={() => setPicked(o.id)}
                  />
                  <div>
                    <b>
                      {o.id} · {o.label}
                    </b>{' '}
                    {o.id === i.recommendation && <span className="chip ok">recommended</span>}
                    {o.impact && <div className="sub">{o.impact}</div>}
                  </div>
                </label>
              ))}
            </fieldset>
          ) : (
            <textarea
              aria-label="Your answer"
              placeholder="Your answer"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <div className="row wrap">
            <button
              className="primary"
              disabled={busy || (options.length > 0 ? !picked : !text.trim())}
              onClick={() =>
                send(
                  options.length > 0
                    ? { optionId: picked, makeStanding: standing, standingScope: scope }
                    : { answer: text, makeStanding: standing, standingScope: scope },
                  standing
                    ? 'Saved as a standing decision. Agents will stop asking about this.'
                    : 'The agent has your answer.',
                )
              }
            >
              Answer
            </button>
            {recommended && i.defaultValue !== null && (
              <span className="small muted">
                If nobody answers, <b>{recommended.label}</b> is applied.
              </span>
            )}
            <label className="small">
              <input
                type="checkbox"
                checked={standing}
                onChange={(e) => setStanding(e.target.checked)}
              />{' '}
              Use this answer from now on
            </label>
            {standing && (
              <select
                aria-label="Applies to"
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                <option value="initiative">for this initiative</option>
                <option value="repository">for this repository</option>
                <option value="global">everywhere</option>
              </select>
            )}
            {!i.hardStop && (
              <button className="right" disabled={busy} onClick={() => snooze()}>
                Snooze 2 h
              </button>
            )}
          </div>
        </>
      )}
      <div className="row">
        {
          <button
            className="link small"
            disabled={marked}
            onClick={async () => {
              await didntNeedToAsk(i.id);
              setMarked(true);
            }}
          >
            {marked ? "Marked: didn't need to ask" : "Didn't need to ask"}
          </button>
        }
      </div>
      {problem && (
        <p role="alert" className="callout warn" data-testid="ask-error">
          {problem}
        </p>
      )}
    </article>
  );
}

function AssumptionRow({ a, onChanged }: { a: AssumptionDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (verb: 'accept' | 'reject') => {
    setBusy(true);
    try {
      await decideAssumption(a.id, verb);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask small" data-testid="assumption">
      <div className="row wrap">
        <span className="chip">Notice</span>
        <span className="chip agent">{roleLabel(a.agentRole)}</span>
        <b>Assumption declared: {a.text}</b>
      </div>
      <p className="muted">
        {a.initiativeTitle}. Accepting turns it into a requirement. Rejecting asks the person who
        started the run what to redo.
      </p>
      <div className="row">
        <button disabled={busy} onClick={() => decide('accept')}>
          Accept
        </button>
        <button disabled={busy} onClick={() => decide('reject')}>
          Reject
        </button>
      </div>
    </div>
  );
}

export function Queue({ openId }: { openId: string | null }) {
  const [items, setItems] = useState<InteractionDto[] | null>(null);
  const [assumptions, setAssumptions] = useState<AssumptionDto[]>([]);
  const [profile, setProfile] = useState<AttentionProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // An answered ask leaves the open list at once. Keep what the person was told, until they leave the page.
  const [settled, setSettled] = useState<Array<{ i: InteractionDto; note: string }>>([]);

  const load = useCallback(async () => {
    try {
      const [q, a] = await Promise.all([getQueue(), getAssumptions()]);
      setItems(q);
      setAssumptions(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    getProfile().then(setProfile, () => {});
    const poll = setInterval(() => void load(), 5000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const visible = (items ?? []).filter(
    (i) => !i.snoozedUntil || new Date(i.snoozedUntil).getTime() <= now,
  );
  const snoozed = (items ?? []).length - visible.length;
  const blocking = visible.filter((i) => i.blocks.length > 0 || i.type === 'review');

  return (
    <>
      <div className="page-head">
        <div className="row">
          <h1>Attention queue</h1>
          {items && (
            <span className={`pill ${visible.length ? 'wait' : 'done'}`} data-testid="count">
              {visible.length ? `${visible.length} waiting on you` : 'All clear'}
            </span>
          )}
        </div>
        <p className="muted">
          Ranked by what each ask blocks, then by deadline. No agent is idle while you read.
        </p>
      </div>
      {error && (
        <p role="alert" className="callout warn">
          {error}
        </p>
      )}
      <div className="grid">
        <div className="stack">
          {items && visible.length === 0 && (
            <div className="card" data-testid="empty">
              Nothing is waiting on you.
              {snoozed > 0 && ` ${snoozed} snoozed.`}
            </div>
          )}
          {visible.map((i, n) => (
            <Ask
              key={i.id}
              i={i}
              rank={n + 1}
              now={now}
              highlight={openId === i.id}
              onChanged={load}
              onAnswered={(note) => {
                setSettled((s) => [...s, { i, note }]);
                void load();
              }}
            />
          ))}
          {settled
            .filter((s) => !visible.some((v) => v.id === s.i.id))
            .map((s) => (
              <div className="ask" key={s.i.id} data-testid="settled">
                <h3>{s.i.title}</h3>
                <div className="callout ok" data-testid="answered">
                  <b>Done.</b> {s.note}
                </div>
              </div>
            ))}
          {assumptions.length > 0 && (
            <>
              <h2>
                Assumptions to review <span className="count">{assumptions.length}</span>
              </h2>
              {assumptions.slice(0, 5).map((a) => (
                <AssumptionRow key={a.id} a={a} onChanged={load} />
              ))}
              <a href="#/assumptions" className="small">
                See all assumptions and standing decisions
              </a>
            </>
          )}
        </div>
        <aside className="stack">
          <div className="card">
            <h3>Blocked work</h3>
            {blocking.length === 0 ? (
              <p className="small">No agent is waiting on you.</p>
            ) : (
              <ul className="checks small">
                {blocking.map((i) => (
                  <li key={i.id}>
                    <span className="wt">●</span> {i.title}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="card" data-testid="reached">
            <h3>How you are reached</h3>
            {profile ? (
              <dl className="kv small">
                <dt>Chat</dt>
                <dd>
                  {profile.chatConfigured
                    ? profile.slackLinked
                      ? 'Slack. Answer simple asks in chat.'
                      : 'Slack is set up, but your account is not linked. Ask an admin.'
                    : 'Not set up. You see asks here.'}
                </dd>
                <dt>Digest</dt>
                <dd>
                  {profile.digestAt
                    ? `${profile.digestAt} for low-priority items`
                    : 'Sent as they come'}
                </dd>
                <dt>Reminders</dt>
                <dd>
                  After {formatSpan(profile.reminderAfterMin * 60_000)}, then the next person after{' '}
                  {formatSpan(profile.escalateAfterMin * 60_000)}
                </dd>
                {profile.hats.map((h) => (
                  <div key={h.role} className="kv-row">
                    <dt>{roleLabel(h.role)}</dt>
                    <dd>
                      {h.deputyName ? `Deputy: ${h.deputyName}` : 'No deputy. Admins are next.'}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="small muted">Loading…</p>
            )}
          </div>
          <div className="card">
            <h3>What makes a good ask</h3>
            <p className="small muted">
              Each card says what the agent was doing, why it needs a person, what is waiting, the
              options, a recommendation, and what happens if nobody answers.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
