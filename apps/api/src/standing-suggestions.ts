import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { initiative, interaction } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { findStandingDecision } from './interactions.js';
import type { InteractionRow } from './interactions.js';

/** How many times a person gives the same answer to the same question before the platform offers to remember it. */
export const SUGGEST_AFTER = 3;
const WINDOW_DAYS = 60;
const PEOPLE = ['workspace', 'slack', 'teams', 'email'];

export interface StandingSuggestion {
  count: number;
  topic: string;
  answer: string;
}

/** What the person answered, as the thing to compare and to remember: the option picked, else the words. */
export function answerKey(answer: unknown): string | null {
  const a = (answer ?? {}) as { choice?: string | null; text?: string };
  const key = (a.choice ?? a.text ?? '').trim();
  return key === '' ? null : key;
}

/**
 * A person has now given the same answer to the same question (its topic) several times on one repository. Offer to make
 * it a standing decision, so the agents stop asking. Only a question that agents tag with a topic can be standing, a hard
 * stop never can, and a topic that already has a standing decision needs no offer.
 */
export async function standingSuggestion(
  db: Db,
  row: InteractionRow,
): Promise<StandingSuggestion | null> {
  const key = answerKey(row.answer);
  if (
    row.state !== 'answered' ||
    row.hardStop ||
    row.standingDecisionId ||
    !row.topicKey ||
    !key ||
    !row.answeredVia ||
    !PEOPLE.includes(row.answeredVia)
  )
    return null;
  if (await findStandingDecision(db, row.initiativeId, row.topicKey)) return null;
  const [init] = await db
    .select({ repositoryId: initiative.repositoryId })
    .from(initiative)
    .where(eq(initiative.id, row.initiativeId));
  if (!init) return null;
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(interaction)
    .innerJoin(initiative, eq(initiative.id, interaction.initiativeId))
    .where(
      and(
        eq(initiative.repositoryId, init.repositoryId),
        sql`lower(${interaction.topicKey}) = lower(${row.topicKey})`,
        eq(interaction.state, 'answered'),
        eq(interaction.hardStop, false),
        inArray(interaction.answeredVia, PEOPLE),
        gt(interaction.answeredAt, since),
        sql`coalesce(${interaction.answer} ->> 'choice', ${interaction.answer} ->> 'text') = ${key}`,
      ),
    );
  const count = r?.n ?? 0;
  if (count < SUGGEST_AFTER) return null;
  const a = row.answer as { text?: string };
  return { count, topic: row.topicKey, answer: String(a.text ?? key).slice(0, 300) };
}
