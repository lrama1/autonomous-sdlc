import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import {
  agentRun,
  assumption,
  buildPlan,
  activityEvent,
  costRecord,
  buildTask,
  createDb,
  createRunFixture,
  initiative,
  integrationEntry,
  interaction,
  runEvent,
  person,
  repositoryEntry,
  stageStart,
  standingDecision,
} from '../packages/db/src/index.ts';

// The dev stack (started by Playwright with demo data) listens on this database.
const DATABASE_URL = 'postgres://sdlc:sdlc@localhost:54329/sdlc';
const { db, pool } = createDb(DATABASE_URL);
test.afterAll(async () => {
  await pool.end();
});

async function signInAs(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.getByRole('button', { name }).click();
  await expect(page.getByTestId('signed-in')).toBeVisible();
}

const card = (page: Page, title: string) =>
  page.getByTestId('ask').filter({ has: page.getByRole('heading', { name: title }) });

test('a person answers a decision from the queue and makes it a standing decision', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Which provider? ${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'decision',
      title,
      contextCard: { context: 'Building the forecast.', whyNow: 'Hard to switch later.' },
      options: [
        { id: 'A', label: 'Free tier', impact: '$0' },
        { id: 'B', label: 'Paid tier', impact: '$29 a month' },
      ],
      recommendation: 'A',
      defaultValue: 'A',
      dueAt: new Date(Date.now() + 5 * 3_600_000),
      blocks: [{ runId: f.runId }],
      topicKey: `provider-${randomUUID().slice(0, 8)}`,
      roleNeeded: 'backend_engineer',
    })
    .returning();

  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-queue').click();
  await expect(page.getByRole('heading', { name: 'Attention queue' })).toBeVisible();

  const ask = card(page, title);
  await expect(ask).toBeVisible();
  await expect(ask.getByText('recommended')).toBeVisible();
  await expect(ask.getByTestId('due')).toContainText(/Default in 4 h|Default in 5 h/);
  await expect(ask.getByText('Blocks 1 run')).toBeVisible();

  await ask.getByLabel(/B · Paid tier/).check();
  await ask.getByLabel('Use this answer from now on').check();
  await ask.getByRole('button', { name: 'Answer' }).click();
  await expect(
    page.getByTestId('settled').filter({ hasText: title }).getByTestId('answered'),
  ).toContainText('standing decision');

  await expect
    .poll(
      async () =>
        (await db.select().from(interaction).where(eq(interaction.id, row!.id)))[0]?.state,
    )
    .toBe('answered');
  const [after] = await db.select().from(interaction).where(eq(interaction.id, row!.id));
  expect(after).toMatchObject({ answeredVia: 'workspace' });
  expect(after!.answer).toMatchObject({ choice: 'B', text: 'B: Paid tier' });
  const [sd] = await db
    .select()
    .from(standingDecision)
    .where(eq(standingDecision.createdFromInteractionId, row!.id));
  expect(sd).toMatchObject({ text: 'B: Paid tier', scope: 'initiative' });

  // It leaves the queue after the next refresh.
  await page.reload();
  await expect(card(page, title)).toHaveCount(0);
});

test('the third identical answer to the same question offers to make it standing', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const topic = `provider-${randomUUID().slice(0, 8)}`;
  const make = (title: string, answered: boolean) =>
    db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'decision',
        title,
        contextCard: { context: 'Picking a provider.' },
        options: [
          { id: 'A', label: 'Free tier', impact: '$0' },
          { id: 'B', label: 'Paid tier', impact: '$29 a month' },
        ],
        blocks: [{ runId: f.runId }],
        topicKey: topic,
        roleNeeded: 'backend_engineer',
        ...(answered
          ? {
              state: 'answered',
              answeredVia: 'workspace',
              answeredAt: new Date(),
              answer: { text: 'B: Paid tier', decision: null, choice: 'B' },
            }
          : {}),
      })
      .returning();
  await make('Earlier one', true);
  await make('Earlier two', true);
  const title = `Which provider again? ${randomUUID().slice(0, 8)}`;
  const [row] = await make(title, false);

  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await ask.getByLabel(/B . Paid tier/).check();
  await ask.getByRole('button', { name: 'Answer' }).click();

  const settled = page.getByTestId('settled').filter({ hasText: title });
  const offer = settled.getByTestId('standing-offer');
  await expect(offer).toContainText('3 times');
  await offer.getByRole('button', { name: 'Make it standing' }).click();
  await expect(settled.getByTestId('standing-saved')).toBeVisible();

  const [sd] = await db
    .select()
    .from(standingDecision)
    .where(eq(standingDecision.createdFromInteractionId, row!.id));
  expect(sd).toMatchObject({ scope: 'repository', topic, active: true });
});
test('a reviewer sees why a review needs them and approves it', async ({ page }) => {
  const f = await createRunFixture(db);
  const title = `Review PR ${randomUUID().slice(0, 8)}`;
  await db.insert(interaction).values({
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'review',
    checkpointId: 'G3',
    title,
    contextCard: {
      kind: 'pull_request',
      summary: 'A small change.',
      verify: { passed: true },
      triggers: [{ id: 'new-dependency', description: 'A new dependency' }],
    },
    blocks: [],
    roleNeeded: 'platform_admin',
  });
  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();
  await expect(ask.getByText('A new dependency')).toBeVisible();
  // The admin did not start this run, so approving works.
  await ask.getByRole('button', { name: 'Approve' }).click();
  await expect(
    page.getByTestId('settled').filter({ hasText: title }).getByTestId('answered'),
  ).toContainText('Approved');
});

