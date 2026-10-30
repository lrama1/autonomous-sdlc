import { describe, expect, it } from 'vitest';
import { groupByApp } from './portfolioGroups';
import type { Row } from './portfolioGroups';

const row = (o: Partial<Row> & { id: string }): Row => ({
  title: o.id,
  repository: 'o/shop',
  autonomyMode: 'balanced',
  kind: 'feature',
  state: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  stage: { id: 'g3', title: 'Build and review', status: 'working', waitingOn: [], detail: '' },
  spentUsd: 1,
  budgetUsd: null,
  lastActivityAt: '2026-10-02T00:00:00.000Z',
  plan: null,
  openBugs: 0,
  openAsks: 0,
  lastRelease: null,
  ...o,
});

describe('grouping the portfolio by app', () => {
  it('puts the initiatives of one repository together, oldest first, and keeps the apps in the order given', () => {
    const groups = groupByApp([
      row({ id: 'b-new', repository: 'o/blog', createdAt: '2026-10-05T00:00:00.000Z' }),
      row({ id: 'shop-2', createdAt: '2026-10-03T00:00:00.000Z' }),
      row({ id: 'shop-1', kind: 'new_app', createdAt: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'shop-3', createdAt: '2026-10-04T00:00:00.000Z' }),
    ]);
    expect(groups.map((g) => g.repository)).toEqual(['o/blog', 'o/shop']);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(['shop-1', 'shop-2', 'shop-3']);
  });

  it('adds up an app: spend, bugs, who is waiting, the latest activity and the latest release', () => {
    const [g] = groupByApp([
      row({
        id: 'a',
        spentUsd: 1.5,
        openBugs: 2,
        lastActivityAt: '2026-10-09T00:00:00.000Z',
        lastRelease: { version: '1.0.0', at: '2026-10-03T00:00:00.000Z' },
      }),
      row({
        id: 'b',
        spentUsd: 2.25,
        openBugs: 1,
        stage: {
          id: 'g1',
          title: 'Spec',
          status: 'waiting_human',
          waitingOn: ['product_owner'],
          detail: '',
        },
        lastRelease: { version: '1.1.0', at: '2026-10-07T00:00:00.000Z' },
      }),
      row({
        id: 'c',
        stage: { id: 'g3', title: 'Build', status: 'blocked', waitingOn: [], detail: '' },
      }),
      row({ id: 'd', stage: null }),
    ]);
    expect(g).toMatchObject({
      spentUsd: 1.5 + 2.25 + 1 + 1,
      openBugs: 3,
      waiting: 2,
      lastActivityAt: '2026-10-09T00:00:00.000Z',
      lastRelease: '1.1.0',
    });
    expect(g!.rows).toHaveLength(4);
  });

  it('says there is no release when none went out, and has no groups for no initiatives', () => {
    expect(groupByApp([row({ id: 'a' })])[0]!.lastRelease).toBeNull();
    expect(groupByApp([])).toEqual([]);
  });
});
