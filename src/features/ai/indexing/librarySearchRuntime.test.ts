import { describe, expect, it, vi } from "vitest";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import type { ResolvedCrossBookSearchHit } from "./indexStore";
import type { LibraryIndexer } from "./libraryIndexer";
import type { NativeIndexTask } from "./indexTaskStore";
import { LibrarySearchRuntime, type LibrarySearchRuntimeDependencies } from "./librarySearchRuntime";

function task(state: NativeIndexTask["state"] = "running"): NativeIndexTask {
  return {
    id: "task-1", kind: "library-text-index", state, progress: 0,
    cancelRequested: false, createdAtMs: 1, updatedAtMs: 1,
  };
}

function dependencies(overrides: Partial<LibrarySearchRuntimeDependencies> = {}): LibrarySearchRuntimeDependencies {
  return {
    supported: true,
    listStatuses: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    search: vi.fn(async () => []),
    clear: vi.fn(async () => undefined),
    createTask: vi.fn(async () => task()),
    updateTask: vi.fn(async () => task()),
    completeTask: vi.fn(async () => task("completed")),
    failTask: vi.fn(async () => task("failed")),
    cancelTask: vi.fn(async () => task("cancelled")),
    createIndexer: vi.fn((): LibraryIndexer => ({
      signal: new AbortController().signal,
      run: async () => ({ indexedBooks: 1, skippedBooks: 0, unavailableBooks: 0, committedChunks: 1, failures: [] }),
      cancel: async () => undefined,
    })),
    debounceMs: 0,
    ...overrides,
  };
}

const book = {
  id: "book-a",
  contentHash: "a".repeat(64),
  title: "测试书",
  creator: "作者",
  available: true,
  fileSize: 1024,
  read: vi.fn(async () => new Uint8Array()),
};

describe("LibrarySearchRuntime", () => {
  it("checks metadata without reading EPUB and requires explicit confirmation", async () => {
    const deps = dependencies();
    const runtime = new LibrarySearchRuntime(deps);
    runtime.setBooks([book]);
    await runtime.checkIndex();
    expect(runtime.getSnapshot().indexState).toBe("confirmation");
    expect(book.read).not.toHaveBeenCalled();
    expect(deps.createIndexer).not.toHaveBeenCalled();
  });

  it("owns one index run even when two UI entries request start", async () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => { finish = resolve; });
    const deps = dependencies({
      createIndexer: vi.fn((): LibraryIndexer => ({
        signal: new AbortController().signal,
        run: async () => {
          await running;
          return { indexedBooks: 1, skippedBooks: 0, unavailableBooks: 0, committedChunks: 1, failures: [] };
        },
        cancel: async () => undefined,
      })),
    });
    const runtime = new LibrarySearchRuntime(deps);
    runtime.setBooks([book]);
    await runtime.checkIndex();
    runtime.startIndex();
    runtime.startIndex();
    await vi.waitFor(() => expect(deps.createTask).toHaveBeenCalledTimes(1));
    finish();
    await vi.waitFor(() => expect(deps.completeTask).toHaveBeenCalledTimes(1));
  });

  it("shares one query/result snapshot for every subscriber", async () => {
    const hit = { contentHash: book.contentHash } as ResolvedCrossBookSearchHit;
    const deps = dependencies({
      listStatuses: vi.fn(async () => [{
        contentHash: book.contentHash,
        parserVersion: CORPUS_PARSER_VERSION,
        normalizerVersion: CORPUS_NORMALIZER_VERSION,
        chunkerVersion: CORPUS_CHUNKER_VERSION,
        chunkCount: 1,
        updatedAt: 1,
      }]),
      search: vi.fn(async () => [hit]),
    });
    const runtime = new LibrarySearchRuntime(deps);
    runtime.setBooks([book]);
    await runtime.checkIndex();
    const first = vi.fn();
    const second = vi.fn();
    runtime.subscribe(first);
    runtime.subscribe(second);
    runtime.setQuery("共同查询");
    await vi.waitFor(() => expect(runtime.getSnapshot().searchStatus).toBe("complete"));
    expect(runtime.getSnapshot().results).toEqual([hit]);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("does not recheck the database for reading-progress-only shelf updates", async () => {
    const deps = dependencies();
    const runtime = new LibrarySearchRuntime(deps);
    runtime.setBooks([book]);
    await runtime.checkIndex();
    runtime.setBooks([{ ...book, read: vi.fn(async () => new Uint8Array()) }]);
    await Promise.resolve();
    expect(deps.listStatuses).toHaveBeenCalledTimes(1);
  });
});
