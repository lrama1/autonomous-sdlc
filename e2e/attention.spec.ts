import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import {
  assumption,
  createDb,
  createRunFixture,
  interaction,
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
