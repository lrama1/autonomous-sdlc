// The SDLC map (spec 10.2): where an initiative is, and who it is waiting on. Pure.
// Only the checkpoints that are active by default are drawn: G1 spec and design, G3 change merge, G6 release (spec 8.2).

export type StageStatus = 'not_started' | 'working' | 'waiting_human' | 'blocked' | 'done';
export type StageId = 'spec' | 'build' | 'release';

export interface MapRun {
  id: string;
  agentRole: string;
  state: string;
}

export interface MapAsk {
  id: string;
  type: string;
  checkpointId: string | null;
  state: string;
  title: string;
  roleNeeded: string;
  hardStop: boolean;
  /** The person's decision, for a review or checkpoint. */
  decision: string | null;
  /** The role of the agent run that raised it, if a run did. */
  runRole: string | null;
  /** How far a pull request got: merged, waiting_ci, ci_failed, and so on. */
  gate: string | null;
  /** The release record, for a G6 checkpoint: released or failed. */
  released: boolean;
}

export interface MapStage {
  id: StageId;
  title: string;
  checkpoint: string;
  status: StageStatus;
  /** Roles whose people the stage is waiting on. */
  waitingOn: string[];
  /** One line saying why the stage has this status. */
  detail: string;
  items: Array<{ kind: 'run' | 'ask'; id: string; title: string; state: string }>;
}

const ACTIVE_RUN = new Set(['queued', 'starting', 'running', 'resuming', 'parked']);
const SPEC_ROLES = new Set(['product', 'architect']);

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** A step before the build that starts by itself or waits for a person: drafting the spec, designing it. */
export interface MapStageStart {
  stage: 'spec' | 'design';
  state: string;
}

function specStage(runs: MapRun[], asks: MapAsk[], starts: MapStageStart[] = []): MapStage {
  const specRuns = runs.filter((r) => SPEC_ROLES.has(r.agentRole));
  const g1 = asks.filter((a) => a.checkpointId === 'G1');
  // The spec agents' own questions also hold this stage up.
  const openG1 = asks.filter(
    (a) =>
      a.state === 'open' &&
      (a.checkpointId === 'G1' || (a.runRole !== null && SPEC_ROLES.has(a.runRole))),
  );
  const approved = g1.filter((a) => a.decision === 'approved');
  const merged = approved.filter((a) => a.gate === 'merged');
  const sent = g1.filter((a) => a.decision === 'changes_requested' || a.decision === 'rejected');
  const items: MapStage['items'] = [
    ...specRuns.map((r) => ({
      kind: 'run' as const,
      id: r.id,
      title: r.agentRole,
      state: r.state,
    })),
    ...g1.map((a) => ({ kind: 'ask' as const, id: a.id, title: a.title, state: a.state })),
  ];
  const base = { id: 'spec' as const, title: 'Spec and design', checkpoint: 'G1', items };
  if (openG1.length > 0)
    return {
      ...base,
      status: 'waiting_human',
      waitingOn: unique(openG1.map((a) => a.roleNeeded)),
      detail: 'The spec needs a decision, or an agent is waiting on an answer.',
    };
  const awaiting = starts.filter((s) => s.state === 'awaiting_start');
  if (awaiting.length > 0) {
    const design = awaiting.some((s) => s.stage === 'design');
    return {
      ...base,
      status: 'waiting_human',
      waitingOn: [design ? 'architect' : 'product_owner'],
      detail: design
        ? 'The spec is approved. A person starts the design.'
        : 'A person starts the spec.',
    };
  }
  if (starts.some((s) => s.state === 'pending'))
    return {
      ...base,
      status: 'working',
      waitingOn: [],
      detail: 'The next step is about to start.',
    };
  if (merged.length > 0 && !specRuns.some((r) => ACTIVE_RUN.has(r.state)))
    return {
      ...base,
      status: 'done',
      waitingOn: [],
      detail: 'The spec and design are approved and merged.',
    };
  if (approved.length > 0)
    return {
      ...base,
      status: 'working',
      waitingOn: [],
      detail: 'Approved. Waiting for the checks, then the merge.',
    };
  if (sent.length > 0 && !specRuns.some((r) => ACTIVE_RUN.has(r.state)))
    return {
      ...base,
      status: 'blocked',
      waitingOn: [],
      detail: 'A person asked for changes or rejected it. It needs another run.',
    };
  if (specRuns.some((r) => ACTIVE_RUN.has(r.state)))
    return { ...base, status: 'working', waitingOn: [], detail: 'An agent is drafting it.' };
  return { ...base, status: 'not_started', waitingOn: [], detail: 'No spec yet.' };
}

/** What the map needs to know about the build plan of an initiative. */
export interface MapPlan {
  state: 'awaiting_start' | 'active' | 'done' | 'cancelled' | 'invalid';
  total: number;
  merged: number;
  failed: number;
}

