import { describe, expect, it } from 'vitest';
import type { SecurityDto, SmokeDto } from '@sdlc/schemas';
import { blockersOf, stopsApprove, stopsSendingBack } from './blockers';

const smoke = (blocks: string | null) => ({ blocks }) as SmokeDto;
const security = (blocks: string | null) => ({ blocks }) as SecurityDto;

describe('what stops a person deciding a review', () => {
  it('is nothing when no check holds it', () => {
    const b = blockersOf({ smoke: smoke(null), security: security(null), youMayNotDecide: null });
    expect(b).toEqual([]);
    expect(stopsApprove(b)).toBe(false);
  });

  it('is nothing before the checks are known, because the server still enforces them', () => {
    expect(blockersOf({ smoke: null, security: null })).toEqual([]);
  });

  it('stops approving, but not sending the work back, while a check is open', () => {
    const b = blockersOf({
      smoke: null,
      security: security('Run the security review first.'),
    });
    expect(b).toEqual([
      {
        id: 'security',
        reason: 'Run the security review first.',
        panel: 'security',
        stops: 'approve',
      },
    ]);
    expect(stopsApprove(b)).toBe(true);
    expect(stopsSendingBack(b)).toBe(false);
  });

  it('lists the security review before the smoke test, each pointing at its own panel', () => {
    const b = blockersOf({
      smoke: smoke('Run the smoke test first.'),
      security: security('Run it.'),
    });
    expect(b.map((x) => [x.id, x.panel])).toEqual([
      ['security', 'security'],
      ['smoke', 'smoke'],
    ]);
  });

  it('stops every decision, and points nowhere, when the person started the run', () => {
    const b = blockersOf({
      smoke: null,
      security: null,
      youMayNotDecide: 'Someone else must review it.',
    });
    expect(b).toEqual([
      { id: 'own', reason: 'Someone else must review it.', panel: null, stops: 'all' },
    ]);
    expect(stopsApprove(b)).toBe(true);
    expect(stopsSendingBack(b)).toBe(true);
  });
});
