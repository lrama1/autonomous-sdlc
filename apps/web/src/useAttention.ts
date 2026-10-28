import { useEffect, useState } from 'react';
import { getQueue } from './api';

export interface Attention {
  /** Asks waiting on this person now. A snoozed one is not counted until its time comes. */
  count: number;
  /** At least one is a hard stop, which only a person can let through. */
  urgent: boolean;
}

export function summarize(
  items: Array<{ snoozedUntil: string | null; hardStop: boolean }>,
  now = Date.now(),
): Attention {
  const waiting = items.filter((i) => !i.snoozedUntil || new Date(i.snoozedUntil).getTime() <= now);
  return { count: waiting.length, urgent: waiting.some((i) => i.hardStop) };
}

/** How many asks wait on the signed-in person, kept fresh for the menu and the page title. */
export function useAttention(signedIn: boolean, everyMs = 8000): Attention {
  const [a, setA] = useState<Attention>({ count: 0, urgent: false });
  useEffect(() => {
    if (!signedIn) return setA({ count: 0, urgent: false });
    let live = true;
    const load = () =>
      getQueue().then(
        (q) => live && setA(summarize(q)),
        () => {}, // a failed check keeps the last answer; the queue page says what went wrong
      );
    void load();
    const poll = setInterval(load, everyMs);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      clearInterval(poll);
      window.removeEventListener('focus', onFocus);
    };
  }, [signedIn, everyMs]);
  return a;
}
