import { DEFAULT_MODEL_ALIASES, DEFAULT_PRICES } from '@sdlc/core';
import type { ModelPrice } from '@sdlc/core';
import type { GatewayConfig } from '@sdlc/schemas';

export interface ProviderPrefs {
  order?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
}

export interface Settings {
  /** alias -> provider model id */
  aliases: Record<string, string>;
  /** provider model id -> price */
  prices: Record<string, ModelPrice>;
  /** injected into every agent request. Clients can never set it. */
  provider: ProviderPrefs;
}

// Spike 1: without preferences OpenRouter routed Claude Code to Bedrock, which OpenRouter does not
// guarantee for Claude Code. Always pin first-party Anthropic and never fall back to another provider.
export const DEFAULT_PROVIDER: ProviderPrefs = {
  order: ['anthropic'],
  allow_fallbacks: false,
  data_collection: 'deny',
};

// An alias can be changed on the platform's Settings page; that choice wins over these, and over GATEWAY_ALIASES.
export const DEFAULT_ALIASES: Record<string, string> = DEFAULT_MODEL_ALIASES;

function parseJson<T>(name: string, raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

export function loadSettings(config: GatewayConfig): Settings {
  const settings: Settings = {
    aliases: parseJson('GATEWAY_ALIASES', config.GATEWAY_ALIASES, DEFAULT_ALIASES),
    prices: { ...DEFAULT_PRICES, ...parseJson('GATEWAY_PRICES', config.GATEWAY_PRICES, {}) },
    provider: parseJson('GATEWAY_PROVIDER', config.GATEWAY_PROVIDER, DEFAULT_PROVIDER),
  };
  // Fail at start-up, not mid-run: every alias must map to a priced model, or cost would be recorded as zero.
  for (const [alias, model] of Object.entries(settings.aliases)) {
    if (!settings.prices[model])
      throw new Error(`alias "${alias}" maps to "${model}", which has no price`);
  }
  return settings;
}
