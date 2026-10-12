/**
 * Shelf library reading state: the first real read of the book list (and of
 * the folder organization) on startup, its failure and its retry.
 *
 * `ready` means a real read has succeeded at least once, so an empty list is
 * a real answer; it keeps the last snapshot and, after a failed refresh, the
 * error of that refresh. There is no second copy of the data here.
 */
export type LibraryLoadState =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "ready"; refreshError: string | null };

export const LIBRARY_LOADING: LibraryLoadState = { status: "loading" };

export function libraryReadSucceeded(): LibraryLoadState {
  return { status: "ready", refreshError: null };
}

/** A failure never discards a snapshot that was already read. */
export function libraryReadFailed(previous: LibraryLoadState, error: string): LibraryLoadState {
  return previous.status === "ready" ? { status: "ready", refreshError: error } : { status: "failed", error };
}

/** What the shelf shows for the library itself, before scopes and filters. */
export type ShelfLibraryView =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "ready"; refreshError: string | null };

/**
 * Books that are on screen are never hidden behind a loading or failure page:
 * a failure with books becomes a refresh error. An empty shelf is claimed
 * only after the list succeeded and the organization read has settled.
 */
export function shelfLibraryView(load: LibraryLoadState, hasBooks: boolean, organizationSettled: boolean): ShelfLibraryView {
  if (load.status === "ready") {
    return !hasBooks && !organizationSettled ? { kind: "loading" } : { kind: "ready", refreshError: load.refreshError };
  }
  if (hasBooks) return { kind: "ready", refreshError: load.status === "failed" ? load.error : null };
  return load.status === "failed" ? { kind: "failed", error: load.error } : { kind: "loading" };
}

export interface LibraryReaderDeps<T> {
  read(): Promise<T>;
  /** Bumped by every other write to the same data (import, delete, sync, user edits). */
  writeCount(): number;
  /** The repository behind the reads; a read that started on another one is never published. */
  repository(): unknown;
  publish(value: T): void;
  fail(error: unknown): void;
}

/** What one load/refresh call ended with; `superseded` means a newer request or teardown owns the result. */
export type LibraryReadOutcome<T> =
  | { kind: "published"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "superseded" };

/** Reads restarted this many times because writes kept landing: the read stops with a retryable error. */
export const MAX_LIBRARY_REREADS = 3;

/** The data kept changing under every read; nothing stale was published and a retry can read again. */
export class LibraryReadInterruptedError extends Error {
  constructor() {
    super("The library changed during every read attempt; nothing was replaced. Retry to read it again.");
    this.name = "LibraryReadInterruptedError";
  }
}

/**
 * One reader per data set (book list, organization), and the only path that
 * publishes a read of it: first read, retry and authoritative refresh alike.
 *
 * A result is published only if, when it arrives, its request is still the
 * newest (no refresh or teardown came after it), no write landed during the
 * read and the repository is the one it started on. Otherwise the read is
 * repeated, at most MAX_LIBRARY_REREADS times; when that budget runs out the
 * request fails with LibraryReadInterruptedError, which keeps any snapshot
 * already shown and can be retried — a stale result is never published.
 *
 * `load()` joins a request already in flight (a double-tapped retry queues
 * nothing); `refresh()` supersedes it and reads anew; `invalidate()` (unmount)
 * supersedes everything.
 */
export function createLibraryReader<T>(deps: LibraryReaderDeps<T>) {
  let generation = 0;
  let inflight: Promise<LibraryReadOutcome<T>> | null = null;

  const run = async (mine: number): Promise<LibraryReadOutcome<T>> => {
    for (let attempt = 0; ; attempt++) {
      const writes = deps.writeCount();
      const repository = deps.repository();
      let result: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        result = { ok: true, value: await deps.read() };
      } catch (error) {
        result = { ok: false, error };
      }
      if (mine !== generation) return { kind: "superseded" };
      if (deps.writeCount() !== writes || deps.repository() !== repository) {
        if (attempt < MAX_LIBRARY_REREADS) continue;
        const error = new LibraryReadInterruptedError();
        deps.fail(error);
        return { kind: "failed", error };
      }
      if (!result.ok) {
        deps.fail(result.error);
        return { kind: "failed", error: result.error };
      }
      deps.publish(result.value);
      return { kind: "published", value: result.value };
    }
  };

  const start = (): Promise<LibraryReadOutcome<T>> => {
    const mine = ++generation;
    const current = run(mine).finally(() => {
      if (inflight === current) inflight = null;
    });
    inflight = current;
    return current;
  };

  return {
    load(): Promise<LibraryReadOutcome<T>> {
      return inflight ?? start();
    },
    refresh(): Promise<LibraryReadOutcome<T>> {
      return start();
    },
    invalidate(): void {
      generation++;
      inflight = null;
    },
  };
}
