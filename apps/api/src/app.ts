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
import { FargateRunner, S3StateStore } from './fargate-runner.js';
import { DockerPreviewHost } from './docker-preview.js';
import type { PreviewHost } from './docker-preview.js';
import { PreviewService } from './previews.js';
import { registerSmokeRoutes } from './smoke-routes.js';
import { SmokeService } from './smoke-service.js';
import { SmokeDiagnosisService } from './smoke-diagnosis.js';
import { AutoChecks } from './auto-checks.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { GatewayAssistantModel } from './assistant/model.js';
import type { AssistantModel } from './assistant/model.js';
import { GatewayModel } from './inline-model.js';
import type { InlineModel } from './inline-model.js';
import { registerSecurityRoutes } from './security-routes.js';
import { SecurityService } from './security-service.js';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FargatePreviewHost, CloudWatchTaskLogs, S3CodeStore } from './fargate-preview.js';
import { registerPreviewProxy } from './preview-proxy.js';
import { ProcessRunner } from './launcher.js';
import type { RunnerAdapter } from './launcher.js';
import { loadRules } from './rules.js';
import { createRunWorker } from './run-worker.js';
import { registerRunnerRoutes } from './runner-routes.js';
import { refreshInstallations, registerGitHubAdminRoutes } from './github-admin.js';
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
import { registerEgressRoutes } from './egress-routes.js';
import { registerPreviewRoutes } from './preview-routes.js';
import { buildTick } from './build.js';
import { registerBuildRoutes } from './build-routes.js';
import { registerStageRoutes } from './stage-routes.js';
import { registerBugRoutes } from './bug-routes.js';
import { registerCostRoutes } from './cost-routes.js';
import { registerPortfolioRoutes } from './portfolio.js';
import { checkBudgetAlert } from './costs.js';
import { stageTick } from './stages.js';
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
import { registerRegistryRoutes } from './registry-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { registerWorkRoutes, repoDto } from './work-routes.js';

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
  /** Where platform previews run. Tests pass a fake. Otherwise the Docker host is used when the Docker runner is. */
  previewHost?: PreviewHost;
  /** What the Security agent asks. Tests replace it; otherwise it asks the model gateway. */
  securityModel?: InlineModel;
  /** The model the assistant chat asks. Tests pass a fake. Otherwise the gateway is used, unless the assistant is off. */
  assistantModel?: AssistantModel;
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
  previewHost,
  securityModel,
  assistantModel,
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

  const loadedAgents = agents ?? (await loadAgents(config.AGENTS_DIR, config.AGENT_ENGINE));
  const ghClient = github ?? new GitHubClient(config.GITHUB_API_URL);
  const secretStore =
    secrets ??
    (config.SECRETS_BACKEND === 'aws'
      ? new AwsSecrets(config.SECRETS_PREFIX)
      : new FileSecrets(config.SECRETS_FILE));
  const ghService = new GitHubService(db, secretStore, ghClient);
  const apiUrl = `http://127.0.0.1:${config.API_PORT}`;
  const refreshApps = () => refreshInstallations(db, secretStore, ghClient);
  registerWorkRoutes(app, db, loadedAgents, refreshApps, async (repo) => {
    try {
      return (await ghService.branchInfo(repo.fullName, repo.integrationBranch))
        ? 'exists'
        : 'missing';
    } catch {
      return 'unknown';
    }
  });
  registerRegistryRoutes(app, db, { refreshApps, github: ghService, dto: repoDto });
  registerSettingsRoutes(app, db, {
    agents: loadedAgents,
    gatewayUrl: config.GATEWAY_URL,
    databaseUrl: config.DATABASE_URL,
  });
  const ruleSet = await loadRules(config.RULES_FILE);
  let smoke: SmokeService | null = null;
  let security: SecurityService | null = null;
  let diagnosis: SmokeDiagnosisService | null = null;
  const gate = createGate({
    db,
    github: ghService,
    smoke: () => smoke,
    security: () => security,
    log: (l) => app.log.info(l),
  });
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
  const previewSettings = {
    maxActive: config.PREVIEW_MAX_ACTIVE,
    ttlMinutes: config.PREVIEW_TTL_MIN,
    portBase: config.PREVIEW_PORT_BASE,
  };
  let previews: PreviewService | null = null;
  // The Security agent reads through the model gateway; nothing else is needed, so it does not wait for a preview host.
  const securityAgent = loadedAgents.get('security');
  if (config.SECURITY_REVIEW === 'on' && securityAgent?.definition.runs === 'inline') {
    security = new SecurityService({
      db,
      github: ghService,
      agent: securityAgent,
      model: securityModel ?? new GatewayModel(config.GATEWAY_URL),
      log: (l) => app.log.info(l),
    });
    // Explaining a failed smoke test is the same kind of call: one reading through the gateway, on the same agent.
    diagnosis = new SmokeDiagnosisService({
      db,
      github: ghService,
      agent: securityAgent,
      model: securityModel ?? new GatewayModel(config.GATEWAY_URL),
    });
    // The platform starts, and says so on its health page, even when the database is not there yet.
    await security
      .recover()
      .catch((e) =>
        app.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'security recovery failed',
        ),
      );
    app.addHook('onClose', async () => {
      await security?.idle();
    });
  }
  const useHost = async (host: PreviewHost) => {
    previews = new PreviewService({
      db,
      github: ghService,
      host,
      settings: previewSettings,
      log: (l) => app.log.info(l),
    });
    await previews.recover();
    smoke = new SmokeService({
      db,
      github: ghService,
      previews,
      host,
      log: (l) => app.log.info(l),
    });
    await smoke.recover();
    if (workers) {
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        previews!
          .tick()
          .catch((e) => app.log.error({ err: e }, 'preview tick failed'))
          .finally(() => {
            busy = false;
          });
      }, config.BUILD_TICK_MS);
      app.addHook('onClose', async () => {
        clearInterval(timer);
        await previews?.idle();
        await smoke?.idle();
      });
    }
    app.addHook('onClose', async () => {
      // Nothing a preview started outlives the platform.
      await host.reconcile().catch(() => {});
      await host.close?.();
    });
  };
  if (previewHost) await useHost(previewHost);
  registerPreviewRoutes(app, db, ghService, () => previews, {
    ttlMinutes: config.PREVIEW_TTL_MIN,
  });
  registerAssistantRoutes(app, db, {
    model:
      assistantModel ??
      (config.ASSISTANT === 'on'
        ? new GatewayAssistantModel(config.GATEWAY_URL, config.DATABASE_URL)
        : null),
    alias: config.ASSISTANT_ALIAS,
    dailyCapUsd: config.ASSISTANT_DAILY_CAP_USD,
    github: ghService,
    previews: () => previews,
  });
  registerSmokeRoutes(
    app,
    db,
    rules,
    () => smoke,
    () => diagnosis,
    gate,
  );
  registerSecurityRoutes(app, db, rules, gate, () => security);
  app.decorate('previews', () => previews);
  registerPreviewProxy(app, db, { secret: config.SESSION_SECRET, origin: config.PREVIEW_ORIGIN });
  registerBuildRoutes(app, db, loadedAgents);
  registerStageRoutes(app, db);
  registerBugRoutes(app, db, loadedAgents);
  const budget = {
    monthlyBudgetUsd: config.MONTHLY_BUDGET_USD,
    alertPercent: config.BUDGET_ALERT_PERCENT,
  };
  registerCostRoutes(app, db, budget);
  registerEgressRoutes(app, db, {
    token: config.EGRESS_ALLOW_TOKEN,
    fixed: config.RUNNER_EGRESS_ALLOW,
  });
  registerPortfolioRoutes(app, db);
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

  // The checks a review needs start by themselves (security in every mode, the smoke test unless guided).
  const autoChecks = new AutoChecks({
    db,
    security: () => security,
    smoke: () => smoke,
    previews: () => previews,
    gate: () => gate,
    log: (l) => app.log.info(l),
  });
  app.decorate('autoChecks', autoChecks);
  if (workers) {
    let checksTimer: NodeJS.Timeout | undefined;
    let checksBusy = false;
    app.addHook('onReady', async () => {
      checksTimer = setInterval(() => {
        if (checksBusy) return;
        checksBusy = true;
        autoChecks
          .tick()
          .catch((e) => app.log.error({ err: e }, 'checks tick failed'))
          .finally(() => {
            checksBusy = false;
          });
      }, config.BUILD_TICK_MS);
    });
    app.addHook('onClose', async () => clearInterval(checksTimer));
  }

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

  if (workers) {
    let buildTimer: NodeJS.Timeout | undefined;
    let buildBusy = false;
    app.addHook('onReady', async () => {
      buildTimer = setInterval(() => {
        if (buildBusy) return;
        buildBusy = true;
        const autoStartMinutes = config.BUILD_AUTOSTART_MIN;
        const log = (l: string) => app.log.info(l);
        // The spec and design steps first, then the build, so one pass can carry work from a step to the next.
        stageTick({ db, agents: loadedAgents, autoStartMinutes, github: ghService, log })
          .catch((e) => app.log.error({ err: e }, 'stage tick failed'))
          .then(() => checkBudgetAlert(db, budget))
          .catch((e) => app.log.error({ err: e }, 'budget check failed'))
          .then(() =>
            buildTick({
              db,
              github: ghService,
              agents: loadedAgents,
              maxActive: config.BUILD_MAX_ACTIVE,
              autoStartMinutes,
              log,
            }),
          )
          .catch((e) => app.log.error({ err: e }, 'build tick failed'))
          .finally(() => {
            buildBusy = false;
          });
      }, config.BUILD_TICK_MS);
    });
    app.addHook('onClose', async () => clearInterval(buildTimer));
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
        : config.RUNNER_ADAPTER === 'fargate'
          ? fargateRunner(config, (l) => app.log.info(l))
          : new ProcessRunner({
              runsDir: config.RUNS_DIR,
              entry: config.RUNNER_ENTRY,
              cwd: process.cwd(),
            });
    if (
      !previewHost &&
      config.RUNNER_ADAPTER === 'fargate' &&
      config.FARGATE_PREVIEW_TASK_DEFINITION &&
      config.FARGATE_PREVIEW_SECURITY_GROUPS &&
      config.PREVIEW_ORIGIN
    ) {
      const list = (v?: string) =>
        (v ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      await useHost(
        new FargatePreviewHost({
          cluster: config.FARGATE_CLUSTER!,
          taskDefinition: config.FARGATE_PREVIEW_TASK_DEFINITION,
          subnets: list(config.FARGATE_SUBNETS),
          securityGroups: list(config.FARGATE_PREVIEW_SECURITY_GROUPS),
          code: new S3CodeStore(config.FARGATE_STATE_BUCKET!),
          data: config.PREVIEW_TABLE_PREFIX
            ? {
                tablePrefix: config.PREVIEW_TABLE_PREFIX,
                region: config.PREVIEW_TABLE_REGION,
                drop: async (table) => {
                  await new DynamoDBClient({ region: config.PREVIEW_TABLE_REGION }).send(
                    new DeleteTableCommand({ TableName: table }),
                  );
                },
              }
            : undefined,
          logs: new CloudWatchTaskLogs(`/${config.FARGATE_CLUSTER}`),
          openUrl: (id) => `${config.PUBLIC_URL}/api/previews/${id}/open`,
          log: (l) => app.log.info(l),
        }),
      );
    }
    if (!previewHost && config.RUNNER_ADAPTER === 'docker')
      await useHost(
        new DockerPreviewHost({
          image: config.RUNNER_IMAGE,
          memory: config.PREVIEW_MEMORY,
          allowHosts: config.PREVIEW_EGRESS_ALLOW.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          log: (l) => app.log.info(l),
        }),
      );
    const worker = createRunWorker({
      db,
      apiUrl,
      maxConcurrent: config.MAX_CONCURRENT_RUNS,
      adapter,
    });
    app.addHook('onReady', async () => worker.start());
    app.addHook('onClose', async () => {
      await worker.shutdown();
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

/** The Fargate runner from configuration, or a clear message about what is missing. */
function fargateRunner(config: ApiConfig, log: (line: string) => void): FargateRunner {
  const list = (v?: string) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const missing = (
    [
      ['FARGATE_CLUSTER', config.FARGATE_CLUSTER],
      ['FARGATE_TASK_DEFINITION', config.FARGATE_TASK_DEFINITION],
      ['FARGATE_SUBNETS', config.FARGATE_SUBNETS],
      ['FARGATE_SECURITY_GROUPS', config.FARGATE_SECURITY_GROUPS],
      ['FARGATE_STATE_BUCKET', config.FARGATE_STATE_BUCKET],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0)
    throw new Error(`RUNNER_ADAPTER=fargate needs ${missing.join(', ')} to be set.`);
  return new FargateRunner({
    cluster: config.FARGATE_CLUSTER!,
    taskDefinition: config.FARGATE_TASK_DEFINITION!,
    subnets: list(config.FARGATE_SUBNETS),
    securityGroups: list(config.FARGATE_SECURITY_GROUPS),
    state: new S3StateStore(config.FARGATE_STATE_BUCKET!),
    log,
  });
}