test('a review shows the preview the repository reported, and warns when it is out of date', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Review PR ${randomUUID().slice(0, 8)}`;
  await db.insert(interaction).values({
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'review',
    checkpointId: 'G3',
    title,
    contextCard: {
      kind: 'pull_request',
      summary: 'A small change.',
      verify: { passed: true },
      prUrl: 'https://github.com/o/r/pull/9',
      prNumber: 9,
    },
    blocks: [],
    roleNeeded: 'platform_admin',
  });
  // GitHub is not reachable from the demo, so the preview answer is supplied here.
  let answer = {
    state: 'stale',
    url: 'https://pr-9.preview.example.test/',
    label: 'preview/pr-9',
    source: 'deployment',
    sha: 'bbbbbbb2222222',
    headSha: 'aaaaaaa1111111',
    detail: 'This preview was built from bbbbbbb. The pull request is now at aaaaaaa.',
    platform: {
      available: false,
      id: null,
      state: 'none',
      expiresAt: null,
      detail: null,
      ttlMinutes: 30,
    },
  };
  await page.route('**/api/interactions/*/preview', (route) => route.fulfill({ json: answer }));
  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-queue').click();
  const preview = card(page, title).getByTestId('preview');
  await expect(preview).toHaveAttribute('data-state', 'stale');
  await expect(preview).toContainText('out of date');
  await expect(preview.getByRole('link', { name: 'preview/pr-9' })).toHaveAttribute(
    'href',
    'https://pr-9.preview.example.test/',
  );
  answer = { ...answer, state: 'ready', sha: 'aaaaaaa1111111', detail: 'Built from aaaaaaa.' };
  await page.reload();
  await page.getByTestId('nav-queue').click();
  await expect(card(page, title).getByTestId('preview')).toHaveAttribute('data-state', 'ready');
});

test('opening an admin page without being signed in sends you to sign in, and back to the page', async ({
  page,
}) => {
  await page.goto('/admin/github');
  // The identity provider's page, not an error.
  await page.getByRole('button', { name: /Dev Admin/ }).click();
  await expect(page).toHaveURL(/\/admin\/github$/);
  await expect(page.getByRole('heading', { name: /GitHub/i }).first()).toBeVisible();
});

test('a reviewer can run the pull request in a sandbox from the review, and stop it', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Review PR ${randomUUID().slice(0, 8)}`;
  const [review] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title,
      contextCard: {
        kind: 'pull_request',
        summary: 'A small change.',
        verify: { passed: true },
        prUrl: 'https://github.com/o/r/pull/12',
        prNumber: 12,
      },
      blocks: [],
      roleNeeded: 'platform_admin',
    })
    .returning();
  const base = {
    state: 'none',
    url: null,
    label: null,
    source: null,
    sha: null,
    headSha: 'aaaaaaa1111111',
    detail: 'The repository has not reported a preview for this pull request.',
  };
  const platform = (state: string, extra: Record<string, unknown> = {}) => ({
    available: true,
    id: 'p-1',
    state,
    expiresAt: null,
    detail: null,
    ttlMinutes: 30,
    ...extra,
  });
  let answer: Record<string, unknown> = { ...base, platform: platform('none', { id: null }) };
  const calls: string[] = [];
  await page.route('**/api/interactions/*/preview', (route) => route.fulfill({ json: answer }));
  await page.route('**/api/interactions/*/preview/start', (route) => {
    calls.push(`start ${route.request().url().split('/').slice(-3, -2)[0]}`);
    answer = { ...base, state: 'building', source: 'platform', platform: platform('starting') };
    return route.fulfill({ status: 202, json: { id: 'p-1', state: 'starting' } });
  });
  await page.route('**/api/previews/*/stop', (route) => {
    calls.push('stop');
    answer = { ...base, platform: platform('stopped') };
    return route.fulfill({ json: { id: 'p-1', state: 'stopped' } });
  });

  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-queue').click();
  const line = card(page, title).getByTestId('preview');
  await expect(line.getByTestId('platform-preview')).toContainText('sandbox for 30 minutes');
  await line.getByRole('button', { name: 'Run it here' }).click();
  await expect(line.getByRole('button', { name: 'Stop the preview' })).toBeVisible();
  expect(calls[0]).toBe(`start ${review!.id}`);

  answer = {
    ...base,
    state: 'ready',
    url: 'http://127.0.0.1:9100/',
    label: 'Run by the platform',
    source: 'platform',
    sha: 'aaaaaaa1111111',
    detail:
      'Run by the platform in a sandbox from aaaaaaa, the current commit. It stops by itself.',
    platform: platform('ready', { expiresAt: new Date(Date.now() + 25 * 60_000).toISOString() }),
  };
  await page.reload();
  await page.getByTestId('nav-queue').click();
  const ready = card(page, title).getByTestId('preview');
  await expect(ready).toHaveAttribute('data-state', 'ready');
  await expect(ready.getByRole('link', { name: 'Run by the platform' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:9100/',
  );
  await expect(ready).toContainText('The platform stops it at');
  await ready.getByRole('button', { name: 'Stop the preview' }).click();
  await expect(ready.getByRole('button', { name: 'Run it again' })).toBeVisible();
  expect(calls).toContain('stop');

  answer = {
    ...base,
    state: 'failed',
    source: 'platform',
    detail: 'The platform could not start the preview.',
    platform: platform('failed', {
      detail: 'the preview stopped before it answered. Its output ended: boom',
    }),
  };
  await page.reload();
  await page.getByTestId('nav-queue').click();
  await expect(card(page, title).getByTestId('platform-preview-error')).toContainText(
    'Its output ended: boom',
  );
});

test('an approved design waits for a person to start the build, then its first task starts', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const [design] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      state: 'answered',
      title: `Review PR #88: design ${randomUUID().slice(0, 6)}`,
      roleNeeded: 'architect',
      contextCard: { kind: 'pull_request', prNumber: 88 },
    })
    .returning();
  const [plan] = await db
    .insert(buildPlan)
    .values({
      initiativeId: f.initiativeId,
      designInteractionId: design!.id,
      designPath: 'docs/design/thing.md',
      designSha: 'abc123',
      state: 'awaiting_start',
      detail: 'The design is approved. A person starts the build.',
      startedBy: f.personId,
    })
    .returning();
  await db.insert(buildTask).values([
    {
      planId: plan!.id,
      key: 'T1',
      position: 0,
      title: 'Add the route',
      role: 'backend_engineer',
      stories: ['US-1'],
      paths: ['src/server.js'],
      doneWhen: ['it answers'],
    },
    {
      planId: plan!.id,
      key: 'T2',
      position: 1,
      title: 'Document it',
      role: 'backend_engineer',
      dependsOn: ['T1'],
      paths: ['README.md'],
      doneWhen: ['it is written'],
    },
  ]);

  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  const panel = page.getByTestId('build-plan');
  await expect(panel).toHaveAttribute('data-state', 'awaiting_start');
  await expect(page.getByTestId('stage-build')).toHaveAttribute('data-status', 'waiting_human');
  await expect(panel.getByTestId('task-T2')).toContainText('after T1');
  await page.getByTestId('stage-build').getByRole('button', { name: 'Start the build' }).click();
  await expect(page.getByTestId('note')).toContainText('The build has started');
  // The build worker queues the first task. The second waits for it to merge.
  await expect(panel.getByTestId('task-T1')).toHaveAttribute('data-state', 'running', {
    timeout: 20_000,
  });
  await expect(panel.getByTestId('task-T2')).toHaveAttribute('data-state', 'waiting');
});

test('a step before the build waits for a person to start it', async ({ page }) => {
  const f = await createRunFixture(db);
  await db.insert(stageStart).values({
    initiativeId: f.initiativeId,
    key: 'spec',
    stage: 'spec',
    role: 'product',
    task: 'Draft the spec: Weather\n\nGoal: show the forecast',
    state: 'awaiting_start',
    detail: 'A person starts the spec.',
    startedBy: f.personId,
  });
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  const spec = page.getByTestId('stage-spec');
  await expect(spec).toHaveAttribute('data-status', 'waiting_human');
  await expect(spec).toContainText('A person starts the spec.');
  await spec.getByRole('button', { name: 'Start the spec' }).click();
  await expect(page.getByTestId('note')).toContainText('is starting');
  // The worker starts the run, and the button leaves the stage.
  await expect(spec.getByRole('button', { name: 'Start the spec' })).toHaveCount(0, {
    timeout: 20_000,
  });
});

