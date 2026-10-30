import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activityEvent, initiative, repositoryEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { portfolioSchema } from '@sdlc/schemas';
import type { PortfolioDto } from '@sdlc/schemas';
import { loadStages } from './map-data.js';
import { requirePerson } from './people.js';

const usd = (micros: unknown) => Number(micros ?? 0) / 1_000_000;

/**
 * Every initiative with its stage, who it waits on, spend, last activity and counts, plus the releases that went out.
 * The stage comes from the same map logic as the initiative's own map, so the two never disagree.
 */
export async function portfolio(db: Db): Promise<PortfolioDto> {
  const rows = await db
    .select({ i: initiative, repo: repositoryEntry.fullName })
    .from(initiative)
    .innerJoin(repositoryEntry, eq(repositoryEntry.id, initiative.repositoryId));

  const spend = new Map<string, number>();
  for (const r of (
    await db.execute(
      sql`select initiative_id as id, sum(cost_micros) as c from cost_record where initiative_id is not null group by initiative_id`,
    )
  ).rows)
    spend.set(String(r.id), usd(r.c));

  const bugs = new Map<string, number>();
  for (const r of (
    await db.execute(
      sql`select initiative_id as id, count(*) as n from bug_report where state <> 'fixed' group by initiative_id`,
    )
  ).rows)
    bugs.set(String(r.id), Number(r.n));

  const asks = new Map<string, number>();
  for (const r of (
    await db.execute(
      sql`select initiative_id as id, count(*) as n from interaction where state = 'open' group by initiative_id`,
    )
  ).rows)
    asks.set(String(r.id), Number(r.n));

  const last = new Map<string, Date>();
  for (const r of (
    await db.execute(
      sql`select initiative_id as id, max(ts) as ts from activity_event where initiative_id is not null group by initiative_id`,
    )
  ).rows)
    last.set(String(r.id), new Date(r.ts as string | Date));

  const released = await db
    .select({
      initiativeId: activityEvent.initiativeId,
      ts: activityEvent.ts,
      detail: activityEvent.detail,
    })
    .from(activityEvent)
    .where(eq(activityEvent.action, 'release.published'))
    .orderBy(sql`${activityEvent.ts} desc`)
    .limit(200);
  const titles = new Map(rows.map(({ i }) => [i.id, i.title]));
  const releases = released
    .filter((r) => r.initiativeId && titles.has(r.initiativeId))
    .map((r) => {
      const d = r.detail as { version?: string; tag?: string; url?: string };
      return {
        initiativeId: r.initiativeId!,
        initiativeTitle: titles.get(r.initiativeId!)!,
        version: d.version ?? '',
        tag: d.tag ?? '',
        url: d.url ?? null,
        at: r.ts.toISOString(),
      };
    });

  const initiatives = [];
  for (const { i, repo } of rows) {
    const { stages, plan } = await loadStages(db, i);
    const current = stages.find((s) => s.status !== 'done');
    const lastRelease = releases.find((r) => r.initiativeId === i.id);
    initiatives.push({
      id: i.id,
      title: i.title,
      repository: repo,
      autonomyMode: i.autonomyMode,
      kind: i.kind,
      state: i.state,
      createdAt: i.createdAt.toISOString(),
      stage: current
        ? {
            id: current.id,
            title: current.title,
            status: current.status,
            waitingOn: current.waitingOn,
            detail: current.detail,
          }
        : null,
      spentUsd: spend.get(i.id) ?? 0,
      budgetUsd: i.budgetMicros === null ? null : i.budgetMicros / 1_000_000,
      lastActivityAt: (last.get(i.id) ?? i.updatedAt).toISOString(),
      plan: plan ? { total: plan.total, merged: plan.merged, failed: plan.failed } : null,
      openBugs: bugs.get(i.id) ?? 0,
      openAsks: asks.get(i.id) ?? 0,
      lastRelease: lastRelease ? { version: lastRelease.version, at: lastRelease.at } : null,
    });
  }
  // Those that need a person first, then the most recently active.
  const rank = (x: PortfolioDto['initiatives'][number]) =>
    x.stage?.status === 'waiting_human' || x.stage?.status === 'blocked' ? 0 : x.stage ? 1 : 2;
  initiatives.sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { initiatives, releases };
}

export function registerPortfolioRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/portfolio', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    return portfolioSchema.parse(await portfolio(db));
  });
}
