import {
  assumptionSchema,
  attentionProfileSchema,
  healthSchema,
  interactionSchema,
  interruptionMetricsSchema,
  meSchema,
  readySchema,
  standingDecisionSchema,
} from '@sdlc/schemas';
import type {
  AnswerRequest,
  AssumptionDto,
  AttentionProfile,
  Health,
  InteractionDto,
  InterruptionMetricsDto,
  Me,
  Ready,
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