test('a failed spec run is run again from the stage itself', async ({ page }) => {
  const f = await createRunFixture(db);
  await db.insert(agentRun).values({
    initiativeId: f.initiativeId,
    agentRole: 'product',
    task: 'Draft the spec: Retry me',
    agentDefinitionId: 'product-agent',
    agentDefinitionVersion: 1,
    engine: 'claude-code',
    modelAlias: 'agent-default',
    state: 'failed',
    sponsorPersonId: f.personId,
    repositoryId: f.repositoryId,
    budgetMicros: 1_000_000,
  });
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  const spec = page.getByTestId('stage-spec');
  await expect(spec).toContainText('product run: failed');
  // There is no separate "Start a run" card to hunt for: the button is on the stage.
  await spec.getByRole('button', { name: 'Run the spec again' }).click();
  await expect(page.getByTestId('note')).toContainText('Running it again');
  await expect(spec.getByRole('button', { name: 'Run the spec again' })).toHaveCount(0, {
    timeout: 20_000,
  });
  const runs = await db.select().from(agentRun).where(eq(agentRun.initiativeId, f.initiativeId));
  expect(runs.filter((r) => r.agentRole === 'product')).toHaveLength(2);
});
test('the menu shows how many asks wait on the person, in red when one is a hard stop', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  await signInAs(page, /Bob Lindqvist/);
  const badge = page.getByTestId('queue-badge');
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const count = async () => ((await badge.count()) ? Number(await badge.innerText()) : 0);
  await refresh();
  await page.waitForTimeout(800);
  const before = await count();

  const [ask] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'decision',
      title: `Badge ${randomUUID().slice(0, 8)}`,
      contextCard: { context: 'c', whyNow: 'w' },
      options: [{ id: 'A', label: 'Yes', impact: '' }],
      hardStop: true,
      blocks: [{ runId: f.runId }],
      roleNeeded: 'backend_engineer',
    })
    .returning();
  await refresh();
  await expect(badge).toHaveText(String(before + 1));
  await expect(badge).toHaveAttribute('data-urgent', 'true');
  await expect(badge).toHaveAccessibleName(/waiting on you, including a hard stop/);
  await expect(page).toHaveTitle(`(${before + 1}) Autonomous SDLC`);

  await db.update(interaction).set({ state: 'answered' }).where(eq(interaction.id, ask!.id));
  await refresh();
  if (before === 0) await expect(badge).toHaveCount(0);
  else await expect(badge).toHaveText(String(before));
});
test('a review shows the assumptions behind it, and approving does not decide them', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Review with assumptions ${randomUUID().slice(0, 6)}`;
  await db.insert(interaction).values({
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'checkpoint',
    checkpointId: 'G1',
    title,
    contextCard: { summary: 'A spec.' },
    options: [{ id: 'A', label: 'Yes', impact: '' }],
    blocks: [{ runId: f.runId }],
    roleNeeded: 'backend_engineer',
  });
  const mk = (text: string) =>
    db.insert(assumption).values({ initiativeId: f.initiativeId, runId: f.runId, text });
  await mk('Money is stored in cents');
  await mk('Sign-in is by email');
  // An assumption from another run does not belong on this review.
  const other = await createRunFixture(db);
  await db
    .insert(assumption)
    .values({ initiativeId: other.initiativeId, runId: other.runId, text: 'Unrelated call' });

  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();
  const block = ask.getByTestId('review-assumptions');
  await expect(block).toContainText('2 undecided');
  await expect(block).toContainText('Money is stored in cents');
  await expect(block).not.toContainText('Unrelated call');
  await expect(ask.getByTestId('undecided-note')).toContainText('2 assumptions');
  await expect(ask.getByTestId('undecided-note')).toContainText('Approving does not accept them');

  await block
    .getByTestId('review-assumption')
    .filter({ hasText: 'Money is stored in cents' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect(ask.getByTestId('undecided-note')).toContainText('1 assumption ');
  await expect(block).not.toContainText('Money is stored in cents');
  // The note never blocks: Approve is still there.
  await expect(ask.getByRole('button', { name: 'Approve' })).toBeEnabled();
  const [row] = await db
    .select()
    .from(assumption)
    .where(eq(assumption.text, 'Money is stored in cents'));
  expect(row!.state).toBe('accepted');
});
test('the Map opens on an initiative in progress, and goes back to the one last looked at', async ({
  page,
}) => {
  const a = await createRunFixture(db);
  const b = await createRunFixture(db);
  await db.update(initiative).set({ state: 'active' }).where(eq(initiative.id, a.initiativeId));
  await db.update(initiative).set({ state: 'active' }).where(eq(initiative.id, b.initiativeId));
  await signInAs(page, /Alice Park/);

  // Nothing chosen yet: the Map picks an initiative that is in progress, with no clicking.
  await page.getByTestId('nav-map').click();
  await expect(page).toHaveURL(/#\/map\/[0-9a-f-]{36}$/);
  const first = page.url().split('/').pop()!;
  const [opened] = await db.select().from(initiative).where(eq(initiative.id, first));
  expect(opened!.state).toBe('active');
  await expect(page.getByTestId('stage-spec')).toBeVisible();

  // Choose another one, leave, and come back: the Map reopens on that one.
  const other = first === a.initiativeId ? b.initiativeId : a.initiativeId;
  await page.getByLabel('Initiative', { exact: true }).selectOption(other);
  await expect(page).toHaveURL(new RegExp(`#/map/${other}$`));
  await page.getByTestId('nav-queue').click();
  await page.getByTestId('nav-map').click();
  await expect(page).toHaveURL(new RegExp(`#/map/${other}$`));
});
const prCard = {
  kind: 'pull_request',
  prUrl: 'https://github.com/acme/shop/pull/3',
  prNumber: 3,
  repository: 'acme/shop',
  headSha: 'abc123',
  summary: 'A change.',
  verify: { ok: true },
};

async function reviewOf(f: { initiativeId: string; runId: string }, title: string) {
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title,
      contextCard: prCard,
      options: [{ id: 'A', label: 'Yes', impact: '' }],
      blocks: [{ runId: f.runId }],
      roleNeeded: 'backend_engineer',
    })
    .returning();
  return row!;
}

