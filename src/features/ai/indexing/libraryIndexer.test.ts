import { describe, expect, it, vi } from "vitest";
import type { Book } from "../../../core/types";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { createLibraryIndexer, indexStatusIsCurrent } from "./libraryIndexer";
import type { IndexStagingStorePort } from "./indexStore";

const hash = "a".repeat(64);

function fakeBook(text = "测试正文"): Book {
  return {
    version: 3, opfPath: "content.opf",
    metadata: { title: "书", identifier: "id", language: "zh-CN" },
    manifest: new Map([["c", { id: "c", href: "c.xhtml", mediaType: "application/xhtml+xml", properties: [] }]]),
    spine: [{ idref: "c", linear: true }], guide: [], toc: [],
    resources: new Map([["c.xhtml", { path: "c.xhtml", mediaType: "application/xhtml+xml", data: new TextEncoder().encode(`<html><body><p>${text}</p></body></html>`) }]]),
    fixedLayout: false, issues: [], drmProtected: false,
  };
}

function store(): IndexStagingStorePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    begin: async () => (calls.push("begin"), "stage-1"),
    append: async () => { calls.push("append"); },
    commit: async () => (calls.push("commit"), 1),
    abort: async () => { calls.push("abort"); },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("library index orchestration", () => {
  it("skips matching versions and indexes stale available books sequentially", async () => {
    const native = store();
    const progress = vi.fn();
    const result = await createLibraryIndexer({
      books: [
        { contentHash: "b".repeat(64), title: "已建库", creator: "", available: true, read: async () => new Uint8Array() },
        { contentHash: hash, title: "待建库", creator: "作者", available: true, read: async () => new Uint8Array([1]) },
      ],
      store: native,
      listStatus: async () => [{
        contentHash: "b".repeat(64), parserVersion: CORPUS_PARSER_VERSION,
        normalizerVersion: CORPUS_NORMALIZER_VERSION, chunkerVersion: CORPUS_CHUNKER_VERSION,
        chunkCount: 1, updatedAt: 1,
      }],
      parseBook: async () => fakeBook(),
      onProgress: progress,
    }).run();
    expect(result).toMatchObject({ indexedBooks: 1, skippedBooks: 1, committedChunks: 1, failures: [] });
    expect(native.calls).toEqual(["begin", "append", "commit"]);
    expect(progress).toHaveBeenCalled();
  });

  it("normalizes an empty legacy shelf language before opening staging", async () => {
    const begin = vi.fn(async () => "stage-1");
    const native: IndexStagingStorePort = {
      begin,
      append: async () => {},
      commit: async () => 1,
      abort: async () => {},
    };
    await createLibraryIndexer({
      books: [{
        contentHash: hash,
        title: "旧记录",
        creator: "作者",
        language: "",
        available: true,
        read: async () => new Uint8Array([1]),
      }],
      store: native,
      listStatus: async () => [],
      parseBook: async () => fakeBook(),
    }).run();
    expect(begin).toHaveBeenCalledWith(expect.not.objectContaining({ language: expect.anything() }));
  });

  it("continues after one corrupt book but cancellation stops the queue", async () => {
    const native = store();
    let parsed = 0;
    const controller = createLibraryIndexer({
      books: [
        { contentHash: hash, title: "坏书", creator: "", available: true, read: async () => new Uint8Array() },
        { contentHash: "c".repeat(64), title: "后续", creator: "", available: true, read: async () => new Uint8Array() },
      ],
      store: native,
      listStatus: async () => [],
      parseBook: async () => {
        parsed++;
        if (parsed === 1) throw new Error("损坏");
        return fakeBook();
      },
    });
    const result = await controller.run();
    expect(result.failures).toHaveLength(1);
    expect(result.indexedBooks).toBe(1);

    const cancelled = createLibraryIndexer({ books: [], store: native, listStatus: async () => [] });
    cancelled.cancel();
    await expect(cancelled.run()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("waits for a non-abortable read to finish before cancellation settles", async () => {
    const native = store();
    const readStarted = deferred();
    const readRelease = deferred<Uint8Array>();
    let reads = 0;
    const indexer = createLibraryIndexer({
      books: [{
        contentHash: hash,
        title: "慢读书",
        creator: "作者",
        available: true,
        read: async () => {
          reads++;
          readStarted.resolve();
          return readRelease.promise;
        },
      }],
      store: native,
      listStatus: async () => [],
      parseBook: async () => fakeBook(),
    });
    const run = indexer.run();
    await readStarted.promise;
    const cancellation = indexer.cancel("关闭应用");
    let settled = false;
    void cancellation.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(reads).toBe(1);
    expect(native.calls).toEqual([]);
    readRelease.resolve(new Uint8Array());
    await cancellation;
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(native.calls).toEqual([]);
  });

  it("checks cancellation after a non-abortable parse before opening staging", async () => {
    const native = store();
    const parseStarted = deferred();
    const parseRelease = deferred<Book>();
    const indexer = createLibraryIndexer({
      books: [{ contentHash: hash, title: "慢解析", creator: "作者", available: true, read: async () => new Uint8Array([1]) }],
      store: native,
      listStatus: async () => [],
      parseBook: async () => {
        parseStarted.resolve();
        return parseRelease.promise;
      },
    });
    const run = indexer.run();
    await parseStarted.promise;
    const cancellation = indexer.cancel("关闭应用");
    let settled = false;
    void cancellation.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(native.calls).toEqual([]);
    parseRelease.resolve(fakeBook());
    await cancellation;
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(native.calls).toEqual([]);
  });

  it("keeps a previously committed book when the following book is cancelled", async () => {
    const native = store();
    let indexer!: ReturnType<typeof createLibraryIndexer>;
    let requested = false;
    indexer = createLibraryIndexer({
      books: [
        { contentHash: hash, title: "已完成", creator: "", available: true, read: async () => new Uint8Array([1]) },
        { contentHash: "b".repeat(64), title: "正在处理", creator: "", available: true, read: async () => new Uint8Array([2]) },
      ],
      store: native,
      listStatus: async () => [],
      parseBook: async () => fakeBook(),
      onProgress: (progress) => {
        if (!requested && progress.currentTitle === "正在处理" && progress.current && progress.current.completedChunks > 0) {
          requested = true;
          void indexer.cancel("用户取消");
        }
      },
    });
    const run = indexer.run();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(native.calls).toEqual(["begin", "append", "commit", "begin", "append", "abort"]);
  });

  it("waits for the current book staging abort and never starts the next book", async () => {
    const native = store();
    const abortStarted = deferred();
    const abortRelease = deferred();
    native.abort = async () => {
      native.calls.push("abort");
      abortStarted.resolve();
      await abortRelease.promise;
    };
    let indexer!: ReturnType<typeof createLibraryIndexer>;
    let requested = false;
    indexer = createLibraryIndexer({
      books: [
        { contentHash: hash, title: "处理中", creator: "", available: true, read: async () => new Uint8Array([1]) },
        { contentHash: "b".repeat(64), title: "不应启动", creator: "", available: true, read: async () => new Uint8Array([2]) },
      ],
      store: native,
      listStatus: async () => [],
      parseBook: async () => fakeBook(),
      onProgress: (progress) => {
        if (!requested && progress.current && progress.current.completedChunks > 0) {
          requested = true;
          void indexer.cancel("应用关闭");
        }
      },
    });
    const run = indexer.run();
    await abortStarted.promise;
    const cancellation = indexer.cancel("重复关闭");
    let settled = false;
    void cancellation.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(native.calls).toEqual(["begin", "append", "abort"]);
    abortRelease.resolve();
    await cancellation;
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(native.calls).toEqual(["begin", "append", "abort"]);
  });

  it("compares all derived-data versions", () => {
    expect(indexStatusIsCurrent(undefined)).toBe(false);
    expect(indexStatusIsCurrent({
      contentHash: hash, parserVersion: "old", normalizerVersion: CORPUS_NORMALIZER_VERSION,
      chunkerVersion: CORPUS_CHUNKER_VERSION, chunkCount: 1, updatedAt: 1,
    })).toBe(false);
  });
});
