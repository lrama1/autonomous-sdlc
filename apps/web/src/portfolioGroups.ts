import type { PortfolioDto } from '@sdlc/schemas';

export type Row = PortfolioDto['initiatives'][number];

/** An initiative that is waiting on a person or blocked. */
export const needsPerson = (i: Row) =>
  i.stage?.status === 'waiting_human' || i.stage?.status === 'blocked';

/** One app: a repository, and the initiatives made on it, oldest first (a new app, then what was added to it). */
export interface AppGroup {
  repository: string;
  rows: Row[];
  spentUsd: number;
  openBugs: number;
  waiting: number;
  lastActivityAt: string;
  lastRelease: string | null;
}

/**
 * Groups initiatives by repository. The apps keep the order the platform gave the initiatives in (those that need a
 * person first, then the most recently active), and each app's initiatives go oldest first, so the list reads as its history.
 */
export function groupByApp(rows: Row[]): AppGroup[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(r.repository, [...(groups.get(r.repository) ?? []), r]);
  return [...groups.entries()].map(([repository, list]) => {
    const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const released = list.filter((r) => r.lastRelease).map((r) => r.lastRelease!);
    released.sort((a, b) => b.at.localeCompare(a.at));
    return {
      repository,
      rows: ordered,
      spentUsd: list.reduce((s, r) => s + r.spentUsd, 0),
      openBugs: list.reduce((s, r) => s + r.openBugs, 0),
      waiting: list.filter(needsPerson).length,
      lastActivityAt: list.map((r) => r.lastActivityAt).sort((a, b) => b.localeCompare(a))[0]!,
      lastRelease: released[0]?.version ?? null,
    };
  });
}