test('Approve is disabled until the required check has run, and the check is marked and one click away', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Review needing a security review ${randomUUID().slice(0, 6)}`;
  const review = await reviewOf(f, title);
  let ran = false;
  const security = () => ({
    available: true,
    required: true,
    commit: 'abc123',
    run: ran
      ? {
          id: 'r1',
          state: 'done',
          summary: 'Nothing found.',
          findings: [],
          detail: null,
          by: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }
      : null,
    blocks: ran
      ? null
      : 'This change has not had a security review on this commit. Run the security review first.',
  });
  await page.route(`**/api/interactions/${review.id}/security`, (route) =>
    route.fulfill({ json: security() }),
  );
  await page.route(`**/api/interactions/${review.id}/security/start`, (route) => {
    ran = true;
    return route.fulfill({ json: { id: 'r1', state: 'running' } });
  });
  await page.route(`**/api/interactions/${review.id}/smoke`, (route) =>
    route.fulfill({
      json: {
        available: false,
        required: 'none',
        detail: null,
        commit: 'abc123',
        run: null,
        blocks: null,
      },
    }),
  );

  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();

  const approve = ask.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeDisabled();
  await expect(ask.getByRole('button', { name: 'Request changes' })).toBeEnabled();
  await expect(ask.getByRole('button', { name: 'Reject' })).toBeEnabled();
  await expect(ask.getByTestId('approve-blocked')).toContainText('Approve is waiting on');
  await expect(ask.getByTestId('blocker-security')).toContainText('Run the security review first');

  const panel = ask.getByTestId('security');
  await expect(panel).toHaveAttribute('data-required', 'true');
  await expect(panel.getByTestId('required-chip')).toContainText('Required before you can approve');

  await ask.getByRole('button', { name: 'Go to it' }).click();
  await expect(panel.getByRole('button', { name: 'Run the security review' })).toBeFocused();
  await panel.getByRole('button', { name: 'Run the security review' }).click();

  // The reason goes away by itself, and Approve comes on.
  await expect(approve).toBeEnabled({ timeout: 15_000 });
  await expect(ask.getByTestId('approve-blocked')).toHaveCount(0);
  await expect(panel).toHaveAttribute('data-required', 'false');
});

test('a failed smoke test can be explained, and the reading sent to the engineer in one click', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Review with a failed smoke test ${randomUUID().slice(0, 6)}`;
  const review = await reviewOf(f, title);
  let diagnosis: Record<string, unknown> | null = null;
  const smoke = () => ({
    available: true,
    required: 'required',
    detail: null,
    commit: 'abc123',
    run: {
      id: 's1',
      state: 'failed',
      results: [
        { kind: 'get', label: 'GET /health', ok: true, detail: '200', ms: 5 },
        {
          kind: 'get',
          label: 'GET /api/accounts',
          ok: false,
          detail: 'expected 200, got 401',
          ms: 5,
        },
      ],
      detail: null,
      diagnosis,
      by: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
    blocks: 'The smoke test failed on this commit. Run it again, or override it with a reason.',
  });
  await page.route(`**/api/interactions/${review.id}/smoke`, (route) =>
    route.fulfill({ json: smoke() }),
  );
  await page.route(`**/api/interactions/${review.id}/smoke/diagnose`, (route) => {
    diagnosis = {
      verdict: 'checks',
      summary: 'GET /api/accounts now needs a login, so the old check gets 401.',
      recommendation: 'Update the smoke checks.',
      instruction: 'Edit .sdlc/preview.yaml.',
      at: new Date().toISOString(),
    };
    return route.fulfill({ json: diagnosis });
  });
  let sent = 0;
  await page.route(`**/api/interactions/${review.id}/smoke/send-back`, (route) => {
    sent++;
    return route.fulfill({ status: 201, json: { sent: 1 } });
  });
  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();

  await expect(ask.getByTestId('smoke-diagnosis')).toHaveCount(0);
  await ask.getByRole('button', { name: 'Explain why it failed' }).click();
  const reading = ask.getByTestId('smoke-diagnosis');
  await expect(reading).toContainText('AI reading, not verified');
  await expect(reading).toContainText('Likely out-of-date smoke checks');
  await expect(reading).toContainText('now needs a login');
  // The reading does not clear the hold on Approve.
  await expect(ask.getByRole('button', { name: 'Approve' })).toBeDisabled();

  await reading
    .getByRole('button', { name: 'Ask the engineer to update the smoke checks' })
    .click();
  await expect.poll(() => sent).toBe(1);
});

test('a protected-path ask shows the patch, and recommends allowing a file the task asked for', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Protected path changed: .sdlc/preview.yaml ${randomUUID().slice(0, 6)}`;
  await db.insert(interaction).values({
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'decision',
    title,
    hardStop: true,
    contextCard: {
      kind: 'protected_path',
      summary:
        'The change edits protected paths: .sdlc/preview.yaml\n\n-  - get: /api/accounts\n+  - get: /api/accounts\n+    status: 401',
      paths: ['.sdlc/preview.yaml'],
      whyNow: 'The task asks for a change to this file, so this edit is what was wanted.',
    },
    options: [
      { id: 'allow', label: 'Allow this change to the protected path' },
      { id: 'discard', label: 'Discard the edits to protected paths' },
    ],
    recommendation: 'allow',
    blocks: [{ runId: f.runId }],
    roleNeeded: 'platform_admin',
  });
  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('protected-patch')).toContainText('+    status: 401');
  await expect(ask).toContainText('this edit is what was wanted');
  await expect(ask.getByRole('radio', { name: /allow/ })).toBeChecked();
  await expect(ask.getByText('recommended')).toBeVisible();
});

test('a spec review has no preview to start, and says why', async ({ page }) => {
  const f = await createRunFixture(db);
  const title = `Review PR: Draft the spec ${randomUUID().slice(0, 6)}`;
  await db.insert(interaction).values({
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'review',
    checkpointId: 'G1',
    title,
    contextCard: { ...prCard, diff: { changedPaths: ['docs/spec/thing.md'] } },
    blocks: [{ runId: f.runId }],
    roleNeeded: 'backend_engineer',
  });
  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();
  const preview = ask.getByTestId('preview');
  await expect(preview).toContainText('Nothing to run: this change only touches documents.');
  await expect(preview.getByRole('button')).toHaveCount(0);
});

test('an initiative has a type: set on the Map, shown and filtered in the Portfolio', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  await db.update(initiative).set({ kind: null }).where(eq(initiative.id, f.initiativeId));
  await signInAs(page, /Dev Admin/);
  await page.goto(`/#/map/${f.initiativeId}`);
  const type = page.getByLabel('Type of initiative');
  await expect(type).toHaveValue('');
  await type.selectOption('feature');
  await expect(page.getByTestId('note')).toContainText('The type is saved');
  await expect(type).toHaveValue('feature');

  await page.getByTestId('nav-portfolio').click();
  const row = page.getByTestId(`row-${f.initiativeId}`);
  await expect(row.getByTestId('kind-chip')).toHaveText('Feature');
  await page.getByTestId('kind-filter').getByRole('combobox').selectOption('new_app');
  await expect(row).toHaveCount(0);
  await page.getByTestId('kind-filter').getByRole('combobox').selectOption('feature');
  await expect(row).toBeVisible();
});

test('the new initiative form suggests a type from the repository, and the person can change it', async ({
  page,
}) => {
  await signInAs(page, /Dev Admin/);
  await page.goto('/#/map/new');
  const type = page.getByLabel('Type', { exact: true });
  await expect(type).toBeVisible();
  // Whatever it suggests is one of the three, and choosing another sticks.
  await type.selectOption('change');
  await expect(type).toHaveValue('change');
  await expect(page.getByText('Changes or fixes behaviour that already exists')).toBeVisible();
});

