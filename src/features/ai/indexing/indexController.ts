import { chunkCorpus, type ChunkingOptions, type DocumentChunk } from "../../../core/chunking";
import type { CorpusChapter } from "../../../core/corpus";
import {
  makeNativeIndexChunk,
  normalizeIndexedBookMetadata,
  type IndexedBookMetadata,
  type IndexStagingBeginInput,
  type IndexStagingBatch,
  type IndexStagingStorePort,
} from "./indexStore";

const DEFAULT_MAX_CHUNKS_PER_BATCH = 64;
const DEFAULT_MAX_CHARACTERS_PER_BATCH = 128_000;

export type IndexChapterInput = CorpusChapter | DocumentChunk | readonly DocumentChunk[];
export type IndexChapterSource = Iterable<IndexChapterInput> | AsyncIterable<IndexChapterInput>;
export type IndexChapterProducer = (
  signal: AbortSignal,
) => IndexChapterSource | Promise<IndexChapterSource>;

export interface IndexProgress {
  /** Aliases for the chunk counters used by task/progress UIs. */
  completed: number;
  total: number | null;
  completedChunks: number;
  totalChunks: number | null;
  completedChapters: number;
  totalChapters: number | null;
  /** Always non-decreasing; it is 1 only after commit succeeds. */
  fraction: number;
}

export interface IndexBuildResult {
  stagingId: string | null;
  committedChunks: number;
  chapters: number;
  batches: number;
  skipped: boolean;
}

export interface IndexControllerOptions {
  metadata: IndexedBookMetadata;
  store: IndexStagingStorePort;
  /** Use either chapters or chapterProducer, not both. */
  chapters?: IndexChapterSource;
  chapterProducer?: IndexChapterProducer;
  /** Options for CorpusChapter inputs; the book fingerprint is supplied by metadata. */
  chunking?: Omit<ChunkingOptions, "bookFingerprint">;
  maxChunksPerBatch?: number;
  maxCharactersPerBatch?: number;
  /** Optional hints. Unknown totals are represented as null in progress. */
  totalChunks?: number;
  totalChapters?: number;
  /** Return false for a matching contentHash/parser/chunker status to skip work. */
  shouldIndex?: (metadata: IndexedBookMetadata) => boolean | Promise<boolean>;
  onProgress?: (progress: IndexProgress) => void;
  /** Yield after bounded appends so an active reader remains responsive. */
  yieldToReader?: () => void | Promise<void>;
  signal?: AbortSignal;
}

export interface IndexBuildController {
  readonly signal: AbortSignal;
  run(): Promise<IndexBuildResult>;
  /**
   * Request cancellation and resolve after the active build has settled.
   *
   * The build promise still rejects with AbortError, so callers that need the
   * result should continue to await run().  The returned promise is a
   * cleanup barrier: it does not resolve until a staging transaction has
   * either been committed or aborted.
   */
  cancel(reason?: string): Promise<void>;
}

export type LibraryBookIndexOptions = Omit<IndexControllerOptions, "onProgress" | "signal">;

export interface MultiIndexProgress {
  bookIndex: number;
  bookCount: number;
  completedBooks: number;
  totalBooks: number;
  contentHash: string;
  current: IndexProgress;
  /** Aggregate progress across the sequential book queue. */
  fraction: number;
}

export interface MultiIndexBuildResult {
  books: IndexBuildResult[];
  committedChunks: number;
  skippedBooks: number;
}

export interface MultiIndexControllerOptions {
  books: readonly LibraryBookIndexOptions[];
  signal?: AbortSignal;
  onProgress?: (progress: MultiIndexProgress) => void;
}

export interface MultiIndexBuildController {
  readonly signal: AbortSignal;
  run(): Promise<MultiIndexBuildResult>;
  /** Resolve after the current book has finished aborting its staging data. */
  cancel(reason?: string): Promise<void>;
}

