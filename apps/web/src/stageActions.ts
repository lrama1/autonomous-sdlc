// What a person can do at each stage of the Map, worked out from where the stage is. Pure.

export type StageActionKind =
  | 'start_step'
  | 'skip_step'
  | 'retry_run'
  | 'start_plan'
  | 'retry_task'
  | 'skip_task'
  | 'preview_start'
  | 'preview_stop'
  | 'preview_open'
  | 'preview_wait';

export interface StageAction {
  kind: StageActionKind;
  /** The step, run or build plan the button acts on. */
  targetId: string;
  /** For a build task: the task's key within the plan named by 	argetId. */
  taskKey?: string;
  label: string;
  primary: boolean;
  /** A link to open, for a button that goes somewhere instead of doing something. */
  href?: string;
}

/** The platform's preview of what the build produced. */
export interface MainPreviewIn {
  available: boolean;
  id: string | null;
  state: string;
  url: string | null;
  detail: string | null;
}

interface StageIn {
  id: string;
  status: string;
  items: Array<{ kind: 'run' | 'ask'; id: string; title: string; state: string }>;
}

const FAILED = ['failed', 'cancelled', 'budget_exceeded', 'timed_out'];
const ACTIVE = ['queued', 'starting', 'running', 'resuming', 'parked', 'paused'];
const STEP_WORD: Record<string, string> = { spec: 'spec', design: 'design' };

/**
 * `steps` are the spec and design starts of the initiative, `plan` its build plan. A person who may not decide these
 * gets no buttons. The spec stage offers Start and Skip for a step that waits, and Run again when its newest run
 * failed. The build stage offers Start the build.
 */
export function stageActions(
  stages: StageIn[],
  steps: Array<{ id: string; stage: string; state: string; title: string; detail: string | null }>,
  plan: {
    id: string;
    state: string;
    tasks?: Array<{ key: string; title: string; state: string; detail?: string | null }>;
  } | null,
  mayControl: boolean,
  /** The preview of the built app, and whether this person may start one. */
  preview: { main: MainPreviewIn | null; mayStart: boolean } | null = null,
): Record<string, { actions: StageAction[]; notes: string[] }> {
  const out: Record<string, { actions: StageAction[]; notes: string[] }> = {};
  for (const s of stages) out[s.id] = { actions: [], notes: [] };

  const spec = out['spec'];
  const specStage = stages.find((s) => s.id === 'spec');
  if (spec && specStage) {
    const before = steps.filter((x) => x.stage === 'spec' || x.stage === 'design');
    for (const x of before.filter((y) => y.state === 'invalid'))
      spec.notes.push(x.detail ?? `${x.title} cannot start.`);
    const waiting = before.filter((x) => x.state === 'awaiting_start');
    if (mayControl)
      for (const x of waiting) {
        spec.actions.push({
          kind: 'start_step',
          targetId: x.id,
          label: `Start the ${STEP_WORD[x.stage] ?? x.stage}`,
          primary: true,
        });
        spec.actions.push({ kind: 'skip_step', targetId: x.id, label: 'Skip', primary: false });
      }
    const runs = specStage.items.filter((i) => i.kind === 'run');
    const newest = runs[runs.length - 1];
    if (
      mayControl &&
      newest &&
      FAILED.includes(newest.state) &&
      waiting.length === 0 &&
      specStage.status !== 'done' &&
      !runs.some((r) => ACTIVE.includes(r.state))
    )
      spec.actions.push({
        kind: 'retry_run',
        targetId: newest.id,
        label: `Run the ${newest.title === 'architect' ? 'design' : 'spec'} again`,
        primary: true,
      });
  }

  const build = out['build'];
  if (build && mayControl && plan?.state === 'awaiting_start')
    build.actions.push({
      kind: 'start_plan',
      targetId: plan.id,
      label: 'Start the build',
      primary: true,
    });
  // A failed build task stops what depends on it. Say which one and why, and put Retry and Skip where the person is looking.
  if (build && plan && ['active', 'awaiting_start'].includes(plan.state)) {
    for (const t of (plan.tasks ?? []).filter((x) => x.state === 'failed')) {
      build.notes.push(`${t.key} failed${t.detail ? `: ${t.detail}` : '.'}`);
      if (mayControl) {
        build.actions.push({
          kind: 'retry_task',
          targetId: plan.id,
          taskKey: t.key,
          label: `Retry ${t.key}`,
          primary: true,
        });
        build.actions.push({
          kind: 'skip_task',
          targetId: plan.id,
          taskKey: t.key,
          label: `Skip ${t.key}`,
          primary: false,
        });
      }
    }
  }

  // Once something has merged, a person can run what the build made, whether or not every task is done.
  const merged = (plan?.tasks ?? []).some((t) => t.state === 'merged');
  if (build && preview?.main?.available && merged) {
    const p = preview.main;
    if (p.state === 'starting')
      build.actions.push({
        kind: 'preview_wait',
        targetId: p.id ?? '',
        label: 'Starting the preview...',
        primary: false,
      });
    else if (p.state === 'ready' && p.url) {
      build.actions.push({
        kind: 'preview_open',
        targetId: p.id ?? '',
        label: 'Open the built app',
        primary: true,
        href: p.url,
      });
      if (preview.mayStart && p.id)
        build.actions.push({
          kind: 'preview_stop',
          targetId: p.id,
          label: 'Stop the preview',
          primary: false,
        });
    } else if (preview.mayStart) {
      if ((p.state === 'failed' || p.state === 'unavailable') && p.detail)
        build.notes.push(`The preview did not start: ${p.detail}`);
      build.actions.push({
        kind: 'preview_start',
        targetId: '',
        label: p.state === 'none' ? 'Preview the built app' : 'Preview the built app again',
        primary: plan?.state === 'done',
      });
    }
  }
  return out;
}
