import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { githubApp } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { recordActivity } from './activity.js';
import type { ApiConfig } from './config.js';
import { GitHubError, appJwt, buildManifest, secretName, storeAppSecrets } from './github-app.js';
import type { AppKind, GitHubClient } from './github-app.js';
import { currentPerson, requirePerson } from './people.js';
import type { Signed } from './people.js';
import type { SecretsStore } from './secrets.js';

const STATE_COOKIE = 'sdlc_gh_state';
const kindSchema = z.enum(['agent', 'gate']);

const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const page = (
  title: string,
  body: string,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:6vh auto;padding:0 20px;color:#1c2430}
h1{font-size:22px}h2{font-size:17px;margin:0}.card{border:1px solid #dde3ec;border-radius:10px;padding:14px 18px;margin:14px 0;background:#fff}
a.btn,button{display:inline-block;padding:8px 14px;border:1px solid #2f5fd0;border-radius:8px;background:#2f5fd0;color:#fff;text-decoration:none;font:inherit;cursor:pointer}
a.btn.alt{background:#fff;color:#2f5fd0}.ok{color:#1a7f37}.warn{color:#b35900}.err{color:#b42318}code{background:#f0f3f8;padding:1px 5px;border-radius:4px}
.muted{color:#5b6674;font-size:14px}</style></head><body>${body}</body></html>`;

async function requireAdmin(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Signed | null> {
  // A person who opens this page in a browser without being signed in is sent to sign in, and back here.
  if (
    !(await currentPerson(db, request)) &&
    String(request.headers.accept ?? '').includes('text/html')
  ) {
    await reply.redirect(`/auth/login?next=${encodeURIComponent(request.url.split('?')[0]!)}`);
    return null;
  }
  const me = await requirePerson(db, request, reply);
  if (!me) return null;
  if (!me.roles.includes('platform_admin')) {
    await reply
      .code(403)
      .type('text/html')
      .send(
        page(
          'Not allowed',
          '<h1>Not allowed</h1><p>Only a Platform Admin can configure GitHub.</p><p><a href="/">Back</a></p>',
        ),
      );
    return null;
  }
  return me;
}

/**
 * Asks GitHub which repositories each registered App can see now, and keeps the answer. A person can add a repository
 * to an App's installation on GitHub at any time, and GitHub sends nobody back here when they do.
 */
export async function refreshInstallations(
  db: Db,
  secrets: SecretsStore,
  github: GitHubClient,
): Promise<void> {
  for (const row of await db.select().from(githubApp)) {
    if (!row.installationId) continue;
    const pem = await secrets.get(secretName(row.kind as AppKind, 'private_key'));
    if (!pem) continue;
    const token = await github.createInstallationToken(appJwt(row.appId, pem), row.installationId);
    const repos = await github.listInstallationRepositories(token.token);
    const names = repos.repositories.map((r) => r.full_name);
    if (JSON.stringify(names) === JSON.stringify(row.installedOn)) continue;
    await db.update(githubApp).set({ installedOn: names }).where(eq(githubApp.id, row.id));
    await recordActivity(db, {
      actorType: 'system',
      action: 'github.installation_refreshed',
      detail: { kind: row.kind, repositories: names },
    });
  }
}

export interface GitHubAdminDeps {
  db: Db;
  config: ApiConfig;
  secrets: SecretsStore;
  github: GitHubClient;
}

export function registerGitHubAdminRoutes(
  app: FastifyInstance,
  { db, config, secrets, github }: GitHubAdminDeps,
): void {
  const publicUrl = config.PUBLIC_URL;
  const secure = publicUrl.startsWith('https://');

  async function rows() {
    return db.select().from(githubApp);
  }

  app.get('/api/admin/github', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!me.roles.includes('platform_admin'))
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Platform Admin only.' } });
    const all = await rows();
    return (['agent', 'gate'] as const).map((kind) => {
      const r = all.find((x) => x.kind === kind);
      return r
        ? {
            kind,
            registered: true,
            slug: r.slug,
            owner: r.ownerLogin,
            installationId: r.installationId,
            installedOn: r.installedOn,
          }
        : { kind, registered: false };
    });
  });

  // After a person adds or removes a repository on GitHub: ask GitHub again.
  app.post('/api/admin/github/refresh', async (request, reply) => {
    const me = await requireAdmin(db, request, reply);
    if (!me) return;
    try {
      await refreshInstallations(db, secrets, github);
    } catch (e) {
      return reply.code(502).send({
        error: {
          code: 'github_unavailable',
          message: e instanceof GitHubError ? e.message : 'GitHub did not answer.',
        },
      });
    }
    return (await rows()).map((r) => ({ kind: r.kind, installedOn: r.installedOn }));
  });

  app.get('/admin/github', async (request, reply) => {
    const me = await requireAdmin(db, request, reply);
    if (!me) return;
    const all = await rows();
    const q = z
      .object({ error: z.string().optional(), done: z.string().optional() })
      .parse(request.query);
    const cards = (['agent', 'gate'] as const)
      .map((kind) => {
        const r = all.find((x) => x.kind === kind);
        const title = kind === 'agent' ? 'Agent App' : 'Gate App';
        const what =
          kind === 'agent'
            ? 'Agents use it to push branches and open pull requests, one repository at a time.'
            : 'The platform uses it to merge a pull request once its required check is green. Its key never enters a sandbox.';
        if (!r) {
          return `<div class="card"><h2>${title}</h2><p class="muted">${what}</p><p class="warn">Not registered yet.</p>
<a class="btn" href="/admin/github/register?kind=${kind}">Register the ${title} on GitHub</a></div>`;
        }
        const install = r.installationId
          ? `<p class="ok">Installed on ${r.installedOn.length} repositor${r.installedOn.length === 1 ? 'y' : 'ies'}: ${r.installedOn.map((n) => `<code>${esc(n)}</code>`).join(', ') || 'none'}</p>
<a class="btn alt" href="${esc(config.GITHUB_WEB_URL)}/apps/${esc(r.slug)}/installations/new">Change repositories</a>`
          : `<p class="warn">Registered, not installed. Install it on only the repositories in the registry.</p>
<a class="btn" href="${esc(config.GITHUB_WEB_URL)}/apps/${esc(r.slug)}/installations/new">Install on GitHub</a>`;
        return `<div class="card"><h2>${title} <span class="muted">(${esc(r.slug)}, owner ${esc(r.ownerLogin)})</span></h2><p class="muted">${what}</p>${install}</div>`;
      })
      .join('');
    const notice = q.error
      ? `<p class="err"><strong>${esc(q.error)}</strong></p>`
      : q.done
        ? `<p class="ok">${esc(q.done)}</p>`
        : '';
    return reply
      .type('text/html')
      .send(
        page(
          'GitHub setup',
          `<h1>GitHub setup</h1><p class="muted">Signed in as ${esc(me.displayName)}. Two GitHub Apps give agents and the merge step separate, narrow access.</p>${notice}${cards}<p><a href="/">Back</a></p>`,
        ),
      );
  });

  // Step 1 of the manifest flow: a page that POSTs the manifest to GitHub. GitHub asks the admin to confirm.
  app.get('/admin/github/register', async (request, reply) => {
    const me = await requireAdmin(db, request, reply);
    if (!me) return;
    const { kind } = z.object({ kind: kindSchema }).parse(request.query);
    const state = randomBytes(16).toString('hex');
    reply.setCookie(STATE_COOKIE, `${state}.${kind}`, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/admin',
      maxAge: 3600,
    });
    const suffix = randomBytes(2).toString('hex');
    const manifest = JSON.stringify(buildManifest(kind, publicUrl, `dev-${suffix}`));
    return reply.type('text/html').send(
      page(
        'Register on GitHub',
        `<h1>Register the ${kind === 'agent' ? 'Agent' : 'Gate'} App</h1>
<p>You will be sent to GitHub to review the permissions and confirm. You can rename the App there.</p>
<form id="f" method="post" action="${esc(config.GITHUB_WEB_URL)}/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${esc(manifest)}"><button type="submit">Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script>`,
      ),
    );
  });

  // Steps 2 and 3: GitHub sends the admin back with a one-time code. Trade it for the App's credentials.
  app.get('/admin/github/created', async (request, reply) => {
    const me = await requireAdmin(db, request, reply);
    if (!me) return;
    const q = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
    const raw = request.cookies[STATE_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    const [state, kindRaw] = (unsigned?.valid && unsigned.value ? unsigned.value : '').split('.');
    const kind = kindSchema.safeParse(kindRaw);
    if (!state || state !== q.state || !kind.success) {
      return reply.redirect(
        '/admin/github?error=' +
          encodeURIComponent(
            'That registration did not start here, or it expired. Start it again.',
          ),
      );
    }
    reply.clearCookie(STATE_COOKIE, { path: '/admin' });
    try {
      const converted = await github.convertManifest(q.code);
      await storeAppSecrets(secrets, kind.data, converted);
      await db
        .insert(githubApp)
        .values({
          kind: kind.data,
          appId: converted.id,
          slug: converted.slug,
          name: converted.name,
          ownerLogin: converted.owner.login,
          htmlUrl: converted.html_url,
        })
        .onConflictDoUpdate({
          target: githubApp.kind,
          set: {
            appId: converted.id,
            slug: converted.slug,
            name: converted.name,
            ownerLogin: converted.owner.login,
            htmlUrl: converted.html_url,
            installationId: null,
            installedOn: [],
          },
        });
      await recordActivity(db, {
        actorType: 'person',
        actorId: me.id,
        action: 'github.app_registered',
        detail: { kind: kind.data, slug: converted.slug, appId: converted.id },
      });
      return reply.redirect(
        '/admin/github?done=' + encodeURIComponent(`Registered ${converted.name}. Now install it.`),
      );
    } catch (e) {
      request.log.error({ err: e }, 'github manifest conversion failed');
      const msg =
        e instanceof GitHubError ? e.message : 'Could not complete the registration with GitHub.';
      return reply.redirect('/admin/github?error=' + encodeURIComponent(msg));
    }
  });

  // GitHub sends the admin here after the install (the manifest's setup_url).
  app.get('/admin/github/installed', async (request, reply) => {
    const me = await requireAdmin(db, request, reply);
    if (!me) return;
    const q = z
      .object({ kind: kindSchema, installation_id: z.coerce.number().int().positive() })
      .parse(request.query);
    const [row] = await db.select().from(githubApp).where(eq(githubApp.kind, q.kind));
    const pem = await secrets.get(secretName(q.kind, 'private_key'));
    if (!row || !pem)
      return reply.redirect(
        '/admin/github?error=' + encodeURIComponent('That App is not registered here.'),
      );
    try {
      const jwt = appJwt(row.appId, pem);
      const inst = await github.getInstallation(jwt, q.installation_id);
      // Spec 6.6: only select repositories, never the whole account.
      if (inst.repository_selection !== 'selected') {
        return reply.redirect(
          '/admin/github?error=' +
            encodeURIComponent(
              'The App was installed on all repositories. Change it to "Only select repositories" and choose the registry repositories.',
            ),
        );
      }
      const token = await github.createInstallationToken(jwt, q.installation_id);
      const repos = await github.listInstallationRepositories(token.token);
      await db
        .update(githubApp)
        .set({
          installationId: q.installation_id,
          installedOn: repos.repositories.map((r) => r.full_name),
        })
        .where(eq(githubApp.kind, q.kind));
      await recordActivity(db, {
        actorType: 'person',
        actorId: me.id,
        action: 'github.app_installed',
        detail: {
          kind: q.kind,
          installationId: q.installation_id,
          repositories: repos.repositories.map((r) => r.full_name),
        },
      });
      return reply.redirect(
        '/admin/github?done=' +
          encodeURIComponent(
            `Installed on ${repos.repositories.length} repositor${repos.repositories.length === 1 ? 'y' : 'ies'}.`,
          ),
      );
    } catch (e) {
      request.log.error({ err: e }, 'github installation check failed');
      return reply.redirect(
        '/admin/github?error=' +
          encodeURIComponent(
            e instanceof GitHubError ? e.message : 'Could not verify the installation.',
          ),
      );
    }
  });
}

export type { AppKind };
