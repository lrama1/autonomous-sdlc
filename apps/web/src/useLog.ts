import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEventDto, LogRunDto } from '@sdlc/schemas';
import { getLog } from './api';

/** How many events stay on the page. The oldest go first. */
export const KEEP = 1500;
// A later event can be stored a moment before an earlier one is visible, so each look starts a little before the last
// event seen, and what was already shown is skipped by its id.
const OVERLAP = 40;

export interface LogState {
  events: LogEventDto[];
  runs: Map<string, LogRunDto>;
  /** The last look failed. The page keeps what it has and tries again. */
  problem: string | null;
  loaded: boolean;
}

/** Adds events that are new, in order, and keeps the newest `keep`. */
export function mergeEvents(have: LogEventDto[], more: LogEventDto[], keep = KEEP): LogEventDto[] {
  const seen = new Set(have.map((e) => e.id));
  const fresh = more.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return have;
  const all = [...have, ...fresh].sort((a, b) => a.gid - b.gid);
  return all.length > keep ? all.slice(all.length - keep) : all;
}

/** The live log of an initiative (or of everything), kept fresh by looking again every couple of seconds. */
export function useLog(initiativeId: string | null, live: boolean, everyMs = 2000): LogState {
  const [state, setState] = useState<LogState>({
    events: [],
    runs: new Map(),
    problem: null,
    loaded: false,
  });
  const cursor = useRef(0);
  const which = useRef<string | null>(null);

  const look = useCallback(async () => {
    try {
      let go = true;
      while (go) {
        const first = cursor.current === 0;
        const r = await getLog({
          initiativeId: initiativeId ?? undefined,
          after: first ? undefined : Math.max(0, cursor.current - OVERLAP),
          limit: first ? 300 : 500,
        });
        if (which.current !== initiativeId) return; // the person moved on
        for (const e of r.events) cursor.current = Math.max(cursor.current, e.gid);
        setState((s) => {
          const runs = new Map(s.runs);
          for (const run of r.runs) runs.set(run.id, run);
          return { events: mergeEvents(s.events, r.events), runs, problem: null, loaded: true };
        });
        go = r.more;
      }
    } catch (e) {
      setState((s) => ({
        ...s,
        loaded: true,
        problem: e instanceof Error ? e.message : 'Could not read the log.',
      }));
    }
  }, [initiativeId]);

  // A different initiative starts from scratch.
  useEffect(() => {
    which.current = initiativeId;
    cursor.current = 0;
    setState({ events: [], runs: new Map(), problem: null, loaded: false });
    void look();
  }, [initiativeId, look]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      if (!document.hidden) void look();
    }, everyMs);
    const onVisible = () => !document.hidden && void look();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [live, everyMs, look]);

  return state;
}
