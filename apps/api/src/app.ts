import path from 'node:path';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { createDb } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { healthSchema, meSchema, readySchema } from '@sdlc/schemas';
import type { Pool } from 'pg';
import { loadAgents } from './agents.js';
import type { LoadedAgent } from './agents.js';
import { registerAuthRoutes } from './auth.js';
import { GitHubClient } from './github-app.js';
import { createGate } from './gate.js';
import { GitHubService } from './github-service.js';
import { DockerRunner } from './docker-runner.js';
import { ProcessRunner } from './launcher.js';
import type { RunnerAdapter } from './launcher.js';
import { loadRules } from './rules.js';
import { createRunWorker } from './run-worker.js';
import { registerRunnerRoutes } from './runner-routes.js';
import { registerGitHubAdminRoutes } from './github-admin.js';
import { AwsSecrets } from './aws-secrets.js';
import { FileSecrets } from './secrets.js';
import type { SecretsStore } from './secrets.js';
import type { ApiConfig } from './config.js';
import { registerInteractionRoutes } from './interaction-routes.js';
import { attentionTick } from './attention.js';
import { loadAttentionPolicy } from './attention-policy.js';
import { registerAttentionRoutes } from './attention-routes.js';
import { registerAutopilotRoutes } from './autopilot-routes.js';
import { registerMapRoutes } from './map-routes.js';
import { applyReleaseDecision } from './releases.js';
import { registerIntegrationRoutes, refreshAllDocs } from './integration-routes.js';
import { applyIntegrationDecision, confirmedHosts, createDocFetcher } from './integrations.js';
import type { DocFetcher } from './integrations.js';
import { LogNotifier } from './notifier.js';
import type { Notifier } from './notifier.js';
import { SlackClient, SlackNotifier, registerSlackRoutes } from './slack.js';
import type { AttentionPolicy } from '@sdlc/core';
import { registerMcpRoute } from './mcp.js';
import { requirePerson } from './people.js';
import { registerWorkRoutes } from './work-routes.js';

export const VERSION = '0.0.0';

export interface BuildOptions {
  config: ApiConfig;
  /** Tests may pass an existing database. Otherwise one is created from DATABASE_URL. */
  deps?: { db: Db; pool: Pool };
  logger?: boolean;
  /** Background work (applying defaults when they come due). Tests that have no database turn it off. */
  workers?: boolean;
  secrets?: SecretsStore;
  github?: GitHubClient;
  /** Agent definitions by role. Loaded from AGENTS_DIR when not given. */
  agents?: Map<string, LoadedAgent>;
  /** Tests may replace how people are reached. Otherwise Slack when it is configured, else the log. */
  notifier?: Notifier;
  policy?: AttentionPolicy;
  slack?: SlackClient;
  /** Fetches documentation links for the Integration Register. Tests replace it. */
  docFetcher?: DocFetcher;
}

