import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import {
  assumption,
  buildPlan,
  buildTask,
  createDb,
  createRunFixture,
  initiative,
  interaction,
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
  await page.getByLabel('Initiative').selectOption(f.initiativeId);
  const panel = page.getByTestId('build-plan');
  await expect(panel).toHaveAttribute('data-state', 'awaiting_start');
  await expect(page.getByTestId('stage-build')).toHaveAttribute('data-status', 'waiting_human');
  await expect(panel.getByTestId('task-T2')).toContainText('after T1');
  await panel.getByRole('button', { name: 'Start the build' }).click();
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
  await page.getByLabel('Initiative').selectOption(f.initiativeId);
  const step = page.getByTestId('step-spec');
  await expect(step).toContainText('Draft the spec: Weather');
  await expect(page.getByTestId('stage-spec')).toHaveAttribute('data-status', 'waiting_human');
  await step.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('note')).toContainText('is starting');
  // The worker starts the run, and the step leaves the list.
  await expect(page.getByTestId('step-spec')).toHaveCount(0, { timeout: 20_000 });
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
  await page.getByLabel('Initiative').selectOption(f.initiativeId);
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
