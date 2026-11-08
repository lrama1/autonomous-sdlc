import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb, githubApp, repositoryEntry } from '../packages/db/src/index.ts';

// The dev stack (started by Playwright with demo data) listens on this database.
const DATABASE_URL = 'postgres://sdlc:sdlc@localhost:54329/sdlc';
const { db, pool } = createDb(DATABASE_URL);
const REPO = 'acme/e2e-registry-shop';
const MANY = 'acme/e2e-many-apps';

test.afterAll(async () => {
  await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, REPO));
  await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, MANY));
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

test('an empty repository offers a first commit, shows what it writes, and says how to protect main', async ({
  page,
}) => {
  const NAME = 'acme/e2e-empty-repo';
  await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, NAME));
  const [row] = await db.insert(repositoryEntry).values({ fullName: NAME }).returning();
  let committed = false;
  const check = (id: string, label: string, status: string, detail: string, more = {}) => ({
    id,
    label,
    status,
    detail,
    ...more,
  });
  await page.route(`**/api/repositories/${row!.id}/readiness`, (route) =>
    route.fulfill({
      json: {
        checks: committed
          ? [
              check('apps', 'Both GitHub Apps are installed on it', 'ok', 'Both can reach it.'),
              check('branch', 'The branch main exists', 'ok', 'It points at c0ffee1.'),
              check(
                'protection',
                'The branch main is protected',
                'problem',
                'Nothing stops a direct push.',
                {
                  howTo: {
                    link: `https://github.com/${NAME}/settings/rules/new?target=branch`,
                    steps: [
                      'Name the rule, and target the branch main.',
                      'Turn on "Require status checks to pass".',
                    ],
                  },
                },
              ),
            ]
          : [
              check('apps', 'Both GitHub Apps are installed on it', 'ok', 'Both can reach it.'),
              check(
                'branch',
                'The branch main exists',
                'problem',
                'This repository has no commits yet.',
                {
                  fix: {
                    kind: 'first_commit',
                    path: 'README.md',
                    content: '# e2e-empty-repo\n\nStarted by Autonomous SDLC.\n',
                    message: 'Start the repository',
                  },
                },
              ),
            ],
      },
    }),
  );
  await page.route(`**/api/repositories/${row!.id}/first-commit`, (route) => {
    committed = true;
    return route.fulfill({
      status: 201,
      json: { sha: 'c0ffee1', branch: 'main', path: 'README.md' },
    });
  });

  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-repositories').click();
  const card = page.getByTestId('repo-card').filter({ hasText: NAME });
  await card.getByRole('button', { name: 'Check readiness' }).click();
  await expect(card.getByTestId('check-branch')).toContainText('no commits yet');

  await card.getByRole('button', { name: 'Create the first commit' }).click();
  await expect(card.getByTestId('first-commit')).toContainText('README.md');
  await expect(card.getByTestId('first-commit')).toContainText('Started by Autonomous SDLC');
  await card.getByRole('button', { name: 'Make the commit' }).click();

  await expect(card.getByTestId('check-branch')).toContainText('It points at c0ffee1');
  const how = card.getByTestId('check-protection').getByTestId('how-to');
  await expect(how).toContainText('Require status checks to pass');
  await expect(how.getByRole('link', { name: 'Open the rule form on GitHub' })).toHaveAttribute(
    'href',
    `https://github.com/${NAME}/settings/rules/new?target=branch`,
  );
  await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, NAME));
});

test('the checklist shows what is left, and a repository that looks like several apps needs a tick', async ({
  page,
}) => {
  await db.delete(repositoryEntry).where(eq(repositoryEntry.fullName, MANY));
  await db.delete(githubApp);

  await signInAs(page, /Dev Admin/);
  await page.getByTestId('nav-repositories').click();
  const checklist = page.getByTestId('setup-checklist');
  await expect(checklist).toContainText('The Agent App is registered on GitHub');
  await expect(page.getByTestId('setup-agent-registered')).toContainText('To do');
  await expect(page.getByTestId('setup-start')).toHaveAttribute('href', '/admin/github/start');

  for (const kind of ['agent', 'gate']) {
    await db.insert(githubApp).values({
      kind,
      appId: 1,
      slug: `${kind}-e2e`,
      name: kind,
      ownerLogin: 'acme',
      htmlUrl: 'https://example.test',
      installationId: 7,
      installedOn: [MANY],
    });
  }
  await page.route(/\/api\/repositories\/inspect/, (route) =>
    route.fulfill({
      json: {
        shape: 'multi_app',
        defaultBranch: 'main',
        fileCount: 40,
        lastCommitAt: '2026-11-03T12:00:00Z',
        archived: false,
        stacks: ['Node.js'],
        appFolders: ['apps/blog', 'apps/shop'],
        needsAcknowledgement: true,
        headline: 'It looks like it holds more than one app (apps/blog, apps/shop).',
        details: ['Nothing is overwritten: agents work on branches and open pull requests.'],
      },
    }),
  );
  await page.reload();
  // Other repositories are already registered, so the checklist has folded into one line.
  await expect(page.getByTestId('setup-done')).toContainText('GitHub is connected');
  await expect(page.getByTestId('install-agent')).toHaveAttribute(
    'href',
    'https://github.com/apps/agent-e2e/installations/new',
  );

  const inspection = page.getByTestId('inspection');
  await expect(inspection).toContainText('more than one app');
  await expect(inspection).toContainText('Nothing is overwritten');
  const add = page.getByRole('button', { name: 'Add repository' });
  await expect(add).toBeDisabled();
  await page.getByLabel('I understand and want to add it anyway').check();
  await expect(add).toBeEnabled();
  await add.click();
  const card = page.getByTestId('repo-card').filter({ hasText: MANY });
  await expect(card).toBeVisible();
  // Its readiness is looked at without a click.
  await expect(card.getByTestId('readiness')).toBeVisible();
});
