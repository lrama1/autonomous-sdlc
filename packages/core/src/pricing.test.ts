import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICES, costMicros } from './pricing.js';
import { generateToken, hashToken } from './tokens.js';

describe('costMicros', () => {
  const haiku = DEFAULT_PRICES['anthropic/claude-haiku-4.5'];

  it('prices each token class separately', () => {
    // 1000 in * 1 + 2000 write * 1.25 + 10000 read * 0.1 + 500 out * 5 = 1000 + 2500 + 1000 + 2500
    const c = costMicros(
      haiku,
      { inputTokens: 1000, cacheWriteTokens: 2000, cachedTokens: 10000, outputTokens: 500 },
      'm',
    );
    expect(c).toBe(7000);
  });

  it('rounds up fractions of a micro-dollar', () => {
    expect(
      costMicros(
        haiku,
        { inputTokens: 0, cacheWriteTokens: 0, cachedTokens: 1, outputTokens: 0 },
        'm',
      ),
    ).toBe(1);
  });

  it('throws for an unpriced model rather than recording zero', () => {
    expect(() =>
      costMicros(
        undefined,
        { inputTokens: 1, cacheWriteTokens: 0, cachedTokens: 0, outputTokens: 0 },
        'x/y',
      ),
    ).toThrow(/x\/y/);
  });
});

describe('tokens', () => {
  it('generates distinct url-safe tokens and hashes them stably', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^sdlc_[A-Za-z0-9_-]{43}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toBe(hashToken(b));
  });
});
