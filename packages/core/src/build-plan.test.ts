import { describe, expect, it } from 'vitest';
import { pathsOverlap, planProgress, readyTasks, stuckBehind, taskPrompt } from './build-plan.js';
import type { PlanTask, TaskState } from './build-plan.js';
import type { DesignTask } from './design.js';

const t = (
  key: string,
  state: TaskState,
  dependsOn: string[] = [],
  paths?: string[],
): PlanTask => ({
  key,
  state,
  dependsOn,
  ...(paths ? { paths } : {}),
});

describe('readyTasks', () => {
  it('starts tasks with nothing to wait for, in plan order', () => {
    expect(
      readyTasks([t('T1', 'waiting'), t('T2', 'waiting'), t('T3', 'waiting', ['T1'])], 4),
    ).toEqual(['T1', 'T2']);
  });

  it('waits for a dependency to be merged, not just reviewed', () => {
    expect(readyTasks([t('T1', 'review'), t('T2', 'waiting', ['T1'])], 4)).toEqual([]);
    expect(readyTasks([t('T1', 'merged'), t('T2', 'waiting', ['T1'])], 4)).toEqual(['T2']);
  });

  it('treats a skipped dependency as settled, and a failed one as a reason to wait', () => {
    expect(readyTasks([t('T1', 'skipped'), t('T2', 'waiting', ['T1'])], 4)).toEqual(['T2']);
    expect(readyTasks([t('T1', 'failed'), t('T2', 'waiting', ['T1'])], 4)).toEqual([]);
  });

  it('never goes past the limit on running tasks', () => {
    const tasks = [
      t('T1', 'running'),
      t('T2', 'running'),
      t('T3', 'waiting'),
      t('T4', 'waiting'),
      t('T5', 'waiting'),
    ];
    expect(readyTasks(tasks, 3)).toEqual(['T3']);
    expect(readyTasks(tasks, 2)).toEqual([]);
    expect(readyTasks(tasks, 1)).toEqual([]);
    expect(readyTasks(tasks, 5)).toEqual(['T3', 'T4', 'T5']);
  });

  it('does not count a task in review against the limit', () => {
    expect(readyTasks([t('T1', 'review'), t('T2', 'waiting')], 1)).toEqual(['T2']);
  });
});

describe('tasks that share a file', () => {
  it('runs them one after another, in plan order', () => {
    const tasks = [
      t('T1', 'waiting', [], ['src/server.js']),
      t('T2', 'waiting', [], ['src/server.js', 'test/a.js']),
      t('T3', 'waiting', [], ['src/other.js']),
    ];
    expect(readyTasks(tasks, 4)).toEqual(['T1', 'T3']);
  });

  it('keeps waiting while the task with the shared file is running or in review, and goes once it is merged', () => {
    const waiting = t('T2', 'waiting', [], ['src/server.js']);
    expect(readyTasks([t('T1', 'running', [], ['src/server.js']), waiting], 4)).toEqual([]);
    expect(readyTasks([t('T1', 'review', [], ['src/server.js']), waiting], 4)).toEqual([]);
    expect(readyTasks([t('T1', 'merged', [], ['src/server.js']), waiting], 4)).toEqual(['T2']);
    expect(readyTasks([t('T1', 'failed', [], ['src/server.js']), waiting], 4)).toEqual(['T2']);
  });

  it('does not make tasks with other files wait, and treats a task with no paths as free', () => {
    expect(
      readyTasks(
        [t('T1', 'running', [], ['a.js']), t('T2', 'waiting', [], ['b.js']), t('T3', 'waiting')],
        4,
      ),
    ).toEqual(['T2', 'T3']);
  });

  it('counts a folder as holding the files under it', () => {
    expect(pathsOverlap(['src/'], ['src/a.js'])).toBe(true);
    expect(pathsOverlap(['src/a.js'], ['src/'])).toBe(true);
    expect(pathsOverlap(['src/a.js'], ['src/b.js'])).toBe(false);
    expect(pathsOverlap(['src'], ['src/a.js'])).toBe(false);
    expect(pathsOverlap([], ['a.js'])).toBe(false);
  });
});

describe('planProgress', () => {
  it('is done when every task is merged or skipped', () => {
    expect(planProgress([t('T1', 'merged'), t('T2', 'skipped')]).status).toBe('done');
  });
  it('is blocked when a task failed, even if others are running', () => {
    expect(planProgress([t('T1', 'failed'), t('T2', 'running')]).status).toBe('blocked');
  });
  it('is working while a run or a review is in progress, and waiting otherwise', () => {
    expect(planProgress([t('T1', 'review'), t('T2', 'waiting', ['T1'])]).status).toBe('working');
    expect(planProgress([t('T1', 'waiting')]).status).toBe('waiting');
  });
  it('counts each state', () => {
    const p = planProgress([t('T1', 'merged'), t('T2', 'running'), t('T3', 'waiting')]);
    expect(p.counts).toMatchObject({ merged: 1, running: 1, waiting: 1, failed: 0 });
    expect(p.total).toBe(3);
  });
});

