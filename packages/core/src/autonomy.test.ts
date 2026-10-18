import { describe, expect, it } from 'vitest';
import { decideMerge } from './autonomy.js';

const docs = { id: 'docs-only' };
const trigger = [{ id: 'new-dependency' }];

describe('decideMerge', () => {
  it('always sends a triggered change to a person, in every mode', () => {
    for (const mode of ['guided', 'balanced', 'autopilot'] as const) {
      const d = decideMerge(mode, trigger, null);
      expect(d.auto).toBe(false);
      expect(d.reason).toContain('new-dependency');
    }
  });

  it('guided mode reviews everything, even a pre-approved type', () => {
    expect(decideMerge('guided', [], docs)).toMatchObject({ auto: false, rule: null });
  });

  it('balanced mode merges only pre-approved types', () => {
    expect(decideMerge('balanced', [], docs)).toMatchObject({ auto: true, rule: 'docs-only' });
    expect(decideMerge('balanced', [], null)).toMatchObject({ auto: false, rule: null });
  });

  it('autopilot merges anything no trigger fired on, and names the rule when one fits', () => {
    expect(decideMerge('autopilot', [], null)).toMatchObject({ auto: true, rule: null });
    expect(decideMerge('autopilot', [], docs)).toMatchObject({ auto: true, rule: 'docs-only' });
  });

  it('gives a reason in every case', () => {
    for (const mode of ['guided', 'balanced', 'autopilot'] as const)
      for (const fired of [[], trigger])
        for (const pre of [null, docs])
          expect(decideMerge(mode, fired, pre).reason.length).toBeGreaterThan(10);
  });
});