function buildStage(runs: MapRun[], asks: MapAsk[], plan?: MapPlan): MapStage {
  const eng = runs.filter((r) => !SPEC_ROLES.has(r.agentRole));
  const mine = asks.filter(
    (a) =>
      a.checkpointId !== 'G1' &&
      a.checkpointId !== 'G6' &&
      !(a.runRole !== null && SPEC_ROLES.has(a.runRole)),
  );
  const open = mine.filter((a) => a.state === 'open');
  const merged = mine.filter((a) => a.type === 'review' && a.gate === 'merged');
  const failed = mine.filter(
    (a) =>
      a.gate === 'ci_failed' || a.gate === 'failed' || a.gate === 'stale' || a.gate === 'conflict',
  );
  const active = eng.filter((r) => ACTIVE_RUN.has(r.state));
  const items: MapStage['items'] = [
    ...eng.map((r) => ({ kind: 'run' as const, id: r.id, title: r.agentRole, state: r.state })),
    ...open.map((a) => ({ kind: 'ask' as const, id: a.id, title: a.title, state: a.state })),
  ];
  const base = { id: 'build' as const, title: 'Build and review', checkpoint: 'G3', items };
  if (open.length > 0)
    return {
      ...base,
      status: 'waiting_human',
      waitingOn: unique(open.map((a) => a.roleNeeded)),
      detail: `${open.length} thing${open.length === 1 ? '' : 's'} waiting on a person.`,
    };
  const p = plan && plan.state !== 'cancelled' ? plan : undefined;
  if (p?.state === 'awaiting_start')
    return {
      ...base,
      status: 'waiting_human',
      waitingOn: ['product_owner', 'architect'],
      detail: `The design is approved. A person starts the build (${p.total} task${p.total === 1 ? '' : 's'}).`,
    };
  if (p?.state === 'invalid')
    return {
      ...base,
      status: 'blocked',
      waitingOn: ['architect'],
      detail: 'The approved design cannot be built as written. See the build plan.',
    };
  if (p?.state === 'active' && p.failed > 0)
    return {
      ...base,
      status: 'blocked',
      waitingOn: ['product_owner', 'architect'],
      detail: `${p.failed} build task${p.failed === 1 ? '' : 's'} failed. A person retries or skips ${p.failed === 1 ? 'it' : 'them'}.`,
    };
  if (active.length > 0)
    return {
      ...base,
      status: 'working',
      waitingOn: [],
      detail: `${active.length} run${active.length === 1 ? '' : 's'} in progress.`,
    };
  if (p?.state === 'active')
    return {
      ...base,
      status: 'working',
      waitingOn: [],
      detail: `${p.merged} of ${p.total} build tasks merged. The next ones start as their dependencies merge.`,
    };
  if (p?.state === 'done')
    return {
      ...base,
      status: 'done',
      waitingOn: [],
      detail: `All ${p.total} build task${p.total === 1 ? '' : 's'} are merged or skipped.`,
    };
  if (failed.length > 0)
    return {
      ...base,
      status: 'blocked',
      waitingOn: [],
      detail: 'A merge was stopped. See the review.',
    };
  if (merged.length > 0)
    return {
      ...base,
      status: 'done',
      waitingOn: [],
      detail: `${merged.length} pull request${merged.length === 1 ? '' : 's'} merged, nothing in progress.`,
    };
  return {
    ...base,
    status: eng.length > 0 ? 'blocked' : 'not_started',
    waitingOn: [],
    detail: eng.length > 0 ? 'Runs ended without a merged change.' : 'No work started.',
  };
}

function releaseStage(asks: MapAsk[], merged: number): MapStage {
  const g6 = asks.filter((a) => a.checkpointId === 'G6');
  const items = g6.map((a) => ({ kind: 'ask' as const, id: a.id, title: a.title, state: a.state }));
  const base = { id: 'release' as const, title: 'Release', checkpoint: 'G6', items };
  const open = g6.filter((a) => a.state === 'open');
  if (open.length > 0)
    return {
      ...base,
      status: 'waiting_human',
      waitingOn: unique(open.map((a) => a.roleNeeded)),
      detail: 'A release is waiting for approval. Releases are never automatic.',
    };
  if (g6.some((a) => a.released))
    return { ...base, status: 'done', waitingOn: [], detail: 'The latest release is published.' };
  if (g6.some((a) => a.decision === 'approved'))
    return {
      ...base,
      status: 'blocked',
      waitingOn: [],
      detail: 'Approved, but the release was not published. See the release.',
    };
  return {
    ...base,
    status: 'not_started',
    waitingOn: [],
    detail:
      merged > 0
        ? `${merged} merged change${merged === 1 ? '' : 's'} are ready to release.`
        : 'Nothing to release yet.',
  };
}

export function buildMap(input: {
  runs: MapRun[];
  asks: MapAsk[];
  plan?: MapPlan;
  starts?: MapStageStart[];
}): MapStage[] {
  const merged = input.asks.filter(
    (a) => a.type === 'review' && a.gate === 'merged' && a.checkpointId === 'G3',
  ).length;
  return [
    specStage(input.runs, input.asks, input.starts),
    buildStage(input.runs, input.asks, input.plan),
    releaseStage(input.asks, merged),
  ];
}
