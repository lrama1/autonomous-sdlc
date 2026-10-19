import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDesignSmoke, parseDesignTasks } from '@sdlc/core';

const DESIGN_FILE = /^docs\/design\/[^/]+\.md$/;

/**
 * Checks the task list and the smoke checks in each design document the branch changes. The Architect agent's output
 * feeds the engineer runs, so a block that does not read is sent back to the agent now, not found after a person has
 * approved it. Returns null when all is well.
 */
export async function checkDesigns(
  repoDir: string,
  changedPaths: string[],
): Promise<string | null> {
  const problems: string[] = [];
  const files = changedPaths.filter((p) => DESIGN_FILE.test(p));
  if (files.length === 0) {
    return 'The branch has no design file. Write the design to docs/design/<slug>.md and commit it.';
  }
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(repoDir, file), 'utf8');
    } catch {
      continue; // deleted in this branch
    }
    const errors = [parseDesignTasks(text), parseDesignSmoke(text)].flatMap((r) =>
      r.ok ? [] : r.errors,
    );
    if (errors.length > 0) problems.push(`${file}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return problems.length > 0 ? problems.join('\n') : null;
}
