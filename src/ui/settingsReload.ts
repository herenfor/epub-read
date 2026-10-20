export interface SettingsReloadDebouncer {
  schedule(task: () => void): void;
  cancel(): void;
}

/** Coalesce rapid setting changes; the caller supplies the latest task closure. */
export function createSettingsReloadDebouncer(delayMs = 150): SettingsReloadDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;
  return {
    schedule(task) {
      if (timer !== null) clearTimeout(timer);
      pending = task;
      timer = setTimeout(() => {
        timer = null;
        const run = pending;
        pending = null;
        run?.();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export interface LatestReloadRunner {
  /** Start now when idle; while one runs, keep only the newest task for when it settles. */
  run(task: () => Promise<unknown> | void): void;
  /**
   * Drop the queued task. A task already running is not stopped here (its
   * own epoch and slot checks make its result void); it keeps the runner
   * busy until it really settles, so nothing new overlaps it.
   */
  cancel(): void;
  readonly busy: boolean;
}

/**
 * The one place settings reloads run, for drags and ordinary changes alike:
 * at most one at a time, and the next one uses the latest value. A slow
 * device simply refreshes less often; nothing queues up behind it.
 */
export function createLatestReloadRunner(): LatestReloadRunner {
  let running = false;
  let pending: (() => Promise<unknown> | void) | null = null;
  const start = (task: () => Promise<unknown> | void): void => {
    running = true;
    let result: Promise<unknown> | void;
    try {
      result = task();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result).catch(() => undefined).then(() => {
      running = false;
      const next = pending;
      pending = null;
      if (next) start(next);
    });
  };
  return {
    run(task) {
      if (running) pending = task;
      else start(task);
    },
    cancel() {
      pending = null;
    },
    get busy() {
      return running;
    },
  };
}
