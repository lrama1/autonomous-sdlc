import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface EngineEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface MappedLine {
  events: EngineEvent[];
  sessionId?: string;
  result?: { text: string; isError: boolean; subtype: string };
  /** Set by an engine that has no turn limit of its own, once the runner's limit is passed. */
  exceeded?: 'max_turns';
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function summarize(content: unknown): string {
  if (typeof content === 'string') return trim(content, 300);
  if (Array.isArray(content)) {
    return trim(
      content
        .map((c) =>
          c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '',
        )
        .join(' ')
        .trim(),
      300,
    );
  }
  return '';
}

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { file_path?: unknown } & Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

// The parts of Claude Code's stream-json that the platform reads. Everything else is ignored.
interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: Block[] | string };
  result?: unknown;
  is_error?: boolean;
}

/** Turns one line of Claude Code's stream-json into the platform's engine-neutral events (mvp-contract section 7). */
export function mapStreamLine(line: string): MappedLine {
  const empty: MappedLine = { events: [] };
  let j: StreamLine;
  try {
    j = JSON.parse(line) as StreamLine;
  } catch {
    return empty;
  }
  const events: EngineEvent[] = [];

  if (j.type === 'system' && j.subtype === 'init') {
    events.push({
      type: 'engine.started',
      payload: { engine: 'claude-code', model: j.model ?? null, sessionId: j.session_id ?? null },
    });
    return { events, sessionId: j.session_id };
  }

  if (j.type === 'assistant') {
    const blocks = Array.isArray(j.message?.content) ? j.message.content : [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text?.trim()) {
        events.push({
          type: 'message',
          payload: { role: 'assistant', text: trim(block.text, 2000) },
        });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool.call',
          payload: {
            toolCallId: block.id,
            name: block.name,
            input: trim(JSON.stringify(block.input ?? {}), 1500),
          },
        });
        if (
          block.name &&
          FILE_TOOLS.has(block.name) &&
          typeof block.input?.file_path === 'string'
        ) {
          events.push({
            type: 'file.changed',
            payload: { path: block.input.file_path, tool: block.name },
          });
        }
      }
    }
    return { events, sessionId: j.session_id };
  }

  if (j.type === 'user' && Array.isArray(j.message?.content)) {
    for (const block of j.message.content) {
      if (block.type === 'tool_result') {
        events.push({
          type: 'tool.result',
          payload: {
            toolCallId: block.tool_use_id,
            ok: !block.is_error,
            summary: summarize(block.content),
          },
        });
      }
    }
    return { events };
  }

  if (j.type === 'result') {
    return {
      events,
      sessionId: j.session_id,
      result: {
        text: typeof j.result === 'string' ? j.result : '',
        isError: Boolean(j.is_error),
        subtype: String(j.subtype ?? ''),
      },
    };
  }
  return empty;
}

export interface EngineOptions {
  bin: string;
  /** Arguments placed before the engine's own. Empty in production. Tests use it to run a script. */
  binArgs?: string[];
  cwd: string;
  homeDir: string;
  prompt: string;
  systemPrompt: string;
  resumeSessionId?: string;
  modelAlias: string;
  gatewayUrl: string;
  runToken: string;
  mcpConfigPath: string;
  maxTurns: number;
  maxWallSeconds: number;
  deniedTools: string[];
  onEvents: (events: EngineEvent[]) => void;
  /** Called as soon as the engine reports its session id, so a crash or kill cannot lose it. */
  onSession?: (sessionId: string) => void;
}

export interface EngineResult {
  sessionId?: string;
  finalText: string;
  isError: boolean;
  subtype: string;
  killedBy: 'caller' | 'timeout' | null;
  exitCode: number | null;
  stderrTail: string;
}

export interface EngineRun {
  done: Promise<EngineResult>;
  kill: () => void;
}

// The sandbox sets these so git, npm, and the verify command can reach only the allowlisted hosts.
export const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

