import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function signInAs(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.getByRole('button', { name }).click();
  await expect(page.getByTestId('signed-in')).toBeVisible();
}

test('the assistant opens on any page, knows the screen, and offers a button for what it suggests', async ({
  page,
}) => {
  const asked: Array<{ text: string; context: { page: string; pageText?: string } }> = [];
  let started = 0;
  const now = new Date().toISOString();
  await page.route('**/api/assistant/usage', (route) =>
    route.fulfill({ json: { available: true, spentMicros: 12_000, capMicros: 4_000_000 } }),
  );
  await page.route('**/api/assistant/conversations', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: { id: '11111111-1111-4111-8111-111111111111', title: 'New chat', updatedAt: now },
        })
      : route.fulfill({ json: [] }),
  );
  await page.route('**/api/assistant/conversations/*/messages', async (route) => {
    asked.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      json: {
        conversation: {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'What is this',
          updatedAt: now,
        },
        user: {
          id: 'u1',
          role: 'user',
          content: asked[0]!.text,
          steps: [],
          proposals: [],
          createdAt: now,
        },
        assistant: {
          id: 'a1',
          role: 'assistant',
          content: 'This is the **Bugs** screen.\n- Report a bug\n- Follow a fix',
          steps: [{ tool: 'platform_api', summary: 'read /api/bugs' }],
          proposals: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              kind: 'start_preview',
              label: 'Run the built app',
              why: 'To see the problem yourself.',
              params: { initiativeId: '33333333-3333-4333-8333-333333333333' },
              state: 'proposed',
            },
          ],
          createdAt: now,
        },
        usage: { available: true, spentMicros: 15_000, capMicros: 4_000_000 },
      },
    });
  });
  await page.route('**/api/initiatives/*/preview/start', (route) => {
    started++;
    return route.fulfill({ status: 202, json: { id: 'p1', state: 'starting' } });
  });
  let marked = '';
  await page.route('**/api/assistant/messages/*/proposals/*', (route) => {
    marked = String(route.request().postDataJSON().state);
    return route.fulfill({ json: { ok: true } });
  });

  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-bugs').click();
  await page.getByTestId('assistant-fab').click();
  await expect(page.getByTestId('assistant-usage')).toContainText('$3.99 of $4.00 left today');

  await page.getByRole('button', { name: 'What is this screen for?' }).click();
  await expect(page.getByTestId('assistant-assistant')).toContainText('This is the Bugs screen.');
  await expect(
    page.getByTestId('assistant-assistant').locator('ul').first().locator('li'),
  ).toHaveCount(2);
  // It was told where the person is, and what the page shows, not its own panel.
  expect(asked[0]!.context.page).toBe('bugs');
  expect(asked[0]!.context.pageText).toContain('Bugs');
  await page.getByTestId('assistant-steps').locator('summary').click();
  await expect(page.getByTestId('assistant-steps')).toContainText('read /api/bugs');

  // A suggestion is a button. Nothing happened until it is clicked.
  expect(started).toBe(0);
  const proposal = page.getByTestId('assistant-proposal');
  await proposal.getByRole('button', { name: 'Do it' }).click();
  await expect(proposal).toHaveAttribute('data-state', 'done');
  expect(started).toBe(1);
  expect(marked).toBe('done');
});

test('the assistant says why when it cannot answer, and keeps the question', async ({ page }) => {
  await page.route('**/api/assistant/usage', (route) =>
    route.fulfill({ json: { available: true, spentMicros: 0, capMicros: 4_000_000 } }),
  );
  await page.route('**/api/assistant/conversations', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            id: '11111111-1111-4111-8111-111111111111',
            title: 'New chat',
            updatedAt: new Date().toISOString(),
          },
        })
      : route.fulfill({ json: [] }),
  );
  await page.route('**/api/assistant/conversations/*/messages', (route) =>
    route.fulfill({
      status: 429,
      json: {
        error: {
          code: 'daily_limit',
          message: 'You have used your $4.00 for the assistant today.',
        },
      },
    }),
  );
  await signInAs(page, /Dev Admin/);
  await page.getByTestId('assistant-fab').click();
  await page.getByLabel('Ask the assistant', { exact: true }).fill('Why is T10 failing?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('assistant-problem')).toContainText('used your $4.00');
  await expect(page.getByLabel('Ask the assistant', { exact: true })).toHaveValue(
    'Why is T10 failing?',
  );
});

test('there is no assistant button when the platform has it switched off', async ({ page }) => {
  await page.route('**/api/assistant/usage', (route) =>
    route.fulfill({ json: { available: false, spentMicros: 0, capMicros: 4_000_000 } }),
  );
  await signInAs(page, /Dev Admin/);
  await expect(page.getByTestId('assistant-fab')).toHaveCount(0);
});
