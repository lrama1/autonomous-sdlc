import {
  dependencyNamesAdded,
  matchingPaths,
  testsDeletedOrSkipped,
  writesUnescapedHtml,
} from '@sdlc/core';
import { git } from './git.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DiffSummary {
  changedPaths: string[];
  linesChanged: number;
  dependencyAdded: boolean;
  dependenciesAdded: string[];
  testsDeletedOrSkipped: boolean;
  protectedPathsTouched: string[];
  unsafeHtml: boolean;
}

/** Summarizes what the branch changes against the integration branch, in the terms the rules use. */
export async function summarizeDiff(
  dir: string,
  integrationBranch: string,
  protectedGlobs: string[],
): Promise<DiffSummary> {
  const range = `origin/${integrationBranch}...HEAD`;
  const names = (await git(dir, ['diff', '--name-only', '-z', range])).out
    .split('\0')
    .filter(Boolean);
  const deleted = (await git(dir, ['diff', '--name-only', '-z', '--diff-filter=D', range])).out
    .split('\0')
    .filter(Boolean);
  const numstat = (await git(dir, ['diff', '--numstat', range])).out.split('\n').filter(Boolean);
  const linesChanged = numstat.reduce((sum, l) => {
    const [add, del] = l.split('\t');
    // Binary files show "-". They count as zero lines.
    return sum + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
  const patch = (await git(dir, ['diff', '-U0', range])).out;
  const addedLines = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));

  const dependenciesAdded = new Set<string>();
  for (const p of names.filter((n) => n === 'package.json' || n.endsWith('/package.json'))) {
    const before = await git(dir, ['show', `origin/${integrationBranch}:${p}`], {
      allowFail: true,
    });
    const after = await readFile(path.join(dir, p), 'utf8').catch(() => null);
    for (const n of dependencyNamesAdded(before.ok ? before.out : null, after))
      dependenciesAdded.add(n);
  }

  return {
    changedPaths: names,
    linesChanged,
    dependencyAdded: dependenciesAdded.size > 0,
    dependenciesAdded: [...dependenciesAdded].sort(),
    testsDeletedOrSkipped: testsDeletedOrSkipped(deleted, addedLines),
    protectedPathsTouched: matchingPaths(names, protectedGlobs),
    unsafeHtml: writesUnescapedHtml(addedLines),
  };
}
