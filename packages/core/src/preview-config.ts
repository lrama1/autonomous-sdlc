import { parse } from 'yaml';

// The file a repository keeps at .sdlc/preview.yaml to say how the platform may run a pull request for a reviewer.
// The platform runs it in a locked-down sandbox, so the file only says what to run and where it listens. Pure.

export interface PreviewConfig {
  /** Run once before start, for example `npm ci`. Null when there is nothing to install. */
  install: string | null;
  start: string;
  /** The port the started process listens on, inside the sandbox. */
  port: number;
  /** The path asked to see whether the preview is up. */
  readyPath: string;
}

export type PreviewConfigResult =
  { ok: true; config: PreviewConfig } | { ok: false; errors: string[] };

export const PREVIEW_CONFIG_PATH = '.sdlc/preview.yaml';
const KEYS = new Set(['install', 'start', 'port', 'ready_path']);
const MAX_COMMAND = 500;

/** One shell command line, no longer than the limit. Empty and multi-line text are refused. */
function command(v: unknown, key: string, errors: string[], required: boolean): string | null {
  if (v === undefined || v === null) {
    if (required) errors.push(`${key} is required: the command that starts the preview`);
    return null;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`${key} must be a command, written as text`);
    return null;
  }
  const text = v.trim();
  if (/[\r\n]/.test(text)) {
    errors.push(`${key} must be one line. Join commands with && or put them in a script`);
    return null;
  }
  if (text.length > MAX_COMMAND) {
    errors.push(`${key} is longer than ${MAX_COMMAND} characters. Put it in a script`);
    return null;
  }
  return text;
}

export function parsePreviewConfig(text: string): PreviewConfigResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `${PREVIEW_CONFIG_PATH} is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      ],
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [`${PREVIEW_CONFIG_PATH} must be a mapping with a start command`] };
  }
  const e = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(e))
    if (!KEYS.has(k)) errors.push(`unknown key "${k}". The keys are ${[...KEYS].join(', ')}`);

  const install = command(e.install, 'install', errors, false);
  const start = command(e.start, 'start', errors, true);

  let port = 3000;
  if (e.port !== undefined) {
    if (typeof e.port !== 'number' || !Number.isInteger(e.port) || e.port < 1024 || e.port > 65535)
      errors.push('port must be a whole number from 1024 to 65535');
    else port = e.port;
  }
  let readyPath = '/';
  if (e.ready_path !== undefined) {
    if (
      typeof e.ready_path !== 'string' ||
      !e.ready_path.startsWith('/') ||
      /\s/.test(e.ready_path) ||
      e.ready_path.length > 200
    )
      errors.push('ready_path must be a path that starts with /, for example /health');
    else readyPath = e.ready_path;
  }
  if (errors.length > 0 || start === null) return { ok: false, errors };
  return { ok: true, config: { install, start, port, readyPath } };
}
