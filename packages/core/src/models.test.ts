import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICES } from './pricing.js';
import {
  DEFAULT_MODEL_ALIASES,
  MODEL_ALIASES,
  VETTED_MODELS,
  internalKey,
  internalKeyMatches,
  isVettedModel,
} from './models.js';

describe('the vetted models', () => {
  it('are all Anthropic models with a known price', () => {
    expect(VETTED_MODELS.length).toBeGreaterThan(0);
    for (const m of VETTED_MODELS) {
      expect(m.id.startsWith('anthropic/')).toBe(true);
      expect(m.price).toEqual(DEFAULT_PRICES[m.id]);
    }
  });

  it('cover every default alias, so a fresh install starts on a vetted model', () => {
    expect(Object.keys(DEFAULT_MODEL_ALIASES).sort()).toEqual([...MODEL_ALIASES].sort());
    for (const id of Object.values(DEFAULT_MODEL_ALIASES)) expect(isVettedModel(id)).toBe(true);
  });

  it('refuse a model that is not on the list', () => {
    expect(isVettedModel('openai/gpt-4o')).toBe(false);
    expect(isVettedModel('anthropic/claude-made-up')).toBe(false);
  });
});

describe('the internal key', () => {
  const url = 'postgres://sdlc:secret@db:5432/sdlc';
  it('matches the key made from the same database address, and only that', () => {
    expect(internalKeyMatches(internalKey(url), url)).toBe(true);
    expect(internalKeyMatches(internalKey(url), 'postgres://sdlc:other@db:5432/sdlc')).toBe(false);
    expect(internalKeyMatches(undefined, url)).toBe(false);
    expect(internalKeyMatches('', url)).toBe(false);
    expect(internalKeyMatches(url, url)).toBe(false);
  });
});
