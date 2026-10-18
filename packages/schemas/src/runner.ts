import { z } from 'zod';

// What the runner receives and sends. The runner is a separate process (later a Fargate task), so these are
// the wire contract between it and the API (mvp-contract sections 6, 7 and 11).

export const runSpecSchema = z.object({
  runId: z.string().uuid(),
  role: z.string(),
  /** A one-line name for the work, used as the pull request title. */
  title: z.string(),
  task: z.string(),
  systemPrompt: z.string(),
  definition: z.object({ id: z.string(), version: z.number().int() }),
  engine: z.string(),
  /** Present when a parked run is being resumed. The message becomes the first thing the engine sees. */
  resume: z.object({ message: z.string() }).nullable(),
  repo: z.object({
    fullName: z.string(),
    cloneUrl: z.string().url(),
    branch: z.string(),
    integrationBranch: z.string(),
    writeMode: z.enum(['direct', 'branch_pr']),
    protectedPaths: z.array(z.string()),
    verifyCommand: z.string(),
  }),
  /** A GitHub token for this one repository, valid for at most an hour. Never given to the engine. */
  git: z.object({ token: z.string(), expiresAt: z.string() }),
  model: z.object({ alias: z.string() }),
  gateway: z.object({ baseUrl: z.string().url() }),
  mcp: z.object({ url: z.string().url() }),
  limits: z.object({
    maxTurns: z.number().int().positive(),
    maxWallSeconds: z.number().int().positive(),
    budgetMicros: z.number().int().positive(),
    maxVerifyAttempts: z.number().int().positive(),
  }),
  tools: z.object({ denied: z.array(z.string()) }),
});
export type RunSpec = z.infer<typeof runSpecSchema>;

export const exitReasonSchema = z.enum([
  'finished',
  'parked',
  'verify_failed',
  'budget',
  'timeout',
  'cancelled',
  'error',
  'blocked',
]);
export type ExitReason = z.infer<typeof exitReasonSchema>;

export const runnerEventsSchema = z.object({
  events: z
    .array(
      z.object({
        type: z.string().min(1).max(60),
        payload: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(200),
});

export const runnerStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }),
  z.object({
    state: z.literal('finished'),
    exitReason: exitReasonSchema,
    summary: z.string().max(8000).optional(),
  }),
]);

export const diffSummarySchema = z.object({
  changedPaths: z.array(z.string()),
  linesChanged: z.number().int().min(0),
  dependencyAdded: z.boolean(),
  testsDeletedOrSkipped: z.boolean(),
  protectedPathsTouched: z.array(z.string()),
});

export const runnerPullRequestSchema = z.object({
  title: z.string().min(1).max(250),
  body: z.string().max(60_000),
  diff: diffSummarySchema,
  verify: z.object({
    ok: z.boolean(),
    command: z.string(),
    attempts: z.number().int().min(1),
    durationMs: z.number().int().min(0),
    summary: z.string().max(4000),
  }),
  summary: z.string().max(8000).default(''),
});

export const runnerTriggerSchema = z.object({
  kind: z.enum(['protected_path', 'verify_failed']),
  summary: z.string().min(1).max(2000),
  paths: z.array(z.string()).default([]),
});

export const ruleSetSchema = z.object({
  version: z.number().int(),
  triggers: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
        when: z.object({
          paths_any: z.array(z.string()).optional(),
          paths_all: z.array(z.string()).optional(),
          dependency_added: z.boolean().optional(),
          tests_deleted_or_skipped: z.boolean().optional(),
          lines_changed_over: z.number().optional(),
          touches_protected_path: z.boolean().optional(),
        }),
        action: z.enum(['require_review', 'require_checkpoint', 'hard_stop']),
      }),
    )
    .default([]),
  pre_approved_change_types: z
    .array(
      z.object({
        id: z.string(),
        owner: z.string().optional(),
        review_by: z.union([z.string(), z.date()]).optional(),
        when: z.object({
          paths_any: z.array(z.string()).optional(),
          paths_all: z.array(z.string()).optional(),
          dependency_added: z.boolean().optional(),
          tests_deleted_or_skipped: z.boolean().optional(),
          lines_changed_over: z.number().optional(),
          touches_protected_path: z.boolean().optional(),
        }),
      }),
    )
    .default([]),
});
