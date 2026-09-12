import { loadBook } from "../../../core/book";
import { iterateBookChunkBatches, textForBookResource } from "../../../core/bookCorpusIndex";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import type { Book } from "../../../core/types";
import { createIndexBuildController, type IndexBuildResult, type IndexProgress } from "./indexController";
import type { IndexedBookStatus, IndexStagingStorePort } from "./indexStore";

export interface LibraryIndexBook {
  contentHash: string;
  title: string;
  creator: string;
  language?: string;
  available: boolean;
  read(): Promise<Uint8Array>;
}

export interface LibraryIndexProgress {
  completedBooks: number;
  totalBooks: number;
  currentTitle: string;
  /** Titles currently parsed in parallel; currentTitle remains the first for legacy UIs. */
  currentTitles?: readonly string[];
  current: IndexProgress | null;
}

export interface LibraryIndexFailure {
  contentHash: string;
  title: string;
  error: string;
}

export interface LibraryIndexResult {
  indexedBooks: number;
  skippedBooks: number;
  unavailableBooks: number;
  committedChunks: number;
  failures: LibraryIndexFailure[];
}

export interface LibraryIndexerOptions {
  books: readonly LibraryIndexBook[];
  store: IndexStagingStorePort;
  listStatus(): Promise<IndexedBookStatus[]>;
  onProgress?(progress: LibraryIndexProgress): void;
  yieldToReader?: () => void | Promise<void>;
  signal?: AbortSignal;
  /** Test seam; production uses the normal EPUB parser. */
  parseBook?: (bytes: Uint8Array) => Promise<Book>;
}

export interface LibraryIndexer {
  readonly signal: AbortSignal;
  run(): Promise<LibraryIndexResult>;
  /**
   * Request cancellation and resolve after the current read/parse operation
   * and any staging abort have settled. The run() promise retains its
   * AbortError rejection for callers that need to distinguish cancellation.
   */
  cancel(reason?: string): Promise<void>;
}

function abortError(reason?: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "书库建库已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

export function indexStatusIsCurrent(status: IndexedBookStatus | undefined): boolean {
  return status?.parserVersion === CORPUS_PARSER_VERSION
    && status.normalizerVersion === CORPUS_NORMALIZER_VERSION
    && status.chunkerVersion === CORPUS_CHUNKER_VERSION;
}

export function createLibraryIndexer(options: LibraryIndexerOptions): LibraryIndexer {
  const abort = new AbortController();
  const forwardAbort = (): void => abort.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let promise: Promise<LibraryIndexResult> | undefined;

  const run = async (): Promise<LibraryIndexResult> => {
    throwIfAborted(abort.signal);
    const statuses = new Map((await options.listStatus()).map((status) => [status.contentHash, status]));
    throwIfAborted(abort.signal);
    const candidates = options.books.filter((book) => book.contentHash.length > 0);
    const result: LibraryIndexResult = {
      indexedBooks: 0, skippedBooks: 0, unavailableBooks: 0, committedChunks: 0, failures: [],
    };
    try {
      for (let index = 0; index < candidates.length; index++) {
        throwIfAborted(abort.signal);
        const item = candidates[index];
        options.onProgress?.({ completedBooks: index, totalBooks: candidates.length, currentTitle: item.title, current: null });
        if (!item.available) {
          result.unavailableBooks++;
          options.onProgress?.({ completedBooks: index + 1, totalBooks: candidates.length, currentTitle: item.title, current: null });
          await options.yieldToReader?.();
          continue;
        }
        if (indexStatusIsCurrent(statuses.get(item.contentHash))) {
          result.skippedBooks++;
          options.onProgress?.({ completedBooks: index + 1, totalBooks: candidates.length, currentTitle: item.title, current: null });
          await options.yieldToReader?.();
          continue;
        }
        try {
          const bytes = await item.read();
          throwIfAborted(abort.signal);
          const book = await (options.parseBook ?? loadBook)(bytes);
          throwIfAborted(abort.signal);
          if (book.fixedLayout) {
            result.unavailableBooks++;
            continue;
          }
          const totalChapters = book.spine.filter((spine) => spine.linear).length;
          const controller = createIndexBuildController({
            metadata: {
              contentHash: item.contentHash,
              title: item.title,
              creator: item.creator,
              language: item.language,
            },
            store: options.store,
            totalChapters: Math.max(1, totalChapters),
            signal: abort.signal,
            yieldToReader: options.yieldToReader,
            chapterProducer: async function* (signal) {
              for await (const batch of iterateBookChunkBatches(book, {
                bookFingerprint: item.contentHash,
                signal,
                textFor: (path) => textForBookResource(book, path),
              })) yield batch.chunks;
            },
            onProgress: (current) => options.onProgress?.({
              completedBooks: index,
              totalBooks: candidates.length,
              currentTitle: item.title,
              current,
            }),
          });
          const built: IndexBuildResult = await controller.run();
          result.indexedBooks++;
          result.committedChunks += built.committedChunks;
        } catch (error) {
          if ((error as Error)?.name === "AbortError") throw error;
          result.failures.push({
            contentHash: item.contentHash,
            title: item.title,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        options.onProgress?.({
          completedBooks: index + 1,
          totalBooks: candidates.length,
          currentTitle: item.title,
          current: null,
        });
        await options.yieldToReader?.();
      }
      return result;
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  };

  return {
    signal: abort.signal,
    run: () => (promise ??= run()),
    cancel: (reason?: string): Promise<void> => {
      if (!abort.signal.aborted) abort.abort(reason ? new Error(reason) : abortError());
      // If the queue was cancelled before it ever started, there is no book
      // read or staging transaction to reclaim. Also detach the forwarding
      // listener so a discarded indexer does not retain its owner.
      if (!promise) {
        options.signal?.removeEventListener("abort", forwardAbort);
        return Promise.resolve();
      }
      // Cancellation is an async lifecycle event: callers can await this
      // barrier before changing search scope or replacing the task. Swallow
      // the expected AbortError (and any run failure) here; run() remains the
      // source of the actual result/error.
      return promise.then(() => undefined, () => undefined);
    },
  };
}