export async function buildApp({
  config,
  deps,
  logger = false,
  workers = true,
  secrets,
  github,
  agents,
  notifier: notifierOverride,
  policy: policyOverride,
  slack: slackOverride,
  docFetcher,
}: BuildOptions) {
  const app = Fastify({ logger });
  const { db, pool } = deps ?? createDb(config.DATABASE_URL, { caFile: config.DATABASE_CA_FILE });
  if (!deps) app.addHook('onClose', async () => pool.end());

  await app.register(cookie, { secret: config.SESSION_SECRET });

  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'The request is not valid.',
          details: err.issues,
        },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) request.log.error({ err }, 'unhandled error');
    reply.code(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : 'bad_request',
        message: status >= 500 ? 'Internal error' : err.message,
      },
    });
  });

  app.get('/healthz', async () =>
    healthSchema.parse({
      status: 'ok',
      service: 'api',
      version: VERSION,
      time: new Date().toISOString(),
    }),
  );

  app.get('/readyz', async (_request, reply) => {
    let dbOk: 'ok' | 'fail' = 'ok';
    try {
      await pool.query('select 1');
    } catch {
      dbOk = 'fail';
    }
    const body = readySchema.parse({
      status: dbOk === 'ok' ? 'ready' : 'not_ready',
      checks: { database: dbOk },
    });
    return reply.code(body.status === 'ready' ? 200 : 503).send(body);
  });

  registerAuthRoutes(app, config, db);

  app.get('/api/me', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    return meSchema.parse(me);
  });

  const loadedAgents = agents ?? (await loadAgents(config.AGENTS_DIR));
  const ghClient = github ?? new GitHubClient(config.GITHUB_API_URL);
  const secretStore =
    secrets ??
    (config.SECRETS_BACKEND === 'aws'
      ? new AwsSecrets(config.SECRETS_PREFIX)
      : new FileSecrets(config.SECRETS_FILE));
  const ghService = new GitHubService(db, secretStore, ghClient);
  const apiUrl = `http://127.0.0.1:${config.API_PORT}`;
  registerWorkRoutes(app, db, loadedAgents);
  const ruleSet = await loadRules(config.RULES_FILE);
  const gate = createGate({ db, github: ghService, log: (l) => app.log.info(l) });
  registerRunnerRoutes(app, {
    db,
    config,
    agents: loadedAgents,
    rules: ruleSet,
    github: ghService,
    apiUrl,
    gate,
  });
  registerAutopilotRoutes(app, db, ruleSet);
  const policy = policyOverride ?? (await loadAttentionPolicy(config.ATTENTION_FILE));
  const slackHosts = ['hooks.slack.com'];
  if (config.SLACK_API_URL !== 'https://slack.com/api')
    slackHosts.push(new URL(config.SLACK_API_URL).host);
  const slackClient =
    slackOverride ??
    (config.SLACK_BOT_TOKEN
      ? new SlackClient(config.SLACK_BOT_TOKEN, config.SLACK_API_URL, slackHosts)
      : null);
  const notifier =
    notifierOverride ??
    (slackClient ? new SlackNotifier(slackClient) : new LogNotifier((l) => app.log.info(l)));
  const rules = { independentReview: config.INDEPENDENT_REVIEW };
  const fetcher = docFetcher ?? createDocFetcher();
  registerInteractionRoutes(app, db, rules, gate, policy, async (row) => {
    await applyIntegrationDecision(db, row, fetcher);
    await applyReleaseDecision(db, ghService, row);
  });
  registerMapRoutes(app, db, ghService, { approverRole: config.RELEASE_APPROVER_ROLE });
  registerIntegrationRoutes(app, db, fetcher);
  registerAttentionRoutes(app, db, {
    policy,
    chatConfigured: Boolean(config.SLACK_SIGNING_SECRET && slackClient),
  });
  if (config.SLACK_SIGNING_SECRET) {
    registerSlackRoutes(app, {
      db,
      signingSecret: config.SLACK_SIGNING_SECRET,
      client: slackClient,
      policy,
      rules,
      gate,
      publicUrl: config.PUBLIC_URL,
    });
  }
  if (workers && config.INTEGRATION_DOCS_INTERVAL_H > 0) {
    let docsTimer: NodeJS.Timeout | undefined;
    app.addHook('onReady', async () => {
      docsTimer = setInterval(
        () =>
          void refreshAllDocs(db, fetcher).catch((e) =>
            app.log.error({ err: e }, 'refreshing integration documentation failed'),
          ),
        config.INTEGRATION_DOCS_INTERVAL_H * 3_600_000,
      );
    });
    app.addHook('onClose', async () => clearInterval(docsTimer));
  }
  if (workers) {
    let attentionTimer: NodeJS.Timeout | undefined;
    let attentionBusy = false;
    app.addHook('onReady', async () => {
      attentionTimer = setInterval(() => {
        if (attentionBusy) return;
        attentionBusy = true;
        attentionTick({
          db,
          policy,
          notifier,
          publicUrl: config.PUBLIC_URL,
          independentReview: config.INDEPENDENT_REVIEW,
          log: (l) => app.log.info(l),
        })
          .catch((e) => app.log.error({ err: e }, 'attention tick failed'))
          .finally(() => {
            attentionBusy = false;
          });
      }, config.ATTENTION_TICK_MS);
    });
    app.addHook('onClose', async () => clearInterval(attentionTimer));
  }
  registerMcpRoute(app, db, { blockingMaxS: config.BLOCKING_MAX_S });
  registerGitHubAdminRoutes(app, {
    db,
    config,
    secrets: secretStore,
    github: ghClient,
  });

  if (workers) {
    let gateTimer: NodeJS.Timeout | undefined;
    let gateBusy = false;
    app.addHook('onReady', async () => {
      gateTimer = setInterval(() => {
        if (gateBusy) return;
        gateBusy = true;
        gate
          .tick()
          .catch((e) => app.log.error({ err: e }, 'gate tick failed'))
          .finally(() => {
            gateBusy = false;
          });
      }, 5000);
    });
    app.addHook('onClose', async () => clearInterval(gateTimer));
  }

  if (workers && config.RUNNER_ADAPTER !== 'none') {
    const adapter: RunnerAdapter =
      config.RUNNER_ADAPTER === 'docker'
        ? new DockerRunner({
            image: config.RUNNER_IMAGE,
            apiPort: config.API_PORT,
            gatewayPort: Number(new URL(config.GATEWAY_URL).port || 80),
            // The fixed list, plus the hosts of every confirmed entry in the Integration Register.
            allowHosts: async () => [
              ...config.RUNNER_EGRESS_ALLOW.split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              ...(await confirmedHosts(db)),
            ],
            log: (l) => app.log.info(l),
          })
        : new ProcessRunner({
            runsDir: config.RUNS_DIR,
            entry: config.RUNNER_ENTRY,
            cwd: process.cwd(),
          });
    const worker = createRunWorker({
      db,
      apiUrl,
      maxConcurrent: config.MAX_CONCURRENT_RUNS,
      adapter,
    });
    app.addHook('onReady', async () => worker.start());
    app.addHook('onClose', async () => {
      worker.stop();
      await adapter.close?.();
    });
  }

  // In a deployment the API serves the built web app, so the browser has one origin (the load balancer).
  if (config.WEB_DIR) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: path.resolve(config.WEB_DIR), wildcard: false });
  }

  return app;
}
