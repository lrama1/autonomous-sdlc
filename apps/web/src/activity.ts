// Working or stuck? What a person is told about a running task from when its agent last reported anything. Pure.

export interface ActivityNote {
  text: string;
  /** ok: heard from lately. quiet: worth a look. stuck: the platform will close it soon, or already could. */
  tone: 'ok' | 'quiet' | 'stuck';
}

const MIN = 60_000;
export const QUIET_AFTER_MS = 3 * MIN;
export const STUCK_AFTER_MS = 10 * MIN;

const span = (ms: number) => {
  const m = Math.floor(ms / MIN);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} min` : ''}`;
};

/** Null when there is nothing to say (the task has no live run). */
export function activityNote(
  lastActivityAt: string | null | undefined,
  now = Date.now(),
): ActivityNote | null {
  if (!lastActivityAt) return null;
  const quiet = now - new Date(lastActivityAt).getTime();
  if (quiet < QUIET_AFTER_MS)
    return { tone: 'ok', text: `Working. Last heard from the agent ${span(quiet)} ago.` };
  if (quiet < STUCK_AFTER_MS)
    return {
      tone: 'quiet',
      text: `Quiet for ${span(quiet)}. Long installs and checks can be silent. After 10 minutes the platform closes it so you can retry.`,
    };
  return {
    tone: 'stuck',
    text: `Nothing heard for ${span(quiet)}. It is probably stuck. The platform closes a run that stays silent, and then you can retry the task.`,
  };
}
