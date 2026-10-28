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
  person,
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
