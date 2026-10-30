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
  // Set after a person has given the same answer to the same question several times: offer to make it standing.
  suggestStanding: z
    .object({ count: z.number(), topic: z.string(), answer: z.string() })
    .nullable()
    .optional(),
  // Why the person asking may not decide this one (they started or steered the run), or null.
  youMayNotDecide: z.string().nullable().optional(),
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

export const autonomyModeSchema = z.enum(['guided', 'balanced', 'autopilot']);

export const autopilotSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      owner: z.string().nullable(),
      reviewBy: z.string().nullable(),
      expired: z.boolean(),
      paths: z.string(),
    }),
  ),
  initiatives: z.array(
    z.object({ id: z.string().uuid(), title: z.string(), autonomyMode: autonomyModeSchema }),
  ),
  recent: z.array(
    z.object({
      interactionId: z.string().uuid(),
      title: z.string(),
      prNumber: z.number().nullable(),
      prUrl: z.string().nullable(),
      initiativeTitle: z.string(),
      decidedBy: z.enum(['rule', 'person', 'waiting']),
      reason: z.string(),
      rule: z.string().nullable(),
      outcome: z.string(),
      at: z.string(),
    }),
  ),
  counts: z.object({ byRule: z.number(), byPerson: z.number(), waiting: z.number() }),
});
export type AutopilotDto = z.infer<typeof autopilotSchema>;

const httpUrl = z
  .string()
  .max(500)
  .refine((u) => {
    try {
      return ['http:', 'https:'].includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }, 'a web link');
const hostname = z
  .string()
  .max(253)
  .regex(
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'a plain hostname, with no wildcard, address, or path',
  );

export const integrationFields = z.object({
  kind: z.enum(['second_party', 'third_party']).default('third_party'),
  owner: z.string().max(120).optional(),
  // Leave out for every initiative.
  initiativeId: z.string().uuid().optional(),
  docs: z.array(httpUrl).max(10).default([]),
  hosts: z.array(hostname).max(20).default([]),
  authType: z.enum(['none', 'api_key', 'oauth', 'basic']).default('none'),
  credentialRef: z
    .string()
    .regex(/^[A-Za-z0-9/_+=.@-]{1,200}$/)
    .optional(),
  dataSent: z.string().max(1000).optional(),
  dataReceived: z.string().max(1000).optional(),
  testStrategy: z.enum(['vendor_sandbox', 'mock', 'recorded', 'none']).default('none'),
  limitsAndCost: z.string().max(1000).optional(),
  terms: z.string().max(1000).optional(),
  failureBehavior: z.string().max(1000).optional(),
});
export const integrationCreateSchema = integrationFields.extend({
  name: z.string().min(1).max(80),
});
export const integrationPatchSchema = integrationFields.partial();

export const integrationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(['second_party', 'third_party']),
  owner: z.string().nullable(),
  initiativeId: z.string().uuid().nullable(),
  docs: z.array(z.string()),
  hosts: z.array(z.string()),
  authType: z.string(),
  credentialRef: z.string().nullable(),
  dataSent: z.string().nullable(),
  dataReceived: z.string().nullable(),
  testStrategy: z.enum(['vendor_sandbox', 'mock', 'recorded', 'none']),
  limitsAndCost: z.string().nullable(),
  terms: z.string().nullable(),
  failureBehavior: z.string().nullable(),
  status: z.enum(['proposed', 'confirmed', 'rejected', 'retired']),
  proposedBy: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  snapshots: z.array(
    z.object({
      url: z.string(),
      fetchedAt: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
      sha256: z.string(),
    }),
  ),
});
export type IntegrationDto = z.infer<typeof integrationSchema>;

