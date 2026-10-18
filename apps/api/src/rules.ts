import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { ruleSetSchema } from '@sdlc/schemas';
import type { RuleSet } from '@sdlc/core';

/** Reads the trigger rules. A missing file means no rules. An invalid one stops start-up. */
export async function loadRules(file: string): Promise<RuleSet> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, triggers: [], pre_approved_change_types: [] };
    throw e;
  }
  const parsed = ruleSetSchema.safeParse(parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${file} is not a valid rule set: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data as RuleSet;
}