test('a person who started the run is told up front that they may not decide it', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `Review of my own run ${randomUUID().slice(0, 6)}`;
  await reviewOf(f, title);
  await signInAs(page, /Bob Lindqvist/);
  const [bob] = await db.select().from(person).where(eq(person.displayName, 'Bob Lindqvist'));
  await db.update(agentRun).set({ sponsorPersonId: bob!.id }).where(eq(agentRun.id, f.runId));

  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('approve-blocked')).toContainText('You cannot decide this one');
  await expect(ask.getByTestId('blocker-own')).toContainText('someone else must review it');
  for (const name of ['Approve', 'Request changes', 'Reject'])
    await expect(ask.getByRole('button', { name })).toBeDisabled();
  // Nothing on the page can clear it, so there is no link to a check.
  await expect(ask.getByRole('button', { name: 'Go to it' })).toHaveCount(0);
});
test('a failed build task is named on the build stage, with Retry and Skip right there', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const [design] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      state: 'answered',
      title: `Review PR #90: design ${randomUUID().slice(0, 6)}`,
      roleNeeded: 'architect',
      contextCard: { kind: 'pull_request', prNumber: 90 },
    })
    .returning();
  const [plan] = await db
    .insert(buildPlan)
    .values({
      initiativeId: f.initiativeId,
      designInteractionId: design!.id,
      designPath: 'docs/design/failing.md',
      designSha: 'abc123',
      state: 'active',
      detail: 'Building.',
      startedBy: f.personId,
    })
    .returning();
  await db.insert(buildTask).values({
    planId: plan!.id,
    key: 'T1',
    position: 0,
    title: 'Add the route',
    role: 'backend_engineer',
    paths: ['src/server.js'],
    doneWhen: ['it answers'],
    state: 'failed',
    detail: 'The checks did not pass after three tries.',
  });
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  const build = page.getByTestId('stage-build');
  await expect(build).toContainText('T1 failed: The checks did not pass after three tries.');
  await expect(build.getByRole('button', { name: 'Skip T1' })).toBeVisible();
  await build.getByRole('button', { name: 'Retry T1' }).click();
  await expect(page.getByTestId('note')).toContainText('T1 will run again');
});
test('the build box offers a preview of the built app once something has merged, and links to it when it runs', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const [design] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      state: 'answered',
      title: `Review PR #92: design ${randomUUID().slice(0, 6)}`,
      roleNeeded: 'architect',
      contextCard: { kind: 'pull_request', prNumber: 92 },
    })
    .returning();
  const [plan] = await db
    .insert(buildPlan)
    .values({
      initiativeId: f.initiativeId,
      designInteractionId: design!.id,
      designPath: 'docs/design/previewable.md',
      designSha: 'abc123',
      state: 'done',
      detail: 'Every task is merged or skipped.',
      startedBy: f.personId,
    })
    .returning();
  await db.insert(buildTask).values({
    planId: plan!.id,
    key: 'T1',
    position: 0,
    title: 'Add the route',
    role: 'backend_engineer',
    paths: ['src/server.js'],
    doneWhen: ['it answers'],
    state: 'merged',
  });
  let state: 'none' | 'starting' | 'ready' = 'none';
  const dto = () => ({
    available: true,
    id: state === 'none' ? null : 'p1',
    state,
    url: state === 'ready' ? 'https://preview.example.test/p1/' : null,
    sha: state === 'none' ? null : 'abc123',
    expiresAt: null,
    detail: null,
    ttlMinutes: 30,
  });
  await page.route(`**/api/initiatives/${f.initiativeId}/preview`, (route) =>
    route.fulfill({ json: dto() }),
  );
  await page.route(`**/api/initiatives/${f.initiativeId}/preview/start`, (route) => {
    state = 'starting';
    setTimeout(() => (state = 'ready'), 1500);
    return route.fulfill({ status: 202, json: { id: 'p1', state: 'starting' } });
  });
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  const build = page.getByTestId('stage-build');
  await build.getByRole('button', { name: 'Preview the built app' }).click();
  await expect(page.getByTestId('note')).toContainText('Starting the built app');
  const open = build.getByRole('link', { name: 'Open the built app' });
  await expect(open).toHaveAttribute('href', 'https://preview.example.test/p1/', {
    timeout: 15_000,
  });
  await expect(build.getByRole('button', { name: 'Stop the preview' })).toBeVisible();
});
test('a task that failed twice asks a person why it failed and takes their words for the next attempt', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const title = `T1 did not work after 2 attempts: Add the route ${randomUUID().slice(0, 6)}`;
  const [ask] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: null,
      type: 'decision',
      title,
      hardStop: true,
      contextCard: {
        kind: 'task_failed',
        task: 'T1',
        attempts: 2,
        failures: [
          {
            attempt: 1,
            why: 'The run ended as failed (error). npm install could not reach the registry.',
          },
          { attempt: 2, why: 'The run ended as failed (error). The same install failed again.' },
        ],
      },
      options: [
        { id: 'retry', label: 'Try again' },
        { id: 'skip', label: 'Skip it' },
      ],
      recommendation: 'retry',
      blocks: [],
      roleNeeded: 'platform_admin',
    })
    .returning();
  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-queue').click();
  const card1 = card(page, title);
  await expect(card1).toContainText(
    'Attempt 1: The run ended as failed (error). npm install could not',
  );
  await expect(card1).toContainText('Attempt 2:');
  await card1.getByLabel('Guidance for the next attempt').fill('Use the built-in http module.');
  await card1.getByRole('button', { name: 'Answer' }).click();
  await expect(
    page.getByTestId('settled').filter({ hasText: title }).getByTestId('answered'),
  ).toBeVisible();
  const [saved] = await db.select().from(interaction).where(eq(interaction.id, ask!.id));
  expect(saved!.answer).toMatchObject({ choice: 'retry', text: 'Use the built-in http module.' });
});
test('a running build task says when its agent last reported, and flags one that went quiet', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const [design] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      state: 'answered',
      title: `Review PR #91: design ${randomUUID().slice(0, 6)}`,
      roleNeeded: 'architect',
      contextCard: { kind: 'pull_request', prNumber: 91 },
    })
    .returning();
  const [plan] = await db
    .insert(buildPlan)
    .values({
      initiativeId: f.initiativeId,
      designInteractionId: design!.id,
      designPath: 'docs/design/quiet.md',
      designSha: 'abc123',
      state: 'active',
      detail: 'Building.',
      startedBy: f.personId,
    })
    .returning();
  await db.insert(buildTask).values({
    planId: plan!.id,
    key: 'T1',
    position: 0,
    title: 'Add the route',
    role: 'backend_engineer',
    paths: ['src/server.js'],
    doneWhen: ['it answers'],
    state: 'running',
    runId: f.runId,
  });
  // The run was last heard from 6 minutes ago: quiet, not yet old enough for the platform to close it.
  await db
    .update(agentRun)
    .set({ updatedAt: new Date(Date.now() - 6 * 60_000) })
    .where(eq(agentRun.id, f.runId));
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  const note = page.getByTestId('activity-T1');
  await expect(note).toContainText('Quiet for 6 minutes');
  await expect(note).toHaveAttribute('data-tone', 'quiet');

  // An event from the agent, and it is working again.
  await db.insert(runEvent).values({ runId: f.runId, seq: 1, type: 'message', payload: {} });
  await expect(note).toContainText('Working. Last heard from the agent', { timeout: 15_000 });
  await expect(note).toHaveAttribute('data-tone', 'ok');
});
test('a person reports a bug, an engineer starts the fix, and the report follows it', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  // Guided, so the fix waits for a click.
  await db
    .update(initiative)
    .set({ autonomyMode: 'guided', autoStages: true })
    .where(eq(initiative.id, f.initiativeId));
  const title = `Total is wrong ${randomUUID().slice(0, 6)}`;
  const [init] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));

  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-bugs').click();
  const form = page.getByTestId('bug-form');
  await form.getByLabel('Initiative').selectOption(init!.id);
  await form.getByLabel('Title').fill(title);
  await form
    .getByLabel('What happens, and what should happen')
    .fill('The total adds tax twice. It should add it once.');
  await form.getByLabel('Severity').selectOption('high');
  await form.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByTestId('note')).toContainText('The report is recorded');

  const bug = page.getByTestId('bug').filter({ hasText: title });
  await expect(bug).toHaveAttribute('data-state', 'open');
  await expect(bug).toContainText('High');
  await bug.getByRole('button', { name: 'Start the fix' }).click();
  await expect(page.getByTestId('note')).toContainText('The fix is starting');
  // The worker starts the run, and the report moves on.
  await expect(bug).toHaveAttribute('data-state', 'fixing', { timeout: 20_000 });
  await expect(bug).toContainText('The agent is working on it');
});