describe('stuckBehind', () => {
  it('names the failed tasks a waiting task is behind', () => {
    expect(
      stuckBehind([t('T1', 'failed'), t('T2', 'waiting', ['T1']), t('T3', 'waiting', ['T2'])]),
    ).toEqual({ T2: ['T1'] });
  });
});

describe('taskPrompt', () => {
  const a: DesignTask = {
    id: 'T1',
    title: 'Add the route',
    role: 'backend_engineer',
    stories: ['US-1'],
    dependsOn: [],
    paths: ['src/server.js'],
    doneWhen: ['GET /x answers 200'],
  };
  const b: DesignTask = {
    ...a,
    id: 'T2',
    title: 'Document it',
    dependsOn: ['T1'],
    stories: [],
    paths: ['README.md'],
  };
  const c: DesignTask = { ...a, id: 'T3', title: 'Unrelated' };

  it('starts with the task as the title, then says what to read and what is done', () => {
    const p = taskPrompt({ path: 'docs/design/x.md' }, a, [a, b, c]);
    expect(p.split('\n')[0]).toBe('T1: Add the route');
    expect(p).toContain('Read docs/design/x.md first');
    expect(p).toContain('Stories: US-1');
    expect(p).toContain('- GET /x answers 200');
    expect(p).toContain('Do not do their work: T2 (Document it); T3 (Unrelated)');
    expect(p).not.toContain('Already merged');
  });

  it('keeps a new app apart when the repository already holds another', () => {
    const alone = taskPrompt(
      { path: 'd.md' },
      a,
      [a],
      undefined,
      null,
      undefined,
      [],
      undefined,
      'new_app',
    );
    const apart = taskPrompt(
      { path: 'd.md' },
      a,
      [a],
      undefined,
      null,
      undefined,
      [],
      undefined,
      'new_app',
      true,
    );
    expect(alone).toContain('part of a new app');
    expect(alone).not.toContain('top-level folder');
    expect(apart).toContain('its own top-level folder');
    expect(apart).toContain('.sdlc/preview.yaml');
  });

  it('says why an earlier attempt could not merge, and what to do about it', () => {
    const p = taskPrompt({ path: 'docs/design/x.md' }, a, [a, b], 'It conflicted with main.');
    expect(p).toContain('This is a new attempt');
    expect(p).toContain('It conflicted with main.');
    expect(p).toContain('Start from the current main branch');
    expect(taskPrompt({ path: 'x' }, a, [a, b])).not.toContain('new attempt');
  });

  it("puts a reviewer's words in the prompt when changes were requested", () => {
    const p = taskPrompt(
      { path: 'docs/design/x.md' },
      a,
      [a, b],
      undefined,
      undefined,
      'F1 use textContent.',
    );
    expect(p).toContain('asked for changes');
    expect(p).toContain('F1 use textContent.');
    expect(p).not.toContain('could not merge');
  });

  it('tells the engineer what the design requires of the running app, only when it does', () => {
    const checks = {
      kind: 'checks' as const,
      checks: [{ kind: 'get' as const, path: '/health', status: 200, contains: null }],
    };
    const p = taskPrompt({ path: 'docs/design/x.md' }, a, [a, b], undefined, checks);
    expect(p).toContain('The design requires these smoke checks');
    expect(p).toContain('- get: /health (status 200)');
    expect(p).toContain('.sdlc/preview.yaml');
    const none = { kind: 'none' as const, reason: 'A library with nothing to start.' };
    expect(taskPrompt({ path: 'x' }, a, [a, b], undefined, none)).not.toContain('smoke');
    expect(taskPrompt({ path: 'x' }, a, [a, b])).not.toContain('smoke');
  });

  it('says what was merged before, and leaves out an empty story line', () => {
    const p = taskPrompt({ path: 'docs/design/x.md' }, b, [a, b, c]);
    expect(p).toContain('Already merged before you started: T1 (Add the route)');
    expect(p).not.toContain('Stories:');
    expect(p).toContain('Do not do their work: T3 (Unrelated)');
  });
});

describe('taskPrompt and the kind of work', () => {
  it('tells the engineer how to treat the app, and says nothing for an older initiative', () => {
    const a = {
      id: 'T1',
      title: 'Add the route',
      role: 'backend_engineer',
      stories: [],
      dependsOn: [],
      paths: ['src/a.ts'],
      doneWhen: ['it answers'],
    } as never;
    const feature = taskPrompt(
      { path: 'docs/design/x.md' },
      a,
      [a],
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      'feature',
    );
    expect(feature).toContain('Kind of work: Feature.');
    expect(feature).toContain('Follow its conventions');
    const plain = taskPrompt({ path: 'docs/design/x.md' }, a, [a]);
    expect(plain).not.toContain('Kind of work');
    expect(
      taskPrompt(
        { path: 'docs/design/x.md' },
        a,
        [a],
        undefined,
        null,
        undefined,
        undefined,
        undefined,
        null,
      ),
    ).toBe(plain);
  });
});
