import { z } from 'zod';

const url = z.string().url();

export const apiConfigSchema = z.object({
  SDLC_ENV: z.enum(['local', 'hybrid', 'aws-sandbox']).default('local'),
  API_PORT: z.coerce.number().int().default(8080),
  // The one origin where the browser reaches both the web app and the API (the dev proxy or the load balancer).
  PUBLIC_URL: url.default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  OIDC_ISSUER: url,
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  GITHUB_API_URL: url.default('https://api.github.com'),
  GITHUB_WEB_URL: url.default('https://github.com'),
  SECRETS_FILE: z.string().default('.dev-data/secrets.json'),
  AGENTS_DIR: z.string().default('agents'),
  RULES_FILE: z.string().default('rules/triggers.yaml'),
  // How people are reached: reminders, escalation, working hours, what chat may settle.
  ATTENTION_FILE: z.string().default('rules/attention.yaml'),
  ATTENTION_TICK_MS: z.coerce.number().int().positive().default(2000),
  // Slack. Both are needed to answer from chat. Only the bot token is needed to send.
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  SLACK_API_URL: url.default('https://slack.com/api'),
  GATEWAY_URL: url.default('http://127.0.0.1:8787'),
  // How runs are started: 'none' (only record them), 'process' (a child process on this machine, no isolation),
  // or 'docker' (an isolated container).
  RUNNER_ADAPTER: z.enum(['none', 'process', 'docker']).default('none'),
  RUNNER_IMAGE: z.string().default('sdlc-runner:dev'),
  // Hosts a sandbox may open HTTPS tunnels to. The platform itself is reached through fixed ports, not this list.
  RUNNER_EGRESS_ALLOW: z.string().default('github.com,registry.npmjs.org'),
  RUNS_DIR: z.string().default('.dev-data/runs'),
  RUNNER_ENTRY: z.string().default('apps/runner/src/main.ts'),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
  // How long a blocking ask_human holds the engine's tool call before the run parks (mvp-contract section 6).
  BLOCKING_MAX_S: z.coerce.number().int().positive().default(120),
  // Off in solo mode (spec 6.4): the person who started a run may then review it.
  INDEPENDENT_REVIEW: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
export type ApiConfig = z.infer<typeof apiConfigSchema>;

export const gatewayConfigSchema = z.object({
  GATEWAY_PORT: z.coerce.number().int().default(8787),
  DATABASE_URL: z.string().min(1),
  // Key for agent runs. Read through the secrets port; in local mode that is an environment variable.
  OPENROUTER_KEY_AGENTS: z.string().min(1),
  UPSTREAM_URL: url.default('https://openrouter.ai/api'),
  // JSON objects. Defaults live in the gateway code.
  GATEWAY_ALIASES: z.string().optional(),
  GATEWAY_PROVIDER: z.string().optional(),
  GATEWAY_PRICES: z.string().optional(),
  GATEWAY_MAX_BODY_MB: z.coerce.number().default(32),
});
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

/** Parse and validate environment variables, with a readable error listing every problem. */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
