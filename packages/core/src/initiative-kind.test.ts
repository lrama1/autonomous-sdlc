import { describe, expect, it } from 'vitest';
import { INITIATIVE_KINDS, isKind, kindGuidance, suggestKind } from './initiative-kind.js';

describe('initiative kinds', () => {
  it('suggests a feature for a repository that already has work, and a new app for one that has none', () => {
    expect(suggestKind(false)).toBe('new_app');
    expect(suggestKind(true)).toBe('feature');
  });

  it('knows its own kinds and nothing else', () => {
    for (const k of INITIATIVE_KINDS) expect(isKind(k)).toBe(true);
    expect(isKind('epic')).toBe(false);
    expect(isKind(null)).toBe(false);
  });

  it('tells each agent what the kind means for its job, and nothing for an unknown kind', () => {
    expect(kindGuidance('feature', 'architect')).toContain('Do not restructure');
    expect(kindGuidance('feature', 'product')).toContain('must not change');
    expect(kindGuidance('feature', 'engineer')).toContain('Follow its conventions');
    expect(kindGuidance('new_app', 'product')).toContain('covers the whole app');
    expect(kindGuidance('new_app', 'architect')).toContain('design covers the whole app');
    expect(kindGuidance('change', 'engineer')).toContain('smallest change');
    expect(kindGuidance(null, 'product')).toBeNull();
    expect(kindGuidance('nonsense', 'engineer')).toBeNull();
    for (const k of INITIATIVE_KINDS)
      for (const a of ['product', 'architect', 'engineer'] as const)
        expect(kindGuidance(k, a)).toMatch(/^Kind of work: /);
  });
});
