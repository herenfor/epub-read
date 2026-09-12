import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import {
  clearAllTextIndexes,
  createTauriIndexStagingStore,
  listIndexedBooks,
  searchBookTextIndex,
  type IndexedBookStatus,
  type ResolvedCrossBookSearchHit,
} from "./indexStore";
import {
  type LibraryIndexBook,
  type LibraryIndexer,
  type LibraryIndexProgress,
  type LibraryIndexResult,
} from "./libraryIndexer";
import { createDefaultCorpusWorkerFactory } from "./corpusWorkerProtocol";
import { createWorkerLibraryIndexerFactory } from "./workerLibraryIndexer";
import {
  libraryIndexCanSearch,
  phaseAfterIndexCheck,
  phaseAfterIndexStop,
  summarizeLibraryIndex,
  type LibraryIndexPhase,
  type LibraryIndexSummary,
} from "./libraryIndexStatus";
import {
  cancelLibraryIndexTask,
  completeLibraryIndexTask,
  createLibraryIndexTask,
  failLibraryIndexTask,
  latestInterruptedLibraryIndexTask,
  listLibraryIndexTasks,
  updateLibraryIndexTask,
  type NativeIndexTask,
} from "./indexTaskStore";

export type LibrarySearchStatus = "idle" | "searching" | "complete" | "error";

export interface LibrarySearchBook extends LibraryIndexBook {
  id: string;
  fileSize: number;
}

export interface LibrarySearchSnapshot {
  query: string;
  results: readonly ResolvedCrossBookSearchHit[];
  searchStatus: LibrarySearchStatus;
  searchError?: string;
  indexState: LibraryIndexPhase;
  indexSummary: LibraryIndexSummary;
  indexProgress: { completed: number; total: number; titles: readonly string[] };
  indexError?: string;
  rebuildRequested: boolean;
}

export interface LibraryIndexRunOptions {
  books: readonly LibrarySearchBook[];
  onProgress(progress: LibraryIndexProgress): void;
  /** Maximum parser workers; resource guards may temporarily run fewer. */
  concurrency: number;
}

export interface LibrarySearchRuntimeDependencies {
  supported: boolean;
  listStatuses(): Promise<IndexedBookStatus[]>;
  listTasks(): Promise<NativeIndexTask[]>;
  search(query: string): Promise<ResolvedCrossBookSearchHit[]>;
  clear(): Promise<void>;
  createTask(): Promise<NativeIndexTask>;
  updateTask(id: string, progress: number): Promise<NativeIndexTask>;
  completeTask(id: string): Promise<NativeIndexTask>;
  failTask(id: string, error: string): Promise<NativeIndexTask>;
  cancelTask(id: string): Promise<NativeIndexTask>;
  createIndexer(options: LibraryIndexRunOptions): LibraryIndexer;
  debounceMs?: number;
}

const EMPTY_SUMMARY: LibraryIndexSummary = {
  total: 0,
  indexed: 0,
  pending: 0,
  unavailable: 0,
  interrupted: false,
};

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Application-lifetime owner for library search and indexing.
 * UI panels subscribe to it; opening/closing a panel never owns or cancels work.
 */
export class LibrarySearchRuntime {
  private readonly listeners = new Set<() => void>();
  private books: readonly LibrarySearchBook[] = [];
  private booksKey = "";
  private state: LibrarySearchSnapshot = {
    query: "",
    results: [],
    searchStatus: "idle",
    indexState: "idle",
    indexSummary: EMPTY_SUMMARY,
    indexProgress: { completed: 0, total: 0, titles: [] },
    rebuildRequested: false,
  };
  private checkGeneration = 0;
  private searchGeneration = 0;
  private indexGeneration = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private checkPromise: Promise<void> | undefined;
  private indexer: LibraryIndexer | undefined;
  private cancelRequested = false;
  private concurrency = 1;

