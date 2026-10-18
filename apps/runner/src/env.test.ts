import { describe, expect, it } from 'vitest';
import { runnerEnvFrom } from './env.js';

const base = { SDLC_API_URL: 'http://api', SDLC_RUN_TOKEN: 'tok', SDLC_WORK_DIR: '/work' };

describe('runnerEnvFrom', () => {
  it('reads the three required values and defaults the engine', () => {
    expect(runnerEnvFrom(base)).toEqual({
      apiUrl: 'http://api',
      runToken: 'tok',
      workDir: '/work',
      claudeBin: 'claude',
      gatewayUrl: undefined,
      mcpUrl: undefined,
    });
  });

  it('passes the sandbox gateway and tool addresses through', () => {
    const env = runnerEnvFrom({
      ...base,
      SDLC_GATEWAY_URL: 'http://10.0.0.2:8787',
      SDLC_MCP_URL: 'http://10.0.0.2:8080/mcp',
    });
    expect(env).toMatchObject({
      gatewayUrl: 'http://10.0.0.2:8787',
      mcpUrl: 'http://10.0.0.2:8080/mcp',
    });
  });

  it('treats an empty address as not set', () => {
    expect(runnerEnvFrom({ ...base, SDLC_GATEWAY_URL: '' })).toMatchObject({
      gatewayUrl: undefined,
    });
  });

  it('allows another engine binary', () => {
    expect(runnerEnvFrom({ ...base, CLAUDE_BIN: '/opt/claude' })).toMatchObject({
      claudeBin: '/opt/claude',
    });
  });

  it.each(['SDLC_API_URL', 'SDLC_RUN_TOKEN', 'SDLC_WORK_DIR'])(
    'refuses to start without %s',
    (name) => {
      const e: Record<string, string | undefined> = { ...base };
      delete e[name];
      expect(runnerEnvFrom(e)).toEqual({ error: expect.stringContaining('required') });
    },
  );
});
