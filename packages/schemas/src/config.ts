import { z } from 'zod';

const url = z.string().url();

export const apiConfigSchema = z.object({
  SDLC_ENV: z.enum(['local', 'hybrid', 'aws-sandbox']).default('local'),
  API_PORT: z.coerce.number().int().default(8080),
  // The address to listen on. Loopback in local development, all interfaces in a container.
  API_HOST: z.string().optional(),
  // The one origin where the browser reaches both the web app and the API (the dev proxy or the load balancer).
  PUBLIC_URL: url.default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  // A PEM file with the CA that signed the database certificate (the RDS bundle on AWS). Turns on verified TLS.
  DATABASE_CA_FILE: z.string().optional(),
  OIDC_ISSUER: url,
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  GITHUB_API_URL: url.default('https://api.github.com'),
  GITHUB_WEB_URL: url.default('https://github.com'),
  SECRETS_FILE: z.string().default('.dev-data/secrets.json'),
  // Where secrets are kept: a git-ignored file locally, AWS Secrets Manager under SECRETS_PREFIX on AWS.
  SECRETS_BACKEND: z.enum(['file', 'aws']).default('file'),
  SECRETS_PREFIX: z.string().default('sdlc/'),
  // The built web app, served by the API so the browser sees one origin. Absent in local development (Vite serves it).
  WEB_DIR: z.string().optional(),
  // A person who signs in with this email gets the platform admin hat. Needed once, to start a fresh deployment.
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  AGENTS_DIR: z.string().default('agents'),
  RULES_FILE: z.string().default('rules/triggers.yaml'),
  // How people are reached: reminders, escalation, working hours, what chat may settle.
  ATTENTION_FILE: z.string().default('rules/attention.yaml'),
  // Who approves a release (spec 8.1: Product Owner or DevOps). One hat, because an ask goes to one role.
  RELEASE_APPROVER_ROLE: z
    .enum(['product_owner', 'devops_release', 'platform_admin'])
    .default('product_owner'),
  // How often the saved copies of integration documentation are fetched again, in hours. 0 turns it off.
  INTEGRATION_DOCS_INTERVAL_H: z.coerce.number().min(0).default(24),
  ATTENTION_TICK_MS: z.coerce.number().int().positive().default(2000),
  // The build plan (mvp-contract section 16): how often it looks, and how many runs one initiative may have at once.
  BUILD_TICK_MS: z.coerce.number().int().positive().default(3000),
  BUILD_MAX_ACTIVE: z.coerce.number().int().positive().default(4),
  // A design approved longer ago than this waits for a person to start its build, in every mode.
  BUILD_AUTOSTART_MIN: z.coerce.number().int().positive().default(120),
  // The monthly model budget in dollars (0 means none), and the share of it at which admins are warned.
  MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(0),
  BUDGET_ALERT_PERCENT: z.coerce.number().min(1).max(100).default(80),
  // Slack. Both are needed to answer from chat. Only the bot token is needed to send.
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  SLACK_API_URL: url.default('https://slack.com/api'),
  GATEWAY_URL: url.default('http://127.0.0.1:8787'),
  // How runs are started: 'none' (only record them), 'process' (a child process on this machine, no isolation),
  // or 'docker' (an isolated container).
  // Moves every agent to one engine, whatever their definitions say. Unset leaves each agent on its own.
  AGENT_ENGINE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['claude-code', 'copilot-cli']).optional(),
  ),
  RUNNER_ADAPTER: z.enum(['none', 'process', 'docker', 'fargate']).default('none'),
  // RUNNER_ADAPTER=fargate: where each run starts (see infra/aws/runner.tf). Lists are comma separated.
  FARGATE_CLUSTER: z.string().optional(),
  FARGATE_TASK_DEFINITION: z.string().optional(),
  FARGATE_SUBNETS: z.string().optional(),
  FARGATE_SECURITY_GROUPS: z.string().optional(),
  FARGATE_STATE_BUCKET: z.string().optional(),
  // A shared secret the egress proxy sends to read the hosts agents may reach. Without it the route is off.
  EGRESS_ALLOW_TOKEN: z.string().min(16).optional(),
  RUNNER_IMAGE: z.string().default('sdlc-runner:dev'),
  // Hosts a sandbox may open HTTPS tunnels to. The platform itself is reached through fixed ports, not this list.
  RUNNER_EGRESS_ALLOW: z.string().default('github.com,registry.npmjs.org'),
  RUNS_DIR: z.string().default('.dev-data/runs'),
  // Previews the platform runs itself from a pull request (needs RUNNER_ADAPTER=docker).
  PREVIEW_MAX_ACTIVE: z.coerce.number().int().min(1).max(10).default(2),
  PREVIEW_TTL_MIN: z.coerce.number().int().min(1).max(240).default(30),
  PREVIEW_PORT_BASE: z.coerce.number().int().min(1024).max(65000).default(9100),
  PREVIEW_MEMORY: z.string().default('512m'),
  // On Fargate: the task definition that runs a preview, and the second web address previews are served from.
  FARGATE_PREVIEW_TASK_DEFINITION: z.string().optional(),
  // Previews get their own security group: no route to the API or the gateway, unlike a run.
  FARGATE_PREVIEW_SECURITY_GROUPS: z.string().optional(),
  // When set, each Fargate preview gets its own DynamoDB table named with this prefix (see PreviewData).
  PREVIEW_TABLE_PREFIX: z.string().optional(),
  PREVIEW_TABLE_REGION: z.string().default('us-east-1'),
  PREVIEW_ORIGIN: z.preprocess((v) => (v === '' ? undefined : v), url.optional()),
  // Hosts a preview may open HTTPS tunnels to while it installs. Nothing else leaves the sandbox.
  PREVIEW_EGRESS_ALLOW: z.string().default('registry.npmjs.org'),
  RUNNER_ENTRY: z.string().default('apps/runner/src/main.ts'),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
  // How long a blocking ask_human holds the engine's tool call before the run parks (mvp-contract section 6).
  BLOCKING_MAX_S: z.coerce.number().int().positive().default(120),
  // Off in solo mode (spec 6.4): the person who started a run may then review it.
  INDEPENDENT_REVIEW: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Whether a pull request needs a security review before it can be approved (mvp-contract section 16). On by default.
  SECURITY_REVIEW: z.enum(['on', 'off']).default('on'),
  // The assistant chat. The alias is the model it uses (Settings picks the model behind it), and the cap is what one person
  // may spend on it in a day, in dollars.
  ASSISTANT: z.enum(['on', 'off']).default('on'),
  ASSISTANT_ALIAS: z.string().default('agent-fast'),
  // How long the steps of a finished run (messages, tool calls and results) stay in the log.
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  ASSISTANT_DAILY_CAP_USD: z.coerce.number().positive().default(4),
});
export type ApiConfig = z.infer<typeof apiConfigSchema>;

export const gatewayConfigSchema = z.object({
  GATEWAY_PORT: z.coerce.number().int().default(8787),
  // Loopback locally. A container must listen on all interfaces to be reached by the API and by runners.
  GATEWAY_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  DATABASE_CA_FILE: z.string().optional(),
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
