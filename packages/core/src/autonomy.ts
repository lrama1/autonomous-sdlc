// Autonomy modes (spec 6.1): when a pull request may merge without a person's review. Pure.
import type { FiredTrigger } from './triggers.js';

export type AutonomyMode = 'guided' | 'balanced' | 'autopilot';

export interface MergeDecision {
  /** True when the platform approves it by rule and the Gate merges it once the checks are green. */
  auto: boolean;
  /** One sentence for the review and the Autopilot page. */
  reason: string;
  /** The pre-approved change type that applied, if one did. */
  rule: string | null;
}

/**
 * A fired trigger always sends the change to a person, in every mode. Hard stops never get this far.
 * Guided mode reviews everything. Balanced merges the pre-approved change types. Autopilot merges anything
 * no trigger fired on.
 */
export function decideMerge(
  mode: AutonomyMode,
  fired: Pick<FiredTrigger, 'id'>[],
  preApproved: { id: string } | null,
): MergeDecision {
  if (fired.length > 0) {
    return {
      auto: false,
      reason: `A trigger fired (${fired.map((f) => f.id).join(', ')}), so a person reviews it.`,
      rule: null,
    };
  }
  if (mode === 'guided') {
    return { auto: false, reason: 'Guided mode: a person reviews every pull request.', rule: null };
  }
  if (mode === 'autopilot') {
    return {
      auto: true,
      reason: preApproved
        ? `Autopilot mode, and it fits the pre-approved type "${preApproved.id}". No trigger fired.`
        : 'Autopilot mode: no trigger fired, so it merges when the checks are green.',
      rule: preApproved?.id ?? null,
    };
  }
  if (preApproved) {
    return {
      auto: true,
      reason: `It fits the pre-approved type "${preApproved.id}" and no trigger fired.`,
      rule: preApproved.id,
    };
  }
  return {
    auto: false,
    reason: 'Balanced mode: only pre-approved change types merge without a review.',
    rule: null,
  };
}
