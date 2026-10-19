import { createDb, githubApp } from '@sdlc/db';

// Runs inside a one-off task of the platform image (see import-github-apps.ps1). Takes the Apps from APPS_B64.
const apps = JSON.parse(Buffer.from(process.env.APPS_B64!, 'base64').toString());
const { db, pool } = createDb(process.env.DATABASE_URL!, { caFile: process.env.DATABASE_CA_FILE });
for (const a of apps) {
  const row = {
    kind: a.kind,
    appId: Number(a.app_id),
    slug: a.slug,
    name: a.name,
    ownerLogin: a.owner_login,
    htmlUrl: a.html_url,
    installationId: Number(a.installation_id),
    installedOn: a.installed_on,
  };
  await db.insert(githubApp).values(row).onConflictDoUpdate({ target: githubApp.kind, set: row });
  console.log('imported', a.kind, a.slug);
}
await pool.end();
