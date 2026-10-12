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
  publish(value: T): void;
  fail(error: unknown): void;
}

/** A read restarted this many times because writes kept landing gives up with the last outcome. */
const MAX_REREADS = 3;

/**
 * One reader per data set (book list, organization). `load()` while a read is
 * in flight returns that same read, so a double-tapped retry queues nothing.
 * A write that lands during the read makes it read again before publishing,
 * so a late first read can never replace books imported in the meantime.
 * `invalidate()` (an authoritative projection, unmount) drops the read in
 * flight: its late success or failure publishes nothing.
 */
export function createLibraryReader<T>(deps: LibraryReaderDeps<T>) {
  let generation = 0;
  let inflight: Promise<void> | null = null;

  const run = async (mine: number): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const writes = deps.writeCount();
      let value: T;
      try {
        value = await deps.read();
      } catch (error) {
        if (mine !== generation) return;
        if (deps.writeCount() !== writes && attempt < MAX_REREADS) continue;
        deps.fail(error);
        return;
      }
      if (mine !== generation) return;
      if (deps.writeCount() !== writes && attempt < MAX_REREADS) continue;
      deps.publish(value);
      return;
    }
  };

  return {
    load(): Promise<void> {
      if (inflight) return inflight;
      const mine = ++generation;
      const current = run(mine).finally(() => {
        if (inflight === current) inflight = null;
      });
      inflight = current;
      return current;
    },
    invalidate(): void {
      generation++;
      inflight = null;
    },
  };
}
