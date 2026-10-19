import { parse } from 'yaml';

// The file a repository keeps at .sdlc/preview.yaml to say how the platform may run a pull request for a reviewer.
// The platform runs it in a locked-down sandbox, so the file only says what to run and where it listens. Pure.

/** One smoke check. A `get` asks the running preview for a path. A `run` runs a command inside the sandbox. */
export type SmokeCheck =
  | { kind: 'get'; path: string; status: number; contains: string | null }
  | { kind: 'run'; command: string };

export const MAX_SMOKE_CHECKS = 20;

export interface PreviewConfig {
  /** Run once before start, for example `npm ci`. Null when there is nothing to install. */
  install: string | null;
  start: string;
  /** The port the started process listens on, inside the sandbox. */
  port: number;
  /** The path asked to see whether the preview is up. */
  readyPath: string;
  /** Checks that decide whether the running preview is healthy. Empty when the repository has none. */
  smoke: SmokeCheck[];
}

/** What a host needs to start a preview. The smoke checks are the platform's business, not the sandbox's. */
export type PreviewStartConfig = Omit<PreviewConfig, 'smoke'>;

export type PreviewConfigResult =
  { ok: true; config: PreviewConfig } | { ok: false; errors: string[] };

export const PREVIEW_CONFIG_PATH = '.sdlc/preview.yaml';
const KEYS = new Set(['install', 'start', 'port', 'ready_path', 'smoke']);
const GET_KEYS = new Set(['get', 'status', 'contains']);
const RUN_KEYS = new Set(['run']);
const MAX_CONTAINS = 200;
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

/** The `smoke:` list. Each entry is a `get` (with optional `status` and `contains`) or a `run`. */
export function readSmokeChecks(v: unknown, errors: string[]): SmokeCheck[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push('smoke must be a list of checks, each starting with get: or run:');
    return [];
  }
  if (v.length > MAX_SMOKE_CHECKS) {
    errors.push(`smoke has ${v.length} checks. The most allowed is ${MAX_SMOKE_CHECKS}`);
    return [];
  }
  const out: SmokeCheck[] = [];
  v.forEach((item, i) => {
    const at = `smoke check ${i + 1}`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} must be a mapping that starts with get: or run:`);
      return;
    }
    const e = item as Record<string, unknown>;
    const isGet = 'get' in e;
    const isRun = 'run' in e;
    if (isGet === isRun) {
      errors.push(`${at} needs exactly one of get: (a path) or run: (a command)`);
      return;
    }
    const allowed = isGet ? GET_KEYS : RUN_KEYS;
    const unknown = Object.keys(e).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      errors.push(
        `${at} has unknown key "${unknown[0]}". A ${isGet ? 'get' : 'run'} check takes ${[...allowed].join(', ')}`,
      );
      return;
    }
    if (isRun) {
      const before = errors.length;
      const c = command(e.run, `${at} run`, errors, true);
      if (errors.length === before && c !== null) out.push({ kind: 'run', command: c });
      return;
    }
    const path = e.get;
    if (typeof path !== 'string' || !path.startsWith('/') || /\s/.test(path) || path.length > 200) {
      errors.push(`${at} get must be a path that starts with /, for example /health`);
      return;
    }
    let status = 200;
    if (e.status !== undefined) {
      if (
        typeof e.status !== 'number' ||
        !Number.isInteger(e.status) ||
        e.status < 100 ||
        e.status > 599
      ) {
        errors.push(`${at} status must be a whole number from 100 to 599`);
        return;
      }
      status = e.status;
    }
    let contains: string | null = null;
    if (e.contains !== undefined) {
      if (typeof e.contains !== 'string' || e.contains === '' || e.contains.length > MAX_CONTAINS) {
        errors.push(`${at} contains must be text of 1 to ${MAX_CONTAINS} characters`);
        return;
      }
      contains = e.contains;
    }
    out.push({ kind: 'get', path, status, contains });
  });
  return out;
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
  const smoke = readSmokeChecks(e.smoke, errors);
  if (errors.length > 0 || start === null) return { ok: false, errors };
  return { ok: true, config: { install, start, port, readyPath, smoke } };
}
