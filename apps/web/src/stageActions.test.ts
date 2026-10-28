import { describe, expect, it } from 'vitest';
import { stageActions } from './stageActions';

const stage = (id: string, status: string, items: Array<[string, string, string]> = []) => ({
  id,
  status,
  items: items.map(([kind, title, state], n) => ({
    kind: kind as 'run' | 'ask',
    id: `${id}-${n}`,
    title,
    state,
  })),
});
const stages = (spec = stage('spec', 'not_started')) => [
  spec,
  stage('build', 'not_started'),
  stage('release', 'not_started'),
];
const step = (stageName: string, state: string, detail: string | null = null) => ({
  id: `step-${stageName}`,
  stage: stageName,
  state,
  title: `Draft the ${stageName}`,
  detail,
});

describe('what a person can do at each stage', () => {
  it('offers Run again on the spec stage when its newest run failed', () => {
    const a = stageActions(
      stages(stage('spec', 'not_started', [['run', 'product', 'failed']])),
      [],
      null,
      true,
    );
    expect(a['spec']!.actions).toEqual([
      { kind: 'retry_run', targetId: 'spec-0', label: 'Run the spec again', primary: true },
    ]);
  });

  it('names the design when the failed run was the architect, and takes the newest run only', () => {
    const run = (r: string, s: string) => ['run', r, s] as [string, string, string];
    const failedDesign = stage('spec', 'working', [
      run('product', 'succeeded'),
      run('architect', 'timed_out'),
    ]);
    expect(stageActions(stages(failedDesign), [], null, true)['spec']!.actions[0]).toMatchObject({
      label: 'Run the design again',
      targetId: 'spec-1',
    });
    const retried = stage('spec', 'working', [run('product', 'failed'), run('product', 'running')]);
    expect(stageActions(stages(retried), [], null, true)['spec']!.actions).toEqual([]);
  });

  it('does not offer Run again for a run that succeeded, or when the stage is done', () => {
    const ok = stage('spec', 'working', [['run', 'product', 'succeeded']]);
    expect(stageActions(stages(ok), [], null, true)['spec']!.actions).toEqual([]);
    const done = stage('spec', 'done', [['run', 'product', 'failed']]);
    expect(stageActions(stages(done), [], null, true)['spec']!.actions).toEqual([]);
  });

  it('offers Start and Skip for a step that waits for a person, and no Run again beside them', () => {
    const waiting = stage('spec', 'waiting_human', [['run', 'product', 'failed']]);
    const a = stageActions(stages(waiting), [step('design', 'awaiting_start')], null, true);
    expect(a['spec']!.actions.map((x) => [x.kind, x.label])).toEqual([
      ['start_step', 'Start the design'],
      ['skip_step', 'Skip'],
    ]);
  });

  it('says why a step cannot start', () => {
    const a = stageActions(stages(), [step('spec', 'invalid', 'The goal is empty.')], null, true);
    expect(a['spec']!.notes).toEqual(['The goal is empty.']);
    expect(a['spec']!.actions).toEqual([]);
  });

  it('offers Start the build when the plan waits', () => {
    const a = stageActions(stages(), [], { id: 'plan-1', state: 'awaiting_start' }, true);
    expect(a['build']!.actions).toEqual([
      { kind: 'start_plan', targetId: 'plan-1', label: 'Start the build', primary: true },
    ]);
    expect(
      stageActions(stages(), [], { id: 'plan-1', state: 'active' }, true)['build']!.actions,
    ).toEqual([]);
  });

  it('gives a person who may not decide no buttons, but still the notes', () => {
    const failed = stage('spec', 'not_started', [['run', 'product', 'failed']]);
    const a = stageActions(
      stages(failed),
      [step('spec', 'invalid', 'Why not.')],
      { id: 'p', state: 'awaiting_start' },
      false,
    );
    expect(a['spec']!.actions).toEqual([]);
    expect(a['build']!.actions).toEqual([]);
    expect(a['spec']!.notes).toEqual(['Why not.']);
  });
});
