import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiConfigSchema, parseEnv } from '@sdlc/schemas';
import { loadAgents } from './agents.js';

const dir = path.resolve(import.meta.dirname, '..', '..', '..', 'agents');

describe('loading agents', () => {
  it('leaves each agent on its own engine unless told otherwise', async () => {
    const agents = await loadAgents(dir);
    expect(agents.size).toBeGreaterThan(3);
    expect([...agents.values()].every((a) => a.definition.engine === 'claude-code')).toBe(true);
  });

  it('moves every agent to the engine it is told to use, changing nothing else', async () => {
    const before = await loadAgents(dir);
    const after = await loadAgents(dir, 'copilot-cli');
    expect([...after.values()].every((a) => a.definition.engine === 'copilot-cli')).toBe(true);
    for (const [role, a] of after)
      expect({ ...a.definition, engine: 'x' }).toEqual({
        ...before.get(role)!.definition,
        engine: 'x',
      });
  });
});

describe('the engine setting', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    OIDC_ISSUER: 'http://localhost:9000',
    OIDC_CLIENT_ID: 'x',
    OIDC_CLIENT_SECRET: 'x',
    SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  };
  it('is optional, and an empty value (what Terraform passes) means not set', () => {
    expect(parseEnv(apiConfigSchema, env).AGENT_ENGINE).toBeUndefined();
    expect(parseEnv(apiConfigSchema, { ...env, AGENT_ENGINE: '' }).AGENT_ENGINE).toBeUndefined();
    expect(parseEnv(apiConfigSchema, { ...env, AGENT_ENGINE: 'copilot-cli' }).AGENT_ENGINE).toBe(
      'copilot-cli',
    );
    expect(() => parseEnv(apiConfigSchema, { ...env, AGENT_ENGINE: 'gpt' })).toThrow();
  });
});
