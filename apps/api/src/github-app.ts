import { createSign } from 'node:crypto';
import type { SecretsStore } from './secrets.js';

export type AppKind = 'agent' | 'gate';

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes?: { url: string; active: boolean };
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: Record<string, 'read' | 'write'>;
  default_events: string[];
}

// Two Apps (spec 6.6, decided 2026-10-16). The Agent App writes branches and PRs. The Gate App merges.
// Neither can change workflows, so the CI configuration is not reachable by an agent.
const PERMISSIONS: Record<AppKind, Record<string, 'read' | 'write'>> = {
  agent: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  gate: {
    contents: 'write',
    pull_requests: 'write',
    checks: 'read',
    statuses: 'read',
    // Read-only, so the review pack can show a preview the repository's pipeline published (step 3, previews).
    deployments: 'read',
    metadata: 'read',
  },
};

export function buildManifest(kind: AppKind, publicUrl: string, nameSuffix: string): AppManifest {
  const label = kind === 'agent' ? 'Agent' : 'Gate';
  // GitHub rejects a webhook URL it cannot reach from the internet, even an inactive one (checked 2026-10-17).
  // Local development has no public endpoint, so no webhook is declared and the platform polls instead.
  const { hostname } = new URL(publicUrl);
  const reachable = !['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  return {
    name: `Autonomous SDLC ${label} ${nameSuffix}`.slice(0, 34),
    url: publicUrl,
    ...(reachable
      ? { hook_attributes: { url: `${publicUrl}/webhooks/github`, active: true } }
      : {}),
    redirect_url: `${publicUrl}/admin/github/created`,
    setup_url: `${publicUrl}/admin/github/installed?kind=${kind}`,
    setup_on_update: true,
    public: false,
    default_permissions: PERMISSIONS[kind],
    default_events: [],
  };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A short-lived JWT that proves we are the App (RS256, valid for 9 minutes). */
export function appJwt(
  appId: number | string,
  privateKeyPem: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // Issued 30 seconds in the past to tolerate clock drift, as GitHub recommends.
  const body = b64url(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: String(appId) }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

export interface ConvertedApp {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
  owner: { login: string };
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class GitHubClient {
  constructor(
    private readonly apiUrl: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  /** One call to the GitHub REST API. The token may be an App JWT, an installation token, or null. */
  async call<T>(method: string, path: string, auth: string | null, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'autonomous-sdlc',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // keep the raw text
      }
      throw new GitHubError(
        res.status,
        `GitHub ${method} ${path} failed (${res.status}): ${message}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Step 3 of the manifest flow: trade the one-time code for the App's credentials. */
  convertManifest(code: string): Promise<ConvertedApp> {
    return this.call('POST', `/app-manifests/${encodeURIComponent(code)}/conversions`, null);
  }

  getApp(
    jwt: string,
  ): Promise<{ id: number; slug: string; name: string; permissions: Record<string, string> }> {
    return this.call('GET', '/app', jwt);
  }

  getInstallation(
    jwt: string,
    installationId: number,
  ): Promise<{
    id: number;
    account: { login: string };
    repository_selection: 'all' | 'selected';
    permissions: Record<string, string>;
  }> {
    return this.call('GET', `/app/installations/${installationId}`, jwt);
  }

  /** A token for one installation, limited to the named repositories and permissions. */
  createInstallationToken(
    jwt: string,
    installationId: number,
    scope: { repositories?: string[]; permissions?: Record<string, 'read' | 'write'> } = {},
  ): Promise<{
    token: string;
    expires_at: string;
    repository_selection: string;
    permissions: Record<string, string>;
  }> {
    return this.call('POST', `/app/installations/${installationId}/access_tokens`, jwt, scope);
  }

  listInstallationRepositories(token: string): Promise<{
    total_count: number;
    repositories: Array<{ full_name: string; private: boolean }>;
  }> {
    return this.call('GET', '/installation/repositories?per_page=100', token);
  }
}

export const secretName = (
  kind: AppKind,
  what: 'private_key' | 'webhook_secret' | 'client_secret',
) => `github/${kind}/${what}`;

/** Stores the secret parts of a converted App. Only the non-secret parts go to the database. */
export async function storeAppSecrets(
  secrets: SecretsStore,
  kind: AppKind,
  app: ConvertedApp,
): Promise<void> {
  await secrets.put(secretName(kind, 'private_key'), app.pem);
  await secrets.put(secretName(kind, 'client_secret'), app.client_secret);
  if (app.webhook_secret) await secrets.put(secretName(kind, 'webhook_secret'), app.webhook_secret);
}
