import { describe, expect, it } from 'vitest';
import { computeInterruptionMetrics, tookRecommendation } from './metrics.js';
import type { AskRow } from './metrics.js';

const now = new Date('2026-10-30T12:00:00Z');
const ago = (days: number, hours = 0) =>
  new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000);

function ask(o: Partial<AskRow> = {}): AskRow {
  return {
    type: 'question',
    state: 'answered',
    agentRole: 'backend_engineer',
    createdAt: ago(2),
    answeredAt: new Date(ago(2).getTime() + 30 * 60_000),
    answeredVia: 'workspace',
    recommendation: 'A',
    choice: 'A',
    text: 'A: Free tier',
    didntNeedToAsk: false,
    blocking: true,
    situation: 'weather-provider',
    standingDecisionId: null,
    ...o,
  };
}

const run = { startedAt: ago(10), endedAt: null };

describe('tookRecommendation', () => {
  it('matches the chosen option or the text, ignoring case', () => {
    expect(tookRecommendation({ recommendation: 'A', choice: 'a', text: null })).toBe(true);
    expect(
      tookRecommendation({ recommendation: 'use date-fns', choice: null, text: 'Use date-fns' }),
    ).toBe(true);
    expect(tookRecommendation({ recommendation: 'A', choice: 'B', text: 'B: Paid' })).toBe(false);
    expect(tookRecommendation({ recommendation: null, choice: 'A', text: null })).toBe(false);
  });
});

describe('computeInterruptionMetrics', () => {
  it('reports nothing for an empty window without dividing by zero', () => {
    const m = computeInterruptionMetrics({ asks: [], merges: [], runs: [], standing: [] }, now);
    expect(m.questionsPerMergedPr).toBeNull();
    expect(m.unchangedShare).toBeNull();
    expect(m.medianAnswerMs).toBeNull();
    expect(m.blockedShare).toBeNull();
    expect(m.weekly).toHaveLength(4);
  });

  it('computes the tiles', () => {
    const m = computeInterruptionMetrics(
      {
        asks: [
          ask(),
          ask({ choice: 'B', text: 'B: Paid' }),
          ask({ didntNeedToAsk: true }),
          ask({ state: 'defaulted', answeredVia: 'default', choice: null, text: 'A' }),
          ask({ type: 'review', situation: 'pr' }),
        ],
        merges: [
          { at: ago(1), agentRole: 'backend_engineer' },
          { at: ago(3), agentRole: 'backend_engineer' },
        ],
        runs: [run],
        standing: [],
      },
      now,
    );
    expect(m.asks).toBe(4);
    expect(m.mergedPrs).toBe(2);
    expect(m.questionsPerMergedPr).toBe(2);
    // Three answered by a person, two with the recommendation unchanged.
    expect(m.unchangedShare).toBeCloseTo(0.67, 2);
    // One of the four settled asks was marked.
    expect(m.didntNeedShare).toBe(0.25);
    expect(m.medianAnswerMs).toBe(30 * 60_000);
    expect(m.defaulted).toBe(1);
  });

  it('does not count asks that a standing decision answered, and reports them separately', () => {
    const m = computeInterruptionMetrics(
      {
        asks: [ask(), ask({ answeredVia: 'standing', standingDecisionId: 'sd1' })],
        merges: [{ at: ago(1), agentRole: null }],
        runs: [run],
        standing: [],
      },
      now,
    );
    expect(m.asks).toBe(1);
    expect(m.avoidedByStanding).toBe(1);
  });

  it('measures blocked time against run time', () => {
    const m = computeInterruptionMetrics(
      {
        asks: [ask({ createdAt: ago(0, 2), answeredAt: ago(0, 1) })],
        merges: [],
        runs: [{ startedAt: ago(0, 10), endedAt: null }],
        standing: [],
      },
      now,
    );
    expect(m.blockedShare).toBe(0.1);
  });

  it('ignores asks outside the window', () => {
    const m = computeInterruptionMetrics(
      {
        asks: [ask({ createdAt: ago(40), answeredAt: ago(40) })],
        merges: [{ at: ago(45), agentRole: null }],
        runs: [],
        standing: [],
      },
      now,
    );
    expect(m.asks).toBe(0);
    expect(m.mergedPrs).toBe(0);
  });

  it('splits by week, oldest first', () => {
    const m = computeInterruptionMetrics(
      {
        asks: [ask({ createdAt: ago(1) }), ask({ createdAt: ago(2) }), ask({ createdAt: ago(9) })],
        merges: [
          { at: ago(1), agentRole: null },
          { at: ago(10), agentRole: null },
        ],
        runs: [],
        standing: [],
      },
      now,
    );
    expect(m.weekly.map((w) => w.asks)).toEqual([0, 0, 1, 2]);
    expect(m.weekly[3]!.perPr).toBe(2);
    expect(m.weekly[2]!.perPr).toBe(1);
  });

  it('breaks results down by agent', () => {
    const m = computeInterruptionMetrics(
      {
        asks: [
          ask(),
          ask({ agentRole: 'frontend_engineer', choice: 'B', text: 'B' }),
          ask({ agentRole: 'frontend_engineer' }),
        ],
        merges: [
          { at: ago(1), agentRole: 'backend_engineer' },
          { at: ago(1), agentRole: 'frontend_engineer' },
        ],
        runs: [],
        standing: [],
      },
      now,
    );
    const be = m.byAgent.find((a) => a.agentRole === 'backend_engineer')!;
    const fe = m.byAgent.find((a) => a.agentRole === 'frontend_engineer')!;
    expect(be).toMatchObject({ asks: 1, merged: 1, perPr: 1, unchangedShare: 1 });
    expect(fe).toMatchObject({ asks: 2, merged: 1, perPr: 2, unchangedShare: 0.5 });
  });

  it('suggests, and never applies, changes to what gets asked', () => {
    const m = computeInterruptionMetrics(
      {
        asks: [
          ask(),
          ask(),
          ask(),
          ask({ situation: 'copy', didntNeedToAsk: true }),
          ask({ situation: 'copy', didntNeedToAsk: true }),
          ask({ situation: 'date-lib' }),
          ask({ situation: 'date-lib', choice: 'B', text: 'B' }),
          ask({ situation: 'covered' }),
        ],
        merges: [],
        runs: [],
        standing: [{ id: 'sd9', topic: 'Covered' }],
      },
      now,
    );
    const by = Object.fromEntries(m.situations.map((s) => [s.situation, s]));
    expect(by['weather-provider']!.suggestion).toBe('make_standing');
    expect(by['copy']!.suggestion).toBe('ask_less');
    expect(by['date-lib']!.suggestion).toBe('keep');
    expect(by['covered']).toMatchObject({ suggestion: 'covered', standingDecisionId: 'sd9' });
  });
});
