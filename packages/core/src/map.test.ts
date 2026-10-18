import { describe, expect, it } from 'vitest';
import { buildMap } from './map.js';
import type { MapAsk, MapPlan, MapRun, MapStageStart } from './map.js';

let n = 0;
const run = (agentRole: string, state: string): MapRun => ({ id: `r${++n}`, agentRole, state });
const ask = (o: Partial<MapAsk> = {}): MapAsk => ({
  id: `a${++n}`,
  type: 'review',
  checkpointId: 'G3',
  state: 'open',
  title: 'ask',
  roleNeeded: 'backend_engineer',
  hardStop: false,
  decision: null,
  runRole: 'backend_engineer',
  gate: null,
  released: false,
  ...o,
});
const stage = (runs: MapRun[], asks: MapAsk[], id: 'spec' | 'build' | 'release') =>
  buildMap({ runs, asks }).find((s) => s.id === id)!;

describe('the SDLC map', () => {
  it('draws the three active checkpoints, all not started for a new initiative', () => {
    const m = buildMap({ runs: [], asks: [] });
    expect(m.map((s) => [s.id, s.checkpoint, s.status])).toEqual([
      ['spec', 'G1', 'not_started'],
      ['build', 'G3', 'not_started'],
      ['release', 'G6', 'not_started'],
    ]);
  });

  describe('spec and design (G1)', () => {
    it('is working while an agent drafts, then waits on the person who decides', () => {
      expect(stage([run('product', 'running')], [], 'spec').status).toBe('working');
      const waiting = stage(
        [run('product', 'succeeded')],
        [ask({ checkpointId: 'G1', roleNeeded: 'product_owner', runRole: 'product' })],
        'spec',
      );
      expect(waiting).toMatchObject({ status: 'waiting_human', waitingOn: ['product_owner'] });
    });

    it("also waits on a person when the spec agent's own question is open", () => {
      const s = stage(
        [run('product', 'parked')],
        [
          ask({
            type: 'question',
            checkpointId: null,
            runRole: 'product',
            roleNeeded: 'product_owner',
          }),
        ],
        'spec',
      );
      expect(s).toMatchObject({ status: 'waiting_human', waitingOn: ['product_owner'] });
    });

    it('is done once the approved spec is merged, and working while the merge is pending', () => {
      const approved = ask({
        checkpointId: 'G1',
        state: 'answered',
        decision: 'approved',
        runRole: 'product',
      });
      expect(
        stage([run('product', 'succeeded')], [{ ...approved, gate: 'waiting_ci' }], 'spec').status,
      ).toBe('working');
      expect(
        stage([run('product', 'succeeded')], [{ ...approved, gate: 'merged' }], 'spec').status,
      ).toBe('done');
    });

    it('is blocked when changes were requested and no run is working on them', () => {
      const s = stage(
        [run('product', 'succeeded')],
        [
          ask({
            checkpointId: 'G1',
            state: 'answered',
            decision: 'changes_requested',
            runRole: 'product',
          }),
        ],
        'spec',
      );
      expect(s.status).toBe('blocked');
      expect(
        stage(
          [run('product', 'running')],
          [
            ask({
              checkpointId: 'G1',
              state: 'answered',
              decision: 'changes_requested',
              runRole: 'product',
            }),
          ],
          'spec',
        ).status,
      ).toBe('working');
    });
  });

  describe('build (G3)', () => {
    it('is working while engineers run, and waiting when a person is needed', () => {
      expect(stage([run('backend_engineer', 'running')], [], 'build').status).toBe('working');
      const s = stage([run('backend_engineer', 'running')], [ask({ roleNeeded: 'qa' })], 'build');
      expect(s).toMatchObject({ status: 'waiting_human', waitingOn: ['qa'] });
    });

    it('is done when changes merged and nothing is running or waiting', () => {
      const merged = ask({ state: 'answered', decision: 'approved', gate: 'merged' });
      const s = stage([run('backend_engineer', 'succeeded')], [merged], 'build');
      expect(s.status).toBe('done');
      expect(s.detail).toContain('1 pull request merged');
    });

    it('is blocked when a merge was stopped, or runs ended with nothing merged', () => {
      expect(
        stage(
          [run('backend_engineer', 'succeeded')],
          [ask({ state: 'answered', decision: 'approved', gate: 'ci_failed' })],
          'build',
        ).status,
      ).toBe('blocked');
      expect(stage([run('backend_engineer', 'failed')], [], 'build').status).toBe('blocked');
    });

    it("does not count the spec agent's work as build work", () => {
      const s = stage(
        [run('product', 'running')],
        [ask({ type: 'question', checkpointId: null, runRole: 'product' })],
        'build',
      );
      expect(s.status).toBe('not_started');
    });
  });

  describe('release (G6)', () => {
    it('says how much is ready, waits for the approver, and is done once published', () => {
      const merged = ask({ state: 'answered', decision: 'approved', gate: 'merged' });
      expect(stage([], [merged], 'release').detail).toContain('1 merged change');
      const open = ask({
        checkpointId: 'G6',
        hardStop: true,
        roleNeeded: 'product_owner',
        runRole: null,
      });
      expect(stage([], [open], 'release')).toMatchObject({
        status: 'waiting_human',
        waitingOn: ['product_owner'],
      });
      expect(
        stage([], [{ ...open, state: 'answered', decision: 'approved', released: true }], 'release')
          .status,
      ).toBe('done');
    });

    it('is blocked when approved but not published', () => {
      const s = stage(
        [],
        [
          ask({
            checkpointId: 'G6',
            state: 'answered',
            decision: 'approved',
            released: false,
            runRole: null,
          }),
        ],
        'release',
      );
      expect(s.status).toBe('blocked');
    });
  });
});