function abortError(reason?: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "索引建库已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

function isCorpusChapter(input: IndexChapterInput): input is CorpusChapter {
  return !Array.isArray(input) && typeof input === "object" && "blocks" in input && "chapterPath" in input;
}

function isDocumentChunk(input: IndexChapterInput): input is DocumentChunk {
  return !Array.isArray(input) && typeof input === "object" && "chunkId" in input && "originalText" in input;
}

function chunksForInput(
  input: IndexChapterInput,
  metadata: IndexedBookMetadata,
  chunking: Omit<ChunkingOptions, "bookFingerprint"> | undefined,
): DocumentChunk[] {
  if (isCorpusChapter(input)) {
    if (input.bookFingerprint !== metadata.contentHash) {
      throw new Error("章节语料与书籍内容指纹不一致");
    }
    return chunkCorpus(input, { ...chunking, bookFingerprint: metadata.contentHash });
  }
  if (isDocumentChunk(input)) return [input];
  return [...input];
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const result = Math.floor(value ?? fallback);
  if (!Number.isFinite(result) || result < 1) throw new Error(`${label} 必须是正整数`);
  return result;
}

function characterCount(chunk: DocumentChunk): number {
  // Count both strings because both cross the IPC boundary in a native batch.
  return Array.from(chunk.originalText).length + Array.from(chunk.normalizedText).length;
}

function sameVersions(a: DocumentChunk, b: DocumentChunk): boolean {
  return a.parserVersion === b.parserVersion
    && a.normalizerVersion === b.normalizerVersion
    && a.chunkerVersion === b.chunkerVersion;
}

function makeProgress(
  completedChunks: number,
  totalChunks: number | null,
  completedChapters: number,
  totalChapters: number | null,
  fraction: number,
): IndexProgress {
  return {
    completed: completedChunks,
    total: totalChunks,
    completedChunks,
    totalChunks,
    completedChapters,
    totalChapters,
    fraction,
  };
}

function sourceFor(options: IndexControllerOptions, signal: AbortSignal): Promise<IndexChapterSource> {
  if (options.chapters && options.chapterProducer) {
    return Promise.reject(new Error("不能同时提供 chapters 和 chapterProducer"));
  }
  if (options.chapters) return Promise.resolve(options.chapters);
  if (options.chapterProducer) return Promise.resolve(options.chapterProducer(signal));
  return Promise.reject(new Error("必须提供 chapters 或 chapterProducer"));
}

/**
 * Create a framework-independent, chapter-oriented index build controller.
 * It never reads a book or shelf itself: callers provide CorpusChapter or
 * DocumentChunk values through chapters/chapterProducer.
 */
export function createIndexBuildController(options: IndexControllerOptions): IndexBuildController {
  const localAbort = new AbortController();
  const externalSignal = options.signal;
  let externalAbortListener: (() => void) | undefined;
  if (externalSignal) {
    const forwardAbort = (): void => localAbort.abort(externalSignal.reason);
    if (externalSignal.aborted) forwardAbort();
    else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
      externalAbortListener = () => externalSignal.removeEventListener("abort", forwardAbort);
    }
  }

  const maxChunks = positiveOption(options.maxChunksPerBatch, DEFAULT_MAX_CHUNKS_PER_BATCH, "每批 chunk 数");
  const maxCharacters = positiveOption(options.maxCharactersPerBatch, DEFAULT_MAX_CHARACTERS_PER_BATCH, "每批字符数");
  const totalChunks = options.totalChunks === undefined ? null : positiveOption(options.totalChunks, 1, "chunk 总数");
  const totalChapters = options.totalChapters === undefined ? null : positiveOption(options.totalChapters, 1, "章节总数");
  let started = false;
  let runPromise: Promise<IndexBuildResult> | undefined;

  const run = async (): Promise<IndexBuildResult> => {
    if (started) throw new Error("索引建库控制器只能运行一次");
    started = true;
    let stagingId: string | undefined;
    let committed = false;
    // Commit is the atomic hand-off from staging to the live index. Do not
    // race it with abort when cancellation arrives during the native call;
    // once commit starts, the book either becomes the new index or the
    // rejected commit is cleaned up in the catch path after it settles.
    let commitInFlight = false;
    let abortCalled = false;
    let sequence = 0;
    let completedChunks = 0;
    let completedChapters = 0;
    let batchCount = 0;
    let previousFraction = 0;
    let expectedVersions: DocumentChunk | undefined;

    const report = (forceComplete = false): void => {
      // A cancelled generation must not publish a late progress update to a
      // replacement search task. The caller still receives the original
      // AbortError from run(), while the cleanup barrier waits for staging to
      // finish aborting.
      if (localAbort.signal.aborted) return;
      const byChunks = totalChunks === null ? 0 : Math.min(1, completedChunks / totalChunks);
      const byChapters = totalChapters === null ? 0 : Math.min(1, completedChapters / totalChapters);
      const next = forceComplete ? 1 : Math.max(previousFraction, totalChunks !== null ? byChunks : byChapters);
      previousFraction = Math.min(1, next);
      options.onProgress?.(makeProgress(
        completedChunks,
        totalChunks,
        completedChapters,
        totalChapters,
        previousFraction,
      ));
    };

    const yieldToReader = async (): Promise<void> => {
      const yielded = options.yieldToReader?.();
      // A reader-priority callback is allowed to request cancellation. In
      // that case cancel() may return the run's cleanup barrier; awaiting it
      // here would deadlock because staging cleanup happens in this same
      // stack after the yield returns.
      if (!localAbort.signal.aborted) await yielded;
    };

    const abortActive = async (reason: unknown): Promise<void> => {
      if (!stagingId || abortCalled || committed || commitInFlight) return;
      abortCalled = true;
      try {
        await options.store.abort(stagingId, reason instanceof Error ? reason.message : String(reason ?? "索引建库失败"));
      } catch {
        // Preserve the original build/cancel error; abort is best-effort cleanup.
      }
    };

    try {
      throwIfAborted(localAbort.signal);
      if (options.shouldIndex && !(await options.shouldIndex(options.metadata))) {
        throwIfAborted(localAbort.signal);
        report(true);
        return { stagingId: null, committedChunks: 0, chapters: 0, batches: 0, skipped: true };
      }
      const source = await sourceFor(options, localAbort.signal);
      let batch: DocumentChunk[] = [];
      let batchCharacters = 0;
      const flush = async (): Promise<boolean> => {
        if (batch.length === 0) return false;
        throwIfAborted(localAbort.signal);
        if (!stagingId || !expectedVersions) throw new Error("索引 staging 尚未初始化");
        const payload: IndexStagingBatch = { sequence, chunks: batch.map(makeNativeIndexChunk) };
        await options.store.append(stagingId, payload);
        sequence++;
        batchCount++;
        completedChunks += batch.length;
        batch = [];
        batchCharacters = 0;
        report();
        await yieldToReader();
        throwIfAborted(localAbort.signal);
        return true;
      };

      for await (const input of source) {
        throwIfAborted(localAbort.signal);
        const chunks = chunksForInput(input, options.metadata, options.chunking);
        let yieldedForChapter = false;
        for (const chunk of chunks) {
          throwIfAborted(localAbort.signal);
          if (chunk.bookFingerprint !== options.metadata.contentHash) {
            throw new Error("索引正文块与书籍内容指纹不一致");
          }
          if (expectedVersions && !sameVersions(expectedVersions, chunk)) {
            throw new Error("索引正文块的 parserVersion、normalizerVersion 或 chunkerVersion 不一致");
          }
          if (!expectedVersions) {
            expectedVersions = chunk;
            const begin: IndexStagingBeginInput = {
              ...normalizeIndexedBookMetadata(options.metadata),
              parserVersion: chunk.parserVersion,
              normalizerVersion: chunk.normalizerVersion,
              chunkerVersion: chunk.chunkerVersion,
              ...(totalChunks === null ? {} : { expectedChunks: totalChunks }),
            };
            stagingId = await options.store.begin(begin);
            throwIfAborted(localAbort.signal);
          }
          const size = characterCount(chunk);
          if (batch.length > 0 && (batch.length >= maxChunks || batchCharacters + size > maxCharacters)) {
            yieldedForChapter = (await flush()) || yieldedForChapter;
          }
          batch.push(chunk);
          batchCharacters += size;
        }
        if (await flush()) yieldedForChapter = true;
        completedChapters++;
        report();
        if (!yieldedForChapter) {
          await yieldToReader();
          throwIfAborted(localAbort.signal);
        }
      }

      throwIfAborted(localAbort.signal);
      if (!stagingId || !expectedVersions || completedChunks === 0) {
        throw new Error("不能为没有正文块的书籍建立索引");
      }
      commitInFlight = true;
      let committedChunks: number;
      try {
        committedChunks = await options.store.commit(stagingId);
      } finally {
        commitInFlight = false;
      }
      committed = true;
      report(true);
      return { stagingId, committedChunks, chapters: completedChapters, batches: batchCount, skipped: false };
    } catch (error) {
      await abortActive(error);
      throw error;
    } finally {
      externalAbortListener?.();
    }
  };

  return {
    signal: localAbort.signal,
    run: () => {
      runPromise ??= run();
      return runPromise;
    },
    cancel: (reason?: string): Promise<void> => {
      if (!localAbort.signal.aborted) localAbort.abort(reason ? new Error(reason) : abortError());
      // A cancellation request may arrive before run() (for example while a
      // panel is being torn down). There is no staging to reclaim in that
      // case, so the cleanup barrier is already satisfied. Once run() has
      // started, observe its settlement so callers can safely remove the UI
      // and release the task generation only after abort() completed.
      if (!runPromise) {
        externalAbortListener?.();
        externalAbortListener = undefined;
        return Promise.resolve();
      }
      return runPromise.then(() => undefined, () => undefined);
    },
  };
}

