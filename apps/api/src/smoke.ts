import type { SmokeCheck } from '@sdlc/core';

export interface SmokeResult {
  kind: 'get' | 'run';
  /** What was checked, in words a reviewer reads: `GET /health` or `run npm run smoke`. */
  label: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export type SmokeExec = (
  command: string,
  timeoutMs: number,
) => Promise<{ exitCode: number; output: string }>;

export interface SmokeOptions {
  /** Where the platform reaches the running preview, without a trailing slash. */
  baseUrl: string;
  checks: SmokeCheck[];
  /** Runs a command inside the preview's sandbox. A host that cannot do that leaves it out, and `run` checks fail. */
  exec?: SmokeExec;
  getTimeoutMs?: number;
  runTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const EXCERPT = 200;
const MAX_BODY = 256 * 1024;

const excerpt = (text: string, n = EXCERPT) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};
const tail = (text: string, n = 400) => {
  const t = text.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** Reads at most MAX_BODY bytes of a body. A check that wants a word near the top does not need the rest. */
async function readBody(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function get(
  opts: SmokeOptions,
  check: Extract<SmokeCheck, { kind: 'get' }>,
): Promise<Pick<SmokeResult, 'ok' | 'detail'>> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${opts.baseUrl}${check.path}`, {
      signal: AbortSignal.timeout(opts.getTimeoutMs ?? 10_000),
      redirect: 'manual',
    });
    const body = await readBody(res);
    if (res.status !== check.status)
      return {
        ok: false,
        detail: `expected ${check.status}, got ${res.status}${body ? `: ${excerpt(body)}` : ''}`,
      };
    if (check.contains !== null && !body.includes(check.contains))
      return {
        ok: false,
        detail: `${res.status}, but the body does not contain "${excerpt(check.contains, 60)}": ${excerpt(body) || '(empty)'}`,
      };
    return { ok: true, detail: `${res.status}` };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false,
      detail: timedOut
        ? `no answer within ${(opts.getTimeoutMs ?? 10_000) / 1000} s`
        : `could not connect: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Runs every check in order, whatever the earlier ones did, so a reviewer sees everything that is wrong at once.
 * Passes only when every check passed, and a list with no checks does not pass: nothing was proven.
 */
export async function runSmoke(
  opts: SmokeOptions,
): Promise<{ passed: boolean; results: SmokeResult[] }> {
  const results: SmokeResult[] = [];
  for (const check of opts.checks) {
    const started = Date.now();
    let r: Pick<SmokeResult, 'ok' | 'detail'>;
    if (check.kind === 'get') {
      r = await get(opts, check);
    } else if (!opts.exec) {
      r = { ok: false, detail: 'this host cannot run commands in the preview' };
    } else {
      const limit = opts.runTimeoutMs ?? 60_000;
      try {
        const out = await opts.exec(check.command, limit);
        r =
          out.exitCode === 0
            ? { ok: true, detail: tail(out.output) || 'exit 0' }
            : {
                ok: false,
                detail: `exit ${out.exitCode}${out.output.trim() ? `: ${tail(out.output)}` : ''}`,
              };
      } catch (e) {
        r = { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    }
    results.push({
      kind: check.kind,
      label: check.kind === 'get' ? `GET ${check.path}` : `run ${check.command}`,
      ...r,
      ms: Date.now() - started,
    });
  }
  return { passed: results.length > 0 && results.every((r) => r.ok), results };
}
