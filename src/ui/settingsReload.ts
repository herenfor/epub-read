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
  /** Drop the queued task; a task still running settles without starting another. */
  cancel(): void;
  readonly busy: boolean;
}

/**
 * Live preview while a slider is held: at most one reload at a time, and the
 * next one uses the latest value. A slow device simply refreshes less often;
 * nothing queues up behind the drag.
 */
export function createLatestReloadRunner(): LatestReloadRunner {
  let running = false;
  let pending: (() => Promise<unknown> | void) | null = null;
  let generation = 0;
  const start = (task: () => Promise<unknown> | void): void => {
    running = true;
    const owner = generation;
    let result: Promise<unknown> | void;
    try {
      result = task();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result).catch(() => undefined).then(() => {
      if (owner !== generation) return;
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
      generation += 1;
      running = false;
      pending = null;
    },
    get busy() {
      return running;
    },
  };
}
