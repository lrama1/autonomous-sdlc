// When a task is told to stop, a run that is waiting for a person should not lose its files with it.

export interface TerminateTarget {
  on(event: 'SIGTERM', listener: () => void): unknown;
}

/**
 * On SIGTERM, saves what there is to save (within `limitMs`) and then exits with 143. ECS sends SIGTERM when a task is
 * stopped and kills it after the container's stop timeout, so the save has to be quick. A save that fails or takes too
 * long is abandoned: the run then resumes from a fresh checkout, which is the best that can be done.
 */
export function saveOnTerminate(
  save: () => Promise<void>,
  exit: (code: number) => void,
  log: (line: string) => void,
  target: TerminateTarget = process,
  limitMs = 90_000,
): void {
  let leaving = false;
  target.on('SIGTERM', () => {
    if (leaving) return;
    leaving = true;
    log("told to stop: saving the run's files first");
    const timer = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`took longer than ${Math.round(limitMs / 1000)} s`)),
        limitMs,
      ).unref(),
    );
    void Promise.race([save(), timer])
      .catch((e: unknown) =>
        log(`could not save the files: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => exit(143));
  });
}
