import { describe, expect, it } from 'vitest';
import { pickInitiative } from './pickInitiative';

const i = (id: string, state: string) => ({ id, state });

describe('which initiative the Map opens on', () => {
  it('picks the first one in progress, newest first', () => {
    expect(
      pickInitiative([i('new-draft', 'draft'), i('a', 'active'), i('b', 'active')], null),
    ).toBe('a');
  });

  it('falls back to the first one not finished when none is in progress', () => {
    expect(pickInitiative([i('old', 'done'), i('p', 'paused'), i('d', 'draft')], null)).toBe('p');
  });

  it('never picks a finished or cancelled one for the person', () => {
    expect(pickInitiative([i('x', 'done'), i('y', 'cancelled')], null)).toBeNull();
    expect(pickInitiative([], null)).toBeNull();
  });

  it('goes back to the one the person was last looking at, while it is unfinished', () => {
    const list = [i('a', 'active'), i('b', 'active'), i('c', 'done')];
    expect(pickInitiative(list, 'b')).toBe('b');
    expect(pickInitiative(list, 'c')).toBe('a');
    expect(pickInitiative(list, 'gone')).toBe('a');
  });
});
