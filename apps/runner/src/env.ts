import type { RunnerEnv } from './run.js';

/**
 * What the platform hands a runner when it starts one. Three values are required. The gateway and tool addresses are
 * set only inside a sandbox, where the platform is not at the address written in the run spec.
 */
export function runnerEnvFrom(
  e: Record<string, string | undefined>,
): RunnerEnv | { error: string } {
  const apiUrl = e.SDLC_API_URL;
  const runToken = e.SDLC_RUN_TOKEN;
  const workDir = e.SDLC_WORK_DIR;
  if (!apiUrl || !runToken || !workDir) {
    return { error: 'SDLC_API_URL, SDLC_RUN_TOKEN and SDLC_WORK_DIR are required' };
  }
  return {
    apiUrl,
    runToken,
    workDir,
    claudeBin: e.CLAUDE_BIN ?? 'claude',
    copilotBin: e.COPILOT_BIN ?? 'copilot',
    gatewayUrl: e.SDLC_GATEWAY_URL || undefined,
    mcpUrl: e.SDLC_MCP_URL || undefined,
  };
}
