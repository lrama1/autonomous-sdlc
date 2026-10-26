import { parse } from 'yaml';
import { GitHubError } from './github-app.js';

type Status = 'ok' | 'problem' | 'unknown';
export interface ReadinessCheck {
  id: 'apps' | 'branch' | 'verify' | 'ci';
  label: string;
  status: Status;
  detail: string;
}

/** What the checks read from GitHub. The Gate App does the reading. */
export interface RepoReader {
  branchHead(repo: string, branch: string): Promise<string>;
  readFile(repo: string, filePath: string, ref: string): Promise<string | null>;
  listFiles(repo: string, dir: string, ref: string): Promise<string[]>;
}

export interface RepoToCheck {
  fullName: string;
  integrationBranch: string;
  verifyCommand: string;
  requiredCheck: string;
}

export interface AppState {
  kind: string;
  installationId: number | null;
  installedOn: string[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `npm run verify`, `pnpm verify` and `yarn run verify` name a package.json script. Anything else is a command we cannot look up. */
export function scriptOf(command: string): string | null {
  const m = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)$/.exec(command.trim());
  return m ? m[1]! : null;
}

function triggersOnPullRequest(on: unknown): boolean {
  if (typeof on === 'string') return on === 'pull_request';
  if (Array.isArray(on)) return on.includes('pull_request');
  if (on && typeof on === 'object') return 'pull_request' in on;
  return false;
}

/** The jobs of a workflow file whose check name is `required`, and whether the workflow runs on pull requests. */
export function workflowProvides(
  text: string,
  required: string,
): { provides: boolean; onPullRequest: boolean } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return { provides: false, onPullRequest: false };
  }
  const w = doc as { on?: unknown; jobs?: Record<string, { name?: unknown } | null> } | null;
  const jobs = w && typeof w.jobs === 'object' && w.jobs ? Object.entries(w.jobs) : [];
  const provides = jobs.some(([key, job]) => {
    const name = typeof job?.name === 'string' ? job.name : key;
    return name === required || name.startsWith(`${required} (`);
  });
  return { provides, onPullRequest: triggersOnPullRequest(w?.on) };
}

export async function checkReadiness(
  repo: RepoToCheck,
  apps: AppState[],
  github: RepoReader,
): Promise<ReadinessCheck[]> {
  const out: ReadinessCheck[] = [];

  const missing = (['agent', 'gate'] as const).filter((kind) => {
    const a = apps.find((x) => x.kind === kind);
    return !a?.installationId || !a.installedOn.includes(repo.fullName);
  });
  out.push({
    id: 'apps',
    label: 'Both GitHub Apps are installed on it',
    status: missing.length === 0 ? 'ok' : 'problem',
    detail:
      missing.length === 0
        ? 'The Agent App and the Gate App can both reach it.'
        : `Install the ${missing.join(' and ')} GitHub App on ${repo.fullName}, then refresh. See GitHub setup.`,
  });
  const needApps = 'Needs both GitHub Apps first.';
  if (missing.length > 0) {
    return [
      ...out,
      {
        id: 'branch',
        label: `The branch ${repo.integrationBranch} exists`,
        status: 'unknown',
        detail: needApps,
      },
      { id: 'verify', label: 'The verify command exists', status: 'unknown', detail: needApps },
      {
        id: 'ci',
        label: `A CI check named ${repo.requiredCheck} runs on pull requests`,
        status: 'unknown',
        detail: needApps,
      },
    ];
  }

  let head: string | null = null;
  const branchLabel = `The branch ${repo.integrationBranch} exists`;
  try {
    head = await github.branchHead(repo.fullName, repo.integrationBranch);
    out.push({
      id: 'branch',
      label: branchLabel,
      status: 'ok',
      detail: `It points at ${head.slice(0, 7)}.`,
    });
  } catch (e) {
    const gone = e instanceof GitHubError && e.status === 404;
    out.push({
      id: 'branch',
      label: branchLabel,
      status: gone ? 'problem' : 'unknown',
      detail: gone
        ? `There is no branch called ${repo.integrationBranch}. Push a first commit to it, or change the integration branch.`
        : `Could not ask GitHub: ${message(e)}`,
    });
  }

  const verifyLabel = `The verify command exists (${repo.verifyCommand})`;
  const script = scriptOf(repo.verifyCommand);
  if (!head) {
    out.push({
      id: 'verify',
      label: verifyLabel,
      status: 'unknown',
      detail: 'Needs the branch first.',
    });
  } else if (!script) {
    out.push({
      id: 'verify',
      label: verifyLabel,
      status: 'unknown',
      detail: 'This is not an npm, pnpm or yarn script, so it cannot be looked up from here.',
    });
  } else {
    try {
      const text = await github.readFile(repo.fullName, 'package.json', repo.integrationBranch);
      let scripts: Record<string, unknown> | null = null;
      try {
        scripts = text
          ? ((JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {})
          : null;
      } catch {
        scripts = null;
      }
      const found = scripts !== null && typeof scripts[script] === 'string';
      out.push({
        id: 'verify',
        label: verifyLabel,
        status: found ? 'ok' : 'problem',
        detail: found
          ? `package.json has a "${script}" script.`
          : text === null
            ? `There is no readable package.json on ${repo.integrationBranch}. Add one with a "${script}" script, or change the verify command.`
            : `package.json has no "${script}" script. Add one that runs the tests, or change the verify command.`,
      });
    } catch (e) {
      out.push({
        id: 'verify',
        label: verifyLabel,
        status: 'unknown',
        detail: `Could not ask GitHub: ${message(e)}`,
      });
    }
  }

  const ciLabel = `A CI check named ${repo.requiredCheck} runs on pull requests`;
  if (!head) {
    out.push({ id: 'ci', label: ciLabel, status: 'unknown', detail: 'Needs the branch first.' });
  } else {
    try {
      const files = (
        await github.listFiles(repo.fullName, '.github/workflows', repo.integrationBranch)
      ).filter((f) => /\.ya?ml$/.test(f));
      let provided = false;
      let onPr = false;
      for (const f of files) {
        const text = await github.readFile(
          repo.fullName,
          `.github/workflows/${f}`,
          repo.integrationBranch,
        );
        if (!text) continue;
        const w = workflowProvides(text, repo.requiredCheck);
        if (w.provides) {
          provided = true;
          onPr ||= w.onPullRequest;
        }
      }
      const status: Status = provided && onPr ? 'ok' : 'problem';
      out.push({
        id: 'ci',
        label: ciLabel,
        status,
        detail:
          status === 'ok'
            ? 'A workflow with that job runs on pull requests.'
            : provided
              ? `A workflow has a job called ${repo.requiredCheck}, but it does not run on pull_request.`
              : files.length === 0
                ? `There is no workflow in .github/workflows on ${repo.integrationBranch}. Add one whose job is called ${repo.requiredCheck} and runs the verify command.`
                : `No workflow has a job called ${repo.requiredCheck}. Add one, or change the required check.`,
      });
    } catch (e) {
      out.push({
        id: 'ci',
        label: ciLabel,
        status: 'unknown',
        detail: `Could not ask GitHub: ${message(e)}`,
      });
    }
  }
  return out;
}
