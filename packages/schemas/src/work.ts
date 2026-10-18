import { z } from 'zod';

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  role: z.string().min(1),
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

export const repositoryCreateSchema = z.object({
  fullName: repoName,
  access: z.enum(['read_write', 'read_only']).default('read_write'),
  writeMode: z.enum(['direct', 'branch_pr']).default('branch_pr'),
  integrationBranch: z.string().min(1).max(100).default('main'),
  protectedPaths: z.array(z.string().min(1).max(200)).max(50).default(DEFAULT_PROTECTED_PATHS),
  modelPolicy: z.enum(['any', 'own_account']).default('any'),
  verifyCommand: z.string().min(1).max(300).default('npm run verify'),
  requiredCheck: z.string().min(1).max(100).default('verify'),
});
export type RepositoryCreate = z.infer<typeof repositoryCreateSchema>;

export const initiativeCreateSchema = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(4000),
  repositoryId: z.string().uuid(),
  autonomyMode: z.enum(['guided', 'balanced', 'autopilot']).default('balanced'),
  // Start the spec from the goal now, and the design and build after each approval. False: a person starts every run.
  autoStages: z.boolean().default(true),
  budgetUsd: z.number().positive().max(10_000).optional(),
});
export type InitiativeCreate = z.infer<typeof initiativeCreateSchema>;

export const runCreateSchema = z.object({
  role: z.string().min(1).default('backend_engineer'),
  task: z.string().min(1).max(8000),
  budgetUsd: z.number().positive().max(1000).optional(),
});
export type RunCreate = z.infer<typeof runCreateSchema>;
