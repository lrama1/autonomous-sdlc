import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb, githubApp, repositoryEntry } from '../packages/db/src/index.ts';

// The dev stack (started by Playwright with demo data) listens on this database.
const DATABASE_URL = 'postgres://sdlc:sdlc@localhost:54329/sdlc';
const { db, pool } = createDb(DATABASE_URL);
const REPO = 'acme/e2e-registry-shop';

test.afterAll(async () => {
  await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, REPO));
  await db.delete(githubApp);
  await pool.end();
});

async function signInAs(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.getByRole('button', { name }).click();
  await expect(page.getByTestId('signed-in')).toBeVisible();
}

test('a Platform Admin registers, changes and removes a repository without calling the API by hand', async ({
  page,
}) => {
  await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, REPO));
  await db.delete(githubApp);
  for (const kind of ['agent', 'gate']) {
    await db.insert(githubApp).values({
      kind,
      appId: 1,
      slug: `${kind}-e2e`,
      name: kind,
      ownerLogin: 'acme',
      htmlUrl: 'https://example.test',
      installationId: 7,
      installedOn: [REPO],
    });
  }

  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-repositories').click();
  await expect(page.getByRole('heading', { name: 'Repositories', level: 1 })).toBeVisible();

  await page.getByLabel('Repository', { exact: true }).selectOption(REPO);
  await page.getByRole('button', { name: 'Add repository' }).click();
  const card = page.getByTestId('repo-card').filter({ hasText: REPO });
  await expect(card).toBeVisible();
  await expect(page.getByTestId('note')).toContainText('is registered');
  await expect(page.getByTestId('none-left')).toBeVisible();

  await card.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Verify command').fill('npm test');
  await page.getByLabel('Protected paths').fill('.github/**\ndeploy/**');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(card).toContainText('npm test');
  await expect(card).toContainText('deploy/**');

  await card.getByRole('button', { name: 'Check readiness' }).click();
  await expect(card.getByTestId('readiness')).toContainText('Both GitHub Apps are installed');

  await card.getByRole('button', { name: 'Remove' }).click();
  await card.getByRole('button', { name: 'Yes, remove it' }).click();
  await expect(page.getByTestId('repo-card').filter({ hasText: REPO })).toHaveCount(0);
});

test('a person who is not a Platform Admin can read the list but not change it', async ({
  page,
}) => {
  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-repositories').click();
  await expect(page.getByText('Only a Platform Admin adds or changes repositories')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add repository' })).toHaveCount(0);
});
