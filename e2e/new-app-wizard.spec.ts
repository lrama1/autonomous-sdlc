import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { eq, inArray } from 'drizzle-orm';
import { createDb, initiative, repositoryEntry } from '../packages/db/src/index.ts';

// The dev stack (started by Playwright with demo data) listens on this database.
const DATABASE_URL = 'postgres://sdlc:sdlc@localhost:54329/sdlc';
const { db, pool } = createDb(DATABASE_URL);
const NAMES = ['acme/e2e-wizard-app', 'acme/e2e-wizard-empty', 'acme/e2e-wizard-used'];
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  await db.delete(repositoryEntry).where(inArray(repositoryEntry.fullName, NAMES));
  for (const fullName of NAMES) {
    const [row] = await db.insert(repositoryEntry).values({ fullName }).returning();
    ids[fullName] = row!.id;
  }
});

test.afterAll(async () => {
  const mine = Object.values(ids);
  await db.delete(initiative).where(inArray(initiative.repositoryId, mine));
  await db.delete(repositoryEntry).where(inArray(repositoryEntry.fullName, NAMES));
  await pool.end();
});

async function signInAs(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.getByRole('button', { name }).click();
  await expect(page.getByTestId('signed-in')).toBeVisible();
}

const startCheck = (page: Page, repo: string, answer: () => Record<string, unknown>) =>
  page.route(new RegExp(`/api/repositories/${ids[repo]}/start-check`), (route) =>
    route.fulfill({ json: answer() }),
  );
const ready = { branch: 'exists', empty: null, hasWork: false, integrationBranch: 'main' };

async function openWizard(page: Page, repo: string) {
  await page.goto('/#/map/new');
  // Another repository may already have an app, in which case the plain form suggests a feature.
  const type = page.getByLabel('Type', { exact: true });
  await expect(page.getByTestId('wizard').or(type)).toBeVisible();
  if (await type.isVisible()) await type.selectOption('new_app');
  await expect(page.getByTestId('wizard')).toBeVisible();
  await page.getByLabel('Repository', { exact: true }).selectOption({ label: repo });
}