// A preview of a pull request, as the repository's pipeline reported it to GitHub (read-only for the platform).
export const previewSchema = z.object({
  state: z.enum(['ready', 'building', 'failed', 'stale', 'none', 'not_permitted']),
  url: z.string().nullable(),
  label: z.string().nullable(),
  source: z.enum(['deployment', 'status', 'platform']).nullable(),
  sha: z.string().nullable(),
  headSha: z.string(),
  detail: z.string(),
  // The change holds only documents (a spec, a design), so there is no program to run.
  docsOnly: z.boolean().optional(),
  // The app shares its repository with another app, so a preview would run the other one.
  shared: z.boolean().optional(),
  // The preview the platform itself runs from the pull request, if that is switched on.
  platform: z.object({
    available: z.boolean(),
    id: z.string().nullable(),
    state: z.enum(['none', 'starting', 'ready', 'failed', 'stopped', 'expired', 'unavailable']),
    expiresAt: z.string().nullable(),
    detail: z.string().nullable(),
    ttlMinutes: z.number(),
  }),
});
export type PreviewDto = z.infer<typeof previewSchema>;

// The platform's preview of what an initiative's merged tasks built (the integration branch), not of one pull request.
export const mainPreviewSchema = z.object({
  available: z.boolean(),
  id: z.string().nullable(),
  state: z.enum(['none', 'starting', 'ready', 'failed', 'stopped', 'expired', 'unavailable']),
  url: z.string().nullable(),
  sha: z.string().nullable(),
  expiresAt: z.string().nullable(),
  detail: z.string().nullable(),
  ttlMinutes: z.number(),
  // The app shares its repository with another app, so a preview would run the other one.
  shared: z.boolean().optional(),
});
export type MainPreviewDto = z.infer<typeof mainPreviewSchema>;

// A preview the person started that is ready to open and that they have not opened or dismissed yet.
export const readyPreviewSchema = z.object({
  id: z.string(),
  // The built app (the integration branch), or a pull request under review.
  kind: z.enum(['main', 'pull_request']),
  initiativeId: z.string().nullable(),
  initiativeTitle: z.string(),
  label: z.string(),
  url: z.string(),
  expiresAt: z.string().nullable(),
  readyAt: z.string().nullable(),
  // The review it belongs to, for a pull request.
  interactionId: z.string().nullable(),
});
export type ReadyPreviewDto = z.infer<typeof readyPreviewSchema>;

// The smoke test of a pull request's code at the commit under review (mvp-contract section 16).
export const smokeResultSchema = z.object({
  kind: z.enum(['get', 'run']),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  ms: z.number(),
});
export const smokeDiagnosisSchema = z.object({
  verdict: z.enum(['code', 'checks', 'environment', 'unclear']),
  summary: z.string(),
  recommendation: z.string(),
  // What to tell the engineer, for a code or checks verdict.
  instruction: z.string(),
  at: z.string(),
});
export type SmokeDiagnosisDto = z.infer<typeof smokeDiagnosisSchema>;

export const smokeSchema = z.object({
  // False when this platform cannot run previews, so it cannot run smoke tests and does not ask for them.
  available: z.boolean(),
  required: z.enum(['none', 'required', 'invalid', 'shared']),
  // Why the config is invalid, or what stops the test from being read.
  detail: z.string().nullable(),
  commit: z.string(),
  run: z
    .object({
      id: z.string(),
      state: z.enum(['running', 'passed', 'failed', 'error', 'overridden']),
      results: z.array(smokeResultSchema),
      // The reason, for an override; what went wrong, for an error.
      detail: z.string().nullable(),
      // An AI's reading of why it failed, once someone asked for it. It advises; it lets nothing through.
      diagnosis: smokeDiagnosisSchema.nullable().optional(),
      by: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
    })
    .nullable(),
  // Why the review cannot be approved yet, or null when it can.
  blocks: z.string().nullable(),
});
export type SmokeDto = z.infer<typeof smokeSchema>;
export type SmokeResultDto = z.infer<typeof smokeResultSchema>;

// The security review of a pull request's code at the commit under review (mvp-contract section 16).
export const securityFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  category: z.string(),
  file: z.string(),
  line: z.number().nullable(),
  title: z.string(),
  why: z.string(),
  fix: z.string(),
  dismissed: z
    .object({ by: z.string(), byName: z.string().nullable(), reason: z.string(), at: z.string() })
    .optional(),
});
export const securitySchema = z.object({
  // False when this platform has no security agent or no model gateway.
  available: z.boolean(),
  // False when the change only touches documents: there is nothing to read.
  required: z.boolean(),
  commit: z.string(),
  run: z
    .object({
      id: z.string(),
      state: z.enum(['running', 'done', 'error']),
      summary: z.string().nullable(),
      findings: z.array(securityFindingSchema),
      detail: z.string().nullable(),
      by: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
    })
    .nullable(),
  // Why the review cannot be approved yet, or null when it can.
  blocks: z.string().nullable(),
});
export type SecurityDto = z.infer<typeof securitySchema>;
export type SecurityFindingDto = z.infer<typeof securityFindingSchema>;

