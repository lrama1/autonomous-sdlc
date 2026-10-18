import { and, desc, eq, sql } from 'drizzle-orm';
import { activityEvent, initiative, interaction, repositoryEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import type { Role } from '@sdlc/core';
import { recordActivity } from './activity.js';
import type { GitHubService } from './github-service.js';
import { createInteraction } from './interactions.js';
import type { InteractionRow } from './interactions.js';

export interface ReleaseCard {
  kind: 'release';
  repository: string;
  branch: string;
  version: string;
  tag: string;
  sha: string;
  notes: string;
  prs: Array<{ number: number | null; title: string; url: string | null }>;
  release?: { state: 'released' | 'stale' | 'failed' | 'declined'; detail?: string; url?: string };
}

export const VERSION = /^\d+\.\d+\.\d+$/;

/** Everything that merged for an initiative since its last published release. */
async function mergedSince(db: Db, initiativeId: string, since: Date) {
  const rows = await db
    .select({ i: interaction, at: activityEvent.ts })
    .from(activityEvent)
    .innerJoin(interaction, eq(interaction.id, activityEvent.interactionId))
    .where(
      and(
        eq(activityEvent.action, 'pull_request.merged'),
        eq(activityEvent.initiativeId, initiativeId),
        sql`${activityEvent.ts} > ${since}`,
      ),
    )
    .orderBy(activityEvent.ts);
  // The same pull request can be logged twice (a retry), so list each once.
  const seen = new Set<string>();
  return rows.filter(({ i }) => !seen.has(i.id) && seen.add(i.id));
}

export async function lastRelease(
  db: Db,
  initiativeId: string,
): Promise<InteractionRow | undefined> {
  const [row] = await db
    .select()
    .from(interaction)
    .where(
      and(
        eq(interaction.initiativeId, initiativeId),
        eq(interaction.checkpointId, 'G6'),
        sql`${interaction.contextCard} -> 'release' ->> 'state' = 'released'`,
      ),
    )
    .orderBy(desc(interaction.createdAt))
    .limit(1);
  return row;
}

export type PrepareResult =
  | { ok: true; interaction: InteractionRow }
  | { ok: false; status: number; code: string; message: string };

/**
 * Prepares a release for approval (checkpoint G6). The notes are the merged pull requests since the last release,
 * the commit is the tip of the integration branch now, and the required check must be green on it. Production
 * releases are a hard stop: only a person approves, and the Gate App publishes (spec 6.3, 8.2).
 */
export async function prepareRelease(
  db: Db,
  github: GitHubService,
  input: { initiativeId: string; version: string; approverRole: Role; by: string },
): Promise<PrepareResult> {
  const fail = (status: number, code: string, message: string): PrepareResult => ({
    ok: false,
    status,
    code,
    message,
  });
  if (!VERSION.test(input.version)) return fail(400, 'bad_version', 'Use a version like 1.2.3.');
  const [init] = await db.select().from(initiative).where(eq(initiative.id, input.initiativeId));
  if (!init) return fail(404, 'not_found', 'No such initiative.');
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, init.repositoryId));
  if (!repo) return fail(409, 'no_repository', 'The initiative has no registered repository.');

  const tag = `release-${input.version}`;
  const open = await db
    .select({ id: interaction.id })
    .from(interaction)
    .where(
      and(
        eq(interaction.initiativeId, input.initiativeId),
        eq(interaction.checkpointId, 'G6'),
        eq(interaction.state, 'open'),
      ),
    );
  if (open.length > 0)
    return fail(409, 'release_pending', 'A release is already waiting for approval.');

  const previous = await lastRelease(db, input.initiativeId);
  const merged = await mergedSince(db, input.initiativeId, previous?.createdAt ?? new Date(0));
  if (merged.length === 0)
    return fail(409, 'nothing_to_release', 'Nothing has merged since the last release.');

  const sha = await github.branchHead(repo.fullName, repo.integrationBranch);
  const ci = await github.checkConclusion(repo.fullName, sha, repo.requiredCheck);
  if (ci !== 'success')
    return fail(
      409,
      'not_green',
      `The check "${repo.requiredCheck}" is ${ci === 'pending' ? 'not finished' : ci} on ${repo.integrationBranch}. Release when it is green.`,
    );

  const prs = merged.map(({ i }) => {
    const c = i.contextCard as { prNumber?: number; prUrl?: string };
    return {
      number: c.prNumber ?? null,
      title: i.title.replace(/^Review PR #\d+: /, ''),
      url: c.prUrl ?? null,
    };
  });
  const notes = [
    `## ${input.version}`,
    '',
    ...prs.map((p) => `- ${p.title}${p.number ? ` (#${p.number})` : ''}`),
    '',
    `Prepared from ${repo.integrationBranch} at ${sha.slice(0, 7)}.`,
  ].join('\n');

  const card: ReleaseCard = {
    kind: 'release',
    repository: repo.fullName,
    branch: repo.integrationBranch,
    version: input.version,
    tag,
    sha,
    notes,
    prs,
  };
  const { interaction: row } = await createInteraction(db, {
    initiativeId: input.initiativeId,
    runId: null,
    type: 'checkpoint',
    checkpointId: 'G6',
    title: `Release ${input.version}: ${prs.length} change${prs.length === 1 ? '' : 's'}`,
    contextCard: {
      ...card,
      context: `Publishes the tag ${tag} on ${repo.fullName} at ${sha.slice(0, 7)} with these notes.`,
      whyNow: 'A release is never automatic. The Gate App publishes it once you approve.',
    },
    blocks: [],
    roleNeeded: input.approverRole,
    hardStop: true,
  });
  await recordActivity(db, {
    actorType: 'person',
    actorId: input.by,
    initiativeId: input.initiativeId,
    interactionId: row.id,
    action: 'release.prepared',
    detail: { version: input.version, tag, sha, changes: prs.length },
  });
  return { ok: true, interaction: row };
}

async function setRelease(
  row: InteractionRow,
  release: NonNullable<ReleaseCard['release']>,
  db: Db,
) {
  await db
    .update(interaction)
    .set({
      contextCard: sql`${interaction.contextCard} || jsonb_build_object('release', ${JSON.stringify(release)}::jsonb)`,
    })
    .where(eq(interaction.id, row.id));
}

/**
 * Runs after a person decides on a release. Approved: publish, but only if the branch is still at the commit that
 * was reviewed. Anything else is recorded and nothing is published.
 */
export async function applyReleaseDecision(
  db: Db,
  github: GitHubService,
  row: InteractionRow,
): Promise<void> {
  const card = row.contextCard as unknown as ReleaseCard;
  if (card.kind !== 'release' || row.checkpointId !== 'G6') return;
  const decision = (row.answer as { decision?: string } | null)?.decision;
  const log = (action: string, detail: Record<string, unknown>) =>
    recordActivity(db, {
      actorType: 'system',
      initiativeId: row.initiativeId,
      interactionId: row.id,
      action,
      detail,
    });

  if (decision !== 'approved') {
    await setRelease(row, { state: 'declined', detail: decision ?? 'no decision' }, db);
    await log('release.declined', { version: card.version, decision });
    return;
  }
  try {
    const head = await github.branchHead(card.repository, card.branch);
    if (head !== card.sha) {
      const detail = `${card.branch} moved from ${card.sha.slice(0, 7)} to ${head.slice(0, 7)} after the release was prepared. Prepare it again.`;
      await setRelease(row, { state: 'stale', detail }, db);
      await log('release.stale', { version: card.version, detail });
      return;
    }
    const published = await github.publishRelease(card.repository, {
      tag: card.tag,
      sha: card.sha,
      name: `${card.version}`,
      notes: card.notes,
    });
    await setRelease(row, { state: 'released', url: published.url }, db);
    await log('release.published', { version: card.version, tag: card.tag, url: published.url });
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await setRelease(row, { state: 'failed', detail }, db);
    await log('release.failed', { version: card.version, detail });
  }
}
