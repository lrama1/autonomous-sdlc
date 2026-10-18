import { parse } from 'yaml';

// The task breakdown in a design document (spec 8.2, checkpoint G1 for the Architect). The Architect agent writes it
// as a fenced block named sdlc-tasks. Engineer runs are later started from it, so it has to be exact. Pure.

export const ENGINEER_ROLES = ['frontend_engineer', 'backend_engineer'] as const;
export type EngineerRole = (typeof ENGINEER_ROLES)[number];

export interface DesignTask {
  id: string;
  title: string;
  role: EngineerRole;
  /** Story ids from the spec, such as US-1. */
  stories: string[];
  dependsOn: string[];
  /** The files the task is expected to touch. A hint for review, not a limit. */
  paths: string[];
  doneWhen: string[];
}

export type DesignTasksResult =
  { ok: true; tasks: DesignTask[]; order: string[] } | { ok: false; errors: string[] };

const ID = /^T\d{1,3}$/;
const STORY = /^US-\d{1,3}$/;
const MAX_TASKS = 20;

const TEST_PATH =
  /(^|\/)(tests?|__tests__|e2e|specs?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i;

/** Whether a path is a test file, by the usual names and folders. */
export const isTestPath = (p: string): boolean => TEST_PATH.test(p.replace(/\\/g, '/'));

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')
    ? (v as string[]).map((x) => x.trim())
    : null;

/** Checks the parsed block and returns the tasks and an order in which they can be built. */
export function validateDesignTasks(raw: unknown): DesignTasksResult {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, errors: ['the task list must be a non-empty list'] };
  }
  if (raw.length > MAX_TASKS) {
    errors.push(`there are ${raw.length} tasks; split the work into at most ${MAX_TASKS}`);
  }

  const tasks: DesignTask[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const where = `task ${index + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where} must be a mapping`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const label = id || where;
    if (!ID.test(id)) errors.push(`${where}: id must look like T1, T2, ...`);
    else if (seen.has(id)) errors.push(`${label}: the id is used twice`);
    seen.add(id);

    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) errors.push(`${label}: a title is required`);
    else if (title.length > 120) errors.push(`${label}: the title is longer than 120 characters`);

    const role = e.role as string;
    if (!(ENGINEER_ROLES as readonly string[]).includes(role)) {
      errors.push(`${label}: role must be one of ${ENGINEER_ROLES.join(', ')}`);
    }

    const stories = e.stories === undefined ? [] : strings(e.stories);
    if (stories === null || !stories.every((s) => STORY.test(s))) {
      errors.push(`${label}: stories must be a list of ids like US-1`);
    }
    const dependsOn = e.depends_on === undefined ? [] : strings(e.depends_on);
    if (dependsOn === null) errors.push(`${label}: depends_on must be a list of task ids`);
    const paths = strings(e.paths);
    if (paths === null) errors.push(`${label}: paths must be a list of the files it touches`);
    const doneWhen = strings(e.done_when);
    if (doneWhen === null) {
      errors.push(
        `${label}: done_when must be a list of text lines. Put quotes around a line that has a colon, a brace or a quote in it`,
      );
    } else if (doneWhen.length === 0) {
      errors.push(`${label}: done_when needs at least one checkable line`);
    }

    if (title && stories && dependsOn && paths && doneWhen && doneWhen.length > 0) {
      tasks.push({
        id,
        title,
        role: role as EngineerRole,
        stories,
        dependsOn,
        paths,
        doneWhen,
      });
    }
  });

  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`${t.id}: a task cannot depend on itself`);
      else if (!ids.has(d)) errors.push(`${t.id}: depends on ${d}, which is not a task`);
    }
  }
  // Tests are written with the code they cover, in the same task. A task that only adds tests to code that another
  // task writes ends up with nothing to do, because the first task already added them. A plan made only of test work
  // (adding coverage to existing code) is fine.
  const touchesCode = (t: DesignTask) => t.paths.some((p) => !isTestPath(p));
  if (tasks.some(touchesCode)) {
    for (const t of tasks) {
      if (t.paths.length > 0 && !touchesCode(t)) {
        errors.push(
          `${t.id}: touches only test files (${t.paths.join(', ')}). Put these tests in the task that writes the code they cover`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Kahn's algorithm, keeping the order the author wrote tasks in whenever dependencies allow.
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d)));
    if (!next) {
      const stuck = tasks.filter((t) => !done.has(t.id)).map((t) => t.id);
      return {
        ok: false,
        errors: [`these tasks depend on each other in a circle: ${stuck.join(', ')}`],
      };
    }
    done.add(next.id);
    order.push(next.id);
  }
  return { ok: true, tasks, order };
}

const FENCE = /^```sdlc-tasks[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm;

/** Finds the one sdlc-tasks block in a design document, reads it, and validates it. */
export function parseDesignTasks(markdown: string): DesignTasksResult {
  const blocks = [...markdown.matchAll(FENCE)];
  if (blocks.length === 0) {
    return { ok: false, errors: ['the design has no ```sdlc-tasks block'] };
  }
  if (blocks.length > 1) {
    return { ok: false, errors: ['the design has more than one ```sdlc-tasks block'] };
  }
  let raw: unknown;
  try {
    raw = parse(blocks[0]![1]!);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `the sdlc-tasks block is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      ],
    };
  }
  return validateDesignTasks(raw);
}
