import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createDb, modelSetting } from '../packages/db/src/index.ts';

// The dev stack (started by Playwright with demo data) listens on this database.
const DATABASE_URL = 'postgres://sdlc:sdlc@localhost:54329/sdlc';
const { db, pool } = createDb(DATABASE_URL);

test.afterAll(async () => {
  await db.delete(modelSetting);
  await pool.end();
});

async function signInAs(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.getByRole('button', { name }).click();
  await expect(page.getByTestId('signed-in')).toBeVisible();
}

test('a Platform Admin picks a different Claude model for an alias, sees the cost effect, and resets it', async ({
  page,
}) => {
  await db.delete(modelSetting);
  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByTestId('alias-card')).toHaveCount(3);

  const card = page
    .getByRole('heading', { name: 'agent-default' })
    .locator('xpath=ancestor::*[@data-testid="alias-card"]');
  await expect(card.getByTestId('current-model')).toContainText('Claude Sonnet 5.5');

  await card.getByLabel('Model for agent-default').selectOption('anthropic/claude-opus-4.8');
  await expect(card).toContainText('2.5 times as much as Claude Sonnet 5.5');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('note')).toContainText('agent-default now uses Claude Opus 4.8');
  await expect(card.getByTestId('current-model')).toContainText('Claude Opus 4.8');
  await expect(card).toContainText('changed from the default');

  await page.reload();
  await expect(card.getByTestId('current-model')).toContainText('Claude Opus 4.8');

  await card.getByRole('button', { name: 'Reset to default' }).click();
  await expect(card.getByTestId('current-model')).toContainText('Claude Sonnet 5.5');
  await expect(card).not.toContainText('changed from the default');
});

test('a person who is not a Platform Admin can see the models but not change them', async ({
  page,
}) => {
  await signInAs(page, /Bob Lindqvist/);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByText('Only a Platform Admin changes these')).toBeVisible();
  await expect(page.getByTestId('alias-card')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test model' })).toHaveCount(0);
});
