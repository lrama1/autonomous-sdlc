// The egress proxy's allowlist, kept up to date from the platform while the proxy runs (spec 12.4, Fargate).
// The Integration Register changes what agents may reach, and a proxy that read its list once at start-up would need
// a redeploy for each change. Fails static: when the platform cannot be asked, the last list stays.

export interface AllowlistOptions {
  /** What to use until the platform has answered, and what it falls back to if it never does. */
  initial: string[];
  url?: string;
  token?: string;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface Allowlist {
  current(): string[];
  refresh(): Promise<void>;
  stop(): void;
}

const HOST = /^\.?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** The hosts in an answer, or null if the answer is not what the platform sends. */
export function parseAllowlist(body: unknown): string[] | null {
  const hosts = (body as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts) || hosts.length > 1000) return null;
  const out: string[] = [];
  for (const h of hosts) {
    if (typeof h !== 'string') return null;
    const host = h.trim().toLowerCase();
    if (!HOST.test(host)) return null;
    out.push(host);
  }
  return out;
}

export function startAllowlist(o: AllowlistOptions): Allowlist {
  const log = o.log ?? (() => {});
  const doFetch = o.fetchImpl ?? fetch;
  let list = [...o.initial];
  let reachable = true;
  let timer: NodeJS.Timeout | undefined;

  async function refresh(): Promise<void> {
    if (!o.url) return;
    try {
      const res = await doFetch(o.url, {
        headers: o.token ? { authorization: `Bearer ${o.token}` } : {},
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = parseAllowlist(await res.json());
      if (!next) throw new Error('the answer is not a list of hosts');
      if (!reachable) log(`allowlist: the platform answers again (${next.length} hosts)`);
      reachable = true;
      if (JSON.stringify(next) !== JSON.stringify(list)) {
        list = next;
        log(`ALLOWLIST ${list.length} hosts: ${list.join(', ')}`);
      }
    } catch (e) {
      if (reachable)
        log(
          `allowlist: cannot read it from the platform (${e instanceof Error ? e.message : String(e)}); keeping ${list.length} hosts`,
        );
      reachable = false;
    }
  }

  if (o.url) {
    void refresh();
    timer = setInterval(() => void refresh(), o.intervalMs ?? 5000);
    timer.unref();
  }
  return { current: () => list, refresh, stop: () => clearInterval(timer) };
}
