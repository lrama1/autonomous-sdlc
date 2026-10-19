import {
  assumptionSchema,
  attentionProfileSchema,
  autopilotSchema,
  bugSchema,
  buildPlanSchema,
  costsSchema,
  portfolioSchema,
  monthlyBudgetSchema,
  healthSchema,
  integrationSchema,
  interactionSchema,
  interruptionMetricsSchema,
  meSchema,
  previewSchema,
  smokeSchema,
  readySchema,
  stageStartSchema,
  standingDecisionSchema,
} from '@sdlc/schemas';
import type {
  AnswerRequest,
  AssumptionDto,
  AutopilotDto,
  AttentionProfile,
  BugCreate,
  BugDto,
  BuildPlanDto,
  CostsDto,
  PortfolioDto,
  Health,
  IntegrationDto,
  InteractionDto,
  InterruptionMetricsDto,
  Me,
  MonthlyBudgetDto,
  PreviewDto,
  SmokeDto,
  Ready,
  StageStartDto,
  StandingDecisionDto,
} from '@sdlc/schemas';
import { z } from 'zod';

export async function getHealth(): Promise<Health> {
  const r = await fetch('/healthz');
  return healthSchema.parse(await r.json());
}

export async function getReady(): Promise<Ready> {
  const r = await fetch('/readyz');
  return readySchema.parse(await r.json());
}

/** Returns the signed-in person, or null when there is no session. */
export async function getMe(): Promise<Me | null> {
  const r = await fetch('/api/me');
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`/api/me failed with ${r.status}`);
  return meSchema.parse(await r.json());
}

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST' });
}

/** An error the API explained in words a person can read. */
export class ApiProblem extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const r = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json: unknown = await r.json().catch(() => null);
  if (!r.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiProblem(
      e?.message ?? `Request failed (${r.status})`,
      e?.code ?? 'error',
      r.status,
    );
  }
  return schema.parse(json);
}

const ok = z.object({}).passthrough();

export const getQueue = () => call('/api/interactions', z.array(interactionSchema));

export const answerInteraction = (
  id: string,
  body: Partial<AnswerRequest>,
): Promise<InteractionDto> =>
  call(`/api/interactions/${id}/answer`, interactionSchema, { method: 'POST', body });

export const snoozeInteraction = (id: string, minutes = 120): Promise<InteractionDto> =>
  call(`/api/interactions/${id}/snooze`, interactionSchema, { method: 'POST', body: { minutes } });

export const didntNeedToAsk = (id: string): Promise<InteractionDto> =>
  call(`/api/interactions/${id}/didnt-need-to-ask`, interactionSchema, { method: 'POST' });

export const getProfile = (): Promise<AttentionProfile> =>
  call('/api/attention/profile', attentionProfileSchema);

export const getPreview = (id: string): Promise<PreviewDto> =>
  call(`/api/interactions/${id}/preview`, previewSchema);

export const startPlatformPreview = (interactionId: string) =>
  call(
    `/api/interactions/${interactionId}/preview/start`,
    z.object({ id: z.string(), state: z.string() }),
    { method: 'POST' },
  );
export const stopPlatformPreview = (previewId: string) =>
  call(`/api/previews/${previewId}/stop`, z.object({ id: z.string(), state: z.string() }), {
    method: 'POST',
  });

export const getSmoke = (id: string): Promise<SmokeDto> =>
  call(`/api/interactions/${id}/smoke`, smokeSchema);

export const startSmoke = (interactionId: string) =>
  call(
    `/api/interactions/${interactionId}/smoke/start`,
    z.object({ id: z.string(), state: z.string() }),
    { method: 'POST' },
  );

export const overrideSmoke = (interactionId: string, reason: string) =>
  call(
    `/api/interactions/${interactionId}/smoke/override`,
    z.object({ id: z.string(), state: z.string() }),
    { method: 'POST', body: { reason } },
  );

export const getAssumptions = (): Promise<AssumptionDto[]> =>
  call('/api/assumptions', z.array(assumptionSchema));

export const decideAssumption = (id: string, verb: 'accept' | 'reject') =>
  call(`/api/assumptions/${id}/${verb}`, ok, { method: 'POST' });

export const getStandingDecisions = (): Promise<StandingDecisionDto[]> =>
  call('/api/standing-decisions', z.array(standingDecisionSchema));

export const retireStandingDecision = (id: string) =>
  call(`/api/standing-decisions/${id}`, ok, { method: 'PATCH', body: { active: false } });

export const createStandingDecision = (body: {
  scope: 'global' | 'initiative';
  scopeId?: string;
  topic: string;
  text: string;
}) => call('/api/standing-decisions', ok, { method: 'POST', body });

const initiatives = z.array(z.object({ id: z.string().uuid(), title: z.string() }).passthrough());
export const getInitiatives = () => call('/api/initiatives', initiatives);

export const getInterruptions = (days: number): Promise<InterruptionMetricsDto> =>
  call(`/api/metrics/interruptions?days=${days}`, interruptionMetricsSchema);

export const getAutopilot = (): Promise<AutopilotDto> => call('/api/autopilot', autopilotSchema);

export const setAutonomyMode = (id: string, autonomyMode: 'guided' | 'balanced' | 'autopilot') =>
  call(`/api/initiatives/${id}`, ok, { method: 'PATCH', body: { autonomyMode } });

