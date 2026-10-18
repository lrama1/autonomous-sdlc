import { apiConfigSchema, parseEnv } from '@sdlc/schemas';
import type { ApiConfig } from '@sdlc/schemas';

export type { ApiConfig };

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiConfigSchema, env);
}
