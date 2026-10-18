import { expect, test } from '@playwright/test';

test('a person signs in through the identity provider, sees their hats, and signs out', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('api-status')).toContainText('API: ok');
  await expect(page.getByTestId('api-status')).toContainText('database: ok');
  await expect(page.getByText('You are not signed in.')).toBeVisible();

  await page.getByTestId('sign-in').click();
  await expect(page.getByRole('heading', { name: 'Development sign-in' })).toBeVisible();
  await page.getByRole('button', { name: /Bob Lindqvist/ }).click();

  await expect(page.getByTestId('signed-in')).toContainText('Bob Lindqvist');
  await expect(page.getByTestId('roles')).toContainText('Backend Engineer');
  await expect(page.getByTestId('roles')).toContainText('Frontend Engineer');

  await page.reload();
  await expect(page.getByTestId('signed-in')).toContainText('Bob Lindqvist');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You are not signed in.')).toBeVisible();
});
