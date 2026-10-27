import { createHash, timingSafeEqual } from 'node:crypto';
import { DEFAULT_PRICES } from './pricing.js';
import type { ModelPrice } from './pricing.js';

// The models a Platform Admin may choose from. Claude Code speaks the Anthropic messages protocol with tool use and
// streaming, and the gateway pins every call to first-party Anthropic with no fallback (spike 1), so the list is Claude
// models with a known price. A model outside it has no price, so its cost would be recorded as zero.
export interface VettedModel {
  id: string;
  label: string;
  price: ModelPrice;
  /** How far it has been used here. */
  note: string;
}

const LABELS: Record<string, { label: string; note: string }> = {
  'anthropic/claude-haiku-4.5': {
    label: 'Claude Haiku 4.5',
    note: 'Fast and cheap. Used for Claude Code’s background work.',
  },
  'anthropic/claude-sonnet-4.6': { label: 'Claude Sonnet 4.6', note: 'Not used by default yet.' },
  'anthropic/claude-sonnet-5': { label: 'Claude Sonnet 5', note: 'Not used by default yet.' },
  'anthropic/claude-sonnet-5.5': {
    label: 'Claude Sonnet 5.5',
    note: 'The default for every agent. Built and demonstrated with it.',
  },
  'anthropic/claude-opus-4.8': {
    label: 'Claude Opus 4.8',
    note: 'The most capable, and about 2.5 times the price of Sonnet 5.5.',
  },
};

export const VETTED_MODELS: VettedModel[] = Object.entries(LABELS).map(([id, l]) => ({
  id,
  label: l.label,
  note: l.note,
  price: DEFAULT_PRICES[id]!,
}));

export const isVettedModel = (id: string): boolean => VETTED_MODELS.some((m) => m.id === id);

/** The three names agents use for a model. An agent definition names an alias; the gateway maps it to a model id. */
export const MODEL_ALIASES = ['agent-fast', 'agent-default', 'agent-strong'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  'agent-fast': 'anthropic/claude-haiku-4.5',
  'agent-default': 'anthropic/claude-sonnet-5.5',
  'agent-strong': 'anthropic/claude-sonnet-5.5',
};

export const ALIAS_PURPOSE: Record<ModelAlias, string> = {
  'agent-fast': 'Claude Code’s small model for background work. Every run may use it.',
  'agent-default': 'The model most agents think with: spec, design, and building.',
  'agent-strong': 'The model for the careful work, such as the security review.',
};

/**
 * The key the API and the gateway share for calls only the platform makes (such as testing a model). Both already hold the
 * database password, so this is derived from it and nothing new has to be stored or deployed.
 */
export function internalKey(databaseUrl: string): string {
  return createHash('sha256').update(`sdlc-internal-v1:${databaseUrl}`).digest('hex');
}

export function internalKeyMatches(given: string | undefined, databaseUrl: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(internalKey(databaseUrl));
  return a.length === b.length && timingSafeEqual(a, b);
}
