import { z } from 'zod';
import { roleSchema } from './roles.js';

export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  time: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

export const readySchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type Ready = z.infer<typeof readySchema>;

export const meSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  roles: z.array(roleSchema),
});
export type Me = z.infer<typeof meSchema>;

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof errorSchema>;

export const interactionTypeSchema = z.enum([
  'question',
  'checkpoint',
  'review',
  'decision',
  'notice',
]);
export const interactionStateSchema = z.enum([
  'open',
  'answered',
  'defaulted',
  'withdrawn',
  'superseded',
]);
export const decisionSchema = z.enum(['approved', 'changes_requested', 'rejected']);

export const interactionSchema = z.object({
  id: z.string().uuid(),
  initiativeId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  type: interactionTypeSchema,
  checkpointId: z.string().nullable(),
  state: interactionStateSchema,
  title: z.string(),
  contextCard: z.record(z.string(), z.unknown()),
  options: z.unknown().nullable(),
  recommendation: z.string().nullable(),
  defaultValue: z.string().nullable(),
  dueAt: z.string().nullable(),
  blocks: z.array(z.unknown()),
  roleNeeded: roleSchema,
  hardStop: z.boolean(),
  answer: z.unknown().nullable(),
  answeredBy: z.string().uuid().nullable(),
  answeredVia: z.string().nullable(),
  answeredAt: z.string().nullable(),
  didntNeedToAsk: z.boolean(),
  assignedPersonId: z.string().uuid().nullable(),
  escalationLevel: z.number().int(),
  snoozedUntil: z.string().nullable(),
  topicKey: z.string().nullable(),
  standingDecisionId: z.string().uuid().nullable(),
  createdAt: z.string(),
  // Filled in by the attention queue.
  initiativeTitle: z.string().optional(),
  agentRole: z.string().nullable().optional(),
  assignedToName: z.string().nullable().optional(),
  chatAnswerable: z.boolean().optional(),
});
export type InteractionDto = z.infer<typeof interactionSchema>;

export const answerRequestSchema = z.object({
  answer: z.string().max(4000).default(''),
  decision: decisionSchema.optional(),
  // The option picked, when the ask had options. The answer text is then filled in from the option.
  optionId: z.string().max(60).optional(),
  makeStanding: z.boolean().default(false),
  standingScope: z.enum(['initiative', 'repository', 'global']).default('initiative'),
  didntNeedToAsk: z.boolean().default(false),
});
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

export const standingDecisionSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['global', 'repository', 'initiative']),
  scopeId: z.string().uuid().nullable(),
  topic: z.string(),
  text: z.string(),
  active: z.boolean(),
  createdBy: z.string().uuid().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  /** How many asks this decision has answered on its own. */
  answeredSince: z.number().int(),
});
export type StandingDecisionDto = z.infer<typeof standingDecisionSchema>;

export const standingDecisionCreateSchema = z.object({
  scope: z.enum(['global', 'repository', 'initiative']).default('initiative'),
  scopeId: z.string().uuid().optional(),
  topic: z.string().min(1).max(120),
  text: z.string().min(1).max(1000),
});

export const standingDecisionPatchSchema = z.object({
  text: z.string().min(1).max(1000).optional(),
  active: z.boolean().optional(),
});

export const assumptionSchema = z.object({
  id: z.string().uuid(),
  initiativeId: z.string().uuid(),
  initiativeTitle: z.string(),
  runId: z.string().uuid(),
  agentRole: z.string(),
  text: z.string(),
  impact: z.string(),
  state: z.enum(['declared', 'accepted', 'rejected']),
  decidedByName: z.string().nullable(),
  createdAt: z.string(),
});
export type AssumptionDto = z.infer<typeof assumptionSchema>;

export const attentionProfileSchema = z.object({
  hats: z.array(
    z.object({
      role: roleSchema,
      deputyName: z.string().nullable(),
      hours: z.unknown().nullable(),
      outOfOffice: z.unknown().nullable(),
    }),
  ),
  slackLinked: z.boolean(),
  chatConfigured: z.boolean(),
  reminderAfterMin: z.number(),
  escalateAfterMin: z.number(),
  digestAt: z.string().nullable(),
  workingHours: z.unknown().nullable(),
});
export type AttentionProfile = z.infer<typeof attentionProfileSchema>;

const nullableNumber = z.number().nullable();
export const interruptionMetricsSchema = z.object({
  windowDays: z.number(),
  asks: z.number(),
  answeredByPerson: z.number(),
  mergedPrs: z.number(),
  questionsPerMergedPr: nullableNumber,
  unchangedShare: nullableNumber,
  didntNeedShare: nullableNumber,
  medianAnswerMs: nullableNumber,
  blockedShare: nullableNumber,
  defaulted: z.number(),
  avoidedByStanding: z.number(),
  weekly: z.array(
    z.object({
      weekStart: z.string(),
      asks: z.number(),
      merged: z.number(),
      perPr: nullableNumber,
    }),
  ),
  byAgent: z.array(
    z.object({
      agentRole: z.string(),
      asks: z.number(),
      merged: z.number(),
      perPr: nullableNumber,
      unchangedShare: nullableNumber,
    }),
  ),
  situations: z.array(
    z.object({
      situation: z.string(),
      asked: z.number(),
      unchanged: z.number(),
      didntNeed: z.number(),
      suggestion: z.enum(['covered', 'make_standing', 'ask_less', 'keep']),
      standingDecisionId: z.string().uuid().nullable(),
    }),
  ),
});
export type InterruptionMetricsDto = z.infer<typeof interruptionMetricsSchema>;