test('the cost page shows where the money went, and an admin is warned near the monthly budget', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const [init] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));
  await db.insert(costRecord).values([
    {
      runId: f.runId,
      initiativeId: f.initiativeId,
      source: 'agent',
      alias: 'agent-default',
      providerModel: 'anthropic/claude-sonnet-4.6',
      inputTokens: 100,
      cachedTokens: 300,
      outputTokens: 50,
      costMicros: 900_000,
    },
  ]);

  await signInAs(page, /Dev Admin/);
  // Against a one-dollar budget, 90 cents is a warning (or more, if other tests spent too).
  await expect(page.getByTestId('budget-banner')).toHaveAttribute('data-level', /warning|exceeded/);
  await page.getByTestId('nav-costs').click();
  await page.getByLabel('Initiative').selectOption(init!.id);
  await expect(page.getByTestId('monthly')).toHaveAttribute('data-level', /warning|exceeded/);
  await expect(page.getByTestId('totals')).toContainText('$0.900');
  await expect(page.getByTestId('totals')).toContainText('75%');
  await expect(page.getByTestId('by-model')).toContainText('anthropic/claude-sonnet-4.6');
  await expect(page.getByTestId('by-role')).toContainText('backend_engineer');
  await expect(
    page.getByTestId('by-initiative').getByRole('link', { name: init!.title }),
  ).toBeVisible();
  await expect(page.getByTestId('by-day').locator('.bar')).toHaveCount(1);
});

test('the portfolio lists every initiative and the releases that went out', async ({ page }) => {
  const f = await createRunFixture(db);
  const [init] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));
  await db.insert(activityEvent).values({
    actorType: 'system',
    initiativeId: f.initiativeId,
    action: 'release.published',
    detail: { version: '9.9.9', tag: 'v9.9.9', url: 'https://example.test/release' },
  });

  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-portfolio').click();
  const row = page.getByTestId(`row-${f.initiativeId}`);
  await expect(row).toContainText(init!.title);
  await expect(row).toContainText('9.9.9');
  await expect(page.getByTestId('releases')).toContainText('9.9.9');
  await expect(
    page.getByTestId('releases').getByRole('link', { name: 'release notes' }).first(),
  ).toHaveAttribute('href', /example\.test\/release/);
  await row.getByRole('link', { name: init!.title }).click();
  await expect(page).toHaveURL(new RegExp(`#/map/${f.initiativeId}`));
});

test('assumptions are accepted or rejected, and a rejection asks the sponsor what to redo', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const text = `Invite links expire after ${randomUUID().slice(0, 4)} days`;
  const [a] = await db
    .insert(assumption)
    .values({ initiativeId: f.initiativeId, runId: f.runId, text, impact: 'low' })
    .returning();

  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-assumptions').click();
  const rowFor = page.getByTestId('assumptions').getByRole('row').filter({ hasText: text });
  await expect(rowFor).toBeVisible();
  await rowFor.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByTestId('result')).toContainText('rejected');
  await expect(rowFor).toHaveCount(0);

  const [after] = await db.select().from(assumption).where(eq(assumption.id, a!.id));
  expect(after!.state).toBe('rejected');
  const asks = await db
    .select()
    .from(interaction)
    .where(eq(interaction.initiativeId, f.initiativeId));
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ assignedPersonId: f.personId, state: 'open' });
});

test('the interruption page shows the month, and suggests but never applies', async ({ page }) => {
  await signInAs(page, /Cara Okafor/);
  await page.getByTestId('nav-interruptions').click();
  await expect(page.getByRole('heading', { name: 'Interruptions' })).toBeVisible();
  await expect(page.getByTestId('per-pr')).not.toHaveText('n/a');
  await expect(page.getByTestId('unchanged')).toContainText('%');

  const situations = page.getByTestId('situations');
  const dateLib = situations.getByRole('row').filter({ hasText: 'date-library' });
  await expect(dateLib).toContainText('Covered by a standing decision');
  const copy = situations.getByRole('row').filter({ hasText: 'copy' });
  await expect(copy).toContainText('didn’t need to ask');
  await expect(page.getByText('Suggestions only. Nothing is applied for you.')).toBeVisible();

  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a hard stop cannot be snoozed', async ({ page }) => {
  const f = await createRunFixture(db);
  const title = `Protected path ${randomUUID().slice(0, 8)}`;
  await db.insert(interaction).values({
    initiativeId: f.initiativeId,
    runId: f.runId,
    type: 'decision',
    title,
    contextCard: { kind: 'protected_path' },
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'discard', label: 'Discard' },
    ],
    recommendation: 'discard',
    hardStop: true,
    blocks: [{ runId: f.runId }],
    roleNeeded: 'backend_engineer',
  });
  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask.getByText('Hard stop')).toBeVisible();
  await expect(ask.getByRole('button', { name: /Snooze/ })).toHaveCount(0);
  await expect(ask.getByText(/If nobody answers/)).toHaveCount(0);
});

