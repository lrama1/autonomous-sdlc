import { describe, expect, it } from 'vitest';
import {
  dependencyAddedInPackageJson,
  evaluateTriggers,
  matchPreApproved,
  matchingPaths,
  strongestAction,
  testsDeletedOrSkipped,
} from './triggers.js';
import type { DiffSummary, RuleSet } from './triggers.js';

const rules: RuleSet = {
  version: 1,
  triggers: [
    { id: 'protected-path', when: { touches_protected_path: true }, action: 'hard_stop' },
    {
      id: 'auth-code',
      when: { paths_any: ['**/auth/**', '**/*session*'] },
      action: 'require_review',
    },
    { id: 'new-dependency', when: { dependency_added: true }, action: 'require_review' },
    { id: 'tests-removed', when: { tests_deleted_or_skipped: true }, action: 'require_review' },
    { id: 'large-diff', when: { lines_changed_over: 800 }, action: 'require_review' },
    { id: 'empty', when: {}, action: 'hard_stop' },
  ],
  pre_approved_change_types: [
    { id: 'docs-only', when: { paths_all: ['**/*.md', 'docs/**'] }, review_by: '2027-01-15' },
  ],
};

const diff = (o: Partial<DiffSummary> = {}): DiffSummary => ({
  changedPaths: ['src/server.js'],
  linesChanged: 20,
  dependencyAdded: false,
  testsDeletedOrSkipped: false,
  protectedPathsTouched: [],
  ...o,
});

describe('matchingPaths', () => {
  it('matches globs including dotfiles and nested folders', () => {
    expect(
      matchingPaths(
        ['.github/workflows/ci.yml', 'src/a.js', 'docs/x/y.md'],
        ['.github/workflows/**', 'docs/**'],
      ),
    ).toEqual(['.github/workflows/ci.yml', 'docs/x/y.md']);
  });
  it('matches a bare file name at the root only when written that way', () => {
    expect(matchingPaths(['CODEOWNERS', 'src/CODEOWNERS'], ['CODEOWNERS'])).toEqual(['CODEOWNERS']);
  });
  it('with no globs nothing is protected', () => {
    expect(matchingPaths(['a'], [])).toEqual([]);
  });
});

describe('evaluateTriggers', () => {
  it('fires nothing for an ordinary change', () => {
    expect(evaluateTriggers(rules, diff())).toEqual([]);
  });
  it('fires on a path pattern', () => {
    expect(
      evaluateTriggers(rules, diff({ changedPaths: ['src/auth/login.ts'] })).map((t) => t.id),
    ).toEqual(['auth-code']);
    expect(
      evaluateTriggers(rules, diff({ changedPaths: ['lib/user-session.ts'] })).map((t) => t.id),
    ).toEqual(['auth-code']);
  });
  it('fires on a new dependency, removed tests, and a large diff', () => {
    const ids = evaluateTriggers(
      rules,
      diff({ dependencyAdded: true, testsDeletedOrSkipped: true, linesChanged: 801 }),
    ).map((t) => t.id);
    expect(ids).toEqual(['new-dependency', 'tests-removed', 'large-diff']);
  });
  it('a diff of exactly 800 lines is not large', () => {
    expect(evaluateTriggers(rules, diff({ linesChanged: 800 }))).toEqual([]);
  });
  it('a protected path is a hard stop', () => {
    const fired = evaluateTriggers(
      rules,
      diff({ protectedPathsTouched: ['.github/workflows/ci.yml'] }),
    );
    expect(fired.map((t) => t.id)).toEqual(['protected-path']);
    expect(strongestAction(fired)).toBe('hard_stop');
  });
  it('a rule with no conditions never fires', () => {
    expect(evaluateTriggers(rules, diff()).some((t) => t.id === 'empty')).toBe(false);
  });
});

describe('strongestAction', () => {
  it('is null when nothing fired, and a hard stop beats a review', () => {
    expect(strongestAction([])).toBeNull();
    expect(
      strongestAction([
        { id: 'a', action: 'require_review' },
        { id: 'b', action: 'hard_stop' },
      ]),
    ).toBe('hard_stop');
  });
});

describe('matchPreApproved', () => {
  const docs = diff({ changedPaths: ['README.md', 'docs/guide.md'] });
  it('matches a documentation-only change', () => {
    expect(matchPreApproved(rules, docs, [], new Date('2026-12-01'))?.id).toBe('docs-only');
  });
  it('does not match when any file is code', () => {
    expect(
      matchPreApproved(rules, diff({ changedPaths: ['README.md', 'src/a.js'] }), []),
    ).toBeNull();
  });
  it('does not match when a trigger fired', () => {
    expect(matchPreApproved(rules, docs, [{ id: 'x', action: 'require_review' }])).toBeNull();
  });
  it('lapses after its review date', () => {
    expect(matchPreApproved(rules, docs, [], new Date('2027-02-01'))).toBeNull();
  });
});

describe('testsDeletedOrSkipped', () => {
  it('sees a deleted test file', () => {
    expect(testsDeletedOrSkipped(['test/server.test.js'], [])).toBe(true);
    expect(testsDeletedOrSkipped(['src/server.js'], [])).toBe(false);
  });
  it.each([
    'it.skip("x", () => {})',
    "describe.only('x', () => {})",
    'xit("x", () => {})',
    '@pytest.mark.skip',
    'test("x", { skip: true }, () => {})',
  ])('sees a skipped or isolated test: %s', (line) => {
    expect(testsDeletedOrSkipped([], [line])).toBe(true);
  });
  it('ignores ordinary lines', () => {
    expect(
      testsDeletedOrSkipped([], ['const skipped = items.filter(Boolean)', 'it("works", () => {})']),
    ).toBe(false);
  });
});

describe('dependencyAddedInPackageJson', () => {
  const pkg = (deps: object, dev: object = {}) =>
    JSON.stringify({ dependencies: deps, devDependencies: dev });
  it('is true when a dependency of any kind appears', () => {
    expect(dependencyAddedInPackageJson(pkg({ a: '1' }), pkg({ a: '1', b: '2' }))).toBe(true);
    expect(dependencyAddedInPackageJson(pkg({}), pkg({}, { vitest: '1' }))).toBe(true);
  });
  it('is false for a version bump, a removal, or no change', () => {
    expect(dependencyAddedInPackageJson(pkg({ a: '1' }), pkg({ a: '2' }))).toBe(false);
    expect(dependencyAddedInPackageJson(pkg({ a: '1', b: '1' }), pkg({ a: '1' }))).toBe(false);
    expect(dependencyAddedInPackageJson(pkg({ a: '1' }), pkg({ a: '1' }))).toBe(false);
  });
  it('treats a new package.json as adding all its dependencies', () => {
    expect(dependencyAddedInPackageJson(null, pkg({ a: '1' }))).toBe(true);
  });
  it('is false when the file was deleted or is not valid JSON', () => {
    expect(dependencyAddedInPackageJson(pkg({ a: '1' }), null)).toBe(false);
    expect(dependencyAddedInPackageJson('{', pkg({ a: '1' }))).toBe(true);
    expect(dependencyAddedInPackageJson(pkg({ a: '1' }), '{')).toBe(false);
  });
});
