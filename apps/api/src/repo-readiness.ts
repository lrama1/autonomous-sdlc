import { parse } from 'yaml';

type Status = 'ok' | 'problem' | 'unknown';
export interface ReadinessCheck {
  id: 'apps' | 'branch' | 'verify' | 'ci' | 'protection';
  label: string;
  status: Status;
  detail: string;
  /** Something the platform can do for the person with one click. */
  fix?: { kind: 'first_commit'; path: string; content: string; message: string };
  /** Something only the person can do, step by step. */
  howTo?: { steps: string[]; link?: string };
}

/** The one file the platform writes into an empty repository so that the integration branch exists. */
export function firstCommitFor(fullName: string): {
  kind: 'first_commit';
  path: string;
  content: string;
  message: string;
} {
  const name = fullName.split('/')[1] ?? fullName;
  return {
    kind: 'first_commit',
    path: 'README.md',
    content: `# ${name}\n\nStarted by Autonomous SDLC, so that agents have a main branch to work from.\n`,
    message: 'Start the repository',
  };
}

/** What the checks read from GitHub. The Gate App does the reading. */
export interface RepoReader {
  branchInfo(repo: string, branch: string): Promise<{ sha: string; protected: boolean } | null>;
  isEmpty(repo: string): Promise<boolean>;
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
      {
        id: 'protection',
        label: `The branch ${repo.integrationBranch} is protected`,
        status: 'unknown',
        detail: needApps,
      },
    ];
  }

  let head: string | null = null;
  let isProtected = false;
  const branchLabel = `The branch ${repo.integrationBranch} exists`;
  try {
    const info = await github.branchInfo(repo.fullName, repo.integrationBranch);
    if (info) {
      head = info.sha;
      isProtected = info.protected;
      out.push({
        id: 'branch',
        label: branchLabel,
        status: 'ok',
        detail: `It points at ${info.sha.slice(0, 7)}.`,
      });
    } else if (await github.isEmpty(repo.fullName)) {
      out.push({
        id: 'branch',
        label: branchLabel,
        status: 'problem',
        detail: `This repository has no commits yet, so agents have nothing to start from. Create the first commit and ${repo.integrationBranch} will exist.`,
        fix: firstCommitFor(repo.fullName),
      });
    } else {
      out.push({
        id: 'branch',
        label: branchLabel,
        status: 'problem',
        detail: `There is no branch called ${repo.integrationBranch}. Push it, or change the integration branch to one that exists.`,
      });
    }
  } catch (e) {
    out.push({
      id: 'branch',
      label: branchLabel,
      status: 'unknown',
      detail: `Could not ask GitHub: ${message(e)}`,
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
  const protectionLabel = `The branch ${repo.integrationBranch} is protected`;
  if (!head) {
    out.push({
      id: 'protection',
      label: protectionLabel,
      status: 'unknown',
      detail: 'Needs the branch first.',
    });
  } else if (isProtected) {
    out.push({
      id: 'protection',
      label: protectionLabel,
      status: 'ok',
      detail:
        'GitHub applies a rule to it. Check that the rule asks for the pull request, one approval and the check below.',
    });
  } else {
    out.push({
      id: 'protection',
      label: protectionLabel,
      status: 'problem',
      detail: `Nothing stops a direct push to ${repo.integrationBranch}, and the Gate's approval is not what allows a merge. Protect it once the ${repo.requiredCheck} check has run on a pull request, because GitHub can only require a check it has seen.`,
      howTo: {
        link: `https://github.com/${repo.fullName}/settings/rules/new?target=branch`,
        steps: [
          `Name the rule, and target the branch ${repo.integrationBranch}.`,
          'Turn on "Require a pull request before merging", with 1 required approval and "Dismiss stale pull request approvals when new commits are pushed".',
          `Turn on "Require status checks to pass", and add ${repo.requiredCheck}. It appears in the list after the check has run once.`,
          'Turn on "Block force pushes", and set Enforcement to Active.',
          'On a free GitHub plan a private repository cannot enforce rules. Use a public repository or a paid plan.',
        ],
      },
    });
  }
  return out;
}