describe('the build stage with a build plan', () => {
  const plan = (o: Partial<MapPlan> = {}): MapPlan => ({
    state: 'active',
    total: 3,
    merged: 1,
    failed: 0,
    ...o,
  });
  const build = (p: MapPlan | undefined, runs: MapRun[] = [], asks: MapAsk[] = []) =>
    buildMap({ runs, asks, plan: p }).find((s) => s.id === 'build')!;

  it('waits for a person to start an approved plan', () => {
    const s = build(plan({ state: 'awaiting_start', merged: 0 }));
    expect(s.status).toBe('waiting_human');
    expect(s.waitingOn).toEqual(['product_owner', 'architect']);
    expect(s.detail).toContain('3 tasks');
  });

  it('is blocked when the plan is invalid, or a task failed', () => {
    expect(build(plan({ state: 'invalid' })).status).toBe('blocked');
    const s = build(plan({ failed: 2 }), [run('backend_engineer', 'running')]);
    expect(s.status).toBe('blocked');
    expect(s.detail).toContain('2 build tasks failed');
  });

  it('is working while tasks wait for others, and says how far it got', () => {
    const s = build(plan());
    expect(s.status).toBe('working');
    expect(s.detail).toContain('1 of 3 build tasks merged');
  });

  it('is done when the plan is done, and ignores a cancelled plan', () => {
    expect(build(plan({ state: 'done', merged: 3 })).status).toBe('done');
    expect(build(plan({ state: 'cancelled' })).status).toBe('not_started');
  });

  it('still shows an open review first', () => {
    const s = build(
      plan(),
      [],
      [ask({ type: 'review', checkpointId: 'G3', runRole: 'backend_engineer' })],
    );
    expect(s.status).toBe('waiting_human');
  });
});

describe('the spec and design stage with steps that start by themselves', () => {
  const spec = (starts: MapStageStart[], runs: MapRun[] = [], asks: MapAsk[] = []) =>
    buildMap({ runs, asks, starts }).find((s) => s.id === 'spec')!;

  it('waits on a Product Owner to start the spec in guided mode', () => {
    const s = spec([{ stage: 'spec', state: 'awaiting_start' }]);
    expect(s.status).toBe('waiting_human');
    expect(s.waitingOn).toEqual(['product_owner']);
  });

  it('waits on an Architect to start the design after the spec merged', () => {
    const merged = ask({
      checkpointId: 'G1',
      state: 'answered',
      decision: 'approved',
      gate: 'merged',
      runRole: 'product',
      roleNeeded: 'product_owner',
    });
    const s = spec(
      [{ stage: 'design', state: 'awaiting_start' }],
      [run('product', 'succeeded')],
      [merged],
    );
    expect(s.status).toBe('waiting_human');
    expect(s.waitingOn).toEqual(['architect']);
  });

  it('is working while a step is about to start, instead of done', () => {
    const merged = ask({
      checkpointId: 'G1',
      state: 'answered',
      decision: 'approved',
      gate: 'merged',
      runRole: 'product',
    });
    const s = spec(
      [{ stage: 'design', state: 'pending' }],
      [run('product', 'succeeded')],
      [merged],
    );
    expect(s.status).toBe('working');
  });

  it('ignores steps that started or were dropped', () => {
    expect(
      spec([
        { stage: 'spec', state: 'started' },
        { stage: 'design', state: 'cancelled' },
      ]).status,
    ).toBe('not_started');
  });
});
