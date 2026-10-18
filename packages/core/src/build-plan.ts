import type { DesignTask } from './design.js';

// The build plan: the approved design's task list, built one run at a time (spec 8.2, "start the next stage"). Pure.
// A task waits until everything it depends on is merged or skipped, so it builds on real code.

export type TaskState =
  'waiting' | 'running' | 'review' | 'merged' | 'failed' | 'skipped' | 'cancelled';

export type PlanState = 'awaiting_start' | 'active' | 'done' | 'cancelled' | 'invalid';

export interface PlanTask {
  key: string;
  state: TaskState;
  dependsOn: string[];
  /** The files the task expects to change. Two tasks that share one are not run at the same time. */
  paths?: string[];
}

const SETTLED = new Set<TaskState>(['merged', 'skipped']);

/** Whether two lists of paths name the same file, or one names a folder (a path ending in "/") that holds the other. */
export function pathsOverlap(a: string[], b: string[]): boolean {
  const within = (folder: string, p: string) => folder.endsWith('/') && p.startsWith(folder);
  return a.some((x) => b.some((y) => x === y || within(x, y) || within(y, x)));
}

/**
 * The waiting tasks to start now, in the order the plan lists them. At most `cap - running` of them, and only those
 * whose dependencies are all settled. A failed dependency keeps its dependents waiting until a person decides.
 * A task that expects to change a file another unmerged task is changing waits for it, because two pull requests
 * that edit the same lines cannot both merge.
 */
export function readyTasks(tasks: PlanTask[], cap: number): string[] {
  const settled = new Set(tasks.filter((t) => SETTLED.has(t.state)).map((t) => t.key));
  const running = tasks.filter((t) => t.state === 'running').length;
  const room = Math.max(0, cap - running);
  // The files that tasks not yet merged are working on, including the ones chosen in this pass.
  const busy: string[][] = tasks
    .filter((t) => t.state === 'running' || t.state === 'review')
    .map((t) => t.paths ?? []);
  const chosen: string[] = [];
  for (const t of tasks) {
    if (chosen.length >= room) break;
    if (t.state !== 'waiting' || !t.dependsOn.every((d) => settled.has(d))) continue;
    const mine = t.paths ?? [];
    if (busy.some((p) => pathsOverlap(mine, p))) continue;
    chosen.push(t.key);
    busy.push(mine);
  }
  return chosen;
}

export interface PlanProgress {
  /** done: nothing left to build. blocked: a task needs a person. working: runs or reviews are in progress. waiting: tasks wait for others. */
  status: 'done' | 'blocked' | 'working' | 'waiting';
  counts: Record<TaskState, number>;
  total: number;
}

export function planProgress(tasks: PlanTask[]): PlanProgress {
  const counts: Record<TaskState, number> = {
    waiting: 0,
    running: 0,
    review: 0,
    merged: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const t of tasks) counts[t.state]++;
  const total = tasks.length;
  const status =
    counts.merged + counts.skipped + counts.cancelled === total
      ? 'done'
      : counts.failed > 0
        ? 'blocked'
        : counts.running + counts.review > 0
          ? 'working'
          : 'waiting';
  return { status, counts, total };
}

/** For each waiting task, the failed tasks it is stuck behind. Shown so a person sees what a decision unblocks. */
export function stuckBehind(tasks: PlanTask[]): Record<string, string[]> {
  const failed = new Set(tasks.filter((t) => t.state === 'failed').map((t) => t.key));
  const out: Record<string, string[]> = {};
  for (const t of tasks) {
    if (t.state !== 'waiting') continue;
    const behind = t.dependsOn.filter((d) => failed.has(d));
    if (behind.length > 0) out[t.key] = behind;
  }
  return out;
}

/**
 * What the engineer agent is told. The first line becomes the pull request title, so it names the task.
 * `others` are the plan's other tasks, listed so the agent leaves their work alone.
 */
export function taskPrompt(
  design: { path: string },
  task: DesignTask,
  others: DesignTask[],
  /** Set when an earlier attempt could not merge, and says why. */
  redo?: string,
): string {
  const lines = [
    `${task.id}: ${task.title}`,
    '',
    `You are building one task of an approved design. Read ${design.path} first, and the spec it covers, then do only this task.`,
    '',
    `Task ${task.id}: ${task.title}`,
    ...(task.stories.length > 0 ? [`Stories: ${task.stories.join(', ')}`] : []),
    `Files you are expected to change: ${task.paths.join(', ')}`,
    'It is done when:',
    ...task.doneWhen.map((d) => `- ${d}`),
  ];
  if (redo) {
    lines.push(
      '',
      `This is a new attempt. An earlier attempt's pull request could not merge: ${redo} Start from the current main branch, which already holds the changes other tasks merged meanwhile, and do this task again on top of it. Do not undo or rewrite what is already there.`,
    );
  }
  const before = others.filter((o) => task.dependsOn.includes(o.id));
  const rest = others.filter((o) => o.id !== task.id && !task.dependsOn.includes(o.id));
  if (before.length > 0) {
    lines.push(
      '',
      `Already merged before you started: ${before.map((o) => `${o.id} (${o.title})`).join('; ')}.`,
    );
  }
  if (rest.length > 0) {
    lines.push(
      '',
      `Other runs build these. Do not do their work: ${rest.map((o) => `${o.id} (${o.title})`).join('; ')}.`,
    );
  }
  return lines.join('\n');
}
