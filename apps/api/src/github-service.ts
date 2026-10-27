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

  /**
   * Asks GitHub to merge the base branch into the pull request's branch, as a merge commit made by the Gate App.
   * `expectedHeadSha` makes GitHub refuse if someone pushed in the meantime.
   */
  async updateBranch(repo: string, number: number, expectedHeadSha: string): Promise<void> {
    const { token } = await this.tokenFor('gate', repo, {
      contents: 'write',
      pull_requests: 'write',
    });
    await this.client.call('PUT', `/repos/${repo}/pulls/${number}/update-branch`, token, {
      expected_head_sha: expectedHeadSha,
    });
  }

  /** The parent commits of a commit. */
  async commitParents(repo: string, sha: string): Promise<string[]> {
    const { token } = await this.tokenFor('gate', repo);
    const c = await this.client.call<{ parents: Array<{ sha: string }> }>(
      'GET',
      `/repos/${repo}/commits/${sha}`,
      token,
    );
    return c.parents.map((p) => p.sha);
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

  /**
   * The branch's head commit and whether GitHub protects it, or null when there is no such branch. (The git ref endpoint
   * answers 409 for an empty repository, so the branch endpoint is the one that says "not found" in every case.)
   */
  async branchInfo(
    repo: string,
    branch: string,
  ): Promise<{ sha: string; protected: boolean } | null> {
    const { token } = await this.tokenFor('gate', repo);
    try {
      const r = await this.client.call<{ commit: { sha: string }; protected: boolean }>(
        'GET',
        `/repos/${repo}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`,
        token,
      );
      return { sha: r.commit.sha, protected: Boolean(r.protected) };
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
  }

  /** True when the repository has no branch at all, that is, no commit. */
  async isEmpty(repo: string): Promise<boolean> {
    const { token } = await this.tokenFor('gate', repo);
    const r = await this.client.call<unknown[]>('GET', `/repos/${repo}/branches?per_page=1`, token);
    return Array.isArray(r) && r.length === 0;
  }

  /**
   * Makes the first commit of an empty repository: one file, on the given branch. GitHub creates the branch with it. The Agent
   * App does this (contents write), and it can do nothing under .github/workflows.
   */
  async createFirstCommit(
    repo: string,
    f: { branch: string; path: string; content: string; message: string },
  ): Promise<{ sha: string }> {
    const { token } = await this.tokenFor('agent', repo, { contents: 'write' });
    const r = await this.client.call<{ commit: { sha: string } }>(
      'PUT',
      `/repos/${repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`,
      token,
      {
        message: f.message,
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        branch: f.branch,
      },
    );
    return { sha: r.commit.sha };
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

  /** A text file at a commit, or null if it is not there. The Gate App reads it. */
  async readFile(repo: string, filePath: string, ref: string): Promise<string | null> {
    const { token } = await this.tokenFor('gate', repo);
    try {
      const r = await this.client.call<{ content?: string; encoding?: string }>(
        'GET',
        `/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        token,
      );
      if (r.encoding !== 'base64' || typeof r.content !== 'string') return null;
      return Buffer.from(r.content, 'base64').toString('utf8');
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  /** The names of the files directly inside a folder at a branch or commit; empty if the folder is not there. */
  async listFiles(repo: string, dir: string, ref: string): Promise<string[]> {
    const { token } = await this.tokenFor('gate', repo);
    try {
      const r = await this.client.call<Array<{ name: string; type: string }>>(
        'GET',
        `/repos/${repo}/contents/${dir.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        token,
      );
      return Array.isArray(r) ? r.filter((f) => f.type === 'file').map((f) => f.name) : [];
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return [];
      throw e;
    }
  }

  /** The repository's files at a commit, as a gzipped tar. The Gate App reads it; the preview sandbox never sees a credential. */
  async archive(repo: string, sha: string): Promise<Buffer> {
    const { token } = await this.tokenFor('gate', repo);
    return this.client.download(
      `/repos/${repo}/tarball/${encodeURIComponent(sha)}`,
      token,
      100 * 1024 * 1024,
    );
  }

  /** The files a pull request changes, each with its unified diff (GitHub leaves it out for a binary or a very large file). */
  async pullRequestFiles(
    repo: string,
    number: number,
    maxFiles = 300,
  ): Promise<Array<{ path: string; status: string; patch: string | null }>> {
    const { token } = await this.tokenFor('gate', repo);
    const out: Array<{ path: string; status: string; patch: string | null }> = [];
    for (let page = 1; out.length < maxFiles; page++) {
      const batch = await this.client.call<
        Array<{ filename: string; status: string; patch?: string }>
      >('GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token);
      for (const f of batch)
        out.push({ path: f.filename, status: f.status, patch: f.patch ?? null });
      if (batch.length < 100) break;
    }
    return out.slice(0, maxFiles);
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
