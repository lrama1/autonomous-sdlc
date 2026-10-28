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
  /** The change puts text into page markup without clear escaping (a possible cross-site scripting hole). */
  writes_unescaped_html?: boolean;
}

export interface TriggerRule {
  id: string;
  description?: string;
  when: TriggerWhen;
  action: TriggerAction;
  /** Kinds of initiative this rule does not apply to (for example new_app, which adds its own dependencies and is large). */
  except_kinds?: string[];
}

export interface PreApprovedType {
  id: string;
  when: TriggerWhen;
  owner?: string;
  review_by?: string | Date;
}

/** A protected path a person has decided, ahead of time, an agent may edit when its task asks for that very file. */
export interface PreApprovedPath {
  id: string;
  description?: string;
  paths: string[];
  owner?: string;
  review_by?: string | Date;
}

export interface RuleSet {
  version: number;
  triggers: TriggerRule[];
  pre_approved_change_types: PreApprovedType[];
  pre_approved_protected_paths?: PreApprovedPath[];
}

/** Everything the rules look at, computed from the diff by whoever holds the checkout. */
export interface DiffSummary {
  changedPaths: string[];
  linesChanged: number;
  dependencyAdded: boolean;
  testsDeletedOrSkipped: boolean;
  protectedPathsTouched: string[];
  /** Optional so a runner built before this rule existed still fits: absent means no. */
  unsafeHtml?: boolean;
  /** The names of the dependencies the change added. Optional so a runner built before this fits. */
  dependenciesAdded?: string[];
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
  if (when.writes_unescaped_html !== undefined)
    checks.push((d.unsafeHtml ?? false) === when.writes_unescaped_html);
  // A rule with no conditions never fires. Better silent than firing on everything.
  return checks.length > 0 && checks.every(Boolean);
}

export function evaluateTriggers(
  rules: RuleSet,
  d: DiffSummary,
  ctx: { kind?: string | null } = {},
): FiredTrigger[] {
  return rules.triggers
    .filter((t) => !(ctx.kind && t.except_kinds?.includes(ctx.kind)))
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

/** The pre-approved path rule that covers every one of these paths, if its review date has not passed. */
export function matchPreApprovedPaths(
  rules: RuleSet,
  paths: string[],
  now = new Date(),
): PreApprovedPath | null {
  if (paths.length === 0) return null;
  for (const p of rules.pre_approved_protected_paths ?? []) {
    if (p.review_by && new Date(p.review_by).getTime() < now.getTime()) continue;
    if (matchingPaths(paths, p.paths).length === paths.length) return p;
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

/** The names of the dependencies package.json gained, of any kind. */
export function dependencyNamesAdded(before: string | null, after: string | null): string[] {
  if (after === null) return [];
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
  return [...names(after)].filter((n) => !was.has(n)).sort();
}

/** True if package.json gained a dependency of any kind. */
export function dependencyAddedInPackageJson(before: string | null, after: string | null): boolean {
  return dependencyNamesAdded(before, after).length > 0;
}

/**
 * Which of these package names a document (an approved design) mentions by name. A name inside a longer one does not count: 
eact
 * is not named by react-dom, nor material by @mui/material.
 */
export function dependenciesNamedIn(
  text: string,
  names: string[],
): { named: string[]; unnamed: string[] } {
  const named: string[] = [];
  const unnamed: string[] = [];
  for (const n of names) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    (new RegExp(`(?<![\\w@/.-])${escaped}(?![\\w-])`).test(text) ? named : unnamed).push(n);
  }
  return { named, unnamed };
}

// Writing text into page markup. `textContent` and DOM calls are safe; these are the ways to hand a string to the HTML
// parser, which is where a name like <img onerror=...> becomes script. A literal with nothing in it that varies is fine.
const ASSIGN_SINK = /(?:innerHTML|outerHTML)\s*\+?=\s*(.*)$/;
const CALL_SINK = /\b(?:insertAdjacentHTML|document\.write(?:ln)?)\s*\((.*)$/;
const FRAMEWORK_SINK = /dangerouslySetInnerHTML|\bv-html\b|\[innerHTML\]|\.html\s*\(\s*[^)\s]/;
const PLAIN_LITERAL = /^\s*(?:'[^'\\]*'|"[^"\\]*"|`[^`$\\]*`)\s*\)?\s*;?\s*(?:\/\/.*)?$/;
const SANITIZED =
  /^\s*(?:escapeHtml|escapeHTML|escape|sanitize|sanitizeHtml|DOMPurify\.sanitize)\s*\(/;
// An inline event handler written into markup with a value in it: the value ends up inside an attribute and inside script.
const INLINE_HANDLER =
  /\bon[a-z]{3,}\s*=\s*(?:\\?"[^"]*\$\{|'[^']*\$\{|\\?["'][^"']*['"]\s*\+\s*\w)/i;
const STRING_LITERALS = /'[^'\\]*'|"[^"\\]*"|`[^`$\\]*`/g;

/**
 * True if an added line hands a string that is not a fixed literal to the HTML parser: an `innerHTML` or `outerHTML`
 * assignment, `insertAdjacentHTML`, `document.write`, a framework's raw-HTML escape hatch, or an inline event handler
 * (`onclick="...${value}..."`) built from a value. It is a flag for a person
 * to look, not a proof: a call to a function named escape-something on the right-hand side is taken as escaping.
 */
export function writesUnescapedHtml(addedLines: string[]): boolean {
  return addedLines.some((raw) => {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('#')) return false;
    if (FRAMEWORK_SINK.test(line) || INLINE_HANDLER.test(line)) return true;
    const assign = ASSIGN_SINK.exec(line);
    if (assign) return !PLAIN_LITERAL.test(assign[1]!) && !SANITIZED.test(assign[1]!);
    const call = CALL_SINK.exec(line);
    if (call) return /[A-Za-z_$]/.test(call[1]!.replace(STRING_LITERALS, ''));
    return false;
  });
}
