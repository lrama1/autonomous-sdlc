// The interaction state machine (mvp-contract section 5). Pure: no database, no clock of its own.

export type InteractionType = 'question' | 'checkpoint' | 'review' | 'decision' | 'notice';
export type InteractionState = 'open' | 'answered' | 'defaulted' | 'withdrawn' | 'superseded';
export type Decision = 'approved' | 'changes_requested' | 'rejected';
export type Role =
  | 'product_owner'
  | 'architect'
  | 'frontend_engineer'
  | 'backend_engineer'
  | 'qa'
  | 'devops_release'
  | 'security'
  | 'platform_admin';

export interface InteractionFacts {
  type: InteractionType;
  state: InteractionState;
  defaultValue: string | null;
  dueAt: Date | null;
  hardStop: boolean;
  roleNeeded: Role;
  assignedPersonId: string | null;
}

/** Checkpoints and reviews are decided, not answered. They never default (spec 5.1 and 6.3). */
export function needsDecision(type: InteractionType): boolean {
  return type === 'checkpoint' || type === 'review';
}

/** A default may apply only to a question or decision request, with a default and a passed deadline, and no hard stop. */
export function defaultApplies(i: InteractionFacts, now: Date): boolean {
  return (
    i.state === 'open' &&
    (i.type === 'question' || i.type === 'decision') &&
    i.defaultValue !== null &&
    !i.hardStop &&
    i.dueAt !== null &&
    i.dueAt.getTime() <= now.getTime()
  );
}

export interface Person {
  id: string;
  roles: Role[];
}

export interface RunPeople {
  sponsorPersonId: string;
  contributors: string[];
}

export type AnswerCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_open'
        | 'wrong_role'
        | 'independent_review'
        | 'decision_required'
        | 'decision_not_allowed';
    };

/**
 * Who may settle an interaction, and with what.
 * Independent review (spec 6.4): whoever started or steered the run cannot review or approve its work.
 */
export function checkAnswer(
  i: InteractionFacts,
  by: Person,
  run: RunPeople | null,
  input: { decision?: Decision },
  rules: { independentReview: boolean } = { independentReview: true },
): AnswerCheck {
  if (i.state !== 'open') return { ok: false, reason: 'not_open' };
  const entitled = i.assignedPersonId === by.id || by.roles.includes(i.roleNeeded);
  if (!entitled) return { ok: false, reason: 'wrong_role' };
  if (needsDecision(i.type)) {
    if (!input.decision) return { ok: false, reason: 'decision_required' };
    if (
      rules.independentReview &&
      run &&
      (run.sponsorPersonId === by.id || run.contributors.includes(by.id))
    ) {
      return { ok: false, reason: 'independent_review' };
    }
  } else if (input.decision) {
    return { ok: false, reason: 'decision_not_allowed' };
  }
  return { ok: true };
}

/** The role an agent's questions go to by default (spec 13). */
export function defaultRoleForAgent(agentRole: string): Role {
  switch (agentRole) {
    case 'product':
      return 'product_owner';
    case 'architect':
      return 'architect';
    case 'tester':
    case 'qa':
      return 'qa';
    case 'devops':
      return 'devops_release';
    case 'security':
      return 'security';
    case 'frontend_engineer':
      return 'frontend_engineer';
    default:
      return 'backend_engineer';
  }
}

/** Highest first: hard stops, then what blocks more runs, then the earliest deadline. */
export function rankInteractions<
  T extends { hardStop: boolean; blocks: unknown[]; dueAt: Date | null; priority: number },
>(items: T[]): T[] {
  const due = (i: T) => (i.dueAt ? i.dueAt.getTime() : Number.POSITIVE_INFINITY);
  return [...items].sort(
    (a, b) =>
      Number(b.hardStop) - Number(a.hardStop) ||
      b.priority - a.priority ||
      b.blocks.length - a.blocks.length ||
      due(a) - due(b),
  );
}
