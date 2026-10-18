import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sdlc/core';
import { person } from './schema.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date());

// Registry (spec 6.5).
export const repositoryEntry = pgTable('repository_entry', {
  id: id(),
  fullName: text('full_name').notNull().unique(),
  access: text('access').notNull().default('read_write'), // read_write | read_only
  writeMode: text('write_mode').notNull().default('branch_pr'), // direct | branch_pr
  integrationBranch: text('integration_branch').notNull().default('main'),
  protectedPaths: text('protected_paths').array().notNull().default([]),
  allowedPaths: text('allowed_paths').array(),
  modelPolicy: text('model_policy').notNull().default('any'), // any | own_account
  verifyCommand: text('verify_command').notNull().default('npm run verify'),
  // The name of the CI check that must be green before the Gate may merge.
  requiredCheck: text('required_check').notNull().default('verify'),
  githubInstallationId: bigint('github_installation_id', { mode: 'number' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const initiative = pgTable('initiative', {
  id: id(),
  title: text('title').notNull(),
  goal: text('goal').notNull(),
  repositoryId: uuid('repository_id')
    .notNull()
    .references(() => repositoryEntry.id),
  autonomyMode: text('autonomy_mode').notNull().default('balanced'), // guided | balanced | autopilot
  state: text('state').notNull().default('draft'), // draft | active | paused | done | cancelled
  createdBy: uuid('created_by')
    .notNull()
    .references(() => person.id),
  budgetMicros: bigint('budget_micros', { mode: 'number' }),
  // Whether the spec and design steps start by themselves (or on a click in guided mode). Off means a person starts every run.
  autoStages: boolean('auto_stages').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentRun = pgTable(
  'agent_run',
  {
    id: id(),
    initiativeId: uuid('initiative_id')
      .notNull()
      .references(() => initiative.id),
    agentRole: text('agent_role').notNull(),
    task: text('task').notNull().default(''),
    agentDefinitionId: text('agent_definition_id').notNull(),
    agentDefinitionVersion: integer('agent_definition_version').notNull(),
    engine: text('engine').notNull(),
    modelAlias: text('model_alias').notNull(),
    // queued | starting | running | parked | resuming | paused | succeeded | failed | cancelled | budget_exceeded | timed_out
    state: text('state').notNull().default('queued'),
    sponsorPersonId: uuid('sponsor_person_id')
      .notNull()
      .references(() => person.id),
    contributors: uuid('contributors').array().notNull().default([]),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositoryEntry.id),
    branch: text('branch'),
    prNumber: integer('pr_number'),
    sessionRef: text('session_ref'),
    parkReason: text('park_reason'),
    budgetMicros: bigint('budget_micros', { mode: 'number' }).notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitReason: text('exit_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('agent_run_initiative_idx').on(t.initiativeId),
    index('agent_run_state_idx').on(t.state),
  ],
);

// Append-only. seq is assigned per run, gapless (mvp-contract section 7).
export const runEvent = pgTable(
  'run_event',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
  },
  (t) => [unique('run_event_run_seq_uq').on(t.runId, t.seq)],
);

// Random 32-byte tokens are stored hashed. scopes look like: 'gateway', 'mcp', 'alias:agent-default'.
export const runToken = pgTable(
  'run_token',
  {
    tokenHash: text('token_hash').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    scopes: text('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('run_token_run_idx').on(t.runId)],
);

export const costRecord = pgTable(
  'cost_record',
  {
    id: id(),
    runId: uuid('run_id').references(() => agentRun.id),
    initiativeId: uuid('initiative_id'),
    source: text('source').notNull(), // agent | service
    alias: text('alias').notNull(),
    providerModel: text('provider_model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0), // uncached input
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0), // cache reads
    outputTokens: integer('output_tokens').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull(),
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('cost_record_run_idx').on(t.runId)],
);

export const interaction = pgTable(
  'interaction',
  {
    id: id(),
    initiativeId: uuid('initiative_id')
      .notNull()
      .references(() => initiative.id),
    runId: uuid('run_id').references(() => agentRun.id),
    type: text('type').notNull(), // question | checkpoint | review | decision | notice
    checkpointId: text('checkpoint_id'), // G0..G7
    state: text('state').notNull().default('open'), // open | answered | defaulted | withdrawn | superseded
    title: text('title').notNull(),
    contextCard: jsonb('context_card').notNull().default({}),
    options: jsonb('options'),
    recommendation: text('recommendation'),
    defaultValue: text('default_value'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    blocks: jsonb('blocks').$type<Array<{ runId: string }>>().notNull().default([]),
    topicKey: text('topic_key'),
    roleNeeded: text('role_needed').notNull(),
    assignedPersonId: uuid('assigned_person_id').references(() => person.id),
    escalationLevel: integer('escalation_level').notNull().default(0),
    // When the current assignee was given the ask. Reminders and the next escalation count from here.
    levelStartedAt: timestamp('level_started_at', { withTimezone: true }),
    reminderCount: integer('reminder_count').notNull().default(0),
    lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    priority: integer('priority').notNull().default(0),
    hardStop: boolean('hard_stop').notNull().default(false),
    answer: jsonb('answer'),
    answeredBy: uuid('answered_by').references(() => person.id),
    answeredVia: text('answered_via'), // workspace | slack | teams | email | default
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    didntNeedToAsk: boolean('didnt_need_to_ask').notNull().default(false),
    standingDecisionId: uuid('standing_decision_id'),
    duplicateOf: uuid('duplicate_of'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('interaction_initiative_state_idx').on(t.initiativeId, t.state),
    index('interaction_run_idx').on(t.runId),
    index('interaction_due_idx').on(t.dueAt),
  ],
);

// The outbox of the notifier port. One row per message to one person on one channel.
export const notification = pgTable(
  'notification',
  {
    id: id(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    interactionId: uuid('interaction_id').references(() => interaction.id),
    // ask | reminder | escalation | default_applied | digest
    kind: text('kind').notNull(),
    channel: text('channel').notNull(), // slack | log
    // pending | held (quiet hours or digest) | sent | failed | skipped
    status: text('status').notNull().default('pending'),
    body: jsonb('body').notNull().default({}),
    // Where it was posted, so a later answer can update the same message (for Slack: channel and ts).
    externalRef: jsonb('external_ref'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('notification_status_idx').on(t.status),
    index('notification_person_idx').on(t.personId),
  ],
);

export const assumption = pgTable('assumption', {
  id: id(),
  initiativeId: uuid('initiative_id')
    .notNull()
    .references(() => initiative.id),
  runId: uuid('run_id')
    .notNull()
    .references(() => agentRun.id),
  text: text('text').notNull(),
  impact: text('impact').notNull().default('low'),
  state: text('state').notNull().default('declared'), // declared | accepted | rejected
  decidedBy: uuid('decided_by').references(() => person.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const standingDecision = pgTable('standing_decision', {
  id: id(),
  scope: text('scope').notNull().default('initiative'), // global | repository | initiative
  scopeId: uuid('scope_id'),
  topic: text('topic').notNull(),
  text: text('text').notNull(),
  createdFromInteractionId: uuid('created_from_interaction_id'),
  createdBy: uuid('created_by').references(() => person.id),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// The Integration Register (spec 6.7): which external systems agents may call, and how to test them.
export const integrationEntry = pgTable('integration_entry', {
  id: id(),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull().default('third_party'), // second_party | third_party
  owner: text('owner'),
  // Empty means every initiative. Otherwise only that initiative may call it.
  initiativeId: uuid('initiative_id').references(() => initiative.id),
  docs: jsonb('docs').$type<string[]>().notNull().default([]),
  // Hostnames a sandbox may open HTTPS tunnels to once the entry is confirmed.
  hosts: jsonb('hosts').$type<string[]>().notNull().default([]),
  authType: text('auth_type').notNull().default('none'), // none | api_key | oauth | basic
  // A name in the secrets store. The secret itself never lives here.
  credentialRef: text('credential_ref'),
  dataSent: text('data_sent'),
  dataReceived: text('data_received'),
  testStrategy: text('test_strategy').notNull().default('none'), // vendor_sandbox | mock | recorded | none
  limitsAndCost: text('limits_and_cost'),
  terms: text('terms'),
  failureBehavior: text('failure_behavior'),
  status: text('status').notNull().default('proposed'), // proposed | confirmed | rejected | retired
  proposedBy: text('proposed_by'), // a person id or "agent:<run id>"
  confirmedBy: uuid('confirmed_by').references(() => person.id),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// A hashed copy of a documentation link, fetched by the platform outside any sandbox. Untrusted input.
export const docSnapshot = pgTable(
  'doc_snapshot',
  {
    id: id(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrationEntry.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    sha256: text('sha256').notNull(),
    // The text agents read, cut to a size limit. Null if the fetch failed.
    content: text('content'),
    error: text('error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('doc_snapshot_integration_idx').on(t.integrationId, t.url, t.fetchedAt)],
);

export const artifact = pgTable('artifact', {
  id: id(),
  initiativeId: uuid('initiative_id')
    .notNull()
    .references(() => initiative.id),
  runId: uuid('run_id').references(() => agentRun.id),
  kind: text('kind').notNull(), // spec | adr | diagram | code | test | result | release_notes
  title: text('title').notNull(),
  gitRef: jsonb('git_ref'), // { path, sha }
  objectKey: text('object_key'),
  createdAt: createdAt(),
});

// The non-secret half of a registered GitHub App. The private key and secrets live in the secrets store.
export const githubApp = pgTable('github_app', {
  id: id(),
  kind: text('kind').notNull().unique(), // agent | gate
  appId: bigint('app_id', { mode: 'number' }).notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  ownerLogin: text('owner_login').notNull(),
  htmlUrl: text('html_url').notNull(),
  installationId: bigint('installation_id', { mode: 'number' }),
  installedOn: text('installed_on').array().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// The build plan: an approved design's task list, built one run at a time (mvp-contract section 16, step 4).
export const buildPlan = pgTable(
  'build_plan',
  {
    id: id(),
    initiativeId: uuid('initiative_id')
      .notNull()
      .references(() => initiative.id),
    // The approved design's review. One plan per approved design.
    designInteractionId: uuid('design_interaction_id')
      .notNull()
      .unique()
      .references(() => interaction.id),
    designPath: text('design_path').notNull(),
    // The commit the Gate merged, so the plan reads the design a person approved.
    designSha: text('design_sha').notNull(),
    state: text('state').notNull(), // awaiting_start | active | done | cancelled | invalid
    detail: text('detail'),
    errors: jsonb('errors').$type<string[]>().notNull().default([]),
    // Sponsor of the runs it starts: whoever approved the design, or whoever clicked start.
    startedBy: uuid('started_by').references(() => person.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('build_plan_initiative_idx').on(t.initiativeId)],
);

export const buildTask = pgTable(
  'build_task',
  {
    id: id(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => buildPlan.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // T1, T2, ...
    position: integer('position').notNull(),
    title: text('title').notNull(),
    role: text('role').notNull(),
    stories: jsonb('stories').$type<string[]>().notNull().default([]),
    dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
    paths: jsonb('paths').$type<string[]>().notNull().default([]),
    doneWhen: jsonb('done_when').$type<string[]>().notNull().default([]),
    state: text('state').notNull().default('waiting'), // waiting | running | review | merged | failed | skipped | cancelled
    runId: uuid('run_id').references(() => agentRun.id),
    attempt: integer('attempt').notNull().default(0),
    detail: text('detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('build_task_plan_key').on(t.planId, t.key),
    index('build_task_run_idx').on(t.runId),
  ],
);

// The steps before the build: drafting the spec from the goal, then designing the approved spec (mvp-contract section 16).
export const stageStart = pgTable(
  'stage_start',
  {
    id: id(),
    initiativeId: uuid('initiative_id')
      .notNull()
      .references(() => initiative.id),
    // "spec", or "design:<id of the spec review it follows>". One start per key.
    key: text('key').notNull(),
    stage: text('stage').notNull(), // spec | design
    role: text('role').notNull(), // product | architect
    sourceInteractionId: uuid('source_interaction_id').references(() => interaction.id),
    // The first line is the pull request title.
    task: text('task').notNull(),
    state: text('state').notNull(), // pending | awaiting_start | started | cancelled | invalid
    detail: text('detail'),
    // Sponsor of the run: the person who started or approved the step before.
    startedBy: uuid('started_by').references(() => person.id),
    runId: uuid('run_id').references(() => agentRun.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('stage_start_initiative_key').on(t.initiativeId, t.key)],
);

// A bug report (spec 9, step 7). The Bug Agent reproduces it, finds the cause, and proposes a fix.
export const bugReport = pgTable(
  'bug_report',
  {
    id: id(),
    initiativeId: uuid('initiative_id')
      .notNull()
      .references(() => initiative.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    steps: text('steps'),
    severity: text('severity').notNull().default('medium'), // low | medium | high
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => person.id),
    // open | fixing | fixed | needs_attention. Kept up to date by the worker from the fix run and its review.
    state: text('state').notNull().default('open'),
    detail: text('detail'),
    stageStartId: uuid('stage_start_id').references(() => stageStart.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('bug_report_initiative_idx').on(t.initiativeId)],
);
