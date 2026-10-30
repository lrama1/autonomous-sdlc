import { z } from 'zod';

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  role: z.string().min(1),
  // `inline` agents answer from one reading inside the platform (through the gateway). They have no sandbox, so no run is
  // started for them by a person; the platform starts them from a review.
  runs: z.enum(['sandbox', 'inline']).default('sandbox'),
  engine: z.string().min(1),
  model_alias: z.string().min(1),
  prompt_file: z.string().min(1),
  tools: z.object({
    platform: z.array(z.string()),
    engine_builtin: z.array(z.string()),
    denied: z.array(z.string()).default([]),
  }),
  limits: z.object({
    max_turns: z.number().int().positive(),
    max_wall_seconds: z.number().int().positive(),
    budget_usd: z.number().positive(),
  }),
  asks: z.array(z.string()).default([]),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'use owner/name');

export const DEFAULT_PROTECTED_PATHS = [
  '.github/workflows/**',
  'CODEOWNERS',
  '.claude/**',
  '.sdlc/**',
];

// The settings of a registered repository, with no defaults, so a change can name just the ones it alters.
const repositorySettings = {
  access: z.enum(['read_write', 'read_only']),
  writeMode: z.enum(['direct', 'branch_pr']),
  integrationBranch: z.string().min(1).max(100),
  protectedPaths: z.array(z.string().min(1).max(200)).max(50),
  modelPolicy: z.enum(['any', 'own_account']),
  verifyCommand: z.string().min(1).max(300),
  requiredCheck: z.string().min(1).max(100),
};

export const repositoryCreateSchema = z.object({
  fullName: repoName,
  access: repositorySettings.access.default('read_write'),
  writeMode: repositorySettings.writeMode.default('branch_pr'),
  integrationBranch: repositorySettings.integrationBranch.default('main'),
  protectedPaths: repositorySettings.protectedPaths.default(DEFAULT_PROTECTED_PATHS),
  modelPolicy: repositorySettings.modelPolicy.default('any'),
  verifyCommand: repositorySettings.verifyCommand.default('npm run verify'),
  requiredCheck: repositorySettings.requiredCheck.default('verify'),
});
export type RepositoryCreate = z.infer<typeof repositoryCreateSchema>;

// Changing a registered repository: any of its settings, but not its name. A setting left out stays as it is.
export const repositoryUpdateSchema = z
  .object(repositorySettings)
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Give at least one setting to change.',
  });
export type RepositoryUpdate = z.infer<typeof repositoryUpdateSchema>;
export const repositoryDtoSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  access: z.enum(['read_write', 'read_only']),
  writeMode: z.enum(['direct', 'branch_pr']),
  integrationBranch: z.string(),
  protectedPaths: z.array(z.string()),
  modelPolicy: z.enum(['any', 'own_account']),
  verifyCommand: z.string(),
  requiredCheck: z.string(),
});
export type RepositoryDto = z.infer<typeof repositoryDtoSchema>;

// Repositories both GitHub Apps can see and nobody has registered yet.
export const repositoryAvailableSchema = z.object({
  problem: z.string().nullable(),
  available: z.array(z.string()),
});
export type RepositoryAvailableDto = z.infer<typeof repositoryAvailableSchema>;

// What a repository still needs before agents can deliver a change through it.
export const repositoryReadinessSchema = z.object({
  checks: z.array(
    z.object({
      id: z.enum(['apps', 'branch', 'verify', 'ci', 'protection']),
      label: z.string(),
      status: z.enum(['ok', 'problem', 'unknown']),
      detail: z.string(),
      fix: z
        .object({
          kind: z.literal('first_commit'),
          path: z.string(),
          content: z.string(),
          message: z.string(),
        })
        .optional(),
      howTo: z.object({ steps: z.array(z.string()), link: z.string().optional() }).optional(),
    }),
  ),
});
export type RepositoryReadinessDto = z.infer<typeof repositoryReadinessSchema>;

// The Settings page: which model each alias means, and the models a Platform Admin may choose from.
export const modelSettingsSchema = z.object({
  aliases: z.array(
    z.object({
      alias: z.string(),
      purpose: z.string(),
      model: z.string(),
      defaultModel: z.string(),
      usedBy: z.array(z.string()),
      changedAt: z.string().nullable(),
      changedBy: z.string().nullable(),
    }),
  ),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      note: z.string(),
      price: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
      }),
    }),
  ),
});
export type ModelSettingsDto = z.infer<typeof modelSettingsSchema>;

export const modelChangeSchema = z.object({ model: z.string().min(1).max(200) });

export const modelTestSchema = z.object({
  ok: z.boolean(),
  answer: z.string().optional(),
  ms: z.number().optional(),
  costMicros: z.number().optional(),
  status: z.number().optional(),
  error: z.string().optional(),
});
export type ModelTestDto = z.infer<typeof modelTestSchema>;

/** What kind of work an initiative is. The agents are told (packages/core/src/initiative-kind.ts keeps the same list). */
export const INITIATIVE_KINDS = ['new_app', 'feature', 'change'] as const;
export type InitiativeKindDto = (typeof INITIATIVE_KINDS)[number];
export const KIND_LABEL: Record<InitiativeKindDto, string> = {
  new_app: 'New app',
  feature: 'Feature',
  change: 'Change or fix',
};
export const KIND_HELP: Record<InitiativeKindDto, string> = {
  new_app: 'A first build: the repository is empty or holds only scaffolding.',
  feature: 'Adds something to an app that already exists.',
  change: 'Changes or fixes behaviour that already exists, as small as it can be.',
};

export const initiativeCreateSchema = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(4000),
  repositoryId: z.string().uuid(),
  autonomyMode: z.enum(['guided', 'balanced', 'autopilot']).default('balanced'),
  // New app, feature, or change or fix. Left out, the platform suggests one from the repository.
  kind: z.enum(INITIATIVE_KINDS).optional(),
  // Start the spec from the goal now, and the design and build after each approval. False: a person starts every run.
  autoStages: z.boolean().default(true),
  // Documentation for outside systems the work must call, or other background. Agents pass them on when they propose an integration.
  referenceLinks: z
    .array(
      z
        .string()
        .url()
        .max(500)
        .refine((u) => u.startsWith('https://'), 'Reference links must be https'),
    )
    .max(10)
    .default([]),
  budgetUsd: z.number().positive().max(10_000).optional(),
  // Needed to make a new app in a repository that already has another: the platform cannot preview or smoke-test it.
  acknowledgeSharedRepository: z.boolean().optional(),
});
export type InitiativeCreate = z.infer<typeof initiativeCreateSchema>;

export const runCreateSchema = z.object({
  role: z.string().min(1).default('backend_engineer'),
  task: z.string().min(1).max(8000),
  budgetUsd: z.number().positive().max(1000).optional(),
});
export type RunCreate = z.infer<typeof runCreateSchema>;
