import type { LogEventDto } from '@sdlc/schemas';

/** How an event is drawn in the live log. */
export type LogKind = 'message' | 'tool' | 'result' | 'file' | 'run' | 'ask' | 'error' | 'other';

export interface LogLine {
  kind: LogKind;
  /** The short label before the text: a tool name, "said", "finished". */
  label: string;
  text: string;
  /** The result of a tool call: false when it failed. */
  ok?: boolean;
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}...` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What a tool was asked to do, in a few words: the command, the file, the pattern, else the input as it is. */
export function toolSummary(input: unknown): string {
  let v: unknown = input;
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input);
    } catch {
      return clip(oneLine(input));
    }
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of [
      'command',
      'file_path',
      'path',
      'pattern',
      'url',
      'query',
      'description',
      'prompt',
    ])
      if (typeof o[k] === 'string' && o[k]) return clip(oneLine(o[k] as string));
    return clip(oneLine(JSON.stringify(v)));
  }
  return clip(oneLine(str(v)));
}

/** Turns a stored event into a line for the log. Events the log does not know are shown as their type and payload. */
export function describeEvent(e: Pick<LogEventDto, 'type' | 'payload'>): LogLine {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'message':
      return { kind: 'message', label: 'said', text: clip(str(p.text), 1200) };
    case 'tool.call':
      return { kind: 'tool', label: str(p.name) || 'tool', text: toolSummary(p.input) };
    case 'tool.result':
      return {
        kind: 'result',
        label: p.ok === false ? 'failed' : 'ok',
        text: clip(oneLine(str(p.summary)), 300),
        ok: p.ok !== false,
      };
    case 'file.changed':
      return { kind: 'file', label: str(p.tool) || 'changed', text: str(p.path) };
    case 'engine.started':
      return {
        kind: 'run',
        label: 'started',
        text: `${str(p.engine) || 'engine'}${p.model ? ` (${str(p.model)})` : ''}`,
      };
    case 'engine.error':
      return {
        kind: 'error',
        label: 'engine error',
        text: clip(oneLine(str(p.message ?? p.error ?? p)), 400),
      };
    case 'run.queued':
      return { kind: 'run', label: 'queued', text: str(p.role) };
    case 'run.started':
      return { kind: 'run', label: 'running', text: '' };
    case 'run.parked':
      return { kind: 'run', label: 'waiting for a person', text: '' };
    case 'run.summary':
      return { kind: 'run', label: 'summary', text: clip(str(p.text), 1200) };
    case 'run.finished': {
      const why = str(p.exitReason ?? p.reason);
      return {
        kind: why && !/^(succeeded|success|ok|done|completed)$/i.test(why) ? 'error' : 'run',
        label: 'finished',
        text: why,
      };
    }
    case 'progress':
      return {
        kind: 'other',
        label: 'progress',
        text: `${str(p.message)}${typeof p.percent === 'number' ? ` (${p.percent}%)` : ''}`,
      };
    case 'interaction.raised':
      return { kind: 'ask', label: 'asked a person', text: str(p.kind) };
    case 'interaction.settled':
      return { kind: 'ask', label: 'answered', text: str(p.via) };
    case 'assumption.declared':
      return { kind: 'ask', label: 'assumed', text: clip(str(p.text), 400) };
    case 'pull_request.opened':
      return {
        kind: 'run',
        label: 'opened a pull request',
        text: p.number ? `#${str(p.number)}` : '',
      };
    default:
      return { kind: 'other', label: e.type, text: clip(oneLine(JSON.stringify(p)), 300) };
  }
}

/** The kinds a person can switch off in the log. */
export const KIND_GROUPS: Array<{ id: string; label: string; kinds: LogKind[] }> = [
  { id: 'said', label: 'Messages', kinds: ['message'] },
  { id: 'tools', label: 'Tools', kinds: ['tool', 'result'] },
  { id: 'files', label: 'Files', kinds: ['file'] },
  { id: 'run', label: 'Run steps', kinds: ['run', 'ask', 'error', 'other'] },
];
