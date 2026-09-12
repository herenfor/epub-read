import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import { createFtsCorpusSink } from "./ftsCorpusSink";
import {
  indexStatusIsCurrent,
  type LibraryIndexBook,
  type LibraryIndexer,
  type LibraryIndexProgress,
  type LibraryIndexResult,
} from "./libraryIndexer";
import type { IndexedBookStatus, IndexStagingStorePort } from "./indexStore";
import { createCorpusWorkerPool } from "./corpusWorkerPool";
import type { CorpusWorkerFactory } from "./corpusWorkerProtocol";

export interface WorkerLibraryIndexerDependencies {
  store: IndexStagingStorePort;
  listStatus(): Promise<IndexedBookStatus[]>;
  workerFactory: CorpusWorkerFactory;
  yieldToReader?(): void | Promise<void>;
  waitUntilRunnable?(signal: AbortSignal): void | Promise<void>;
}

export interface WorkerLibraryIndexerOptions {
  books: readonly (LibraryIndexBook & { fileSize?: number })[];
  concurrency: number;
  onProgress(progress: LibraryIndexProgress): void;
}

function abortError(reason?: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "书库建库已取消");
  error.name = "AbortError";
  return error;
}

function progress(completedBooks: number, totalBooks: number, titles: readonly string[] = []): LibraryIndexProgress {
  return { completedBooks, totalBooks, currentTitle: titles[0] ?? "", currentTitles: titles, current: null };
}

/**
 * Adapt the shared corpus Worker pool to the existing library-indexer
 * contract. EPUB parsing stays in the Worker and FTS remains a sink, so later
 * consumers can reuse the same producer without duplicating extraction.
 */
export function createWorkerLibraryIndexer(
  dependencies: WorkerLibraryIndexerDependencies,
  options: WorkerLibraryIndexerOptions,
): LibraryIndexer {
  const localAbort = new AbortController();
  let pool: ReturnType<typeof createCorpusWorkerPool> | undefined;
  let runPromise: Promise<LibraryIndexResult> | undefined;

  const run = async (): Promise<LibraryIndexResult> => {
    if (localAbort.signal.aborted) throw abortError(localAbort.signal.reason);
    const statuses = new Map((await dependencies.listStatus()).map((status) => [status.contentHash, status]));
    if (localAbort.signal.aborted) throw abortError(localAbort.signal.reason);
    const candidates = options.books.filter((book) => book.contentHash.length > 0);
    const failuresByHash = new Map(candidates.map((book) => [book.contentHash, book]));
    const skippedBooks = candidates.filter((book) => book.available && indexStatusIsCurrent(statuses.get(book.contentHash))).length;
    const unavailableBooks = candidates.filter((book) => !book.available).length;
    const jobs = candidates
      .filter((book) => book.available && !indexStatusIsCurrent(statuses.get(book.contentHash)))
      .map((book) => ({
        jobId: book.contentHash,
        book: { contentHash: book.contentHash, title: book.title, creator: book.creator, language: book.language },
        sizeBytes: book.fileSize,
        read: async () => book.read(),
      }));
    let completedBooks = skippedBooks + unavailableBooks;
    const activeTitles = new Map<string, string>();
    options.onProgress(progress(completedBooks, candidates.length));
    pool = createCorpusWorkerPool({
      jobs,
      workerFactory: dependencies.workerFactory,
      sink: createFtsCorpusSink(dependencies.store),
      concurrency: options.concurrency,
      signal: localAbort.signal,
      onJobStarted: (jobId) => {
        const book = failuresByHash.get(jobId);
        if (book) activeTitles.set(jobId, book.title);
        options.onProgress(progress(completedBooks, candidates.length, [...activeTitles.values()]));
      },
      waitUntilRunnable: dependencies.waitUntilRunnable,
      onJobSettled: (jobId, status) => {
        if (status === "completed" || status === "failed") completedBooks++;
        activeTitles.delete(jobId);
        options.onProgress(progress(completedBooks, candidates.length, [...activeTitles.values()]));
        void dependencies.yieldToReader?.();
      },
    });
    const result = await pool.run();
    if (result.cancelled || localAbort.signal.aborted) throw abortError(localAbort.signal.reason);
    return {
      indexedBooks: result.completedJobs,
      skippedBooks,
      unavailableBooks,
      committedChunks: result.committedChunks,
      failures: result.failures.map((failure) => {
        const book = failuresByHash.get(failure.jobId);
        return { contentHash: failure.jobId, title: book?.title ?? failure.jobId, error: failure.error };
      }),
    };
  };

  return {
    signal: localAbort.signal,
    run: () => (runPromise ??= run()),
    cancel: async (reason?: string): Promise<void> => {
      if (!localAbort.signal.aborted) localAbort.abort(reason ? new Error(reason) : abortError());
      await pool?.cancel(reason);
      if (runPromise) await runPromise.then(() => undefined, () => undefined);
    },
  };
}

export function createWorkerLibraryIndexerFactory(dependencies: WorkerLibraryIndexerDependencies):
  (options: WorkerLibraryIndexerOptions) => LibraryIndexer {
  return (options) => createWorkerLibraryIndexer(dependencies, options);
}

export const currentCorpusVersions = {
  parserVersion: CORPUS_PARSER_VERSION,
  normalizerVersion: CORPUS_NORMALIZER_VERSION,
  chunkerVersion: CORPUS_CHUNKER_VERSION,
} as const;
