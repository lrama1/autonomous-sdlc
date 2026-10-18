import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { INHERITED, runEngineProcess } from './claude.js';
import type { EngineEvent, EngineOptions, EngineRun, MappedLine } from './claude.js';

// The GitHub Copilot CLI as an engine (spec 11.3, spike 5). It talks to our Model Gateway in its bring-your-own-key
// mode, so it needs no GitHub sign-in and the gateway meters and budgets it like any other engine.

export const COPILOT_ENGINE = 'copilot-cli';

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface CopilotLine {
  type?: string;
  sessionId?: string;
  exitCode?: number;
  data?: {
    content?: string;
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    success?: boolean;
    result?: { content?: string };
    fileEdits?: { path?: string; kind?: string }[];
  };
}

/**
 * Reads the CLI's `--output-format json` lines. It has no turn limit of its own, so this counts model calls and
 * reports when the run's limit is passed. Deltas, skills, and background-task chatter are ignored.
 */
export class CopilotMapper {
  private started = false;
  private turns = 0;
  private lastText = '';

  constructor(
    private readonly sessionId: string,
    private readonly model: string,
    private readonly maxTurns: number,
  ) {}

  map = (line: string): MappedLine => {
    let j: CopilotLine;
    try {
      j = JSON.parse(line) as CopilotLine;
    } catch {
      return { events: [] };
    }
    const events: EngineEvent[] = [];
    // The session exists once the CLI is talking, so a crash before this leaves nothing to resume.
    const first = !this.started && typeof j.type === 'string';
    if (first) {
      this.started = true;
      events.push({
        type: 'engine.started',
        payload: { engine: COPILOT_ENGINE, model: this.model, sessionId: this.sessionId },
      });
    }
    const out: MappedLine = { events, ...(first ? { sessionId: this.sessionId } : {}) };
    const d = j.data ?? {};

    switch (j.type) {
      case 'assistant.turn_start':
        this.turns++;
        if (this.turns > this.maxTurns) out.exceeded = 'max_turns';
        break;
      case 'assistant.message':
        if (d.content?.trim()) {
          this.lastText = d.content;
          events.push({
            type: 'message',
            payload: { role: 'assistant', text: trim(d.content, 2000) },
          });
        }
        break;
      case 'tool.execution_start':
        events.push({
          type: 'tool.call',
          payload: {
            toolCallId: d.toolCallId,
            name: d.toolName,
            input: trim(JSON.stringify(d.arguments ?? {}), 1500),
          },
        });
        break;
      case 'tool.execution_complete':
        events.push({
          type: 'tool.result',
          payload: {
            toolCallId: d.toolCallId,
            ok: d.success !== false,
            summary: trim(d.result?.content ?? '', 300),
          },
        });
        for (const f of d.fileEdits ?? []) {
          if (f.path)
            events.push({ type: 'file.changed', payload: { path: f.path, tool: f.kind } });
        }
        break;
      case 'result': {
        const code = j.exitCode ?? 1;
        out.sessionId = j.sessionId ?? this.sessionId;
        out.result = {
          text: this.lastText,
          isError: code !== 0,
          subtype: code === 0 ? 'success' : `error_exit_${code}`,
        };
        break;
      }
    }
    return out;
  };
}

/** Where the CLI keeps its sessions. Inside the run's own home, so they survive a park with the work volume. */
export const copilotHome = (homeDir: string) => path.join(homeDir, '.copilot');

export function copilotEnv(
  o: Pick<EngineOptions, 'homeDir' | 'gatewayUrl' | 'runToken' | 'modelAlias'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, {
    HOME: o.homeDir,
    USERPROFILE: o.homeDir,
    COPILOT_HOME: copilotHome(o.homeDir),
    COPILOT_PROVIDER_TYPE: 'anthropic',
    COPILOT_PROVIDER_BASE_URL: o.gatewayUrl,
    COPILOT_PROVIDER_BEARER_TOKEN: o.runToken,
    COPILOT_MODEL: o.modelAlias,
    COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '120000',
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '16000',
    // Nothing a person is signed in with, and no GitHub token, can reach the CLI.
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    COPILOT_GITHUB_TOKEN: '',
    COPILOT_AUTO_UPDATE: 'false',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  return env;
}

export function copilotArgs(o: EngineOptions, sessionId: string): string[] {
  // The CLI has no system-prompt flag. A resumed session already holds it, so only the new message is sent.
  const prompt = o.resumeSessionId
    ? o.prompt
    : `${o.systemPrompt}\n\n---\n\nYour task:\n\n${o.prompt}`;
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--log-level',
    'error',
    '--allow-all-tools',
    '--no-ask-user',
    '--disable-builtin-mcps',
    '--disable-client-telemetry',
    '--additional-mcp-config',
    `@${o.mcpConfigPath}`,
    ...(o.resumeSessionId ? [`--resume=${o.resumeSessionId}`] : [`--session-id=${sessionId}`]),
    // Only the runner pushes.
    '--deny-tool=shell(git push)',
    // Variadic, so it goes last.
    '--excluded-tools',
    ...new Set([...o.deniedTools, 'web_fetch', 'web_search']),
  ];
}

export function runCopilot(o: EngineOptions): EngineRun {
  const sessionId = o.resumeSessionId ?? randomUUID();
  const mapper = new CopilotMapper(sessionId, o.modelAlias, o.maxTurns);
  return runEngineProcess({
    bin: o.bin,
    args: [...(o.binArgs ?? []), ...copilotArgs(o, sessionId)],
    env: copilotEnv(o),
    cwd: o.cwd,
    maxWallSeconds: o.maxWallSeconds,
    mapLine: mapper.map,
    onEvents: o.onEvents,
    onSession: o.onSession,
  });
}