export async function buildBookIndex(options: IndexControllerOptions): Promise<IndexBuildResult> {
  return createIndexBuildController(options).run();
}

/**
 * Queue independent books sequentially. This keeps the reader-friendly yield
 * and cancellation semantics of each single-book controller while exposing an
 * aggregate progress stream for a library task UI.
 */
export function createMultiBookIndexController(options: MultiIndexControllerOptions): MultiIndexBuildController {
  const localAbort = new AbortController();
  let externalAbortListener: (() => void) | undefined;
  if (options.signal) {
    const forwardAbort = (): void => localAbort.abort(options.signal?.reason);
    if (options.signal.aborted) forwardAbort();
    else {
      options.signal.addEventListener("abort", forwardAbort, { once: true });
      externalAbortListener = () => options.signal?.removeEventListener("abort", forwardAbort);
    }
  }
  let started = false;
  let runPromise: Promise<MultiIndexBuildResult> | undefined;

  const run = async (): Promise<MultiIndexBuildResult> => {
    if (started) throw new Error("多书索引控制器只能运行一次");
    started = true;
    const results: IndexBuildResult[] = [];
    let committedChunks = 0;
    let skippedBooks = 0;
    try {
      const bookCount = options.books.length;
      if (bookCount === 0) {
        options.onProgress?.({
          bookIndex: 0,
          bookCount: 0,
          completedBooks: 0,
          totalBooks: 0,
          contentHash: "",
          current: makeProgress(0, 0, 0, 0, 1),
          fraction: 1,
        });
        return { books: results, committedChunks: 0, skippedBooks: 0 };
      }
      for (let bookIndex = 0; bookIndex < bookCount; bookIndex++) {
        throwIfAborted(localAbort.signal);
        const book = options.books[bookIndex];
        const controller = createIndexBuildController({
          ...book,
          signal: localAbort.signal,
          onProgress: (current) => options.onProgress?.({
            bookIndex,
            bookCount,
            completedBooks: bookIndex,
            totalBooks: bookCount,
            contentHash: book.metadata.contentHash,
            current,
            fraction: Math.min(1, (bookIndex + current.fraction) / bookCount),
          }),
        });
        const result = await controller.run();
        // A cancellation can arrive while the native commit is in flight.
        // The single-book transaction is already atomic (and is deliberately
        // retained), but the queue must not publish a stale completion or
        // start another book for the old generation.
        throwIfAborted(localAbort.signal);
        results.push(result);
        committedChunks += result.committedChunks;
        if (result.skipped) skippedBooks++;
        const current = makeProgress(
          result.committedChunks,
          result.committedChunks,
          result.chapters,
          result.chapters,
          1,
        );
        options.onProgress?.({
          bookIndex,
          bookCount,
          completedBooks: bookIndex + 1,
          totalBooks: bookCount,
          contentHash: book.metadata.contentHash,
          current,
          fraction: (bookIndex + 1) / bookCount,
        });
      }
      return { books: results, committedChunks, skippedBooks };
    } finally {
      externalAbortListener?.();
    }
  };

  return {
    signal: localAbort.signal,
    run: () => {
      runPromise ??= run();
      return runPromise;
    },
    cancel: (reason?: string): Promise<void> => {
      if (!localAbort.signal.aborted) localAbort.abort(reason ? new Error(reason) : abortError());
      if (!runPromise) {
        externalAbortListener?.();
        externalAbortListener = undefined;
        return Promise.resolve();
      }
      return runPromise.then(() => undefined, () => undefined);
    },
  };
}

export async function buildLibraryIndexes(options: MultiIndexControllerOptions): Promise<MultiIndexBuildResult> {
  return createMultiBookIndexController(options).run();
}
