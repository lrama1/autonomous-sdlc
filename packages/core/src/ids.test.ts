import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids.js';

describe('uuidv7', () => {
  it('has the version and variant bits set', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const id = uuidv7(0x0123456789ab);
    expect(id.replace(/-/g, '').slice(0, 12)).toBe('0123456789ab');
  });

  it('sorts by creation time', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect([b, a].sort()).toEqual([a, b]);
  });

  it('is unique for the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(5_000)));
    expect(ids.size).toBe(1000);
  });
});
