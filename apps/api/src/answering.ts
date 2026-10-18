import { eq } from 'drizzle-orm';
import { agentRun, interaction } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { checkAnswer } from '@sdlc/core';
import type { InteractionFacts } from '@sdlc/core';
import type { AnswerRequest } from '@sdlc/schemas';
import type { Gate } from './gate.js';
import { getInteraction, settleWithAnswer } from './interactions.js';
import type { InteractionRow } from './interactions.js';

export const REASONS: Record<string, { status: number; message: string }> = {
  not_found: { status: 404, message: 'No such interaction.' },
  not_open: { status: 409, message: 'This was already answered.' },
  wrong_role: { status: 403, message: 'This is not addressed to you.' },
  independent_review: {
    status: 403,
    message: 'You started or steered this run, so someone else must review it.',
  },
  decision_required: {
    status: 400,
    message: 'Choose a decision: approved, changes_requested, or rejected.',
  },
  decision_not_allowed: {
    status: 400,
    message: 'A decision applies only to checkpoints and reviews.',
  },
  unknown_option: { status: 400, message: 'That is not one of the options.' },
};

export const factsOf = (r: InteractionRow): InteractionFacts => ({
  type: r.type as InteractionFacts['type'],
  state: r.state as InteractionFacts['state'],
  defaultValue: r.defaultValue,
  dueAt: r.dueAt,
  hardStop: r.hardStop,
  roleNeeded: r.roleNeeded as InteractionFacts['roleNeeded'],
  assignedPersonId: r.assignedPersonId,
});

export type AnswerOutcome =
  { ok: true; row: InteractionRow } | { ok: false; status: number; code: string; message: string };

const refuse = (code: string): AnswerOutcome => ({
  ok: false,
  status: REASONS[code]!.status,
  code,
  message: REASONS[code]!.message,
});

interface OptionShape {
  id: string;
  label: string;
}
const optionsOf = (row: InteractionRow): OptionShape[] =>
  Array.isArray(row.options)
    ? (row.options as OptionShape[]).filter((o) => o && typeof o.id === 'string')
    : [];

/**
 * A person settles an ask, from the Workspace or from chat. The same checks apply to both.
 * A GitHub problem after a pull request decision never undoes the answer.
 */
export async function answerAsPerson(
  deps: {
    db: Db;
    rules: { independentReview: boolean };
    gate?: Gate;
    onGateError?: (e: unknown) => void;
    /** Runs after an answer is saved, for effects that follow from it (an integration being confirmed). */
    afterAnswer?: (row: InteractionRow) => Promise<void>;
  },
  id: string,
  me: { id: string; roles: InteractionFacts['roleNeeded'][] },
  via: 'workspace' | 'slack' | 'teams' | 'email',
  body: AnswerRequest,
): Promise<AnswerOutcome> {
  const { db } = deps;
  const row = await getInteraction(db, id);
  if (!row) return refuse('not_found');

  const [run] = row.runId
    ? await db.select().from(agentRun).where(eq(agentRun.id, row.runId))
    : [undefined];
  const verdict = checkAnswer(
    factsOf(row),
    { id: me.id, roles: me.roles },
    run ? { sponsorPersonId: run.sponsorPersonId, contributors: run.contributors } : null,
    { decision: body.decision },
    deps.rules,
  );
  if (!verdict.ok) return refuse(verdict.reason);

  let text = body.answer;
  if (body.optionId) {
    const option = optionsOf(row).find((o) => o.id === body.optionId);
    if (!option) return refuse('unknown_option');
    if (!text.trim()) text = `${option.id}: ${option.label}`;
  }

  const settled = await settleWithAnswer(db, id, {
    answer: text,
    decision: body.decision,
    optionId: body.optionId,
    by: me.id,
    via,
    makeStanding: body.makeStanding,
    standingScope: body.standingScope,
    didntNeedToAsk: body.didntNeedToAsk,
  });
  if (!settled) return refuse('not_open'); // lost a race with another answer or a default

  if (deps.gate) {
    await deps.gate.afterDecision(settled).catch((e) => deps.onGateError?.(e));
  }
  await deps.afterAnswer?.(settled).catch((e) => deps.onGateError?.(e));
  const [after] = await db.select().from(interaction).where(eq(interaction.id, settled.id));
  return { ok: true, row: after ?? settled };
}