// The build plan of an initiative: the approved design's tasks, and where each one is.
export const buildTaskStateSchema = z.enum([
  'waiting',
  'running',
  'review',
  'merged',
  'failed',
  'skipped',
  'cancelled',
]);
export const buildTaskSchema = z.object({
  key: z.string(),
  title: z.string(),
  role: z.string(),
  stories: z.array(z.string()),
  dependsOn: z.array(z.string()),
  paths: z.array(z.string()),
  doneWhen: z.array(z.string()),
  state: buildTaskStateSchema,
  runId: z.string().nullable(),
  prNumber: z.number().nullable(),
  attempt: z.number(),
  detail: z.string().nullable(),
  /** When the agent running this task last reported anything, or null when no run is live. */
  lastActivityAt: z.string().nullable().optional(),
  /** The failed tasks this one is stuck behind. */
  stuckBehind: z.array(z.string()),
});
export const buildPlanSchema = z.object({
  id: z.string(),
  initiativeId: z.string(),
  state: z.enum(['awaiting_start', 'active', 'done', 'cancelled', 'invalid']),
  designPath: z.string(),
  detail: z.string().nullable(),
  errors: z.array(z.string()),
  tasks: z.array(buildTaskSchema),
  createdAt: z.string(),
});
export type BuildPlanDto = z.infer<typeof buildPlanSchema>;
export type BuildTaskDto = z.infer<typeof buildTaskSchema>;

// A step before the build that starts by itself or waits for a click: drafting the spec, designing it.
export const stageStartSchema = z.object({
  id: z.string(),
  initiativeId: z.string(),
  stage: z.enum(['spec', 'design', 'bug']),
  state: z.enum(['pending', 'awaiting_start', 'started', 'cancelled', 'invalid']),
  detail: z.string().nullable(),
  runId: z.string().nullable(),
  /** The first line of the task: what the step is called. */
  title: z.string(),
  createdAt: z.string(),
});
export type StageStartDto = z.infer<typeof stageStartSchema>;

export const bugCreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(4000),
  steps: z.string().trim().max(4000).optional(),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type BugCreate = z.infer<typeof bugCreateSchema>;

export const bugSchema = z.object({
  id: z.string(),
  initiativeId: z.string(),
  initiativeTitle: z.string(),
  title: z.string(),
  description: z.string(),
  steps: z.string().nullable(),
  severity: z.enum(['low', 'medium', 'high']),
  reportedBy: z.string(),
  state: z.enum(['open', 'fixing', 'fixed', 'needs_attention']),
  detail: z.string().nullable(),
  /** The fix run, once there is one. */
  runId: z.string().nullable(),
  prNumber: z.number().nullable(),
  /** The step that starts the fix, while it waits for a click. */
  stageStartId: z.string().nullable(),
  stageState: z.string().nullable(),
  createdAt: z.string(),
});
export type BugDto = z.infer<typeof bugSchema>;

