import { eq } from 'drizzle-orm';
import { githubApp } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { appJwt, secretName } from './github-app.js';
import type { AppKind, GitHubClient } from './github-app.js';
import type { SecretsStore } from './secrets.js';

export interface PullRequestInfo {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
  mergeable_state?: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}

/** What the platform does on GitHub with each App's own credentials. Keys never leave this class. */
export class GitHubService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretsStore,
    private readonly client: GitHubClient,
  ) {}

  /** A token for one repository, from the named App. Agents get this one, never the Gate's. */
  async tokenFor(
    kind: AppKind,
    repoFullName: string,
    permissions?: Record<string, 'read' | 'write'>,
  ): Promise<{ token: string; expiresAt: string }> {
    const [app] = await this.db.select().from(githubApp).where(eq(githubApp.kind, kind));
    if (!app?.installationId)
      throw new Error(`the ${kind} GitHub App is not registered and installed`);
    if (!app.installedOn.includes(repoFullName))
      throw new Error(`the ${kind} GitHub App is not installed on ${repoFullName}`);
    const pem = await this.secrets.get(secretName(kind, 'private_key'));
    if (!pem) throw new Error(`no private key stored for the ${kind} GitHub App`);
    const name = repoFullName.split('/')[1]!;
    const t = await this.client.createInstallationToken(
      appJwt(app.appId, pem),
      app.installationId,
      { repositories: [name], permissions },
    );
    return { token: t.token, expiresAt: t.expires_at };
  }

  async openPullRequest(
    repo: string,
    p: { title: string; body: string; head: string; base: string },
  ): Promise<{ number: number; url: string; headSha: string }> {
    const { token } = await this.tokenFor('agent', repo, {
      contents: 'write',
      pull_requests: 'write',
    });
    const pr = await this.client.call<PullRequestInfo>('POST', `/repos/${repo}/pulls`, token, p);
    return { number: pr.number, url: pr.html_url, headSha: pr.head.sha };
  }

  async getPullRequest(
    repo: string,
    number: number,
    as: AppKind = 'gate',
  ): Promise<PullRequestInfo> {
    const { token } = await this.tokenFor(as, repo);
    return this.client.call<PullRequestInfo>('GET', `/repos/${repo}/pulls/${number}`, token);
  }

  /** The conclusion of a named check on a commit: 'success', 'failure', ..., or 'pending' while it runs or is absent. */
  async checkConclusion(repo: string, sha: string, name: string): Promise<string> {
    const { token } = await this.tokenFor('gate', repo);
    const r = await this.client.call<{
      check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
    }>('GET', `/repos/${repo}/commits/${sha}/check-runs`, token);
    const run = r.check_runs.find((c) => c.name === name);
    if (!run || run.status !== 'completed') return 'pending';
    return run.conclusion ?? 'pending';
  }

  /** The Gate App's approving review, which branch protection requires before a merge (spike 4). */
  async gateApprove(repo: string, number: number, body: string): Promise<void> {
    const { token } = await this.tokenFor('gate', repo, {
      contents: 'write',
      pull_requests: 'write',
    });
    await this.client.call('POST', `/repos/${repo}/pulls/${number}/reviews`, token, {
      event: 'APPROVE',
      body,
    });
  }

  async gateMerge(repo: string, number: number, title: string): Promise<{ sha: string }> {
    const { token } = await this.tokenFor('gate', repo, {
      contents: 'write',
      pull_requests: 'write',
    });
    const r = await this.client.call<{ sha: string; merged: boolean }>(
      'PUT',
      `/repos/${repo}/pulls/${number}/merge`,
      token,
      {
        merge_method: 'squash',
        commit_title: title,
      },
    );
    return { sha: r.sha };
  }

  async closePullRequest(repo: string, number: number): Promise<void> {
    const { token } = await this.tokenFor('gate', repo, { pull_requests: 'write' });
    await this.client.call('PATCH', `/repos/${repo}/pulls/${number}`, token, { state: 'closed' });
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    const { token } = await this.tokenFor('gate', repo, { pull_requests: 'write' });
    await this.client.call('POST', `/repos/${repo}/issues/${number}/comments`, token, { body });
  }
}
