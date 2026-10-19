import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { agentDefinitionSchema } from '@sdlc/schemas';
import type { AgentDefinition } from '@sdlc/schemas';

export interface LoadedAgent {
  definition: AgentDefinition;
  prompt: string;
}

/**
 * Reads every agents/<id>/agent.yaml plus its prompt file. Invalid definitions stop start-up. `engine`, when given,
 * replaces the engine of every agent, so a whole platform can move to the other engine without editing definitions.
 */
export async function loadAgents(dir: string, engine?: string): Promise<Map<string, LoadedAgent>> {
  const byRole = new Map<string, LoadedAgent>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return byRole;
    throw e;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry, 'agent.yaml');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code === 'ENOENT' ||
        (e as NodeJS.ErrnoException).code === 'ENOTDIR'
      )
        continue;
      throw e;
    }
    const parsed = agentDefinitionSchema.safeParse(parse(raw));
    if (!parsed.success) {
      throw new Error(
        `${file} is not a valid agent definition: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    const def = engine ? { ...parsed.data, engine } : parsed.data;
    if (def.id !== entry)
      throw new Error(`${file}: id "${def.id}" must match the folder name "${entry}"`);
    const prompt = await readFile(path.join(dir, entry, def.prompt_file), 'utf8');
    if (byRole.has(def.role)) throw new Error(`two agent definitions claim the role ${def.role}`);
    byRole.set(def.role, { definition: def, prompt });
  }
  return byRole;
}
