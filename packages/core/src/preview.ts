// What the review pack says about a preview of a pull request (spec 10.1, mvp-contract section 16, previews).
// The repository's own pipeline builds and hosts the preview and reports it to GitHub, either as a Deployment or as
// a commit status whose name contains "preview". The platform only reads that report. These rules are pure.

export type PreviewState = 'ready' | 'building' | 'failed' | 'stale' | 'none' | 'not_permitted';

export interface PreviewCandidate {
  source: 'deployment' | 'status';
  /** The commit the pipeline built. */
  sha: string;
  state: 'success' | 'pending' | 'failure';
  url?: string;
  /** The Deployment's environment, or the status's name. */
  label?: string;
  /** When it was reported (ISO). The newest report for a commit wins. */
  at: string;
}

export interface Preview {
  state: PreviewState;
  url: string | null;
  label: string | null;
  source: 'deployment' | 'status' | null;
  /** The commit the preview was built from, when there is one. */
  sha: string | null;
  /** The commit the pull request is at now. */
  headSha: string;
  detail: string;
}

/** Only web addresses become links. Anything else (a javascript: address, say) is dropped. */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Maps a Deployment status or a commit status to the three states the review pack distinguishes. `null` means ignore it. */
export function normalizePreviewState(raw: string): PreviewCandidate['state'] | null {
  switch (raw) {
    case 'success':
      return 'success';
    case 'pending':
    case 'queued':
    case 'in_progress':
      return 'pending';
    case 'failure':
    case 'error':
      return 'failure';
    default:
      // "inactive" means the environment was replaced or torn down.
      return null;
  }
}

const short = (sha: string) => sha.slice(0, 7);

const newest = (a: PreviewCandidate[]) =>
  [...a].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];

/**
 * Picks what to show for a pull request now at `headSha`. A usable preview of the current commit beats everything.
 * A preview of an older commit is shown as stale, never as ready, because a reviewer would be approving code they did
 * not look at. `deploymentsReadable` is false when GitHub refused to list Deployments (the App lacks the permission).
 */
export function choosePreview(
  headSha: string,
  candidates: PreviewCandidate[],
  deploymentsReadable: boolean,
): Preview {
  const base = { url: null, label: null, source: null, sha: null, headSha } as const;
  const current = candidates.filter((c) => c.sha === headSha);

  const ready = newest(current.filter((c) => c.state === 'success' && c.url));
  // A newer failure or pending report for the same commit means the pipeline is redoing it.
  const latest = newest(current);
  if (ready && (!latest || latest === ready || Date.parse(latest.at) <= Date.parse(ready.at))) {
    return {
      state: 'ready',
      url: ready.url ?? null,
      label: ready.label ?? null,
      source: ready.source,
      sha: ready.sha,
      headSha,
      detail: `Built from ${short(headSha)}, the current commit.`,
    };
  }
  if (latest?.state === 'pending') {
    return {
      ...base,
      state: 'building',
      label: latest.label ?? null,
      source: latest.source,
      sha: latest.sha,
      detail: 'The pipeline is still building the preview.',
    };
  }
  if (latest?.state === 'failure') {
    return {
      ...base,
      state: 'failed',
      label: latest.label ?? null,
      source: latest.source,
      sha: latest.sha,
      url: latest.url ?? null,
      detail: 'The pipeline reported that the preview failed.',
    };
  }

  const older = newest(
    candidates.filter((c) => c.sha !== headSha && c.state === 'success' && c.url),
  );
  if (older) {
    return {
      state: 'stale',
      url: older.url ?? null,
      label: older.label ?? null,
      source: older.source,
      sha: older.sha,
      headSha,
      detail: `This preview was built from ${short(older.sha)}. The pull request is now at ${short(headSha)}.`,
    };
  }

  if (!deploymentsReadable) {
    return {
      ...base,
      state: 'not_permitted',
      detail:
        'No preview was reported as a commit status, and the Gate App cannot read Deployments. Accept its "Deployments: read" permission on GitHub to see those.',
    };
  }
  return {
    ...base,
    state: 'none',
    detail:
      'The repository has not reported a preview for this pull request. Its pipeline can create a GitHub Deployment, or a commit status with "preview" in its name.',
  };
}