test('the autopilot page shows what merged by rule and what was held, and changes the mode', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const tag = randomUUID().slice(0, 8);
  const card = (n: number, auto: boolean, reason: string) => ({
    kind: 'pull_request',
    prNumber: n,
    prUrl: `https://example.test/pull/${n}`,
    autoMerge: { mode: 'balanced', auto, reason, rule: auto ? 'docs-only' : null },
    gate: auto ? { state: 'merged' } : undefined,
  });
  await db.insert(interaction).values([
    {
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: `Review PR #901: docs ${tag}`,
      roleNeeded: 'product_owner',
      state: 'answered',
      answeredVia: 'auto',
      answer: { decision: 'approved', source: 'policy', rule: 'docs-only' },
      contextCard: card(901, true, `It fits docs-only ${tag}.`),
    },
    {
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G3',
      title: `Review PR #902: code ${tag}`,
      roleNeeded: 'product_owner',
      contextCard: card(902, false, `A trigger fired ${tag}.`),
    },
  ]);

  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-autopilot').click();
  const recent = page.getByTestId('recent');
  const merged = recent.getByRole('row').filter({ hasText: `docs ${tag}` });
  await expect(merged).toContainText('Approved by rule');
  await expect(merged).toContainText(`It fits docs-only ${tag}.`);
  await expect(merged).toContainText('merged');
  const held = recent.getByRole('row').filter({ hasText: `code ${tag}` });
  await expect(held).toContainText('Held for a person');
  await expect(held).toContainText(`A trigger fired ${tag}.`);
  await expect(page.getByTestId('rules')).toContainText('docs-only');

  // Alice is a Product Owner, so she may change how the initiative runs.
  const select = page.getByLabel(/Autonomy mode for Initiative/).first();
  await expect(select).toBeVisible();
  const initTitle = (
    await db.select().from(initiative).where(eq(initiative.id, f.initiativeId))
  )[0]!.title;
  const mine = page.getByLabel(`Autonomy mode for ${initTitle}`);
  await mine.selectOption('guided');
  await expect
    .poll(
      async () =>
        (await db.select().from(initiative).where(eq(initiative.id, f.initiativeId)))[0]!
          .autonomyMode,
    )
    .toBe('guided');
});

test('an architect adds an external system, sees it confirmed, and retires it', async ({
  page,
}) => {
  const name = `Weather ${randomUUID().slice(0, 6)}`;
  const host = `api-${randomUUID().slice(0, 6)}.weather.example.com`;
  await signInAs(page, /Cara Okafor/);
  await page.getByTestId('nav-integrations').click();
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Hosts').fill(`*.${host}`);
  await page.getByRole('button', { name: 'Add and confirm' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Hosts').fill(host);
  await page.getByRole('button', { name: 'Add and confirm' }).click();
  const row = page.getByTestId('integrations').getByRole('row').filter({ hasText: name });
  await expect(row).toContainText(host);
  await expect(row).toContainText('Confirmed');

  await row.getByRole('button', { name: 'Retire' }).click();
  await expect(row).toContainText('Retired');
});

test('the map shows each stage, who it waits on, and links to the ask', async ({ page }) => {
  const f = await createRunFixture(db);
  const title = `Review PR #77: spec ${randomUUID().slice(0, 6)}`;
  const [g1] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'review',
      checkpointId: 'G1',
      title,
      roleNeeded: 'product_owner',
      contextCard: { kind: 'pull_request', prNumber: 77 },
    })
    .returning();
  const init = (await db.select().from(initiative).where(eq(initiative.id, f.initiativeId)))[0]!;

  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  await expect(page.getByTestId('flow')).toBeVisible();
  await expect(page.locator('p b', { hasText: init.title })).toBeVisible();
  const spec = page.getByTestId('stage-spec');
  await expect(spec).toHaveAttribute('data-status', 'waiting_human');
  await expect(spec).toContainText('Waiting on Product Owner');
  await expect(page.getByTestId('stage-build')).toHaveAttribute('data-status', 'working');
  await expect(page.getByTestId('stage-release')).toHaveAttribute('data-status', 'not_started');

  // The product owner may prepare a release. There is nothing merged yet, so the platform says why not.
  await page.getByLabel('Version').fill('0.1.0');
  await page.getByRole('button', { name: 'Prepare a release' }).click();
  await expect(page.getByRole('alert')).toContainText('Nothing has merged');

  await spec.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`#/queue/${g1!.id}`));
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});

test('an architect is asked for the documentation link of a new system, and gives it', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const name = `Vendor ${randomUUID().slice(0, 8)}`;
  const [entry] = await db
    .insert(integrationEntry)
    .values({
      name,
      hosts: ['api.vendor.example.com'],
      docs: [],
      testStrategy: 'mock',
      status: 'proposed',
      initiativeId: f.initiativeId,
    })
    .returning();
  const title = `New external system: ${name}`;
  const [row] = await db
    .insert(interaction)
    .values({
      initiativeId: f.initiativeId,
      runId: f.runId,
      type: 'decision',
      title,
      contextCard: {
        kind: 'integration_proposal',
        integrationId: entry!.id,
        context: 'The task takes payments.',
        whyNow: 'Agents may reach it only after a person confirms.',
        docs: [],
        docsUnknown: true,
      },
      options: [
        {
          id: 'confirm',
          label: 'Confirm: allow these hosts, with the documentation links I paste',
        },
        { id: 'confirm_no_docs', label: 'Confirm without documentation' },
        { id: 'reject', label: 'Reject' },
      ],
      blocks: [],
      hardStop: true,
      roleNeeded: 'architect',
    })
    .returning();

  await signInAs(page, /Cara/);
  await page.getByTestId('nav-queue').click();
  const ask = card(page, title);
  await expect(ask).toBeVisible();
  await expect(ask.getByText('None yet. The agent had no link it was sure of.')).toBeVisible();

  // No link: the platform refuses and says why.
  await ask.getByLabel(/Confirm: allow these hosts/).check();
  await ask.getByRole('button', { name: 'Answer' }).click();
  await expect(ask.getByText(/no documentation link yet/)).toBeVisible();

  await ask
    .getByRole('textbox', { name: 'Documentation links' })
    .fill('https://127.0.0.1/vendor/api');
  await ask.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByTestId('settled').filter({ hasText: title })).toBeVisible();

  const [after] = await db
    .select()
    .from(integrationEntry)
    .where(eq(integrationEntry.id, entry!.id));
  expect(after).toMatchObject({ status: 'confirmed', docs: ['https://127.0.0.1/vendor/api'] });
  const [settled] = await db.select().from(interaction).where(eq(interaction.id, row!.id));
  expect(settled).toMatchObject({ state: 'answered' });
});