test('a product owner is walked through a new app, and the goal is written from the answers', async ({
  page,
}) => {
  const repo = NAMES[0]!;
  await startCheck(page, repo, () => ready);
  await signInAs(page, /Alice Park/);
  await openWizard(page, repo);

  // Step 1: where it lives.
  await expect(page.getByTestId('wizard-repo-status')).toContainText('The branch main exists');
  await page.getByTestId('wizard-next').click();

  // Step 2: it will not go on without the essentials, and says what is missing.
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-problems')).toContainText('Give it a name');
  await expect(page.getByTestId('wizard-problems')).toContainText('at least one thing it must do');
  await page.getByLabel('Name').fill('Groomer bookings');
  await page.getByLabel('What is it, and who is it for?').fill('A booking site for a dog groomer.');
  await page
    .getByLabel(/What must it do/)
    .fill('Clients pick a time slot\nThe groomer sees tomorrow');
  await page.getByLabel(/What must it not do/).fill('Take payments');
  await page.getByTestId('wizard-next').click();

  // Step 3: Guided is chosen and recommended; the plain-language text says what it means.
  await expect(page.getByRole('radio', { name: /Guided/ })).toBeChecked();
  await expect(page.getByTestId('wizard-step-2')).toContainText(
    'Nothing merges without your click',
  );
  await page.getByLabel(/Start the spec as soon as I create it/).uncheck();
  await page.getByTestId('wizard-next').click();

  // Step 4: review. The goal is written from the answers, and can be edited.
  const goal = page.getByTestId('wizard-goal');
  await expect(goal).toHaveValue(
    /A booking site for a dog groomer\.\n\nIt must:\n- Clients pick a time slot\n- The groomer sees tomorrow\n\nIt must not, or leaves out:\n- Take payments/,
  );
  await expect(page.getByTestId('wizard-summary')).toContainText('Groomer bookings');
  await expect(page.getByTestId('wizard-summary')).toContainText('Guided, you start each stage');
  await expect(page.getByTestId('wizard-estimate')).toContainText('What it may cost');
  await page.getByTestId('wizard-back').click();
  await page.getByTestId('wizard-back').click();
  await expect(page.getByLabel('Name')).toHaveValue('Groomer bookings');
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-create').click();

  await expect(page).toHaveURL(/#\/map\/[0-9a-f-]{36}$/);
  const [made] = await db.select().from(initiative).where(eq(initiative.repositoryId, ids[repo]!));
  expect(made).toMatchObject({
    title: 'Groomer bookings',
    kind: 'new_app',
    autonomyMode: 'guided',
  });
  expect(made!.goal).toContain('It must:\n- Clients pick a time slot');
});

test('an empty repository blocks the wizard, and an admin can fix it on the spot', async ({
  page,
}) => {
  const repo = NAMES[1]!;
  let fixed = false;
  await startCheck(page, repo, () =>
    fixed ? ready : { branch: 'missing', empty: true, hasWork: false, integrationBranch: 'main' },
  );
  await page.route(new RegExp(`/api/repositories/${ids[repo]}/first-commit`), (route) => {
    fixed = true;
    return route.fulfill({
      status: 201,
      json: { sha: 'c0ffee1', branch: 'main', path: 'README.md' },
    });
  });
  await signInAs(page, /Dev Admin/);
  await openWizard(page, repo);

  await expect(page.getByTestId('wizard-branch-missing')).toContainText('is empty');
  await expect(page.getByTestId('wizard-next')).toBeDisabled();
  await page.getByTestId('wizard-first-commit').click();
  await expect(page.getByTestId('wizard-repo-status')).toContainText('The branch main exists');
  await expect(page.getByTestId('wizard-next')).toBeEnabled();
});

test('someone who is not an admin is told who can fix an empty repository', async ({ page }) => {
  const repo = NAMES[1]!;
  await startCheck(page, repo, () => ({
    branch: 'missing',
    empty: true,
    hasWork: false,
    integrationBranch: 'main',
  }));
  await signInAs(page, /Alice Park/);
  await openWizard(page, repo);
  await expect(page.getByTestId('wizard-branch-missing')).toContainText('Platform Admin');
  await expect(page.getByTestId('wizard-first-commit')).toHaveCount(0);
  await expect(page.getByTestId('wizard-next')).toBeDisabled();
});

test('a repository that already has an app asks for a tick, or offers a feature instead', async ({
  page,
}) => {
  const repo = NAMES[2]!;
  await startCheck(page, repo, () => ({ ...ready, hasWork: true }));
  await signInAs(page, /Alice Park/);
  await openWizard(page, repo);

  await expect(page.getByTestId('wizard-alongside')).toContainText('already has an app');
  await expect(page.getByTestId('wizard-next')).toBeDisabled();
  await page.getByLabel('I understand').check();
  await expect(page.getByTestId('wizard-next')).toBeEnabled();
  await page.getByLabel('I understand').uncheck();

  await page.getByRole('button', { name: 'add a feature to the existing app instead' }).click();
  await expect(page.getByLabel('Type', { exact: true })).toHaveValue('feature');
  await expect(page.getByTestId('wizard')).toHaveCount(0);
});

test('skipping the wizard keeps what was typed, and the plain form can go back to it', async ({
  page,
}) => {
  const repo = NAMES[0]!;
  await startCheck(page, repo, () => ready);
  await signInAs(page, /Alice Park/);
  await openWizard(page, repo);
  await page.getByTestId('wizard-next').click();
  await page.getByLabel('Name').fill('Skipped app');
  await page.getByLabel('What is it, and who is it for?').fill('A thing.');
  await page.getByLabel(/What must it do/).fill('Work');
  await page.getByTestId('wizard-skip').click();

  const form = page.locator('form', { hasText: 'New initiative' });
  await expect(form.getByLabel('Title')).toHaveValue('Skipped app');
  await expect(form.getByLabel('Goal')).toHaveValue('A thing.\n\nIt must:\n- Work');
  await expect(form.getByLabel('Type', { exact: true })).toHaveValue('new_app');

  await page.getByTestId('use-wizard').click();
  await expect(page.getByTestId('wizard')).toBeVisible();
});
