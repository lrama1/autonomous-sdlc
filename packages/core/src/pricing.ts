// Prices in micro-USD per token. OpenRouter's response carries token counts but no cost,
// so the gateway multiplies by this table (mvp-contract section 10).

export interface ModelPrice {
  /** micro-USD per uncached input token (USD per 1M tokens equals micro-USD per token) */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Usage {
  inputTokens: number;
  cacheWriteTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

// Checked against OpenRouter's /api/v1/models on 2026-10-17 (USD per 1M tokens).
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'anthropic/claude-haiku-4.5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'anthropic/claude-sonnet-4.6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'anthropic/claude-opus-4.8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/** Cost in whole micro-USD, rounded up so budgets never under-count. Unknown models throw. */
export function costMicros(price: ModelPrice | undefined, usage: Usage, model: string): number {
  if (!price) throw new Error(`no price configured for model ${model}`);
  const total =
    usage.inputTokens * price.input +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.cachedTokens * price.cacheRead +
    usage.outputTokens * price.output;
  return Math.ceil(total);
}