// Cost views (spec 6.8): what the models cost, from the gateway's cost records.
export const monthlyBudgetSchema = z.object({
  budgetUsd: z.number().nullable(),
  spentUsd: z.number(),
  percent: z.number().nullable(),
  level: z.enum(['none', 'ok', 'warning', 'exceeded']),
  month: z.string(),
  alertPercent: z.number(),
});
const tokenFields = {
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedTokens: z.number(),
  cacheWriteTokens: z.number(),
};
export const costsSchema = z.object({
  days: z.number(),
  from: z.string(),
  initiativeId: z.string().nullable(),
  monthly: monthlyBudgetSchema,
  totals: z.object({
    costUsd: z.number(),
    calls: z.number(),
    runs: z.number(),
    cacheReadShare: z.number(),
    ...tokenFields,
  }),
  byDay: z.array(z.object({ day: z.string(), costUsd: z.number(), calls: z.number() })),
  byInitiative: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      costUsd: z.number(),
      allTimeUsd: z.number(),
      budgetUsd: z.number().nullable(),
      percentOfBudget: z.number().nullable(),
      runs: z.number(),
    }),
  ),
  byRole: z.array(
    z.object({ role: z.string(), costUsd: z.number(), runs: z.number(), avgPerRunUsd: z.number() }),
  ),
  byModel: z.array(
    z.object({
      alias: z.string(),
      providerModel: z.string(),
      costUsd: z.number(),
      calls: z.number(),
      ...tokenFields,
    }),
  ),
  topRuns: z.array(
    z.object({
      id: z.string(),
      role: z.string(),
      initiativeId: z.string(),
      initiativeTitle: z.string(),
      title: z.string(),
      state: z.string(),
      costUsd: z.number(),
    }),
  ),
});
export type CostsDto = z.infer<typeof costsSchema>;
export type MonthlyBudgetDto = z.infer<typeof monthlyBudgetSchema>;

// Portfolio view (spec 10): every initiative at a glance, and the releases that went out.
export const portfolioSchema = z.object({
  initiatives: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      repository: z.string(),
      autonomyMode: z.string(),
      // New app, feature or change. Null for work made before the kind existed.
      kind: z.string().nullable().default(null),
      state: z.string(),
      // When it was made. The Portfolio lists an app's initiatives oldest first.
      createdAt: z.string().default(''),
      // The first stage that is not done. Null when every stage is done.
      stage: z
        .object({
          id: z.string(),
          title: z.string(),
          status: z.enum(['not_started', 'working', 'waiting_human', 'blocked', 'done']),
          waitingOn: z.array(z.string()),
          detail: z.string(),
        })
        .nullable(),
      spentUsd: z.number(),
      budgetUsd: z.number().nullable(),
      lastActivityAt: z.string(),
      plan: z.object({ total: z.number(), merged: z.number(), failed: z.number() }).nullable(),
      openBugs: z.number(),
      openAsks: z.number(),
      lastRelease: z.object({ version: z.string(), at: z.string() }).nullable(),
    }),
  ),
  releases: z.array(
    z.object({
      initiativeId: z.string(),
      initiativeTitle: z.string(),
      version: z.string(),
      tag: z.string(),
      url: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
export type PortfolioDto = z.infer<typeof portfolioSchema>;

// The assistant chat (mvp-contract, assistant).
export const assistantProposalSchema = z.object({
  id: z.string(),
  kind: z.enum(['retry_task', 'start_preview', 'file_bug', 'open_screen']),
  label: z.string(),
  why: z.string(),
  params: z.record(z.string(), z.unknown()),
  state: z.enum(['proposed', 'done', 'dismissed']),
});
export type AssistantProposalDto = z.infer<typeof assistantProposalSchema>;

export const assistantMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  steps: z.array(z.object({ tool: z.string(), summary: z.string() })),
  proposals: z.array(assistantProposalSchema),
  createdAt: z.string(),
});
export type AssistantMessageDto = z.infer<typeof assistantMessageSchema>;

export const assistantConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
export type AssistantConversationDto = z.infer<typeof assistantConversationSchema>;

export const assistantUsageSchema = z.object({
  available: z.boolean(),
  spentMicros: z.number(),
  capMicros: z.number(),
});
export type AssistantUsageDto = z.infer<typeof assistantUsageSchema>;

export const assistantAskSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  context: z
    .object({
      page: z.string().max(40).optional(),
      hash: z.string().max(300).optional(),
      initiativeId: z.string().uuid().optional(),
      interactionId: z.string().uuid().optional(),
      pageText: z.string().max(12000).optional(),
    })
    .default({}),
});
export type AssistantAsk = z.infer<typeof assistantAskSchema>;

export const assistantReplySchema = z.object({
  conversation: assistantConversationSchema,
  user: assistantMessageSchema,
  assistant: assistantMessageSchema,
  usage: assistantUsageSchema,
});
export type AssistantReplyDto = z.infer<typeof assistantReplySchema>;
