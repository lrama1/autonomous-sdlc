import { eq } from 'drizzle-orm';
import { githubApp } from '@sdlc/db';
import { normalizePreviewState, safeUrl } from '@sdlc/core';
import type { PreviewCandidate } from '@sdlc/core';
import type { Db } from '@sdlc/db';
import { GitHubError, appJwt, secretName } from './github-app.js';
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

  /** The commit a branch points at now. */
  async branchHead(repo: string, branch: string): Promise<string> {
    const { token } = await this.tokenFor('gate', repo);
    const r = await this.client.call<{ object: { sha: string } }>(
      'GET',
      `/repos/${repo}/git/ref/heads/${branch}`,
      token,
    );
    return r.object.sha;
  }

  /** Publishes a release: a tag on the given commit and a release page with the notes. The Gate App does this, never an agent. */
  async publishRelease(
    repo: string,
    r: { tag: string; sha: string; name: string; notes: string },
  ): Promise<{ url: string }> {
    const { token } = await this.tokenFor('gate', repo, { contents: 'write' });
    await this.client.call('POST', `/repos/${repo}/git/refs`, token, {
      ref: `refs/tags/${r.tag}`,
      sha: r.sha,
    });
    const rel = await this.client.call<{ html_url: string }>(
      'POST',
      `/repos/${repo}/releases`,
      token,
      { tag_name: r.tag, name: r.name, body: r.notes, draft: false, prerelease: false },
    );
    return { url: rel.html_url };
  }

  async closePullRequest(repo: string, number: number): Promise<void> {
    const { token } = await this.tokenFor('gate', repo, { pull_requests: 'write' });
    await this.client.call('PATCH', `/repos/${repo}/pulls/${number}`, token, { state: 'closed' });
  }

  /**
   * What the repository's pipeline has reported as a preview of a pull request: Deployments (for the commit and for the
   * branch, so an older build can be called stale) and commit statuses with "preview" in their name. Read-only.
   */
  async previewCandidates(
    repo: string,
    number: number,
  ): Promise<{ headSha: string; candidates: PreviewCandidate[]; deploymentsReadable: boolean }> {
    const pr = await this.getPullRequest(repo, number);
    const headSha = pr.head.sha;
    const { token } = await this.tokenFor('gate', repo);
    const candidates: PreviewCandidate[] = [];
    let deploymentsReadable = true;

    interface Deployment {
      id: number;
      sha: string;
      environment?: string;
      created_at: string;
    }
    interface DeploymentStatus {
      state: string;
      environment_url?: string;
      target_url?: string;
      created_at: string;
    }
    try {
      const found = new Map<number, Deployment>();
      for (const q of [`sha=${headSha}`, `ref=${encodeURIComponent(pr.head.ref)}`]) {
        const list = await this.client.call<Deployment[]>(
          'GET',
          `/repos/${repo}/deployments?${q}&per_page=5`,
          token,
        );
        for (const d of list) found.set(d.id, d);
      }
      for (const d of found.values()) {
        const [s] = await this.client.call<DeploymentStatus[]>(
          'GET',
          `/repos/${repo}/deployments/${d.id}/statuses?per_page=1`,
          token,
        );
        const state = s ? normalizePreviewState(s.state) : 'pending';
        if (!state) continue;
        candidates.push({
          source: 'deployment',
          sha: d.sha,
          state,
          url: safeUrl(s?.environment_url) ?? safeUrl(s?.target_url),
          label: d.environment,
          at: s?.created_at ?? d.created_at,
        });
      }
    } catch (e) {
      if (!(e instanceof GitHubError) || (e.status !== 403 && e.status !== 404)) throw e;
      deploymentsReadable = false;
    }

    const combined = await this.client.call<{
      statuses: Array<{ context: string; state: string; target_url?: string; created_at: string }>;
    }>('GET', `/repos/${repo}/commits/${headSha}/status?per_page=100`, token);
    for (const s of combined.statuses) {
      if (!/preview/i.test(s.context)) continue;
      const state = normalizePreviewState(s.state);
      if (!state) continue;
      candidates.push({
        source: 'status',
        sha: headSha,
        state,
        url: safeUrl(s.target_url),
        label: s.context,
        at: s.created_at,
      });
    }
    return { headSha, candidates, deploymentsReadable };
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    const { token } = await this.tokenFor('gate', repo, { pull_requests: 'write' });
    await this.client.call('POST', `/repos/${repo}/issues/${number}/comments`, token, { body });
  }
}
