import picomatch from 'picomatch';

// Deterministic triggers (spec 5.2 layer 2). Rules, not model judgment: the same diff always gives the same answer.

export type TriggerAction = 'require_review' | 'require_checkpoint' | 'hard_stop';

export interface TriggerWhen {
  paths_any?: string[];
  paths_all?: string[];
  dependency_added?: boolean;
  tests_deleted_or_skipped?: boolean;
  lines_changed_over?: number;
  touches_protected_path?: boolean;
}

export interface TriggerRule {
  id: string;
  description?: string;
  when: TriggerWhen;
  action: TriggerAction;
}

export interface PreApprovedType {
  id: string;
  when: TriggerWhen;
  owner?: string;
  review_by?: string | Date;
}

export interface RuleSet {
  version: number;
  triggers: TriggerRule[];
  pre_approved_change_types: PreApprovedType[];
}

/** Everything the rules look at, computed from the diff by whoever holds the checkout. */
export interface DiffSummary {
  changedPaths: string[];
  linesChanged: number;
  dependencyAdded: boolean;
  testsDeletedOrSkipped: boolean;
  protectedPathsTouched: string[];
}

export interface FiredTrigger {
  id: string;
  action: TriggerAction;
  description?: string;
}

const glob = (patterns: string[]) => picomatch(patterns, { dot: true });

/** Paths that match any of the globs. Used for the protected-path check before every push. */
export function matchingPaths(paths: string[], globs: string[]): string[] {
  if (globs.length === 0) return [];
  const isMatch = glob(globs);
  return paths.filter((p) => isMatch(p));
}

function holds(when: TriggerWhen, d: DiffSummary): boolean {
  const checks: boolean[] = [];
  if (when.paths_any) checks.push(matchingPaths(d.changedPaths, when.paths_any).length > 0);
  if (when.paths_all) {
    checks.push(
      d.changedPaths.length > 0 &&
        matchingPaths(d.changedPaths, when.paths_all).length === d.changedPaths.length,
    );
  }
  if (when.dependency_added !== undefined) checks.push(d.dependencyAdded === when.dependency_added);
  if (when.tests_deleted_or_skipped !== undefined)
    checks.push(d.testsDeletedOrSkipped === when.tests_deleted_or_skipped);
  if (when.lines_changed_over !== undefined) checks.push(d.linesChanged > when.lines_changed_over);
  if (when.touches_protected_path !== undefined)
    checks.push(d.protectedPathsTouched.length > 0 === when.touches_protected_path);
  // A rule with no conditions never fires. Better silent than firing on everything.
  return checks.length > 0 && checks.every(Boolean);
}

export function evaluateTriggers(rules: RuleSet, d: DiffSummary): FiredTrigger[] {
  return rules.triggers
    .filter((t) => holds(t.when, d))
    .map((t) => ({ id: t.id, action: t.action, description: t.description }));
}

/** The first pre-approved change type the diff fits, if no trigger fired and the review date has not passed. */
export function matchPreApproved(
  rules: RuleSet,
  d: DiffSummary,
  fired: FiredTrigger[],
  now = new Date(),
): PreApprovedType | null {
  if (fired.length > 0) return null;
  for (const p of rules.pre_approved_change_types) {
    if (p.review_by && new Date(p.review_by).getTime() < now.getTime()) continue;
    if (holds(p.when, d)) return p;
  }
  return null;
}

/** Strongest action wins: a hard stop beats a checkpoint beats a review. */
export function strongestAction(fired: FiredTrigger[]): TriggerAction | null {
  const order: TriggerAction[] = ['hard_stop', 'require_checkpoint', 'require_review'];
  for (const a of order) if (fired.some((f) => f.action === a)) return a;
  return null;
}

const TEST_PATH = picomatch(
  [
    '**/*.test.*',
    '**/*.spec.*',
    '**/test/**',
    '**/tests/**',
    '**/__tests__/**',
    '**/test_*.py',
    '**/*_test.py',
  ],
  { dot: true },
);
const SKIP_MARKER =
  /\b(?:it|test|describe)\.(?:skip|only)\s*\(|\bx(?:it|describe)\s*\(|@pytest\.mark\.skip|\bt\.skip\s*\(|\{\s*skip\s*:\s*true/;

/** True if a test file was deleted, or a line that skips or isolates a test was added. */
export function testsDeletedOrSkipped(deletedPaths: string[], addedLines: string[]): boolean {
  return deletedPaths.some((p) => TEST_PATH(p)) || addedLines.some((l) => SKIP_MARKER.test(l));
}

/** True if package.json gained a dependency of any kind. */
export function dependencyAddedInPackageJson(before: string | null, after: string | null): boolean {
  if (after === null) return false;
  const names = (text: string | null): Set<string> => {
    if (text === null) return new Set();
    try {
      const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      return new Set(
        ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
          (k) => Object.keys(j[k] ?? {}),
        ),
      );
    } catch {
      return new Set();
    }
  };
  const was = names(before);
  return [...names(after)].some((n) => !was.has(n));
}