  constructor(private readonly dependencies: LibrarySearchRuntimeDependencies) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): LibrarySearchSnapshot => this.state;

  setBooks(books: readonly LibrarySearchBook[]): void {
    const nextKey = books.map((book) => [
      book.id, book.contentHash, book.available ? 1 : 0, book.fileSize,
      book.title, book.creator, book.language ?? "",
    ].join("\u0000")).join("\u0001");
    const changed = nextKey !== this.booksKey;
    this.books = books;
    this.booksKey = nextKey;
    if (changed && this.state.indexState !== "idle" && !this.isIndexBusy()) void this.checkIndex();
  }

  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, Math.floor(value));
  }

  setQuery(query: string): void {
    if (query === this.state.query) return;
    this.patch({ query });
    this.scheduleSearch();
  }

  async checkIndex(): Promise<void> {
    if (this.checkPromise) return this.checkPromise;
    const generation = ++this.checkGeneration;
    if (!this.dependencies.supported) {
      this.patch({ indexState: "error", indexError: "全部书籍检索目前仅支持 Windows 桌面版" });
      return;
    }
    this.patch({ indexState: "checking", indexError: undefined, rebuildRequested: false });
    const promise = Promise.all([this.dependencies.listStatuses(), this.dependencies.listTasks()])
      .then(([statuses, tasks]) => {
        if (generation !== this.checkGeneration) return;
        const summary = this.summarize(statuses, Boolean(latestInterruptedLibraryIndexTask(tasks)));
        this.patch({
          indexSummary: summary,
          indexProgress: { completed: summary.indexed, total: summary.total, titles: [] },
          indexState: phaseAfterIndexCheck(summary),
          indexError: summary.interrupted ? "上次建库在应用退出时中断，已完成书籍仍然可用。" : undefined,
        });
        this.scheduleSearch();
      })
      .catch((error: unknown) => {
        if (generation !== this.checkGeneration) return;
        this.patch({ indexState: "error", indexError: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (this.checkPromise === promise) this.checkPromise = undefined;
      });
    this.checkPromise = promise;
    return promise;
  }

  startIndex(): void {
    if (!this.dependencies.supported || this.indexer || !["confirmation", "partial", "cancelled", "error"].includes(this.state.indexState)) return;
    const generation = ++this.indexGeneration;
    const entries = this.books.filter((entry) => Boolean(entry.contentHash));
    const rebuild = this.state.rebuildRequested;
    this.cancelRequested = false;
    this.patch({
      indexState: "indexing",
      indexProgress: { completed: 0, total: entries.length, titles: [] },
      indexError: undefined,
    });

    void (async () => {
      let taskId: string | undefined;
      let indexer: LibraryIndexer | undefined;
      let taskUpdates = Promise.resolve();
      let lastPersistedCompleted = -1;
      try {
        taskId = (await this.dependencies.createTask()).id;
        if (this.cancelRequested) throw abortError("用户取消书库建库");
        if (rebuild) {
          await this.dependencies.clear();
          this.patch({ results: [], indexSummary: this.summarize([], false) });
          if (this.cancelRequested) throw abortError("用户取消书库建库");
        }
        indexer = this.dependencies.createIndexer({
          books: entries,
          concurrency: this.concurrency,
          onProgress: ({ completedBooks, totalBooks, currentTitle, currentTitles }) => {
            if (generation !== this.indexGeneration) return;
            this.patch({
              indexProgress: {
                completed: completedBooks,
                total: totalBooks,
                titles: currentTitles ?? (currentTitle ? [currentTitle] : []),
              },
            });
            if (taskId && totalBooks > 0 && completedBooks !== lastPersistedCompleted) {
              lastPersistedCompleted = completedBooks;
              taskUpdates = taskUpdates
                .then(() => this.dependencies.updateTask(taskId!, Math.min(1, completedBooks / totalBooks)))
                .then(() => undefined, () => undefined);
            }
          },
        });
        this.indexer = indexer;
        if (this.cancelRequested) await indexer.cancel("用户取消书库建库");
        const result = await indexer.run();
        await taskUpdates;
        if (taskId) await this.dependencies.completeTask(taskId);
        const summary = await this.readSummary(false);
        if (generation !== this.indexGeneration) return;
        this.patch({
          indexState: summary.pending > 0 ? "partial" : "ready",
          indexError: failureMessage(result),
          rebuildRequested: false,
        });
        this.scheduleSearch();
      } catch (error) {
        await taskUpdates;
        const cancelled = (error as Error)?.name === "AbortError" || this.cancelRequested;
        if (taskId) {
          try {
            if (cancelled) await this.dependencies.cancelTask(taskId);
            else await this.dependencies.failTask(taskId, error instanceof Error ? error.message : String(error));
          } catch {
            // Native startup recovery reclaims a still-active durable task.
          }
        }
        const summary = await this.readSummary(false).catch(() => this.state.indexSummary);
        if (generation !== this.indexGeneration) return;
        this.patch({
          indexState: cancelled ? phaseAfterIndexStop(summary) : (summary.indexed > 0 ? "partial" : "error"),
          indexError: cancelled ? undefined : (error instanceof Error ? error.message : String(error)),
          rebuildRequested: false,
        });
      } finally {
        if (this.indexer === indexer) this.indexer = undefined;
        if (generation === this.indexGeneration) this.cancelRequested = false;
      }
    })();
  }

  cancelIndex(): void {
    if (this.state.indexState !== "indexing" && this.state.indexState !== "cancelling") return;
    this.cancelRequested = true;
    this.patch({ indexState: "cancelling" });
    if (this.indexer) void this.indexer.cancel("用户取消书库建库");
  }

  deferIndex(): void {
    if (this.state.rebuildRequested) {
      void this.checkIndex();
      return;
    }
    this.patch({
      indexState: this.state.indexSummary.indexed > 0 ? "partial" : "idle",
      indexError: undefined,
      rebuildRequested: false,
    });
  }

  requestRebuild(): void {
    if (!this.dependencies.supported || this.isIndexBusy()) return;
    const summary = this.summarize([], false);
    this.patch({
      indexState: "confirmation",
      indexSummary: summary,
      rebuildRequested: true,
      indexError: undefined,
      results: [],
      searchStatus: "idle",
    });
  }

  async clearIndex(): Promise<void> {
    if (!this.dependencies.supported || this.isIndexBusy()) return;
    try {
      await this.dependencies.clear();
      this.patch({
        results: [],
        searchStatus: "idle",
        indexState: "idle",
        indexSummary: EMPTY_SUMMARY,
        indexProgress: { completed: 0, total: 0, titles: [] },
        searchError: undefined,
        indexError: undefined,
        rebuildRequested: false,
      });
    } catch (error) {
      this.patch({ indexState: "error", indexError: error instanceof Error ? error.message : String(error) });
    }
  }

  private isIndexBusy(): boolean {
    return this.state.indexState === "indexing" || this.state.indexState === "cancelling";
  }

  private summarize(statuses: readonly IndexedBookStatus[], interrupted: boolean): LibraryIndexSummary {
    return summarizeLibraryIndex(
      this.books.map((entry) => ({ contentHash: entry.contentHash, available: entry.available })),
      statuses,
      interrupted,
    );
  }

  private async readSummary(interrupted: boolean): Promise<LibraryIndexSummary> {
    const summary = this.summarize(await this.dependencies.listStatuses(), interrupted);
    this.patch({ indexSummary: summary });
    return summary;
  }

  private scheduleSearch(): void {
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    const generation = ++this.searchGeneration;
    const query = this.state.query.trim();
    if (!query) {
      this.patch({ results: [], searchStatus: "idle", searchError: undefined });
      return;
    }
    if (!libraryIndexCanSearch(this.state.indexState, this.state.indexSummary)) {
      this.patch({ results: [], searchStatus: this.state.indexState === "error" ? "error" : "idle" });
      return;
    }
    this.patch({ searchStatus: "searching", searchError: undefined });
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      void this.dependencies.search(query).then((results) => {
        if (generation !== this.searchGeneration) return;
        this.patch({ results, searchStatus: "complete" });
      }).catch((error: unknown) => {
        if (generation !== this.searchGeneration) return;
        this.patch({ searchStatus: "error", searchError: error instanceof Error ? error.message : String(error) });
      });
    }, this.dependencies.debounceMs ?? 180);
  }

  private patch(patch: Partial<LibrarySearchSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function failureMessage(result: LibraryIndexResult): string | undefined {
  if (result.failures.length === 0) return undefined;
  const firstFailure = result.failures[0]?.error;
  return `有 ${result.failures.length} 本书建库失败${firstFailure ? `：${firstFailure}` : ""}`;
}

export function createDefaultLibrarySearchRuntime(
  supported: boolean,
  options: { waitUntilRunnable?(signal: AbortSignal): void | Promise<void> } = {},
): LibrarySearchRuntime {
  const createIndexer = createWorkerLibraryIndexerFactory({
    store: createTauriIndexStagingStore(),
    listStatus: listIndexedBooks,
    workerFactory: createDefaultCorpusWorkerFactory(),
    waitUntilRunnable: options.waitUntilRunnable,
    yieldToReader: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  });
  return new LibrarySearchRuntime({
    supported,
    listStatuses: listIndexedBooks,
    listTasks: listLibraryIndexTasks,
    search: (query) => searchBookTextIndex({
      query,
      limit: 101,
      parserVersion: CORPUS_PARSER_VERSION,
      normalizerVersion: CORPUS_NORMALIZER_VERSION,
      chunkerVersion: CORPUS_CHUNKER_VERSION,
    }),
    clear: clearAllTextIndexes,
    createTask: createLibraryIndexTask,
    updateTask: updateLibraryIndexTask,
    completeTask: completeLibraryIndexTask,
    failTask: failLibraryIndexTask,
    cancelTask: cancelLibraryIndexTask,
    createIndexer,
  });
}
