/**
 * What a person should know about a repository before registering it: is it empty, does it already hold a project, does it
 * look like it holds several apps. Pure text-in, text-out; the GitHub reads are in GitHubService.inspect.
 */

export type RepositoryShape = 'empty' | 'starter' | 'project' | 'multi_app';

export interface RepositoryFacts {
  empty: boolean;
  defaultBranch: string | null;
  archived: boolean;
  /** Every file path on the default branch (GitHub may cut a very large repository short: see `truncated`). */
  paths: string[];
  truncated: boolean;
  lastCommitAt: string | null;
}

export interface RepositoryInspection {
  shape: RepositoryShape;
  defaultBranch: string | null;
  fileCount: number;
  lastCommitAt: string | null;
  archived: boolean;
  /** The kinds of project found, by their manifest files (Node.js, Java (Maven), and so on). */
  stacks: string[];
  /** Folders (not the root) that hold a manifest of their own. */
  appFolders: string[];
  /** The person must tick a box before adding it. Only when it looks like more than one app. */
  needsAcknowledgement: boolean;
  headline: string;
  details: string[];
}

const MANIFESTS: Array<[RegExp, string]> = [
  [/^package\.json$/, 'Node.js'],
  [/^pom\.xml$/, 'Java (Maven)'],
  [/^build\.gradle(\.kts)?$/, 'Java or Kotlin (Gradle)'],
  [/^(pyproject\.toml|requirements\.txt|setup\.py)$/, 'Python'],
  [/^go\.mod$/, 'Go'],
  [/^Cargo\.toml$/, 'Rust'],
  [/^Gemfile$/, 'Ruby'],
  [/^composer\.json$/, 'PHP'],
  [/\.(csproj|sln)$/, '.NET'],
  [/^Package\.swift$/, 'Swift'],
  [/^mix\.exs$/, 'Elixir'],
];

/** A tool at the root that says the folders below it are parts of one project, not separate apps. */
const WORKSPACE_FILES = new Set([
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  'rush.json',
  'settings.gradle',
  'settings.gradle.kts',
]);

/** Folders that never hold an app of their own. */
const IGNORED =
  /(^|\/)(node_modules|vendor|dist|build|target|\.venv|venv|__pycache__|\.next|\.terraform)(\/|$)/;
const SUPPORT_FOLDERS = new Set([
  'docs',
  'doc',
  'examples',
  'example',
  'test',
  'tests',
  'e2e',
  'scripts',
  'tools',
  'spikes',
  'demo',
  'infra',
  'designs',
]);
/** What a new repository starts with when the person ticked "add a README", a licence or a .gitignore. */
const STARTER =
  /^(README(\.\w+)?|LICENSE(\.\w+)?|COPYING|\.gitignore|\.gitattributes|\.editorconfig)$/i;

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function manifestKind(file: string): string | null {
  for (const [re, kind] of MANIFESTS) if (re.test(file)) return kind;
  return null;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function describeRepository(f: RepositoryFacts): RepositoryInspection {
  const common = {
    defaultBranch: f.defaultBranch,
    lastCommitAt: f.lastCommitAt,
    archived: f.archived,
  };
  const archivedNote = f.archived
    ? ['It is archived on GitHub, so nobody can push to it. Unarchive it before agents work on it.']
    : [];

  if (f.empty) {
    return {
      ...common,
      shape: 'empty',
      fileCount: 0,
      stacks: [],
      appFolders: [],
      needsAcknowledgement: false,
      headline: 'This repository is empty.',
      details: [
        'There is nothing in it to overwrite. After you add it, Check readiness offers to make its first commit.',
        ...archivedNote,
      ],
    };
  }

  const paths = f.paths.filter((p) => !IGNORED.test(p));
  const rootFiles = paths.filter((p) => !p.includes('/'));
  const branchNote =
    f.defaultBranch && f.defaultBranch !== 'main'
      ? [`Its default branch is ${f.defaultBranch}, so that is where agents deliver.`]
      : [];

  if (paths.length > 0 && paths.every((p) => !p.includes('/') && STARTER.test(p))) {
    return {
      ...common,
      shape: 'starter',
      fileCount: paths.length,
      stacks: [],
      appFolders: [],
      needsAcknowledgement: false,
      headline: 'It holds only a README, licence or similar starter files.',
      details: [
        'It is treated like a new repository: nothing is overwritten, and the first design task sets up the verify command and its CI check.',
        ...branchNote,
        ...archivedNote,
      ],
    };
  }

  const stacks = new Set<string>();
  const rootManifest = rootFiles.some((p) => manifestKind(p));
  const folders = new Set<string>();
  for (const p of paths) {
    const kind = manifestKind(base(p));
    if (!kind) continue;
    const d = dir(p);
    if (SUPPORT_FOLDERS.has(d.split('/')[0]!)) continue;
    stacks.add(kind);
    if (d && d.split('/').length <= 2) folders.add(d);
  }
  const appFolders = [...folders].sort();
  const workspace =
    rootFiles.some((p) => WORKSPACE_FILES.has(p)) ||
    (rootFiles.includes('pom.xml') && appFolders.length > 0);
  const multi = !workspace && appFolders.length >= 2;

  const kinds = [...stacks].sort();
  const facts = [
    kinds.length ? kinds.join(' and ') : 'no recognised project file',
    `${f.paths.length}${f.truncated ? '+' : ''} files`,
    f.lastCommitAt ? `last commit ${day(f.lastCommitAt)}` : null,
  ].filter(Boolean);

  if (multi) {
    return {
      ...common,
      shape: 'multi_app',
      fileCount: f.paths.length,
      stacks: kinds,
      appFolders,
      needsAcknowledgement: true,
      headline: `It looks like it holds more than one app (${appFolders.slice(0, 4).join(', ')}${appFolders.length > 4 ? ', …' : ''}). ${facts.join(', ')}.`,
      details: [
        'Nothing is overwritten: agents work on branches and open pull requests, and the main branch changes only when a person approves.',
        'The platform previews, smoke-tests and verifies one app, from the repository root. It cannot do that for each app here. A separate app is best given its own repository (docs/ADOPTING.md, step 8, shows how to split one out and keep its history).',
        ...branchNote,
        ...archivedNote,
      ],
    };
  }

  const details = [
    'Nothing is overwritten. Agents work on branches and open pull requests, and the main branch changes only when a person approves and the checks pass. New work is added next to what is already there.',
  ];
  if (!rootManifest && appFolders.length === 1) {
    details.push(
      `Its project files are in ${appFolders[0]}/, but the platform previews and verifies from the repository root. Put the app at the root, or set the verify command to run from there.`,
    );
  } else if (!rootManifest && kinds.length === 0) {
    details.push(
      'It has no project file the platform recognises, so Check readiness cannot look for a verify script. You can still set the verify command by hand.',
    );
  }
  if (f.truncated)
    details.push('It is very large: GitHub listed only part of it, so these numbers are a floor.');
  details.push(...branchNote, ...archivedNote);
  return {
    ...common,
    shape: 'project',
    fileCount: f.paths.length,
    stacks: kinds,
    appFolders,
    needsAcknowledgement: false,
    headline: `It already has code: ${facts.join(', ')}.`,
    details,
  };
}
