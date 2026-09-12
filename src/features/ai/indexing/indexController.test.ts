import { describe, expect, it, vi } from "vitest";
import type { DocumentChunk } from "../../../core/chunking";
import type { IndexStagingBatch, IndexStagingStorePort } from "./indexStore";
import { createIndexBuildController, createMultiBookIndexController } from "./indexController";

const hash = "a".repeat(64);

function chunk(index: number, overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    bookFingerprint: hash,
    chunkId: `chunk-${index}`,
    chapterPath: `Text/${index}.xhtml`,
    chapterTitle: `第${index}章`,
    spineIndex: index,
    contentType: "paragraph",
    originalText: `正文${index}`,
    normalizedText: `正文${index}`,
    textAnchor: { start: index, end: index + 2, snippet: `正文${index}` },
    parserVersion: "parser-v1",
    normalizerVersion: "normalizer-v1",
    chunkerVersion: "chunker-v1",
    unitStart: 0,
    unitEnd: 1,
    ...overrides,
  };
}

function store(): IndexStagingStorePort & { batches: IndexStagingBatch[]; aborted: string[] } {
  const batches: IndexStagingBatch[] = [];
  const aborted: string[] = [];
  return {
    batches,
    aborted,
    begin: vi.fn(async () => "stage-1"),
    append: vi.fn(async (_id, batch) => { batches.push(batch); }),
    commit: vi.fn(async () => batches.reduce((sum, batch) => sum + batch.chunks.length, 0)),
    abort: vi.fn(async (id) => { aborted.push(id); }),
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const metadata = { contentHash: hash, title: "测试书", creator: "作者" };

describe("index build controller", () => {
  it("opens one staging transaction and obeys both batch limits", async () => {
    const active = store();
    const progress: number[] = [];
    const controller = createIndexBuildController({
      metadata,
      store: active,
      chapters: [[chunk(1), chunk(2)], [chunk(3)]],
      maxChunksPerBatch: 2,
      maxCharactersPerBatch: 20,
      onProgress: (value) => progress.push(value.fraction),
      yieldToReader: vi.fn(),
    });

    await expect(controller.run()).resolves.toMatchObject({ stagingId: "stage-1", committedChunks: 3, chapters: 2, batches: 2, skipped: false });
    expect(active.begin).toHaveBeenCalledWith({ ...metadata, parserVersion: "parser-v1", normalizerVersion: "normalizer-v1", chunkerVersion: "chunker-v1" });
    expect(active.batches.map((batch) => batch.chunks.map((item) => item.chunkId))).toEqual([["chunk-1", "chunk-2"], ["chunk-3"]]);
    expect(active.batches.map((batch) => batch.sequence)).toEqual([0, 1]);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    expect(active.abort).not.toHaveBeenCalled();
  });

  it("aborts a staging transaction when a reader-priority yield is cancelled", async () => {
    const active = store();
    let controller!: ReturnType<typeof createIndexBuildController>;
    controller = createIndexBuildController({
      metadata,
      store: active,
      chapters: [[chunk(1)]],
      yieldToReader: () => controller.cancel("reader resumed"),
    });

    await expect(controller.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(active.abort).toHaveBeenCalledWith("stage-1", "reader resumed");
    expect(active.commit).not.toHaveBeenCalled();
  });

  it("returns a cleanup barrier and makes repeated cancellation idempotent", async () => {
    const active = store();
    const abortStarted = deferred();
    const abortRelease = deferred();
    active.abort = vi.fn(async (id) => {
      active.aborted.push(id);
      abortStarted.resolve();
      await abortRelease.promise;
    });
    let controller!: ReturnType<typeof createIndexBuildController>;
    controller = createIndexBuildController({
      metadata,
      store: active,
      chapters: [[chunk(1)]],
      yieldToReader: () => controller.cancel("用户取消"),
    });

    const run = controller.run();
    await abortStarted.promise;
    const first = controller.cancel("重复取消");
    const second = controller.cancel("重复取消");
    let settled = false;
    void first.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(active.abort).toHaveBeenCalledTimes(1);
    abortRelease.resolve();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(active.commit).not.toHaveBeenCalled();
  });

  it("does not race abort with an atomic commit that is already in flight", async () => {
    const active = store();
    const commitStarted = deferred();
    const commitRelease = deferred<number>();
    active.commit = vi.fn(async () => {
      commitStarted.resolve();
      return commitRelease.promise;
    });
    const controller = createIndexBuildController({ metadata, store: active, chapters: [[chunk(1)]] });
    const run = controller.run();
    await commitStarted.promise;
    const cancellation = controller.cancel("太晚取消");
    expect(active.abort).not.toHaveBeenCalled();
    commitRelease.resolve(1);
    await expect(run).resolves.toMatchObject({ committedChunks: 1 });
    await cancellation;
    expect(active.abort).not.toHaveBeenCalled();
  });

  it("aborts on append failure and does not mask the original error", async () => {
    const active = store();
    const failure = new Error("disk full");
    active.append = vi.fn(async () => { throw failure; });
    const controller = createIndexBuildController({ metadata, store: active, chapters: [[chunk(1)]] });

    await expect(controller.run()).rejects.toBe(failure);
    expect(active.abort).toHaveBeenCalledWith("stage-1", "disk full");
  });

  it("can skip a matching indexed-book status without opening storage", async () => {
    const active = store();
    const controller = createIndexBuildController({
      metadata,
      store: active,
      chapterProducer: async function* () {
        throw new Error("producer should not be consumed");
      },
      shouldIndex: () => false,
    });

    await expect(controller.run()).resolves.toEqual({ stagingId: null, committedChunks: 0, chapters: 0, batches: 0, skipped: true });
    expect(active.begin).not.toHaveBeenCalled();
    expect(active.abort).not.toHaveBeenCalled();
  });

  it("accepts a chapter producer and yields between chapters", async () => {
    const active = store();
    const yielded: string[] = [];
    const producer = async function* (signal: AbortSignal) {
      expect(signal.aborted).toBe(false);
      yield [chunk(1)];
      yield [chunk(2)];
    };
    const controller = createIndexBuildController({
      metadata,
      store: active,
      chapterProducer: producer,
      yieldToReader: () => { yielded.push("yield"); },
    });

    await controller.run();
    expect(yielded).toHaveLength(2);
    expect(active.batches).toHaveLength(2);
  });

  it("reports aggregate progress and skips already indexed books", async () => {
    const first = store();
    const second = store();
    const progress: number[] = [];
    const controller = createMultiBookIndexController({
      books: [
        { metadata, store: first, chapters: [[chunk(1)]], yieldToReader: vi.fn() },
        { metadata: { ...metadata, contentHash: "b".repeat(64) }, store: second, chapters: [], shouldIndex: () => false },
      ],
      onProgress: (value) => progress.push(value.fraction),
    });

    await expect(controller.run()).resolves.toMatchObject({ committedChunks: 1, skippedBooks: 1 });
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    expect(second.begin).not.toHaveBeenCalled();
  });
});