test('the new initiative form is its own page, opened from the picker or a button, and a draft is kept', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  await db.update(initiative).set({ state: 'active' }).where(eq(initiative.id, f.initiativeId));
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-map').click();
  await expect(page).toHaveURL(/#\/map\/[0-9a-f-]{36}$/);
  const form = page.locator('form', { hasText: 'New initiative' });
  // The form is not under the map any more.
  await expect(form).toHaveCount(0);

  // The button opens it, and the map is gone while it is open.
  await page.getByTestId('new-initiative-button').click();
  await expect(page).toHaveURL(/#\/map\/new$/);
  await expect(form).toBeVisible();
  await expect(page.getByTestId('stage-spec')).toHaveCount(0);
  await expect(page.getByLabel('Initiative', { exact: true })).toHaveValue('new');
  await form.getByLabel('Title').fill('A draft I will come back to');

  // Looking at another initiative keeps the draft.
  await page.getByLabel('Initiative', { exact: true }).selectOption(f.initiativeId);
  await expect(page).toHaveURL(new RegExp(`#/map/${f.initiativeId}$`));
  await expect(form).toHaveCount(0);
  await page.getByLabel('Initiative', { exact: true }).selectOption({ label: 'New initiative…' });
  await expect(page).toHaveURL(/#\/map\/new$/);
  await expect(form.getByLabel('Title')).toHaveValue('A draft I will come back to');

  // Cancel returns to the initiative.
  await form.getByTestId('new-initiative-cancel').click();
  await expect(page).toHaveURL(/#\/map\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('stage-spec')).toBeVisible();
});

test('a ready preview raises a banner on any screen, a quiet notice in the queue, and a dot in the tab title', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  let list: Array<Record<string, unknown>> = [];
  const seen: string[] = [];
  await page.route('**/api/previews/ready', (route) => route.fulfill({ json: list }));
  await page.route('**/api/previews/*/seen', (route) => {
    const id = route.request().url().split('/').slice(-2)[0]!;
    seen.push(id);
    list = list.filter((p) => p.id !== id);
    return route.fulfill({ json: { id } });
  });
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-portfolio').click();
  await expect(page.getByTestId('preview-ready-banner')).toHaveCount(0);

  // The preview becomes ready while the person is on another screen.
  list = [
    {
      id: 'pv1',
      kind: 'main',
      initiativeId: f.initiativeId,
      initiativeTitle: 'Fernleaf plant shop',
      label: 'The built app',
      url: 'https://preview.example.test/pv1/',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      readyAt: new Date().toISOString(),
      interactionId: null,
    },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('sdlc:previews-changed')));
  const alert = page.getByTestId('preview-ready-alert');
  await expect(alert).toContainText('Preview is ready. The built app of Fernleaf plant shop');
  await expect(alert.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute(
    'href',
    'https://preview.example.test/pv1/',
  );
  await expect(page).toHaveTitle(/●/);

  // Closing the banner leaves the notice in the queue, which does not count as an ask.
  await alert.getByRole('button', { name: 'Close' }).click();
  await expect(alert).toHaveCount(0);
  await page.getByTestId('nav-queue').click();
  const notice = page.getByTestId('preview-ready');
  await expect(notice).toContainText('Preview is ready: The built app of Fernleaf plant shop');
  await expect(notice.getByRole('link', { name: 'Open the preview' })).toHaveAttribute(
    'href',
    'https://preview.example.test/pv1/',
  );
  expect(seen).toEqual([]);

  // Dismissing it clears it for good.
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  expect(seen).toEqual(['pv1']);
  await expect(page).not.toHaveTitle(/●/);
});

test('choosing New app on a repository that already has work shows a warning, and Feature does not', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  await signInAs(page, /Dev Admin/);
  await page.goto('/#/map/new');
  const form = page.locator('form', { hasText: 'New initiative' });
  await form.getByLabel('Repository').selectOption({ label: repo!.fullName });
  // The platform suggests Feature for a repository with work, so there is nothing to warn about.
  await expect(form.getByLabel('Type', { exact: true })).toHaveValue('feature');
  await expect(page.getByTestId('alongside-warning')).toHaveCount(0);
  await form.getByLabel('Type', { exact: true }).selectOption('new_app');
  await expect(page.getByTestId('alongside-warning')).toContainText('already has an app');
  await expect(page.getByTestId('alongside-warning').getByRole('link')).toHaveAttribute(
    'href',
    '#/repositories',
  );
  await form.getByLabel('Type', { exact: true }).selectOption('feature');
  await expect(page.getByTestId('alongside-warning')).toHaveCount(0);
});

test('the portfolio groups initiatives by app, oldest first, and collapses or flattens them', async ({
  page,
}) => {
  const f = await createRunFixture(db);
  const [first] = await db.select().from(initiative).where(eq(initiative.id, f.initiativeId));
  const [repo] = await db
    .select()
    .from(repositoryEntry)
    .where(eq(repositoryEntry.id, f.repositoryId));
  await db
    .update(initiative)
    .set({ kind: 'new_app', createdAt: new Date(Date.now() - 3 * 86_400_000) })
    .where(eq(initiative.id, first!.id));
  const later = async (title: string, kind: string, ageDays: number) =>
    (
      await db
        .insert(initiative)
        .values({
          title,
          goal: 'g',
          repositoryId: f.repositoryId,
          createdBy: f.personId,
          kind,
          createdAt: new Date(Date.now() - ageDays * 86_400_000),
        })
        .returning()
    )[0]!;
  const feature = await later(`Added later ${randomUUID().slice(0, 6)}`, 'feature', 1);
  const middle = await later(`Added in between ${randomUUID().slice(0, 6)}`, 'feature', 2);
  await signInAs(page, /Alice Park/);
  await page.getByTestId('nav-portfolio').click();

  // One app row for the repository, with its three initiatives under it, oldest first.
  const app = page.getByTestId(`app-${repo!.fullName}`);
  await expect(app).toContainText('3 initiatives');
  await expect(app).toHaveAttribute('data-expanded', 'true');
  const ids = [first!.id, middle.id, feature.id];
  for (const id of ids) await expect(page.getByTestId(`row-${id}`)).toBeVisible();
  const order = await page
    .locator(`[data-testid="app-${repo!.fullName}"], [data-testid^="row-"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  const at = (id: string) => order.indexOf(`row-${id}`);
  expect(at(first!.id)).toBeGreaterThan(order.indexOf(`app-${repo!.fullName}`));
  expect(at(first!.id)).toBeLessThan(at(middle.id));
  expect(at(middle.id)).toBeLessThan(at(feature.id));
  // The repository is in the app row, not repeated under every initiative.
  await expect(page.getByTestId(`row-${feature.id}`)).not.toContainText(repo!.fullName);

  // Collapsing hides the app's initiatives, expanding shows them again.
  await app.getByRole('button', { name: `Collapse ${repo!.fullName}` }).click();
  await expect(app).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByTestId(`row-${feature.id}`)).toHaveCount(0);
  await app.getByRole('button', { name: `Expand ${repo!.fullName}` }).click();
  await expect(page.getByTestId(`row-${feature.id}`)).toBeVisible();

  // The type filter works inside the groups.
  await page.getByTestId('kind-filter').getByRole('combobox').selectOption('new_app');
  await expect(app).toContainText('1 initiative');
  await expect(page.getByTestId(`row-${feature.id}`)).toHaveCount(0);
  await page.getByTestId('kind-filter').getByRole('combobox').selectOption('all');

  // The flat list has no app rows, and names the repository under each initiative. The choice is remembered.
  await page.getByTestId('view-switch').getByRole('combobox').selectOption('flat');
  await expect(app).toHaveCount(0);
  await expect(page.getByTestId(`row-${feature.id}`)).toContainText(repo!.fullName);
  await page.reload();
  await expect(page.getByTestId('view-switch').getByRole('combobox')).toHaveValue('flat');
  await page.getByTestId('view-switch').getByRole('combobox').selectOption('apps');
  await expect(page.getByTestId(`app-${repo!.fullName}`)).toBeVisible();
});