export const getIntegrations = (): Promise<IntegrationDto[]> =>
  call('/api/integrations', z.array(integrationSchema));

export interface NewIntegration {
  name: string;
  kind: 'second_party' | 'third_party';
  docs: string[];
  hosts: string[];
  authType: 'none' | 'api_key' | 'oauth' | 'basic';
  credentialRef?: string;
  testStrategy: 'vendor_sandbox' | 'mock' | 'recorded' | 'none';
  owner?: string;
  failureBehavior?: string;
}

export const createIntegration = (body: NewIntegration): Promise<IntegrationDto> =>
  call('/api/integrations', integrationSchema, { method: 'POST', body });

export const retireIntegration = (id: string) =>
  call(`/api/integrations/${id}/retire`, ok, { method: 'POST' });

export const refreshIntegrationDocs = (id: string) =>
  call(`/api/integrations/${id}/refresh-docs`, ok, { method: 'POST' });

const stageSchema = z.object({
  id: z.enum(['spec', 'build', 'release']),
  title: z.string(),
  checkpoint: z.string(),
  status: z.enum(['not_started', 'working', 'waiting_human', 'blocked', 'done']),
  waitingOn: z.array(z.string()),
  detail: z.string(),
  items: z.array(
    z.object({
      kind: z.enum(['run', 'ask']),
      id: z.string(),
      title: z.string(),
      state: z.string(),
    }),
  ),
});
export type Stage = z.infer<typeof stageSchema>;

const mapSchema = z.object({
  initiative: z.object({
    id: z.string().uuid(),
    title: z.string(),
    goal: z.string(),
    autonomyMode: z.string(),
  }),
  stages: z.array(stageSchema),
});
export type InitiativeMap = z.infer<typeof mapSchema>;

export const getMap = (id: string): Promise<InitiativeMap> =>
  call(`/api/initiatives/${id}/map`, mapSchema);

const releaseSchema = z.array(
  z.object({
    interactionId: z.string().uuid(),
    version: z.string(),
    tag: z.string(),
    notes: z.string(),
    state: z.string(),
    url: z.string().nullable(),
    detail: z.string().nullable(),
    createdAt: z.string(),
  }),
);
export const getReleases = (id: string) => call(`/api/initiatives/${id}/releases`, releaseSchema);
export const prepareRelease = (id: string, version: string) =>
  call(`/api/initiatives/${id}/releases`, ok, { method: 'POST', body: { version } });

const repositories = z.array(
  z.object({ id: z.string().uuid(), fullName: z.string() }).passthrough(),
);
export const getRepositories = () => call('/api/repositories', repositories);

export const createInitiative = (body: {
  title: string;
  goal: string;
  repositoryId: string;
  autonomyMode: 'guided' | 'balanced' | 'autopilot';
  autoStages: boolean;
}) =>
  call('/api/initiatives', z.object({ id: z.string().uuid() }).passthrough(), {
    method: 'POST',
    body,
  });

export const startRun = (id: string, body: { role: string; task: string; budgetUsd?: number }) =>
  call(`/api/initiatives/${id}/runs`, z.object({ id: z.string().uuid() }).passthrough(), {
    method: 'POST',
    body,
  });

const planAnswer = z.object({ plan: buildPlanSchema.nullable() });
export const getBuildPlan = async (initiativeId: string): Promise<BuildPlanDto | null> =>
  (await call(`/api/initiatives/${initiativeId}/plan`, planAnswer)).plan;
const planAction = (path: string) => call(path, buildPlanSchema, { method: 'POST' });
export const startBuildPlan = (id: string) => planAction(`/api/plans/${id}/start`);
export const cancelBuildPlan = (id: string) => planAction(`/api/plans/${id}/cancel`);
export const retryBuildTask = (id: string, key: string) =>
  planAction(`/api/plans/${id}/tasks/${key}/retry`);
export const skipBuildTask = (id: string, key: string) =>
  planAction(`/api/plans/${id}/tasks/${key}/skip`);

export const getStageStarts = (initiativeId: string): Promise<StageStartDto[]> =>
  call(`/api/initiatives/${initiativeId}/stages`, z.array(stageStartSchema));
export const startStageStep = (id: string) =>
  call(`/api/stages/${id}/start`, stageStartSchema, { method: 'POST' });
export const skipStageStep = (id: string) =>
  call(`/api/stages/${id}/skip`, stageStartSchema, { method: 'POST' });

export const getBugs = (): Promise<BugDto[]> => call('/api/bugs', z.array(bugSchema));
export const reportBug = (initiativeId: string, body: BugCreate): Promise<BugDto> =>
  call(`/api/initiatives/${initiativeId}/bugs`, bugSchema, { method: 'POST', body });

export const getCosts = (days: number, initiativeId: string | null): Promise<CostsDto> =>
  call(
    `/api/costs?days=${days}${initiativeId ? `&initiativeId=${initiativeId}` : ''}`,
    costsSchema,
  );
export const getPortfolio = (): Promise<PortfolioDto> => call('/api/portfolio', portfolioSchema);
export const getBudget = (): Promise<MonthlyBudgetDto> =>
  call('/api/costs/budget', monthlyBudgetSchema);