// What the engine inherits. No platform secrets, no provider keys, no GitHub token.
export const INHERITED = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'ProgramFiles',
  'ProgramData',
  'APPDATA',
  'LOCALAPPDATA',
  ...PROXY_VARS,
];

export function engineEnv(
  o: Pick<EngineOptions, 'homeDir' | 'gatewayUrl' | 'runToken' | 'modelAlias'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, {
    HOME: o.homeDir,
    USERPROFILE: o.homeDir,
    ANTHROPIC_BASE_URL: o.gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: o.runToken,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: o.modelAlias,
    // Only the runner pushes. No prompts, no helper, no system config that could supply someone's login.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  return env;
}

const pascal = (s: string) =>
  s
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

export function engineArgs(o: EngineOptions): string[] {
  const denied = [...new Set([...o.deniedTools.map(pascal), 'WebSearch'])];
  return [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    o.mcpConfigPath,
    '--model',
    o.modelAlias,
    '--permission-mode',
    'bypassPermissions',
    '--max-turns',
    String(o.maxTurns),
    '--append-system-prompt',
    o.systemPrompt,
    ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []),
    // Variadic, so it goes last.
    '--disallowedTools',
    ...denied,
  ];
}

/** Stops a process and everything it started. On Windows a plain kill leaves the child shells behind. */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
  } else {
    // The engine runs in its own process group, so its shells and tests go with it.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export interface EngineProcess {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  maxWallSeconds: number;
  /** Turns one line of the engine's output into platform events. Called in order, so it may keep state. */
  mapLine: (line: string) => MappedLine;
  onEvents: (events: EngineEvent[]) => void;
  onSession?: (sessionId: string) => void;
}

/** Starts an engine process, reads its output line by line, and enforces the wall-clock limit. */
export function runEngineProcess(p: EngineProcess): EngineRun {
  const child = spawn(p.bin, p.args, {
    cwd: p.cwd,
    env: p.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });
  let buf = '';
  let sessionId: string | undefined;
  let result: MappedLine['result'];
  let stderr = '';
  let killedBy: EngineResult['killedBy'] = null;
  let exceeded: MappedLine['exceeded'];

  const line = (l: string) => {
    if (!l.trim()) return;
    const m = p.mapLine(l);
    if (m.sessionId && m.sessionId !== sessionId) {
      sessionId = m.sessionId;
      p.onSession?.(sessionId);
    }
    if (m.result) result = m.result;
    if (m.events.length) p.onEvents(m.events);
    if (m.exceeded && !exceeded) {
      exceeded = m.exceeded;
      killTree(child);
    }
  };
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      line(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-2000);
  });

  const timer = setTimeout(() => {
    killedBy = 'timeout';
    killTree(child);
  }, p.maxWallSeconds * 1000);

  const done = new Promise<EngineResult>((resolve) => {
    const finish = (code: number | null) => {
      clearTimeout(timer);
      line(buf);
      resolve({
        sessionId,
        finalText: result?.text ?? '',
        isError: exceeded ? true : result ? result.isError : true,
        subtype: exceeded ? `error_${exceeded}` : (result?.subtype ?? 'no_result'),
        killedBy,
        exitCode: code,
        stderrTail: stderr,
      });
    };
    child.on('error', (e) => {
      stderr += String(e);
      finish(null);
    });
    child.on('close', finish);
  });

  return {
    done,
    kill: () => {
      killedBy ??= 'caller';
      killTree(child);
    },
  };
}

export function runClaude(o: EngineOptions): EngineRun {
  return runEngineProcess({
    bin: o.bin,
    args: [...(o.binArgs ?? []), ...engineArgs(o)],
    env: engineEnv(o),
    cwd: o.cwd,
    maxWallSeconds: o.maxWallSeconds,
    mapLine: mapStreamLine,
    onEvents: o.onEvents,
    onSession: o.onSession,
  });
}
