import { createElement, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LibrarySearchBook, LibrarySearchSnapshot } from "../features/ai/indexing/librarySearchRuntime";
import { CORPUS_CONCURRENCY_STORAGE_KEY } from "../features/ai/indexing/corpusConcurrencyPreference";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { createReactDomHarness } from "../test/reactDomHarness";
import type { ShelfEntry } from "./shelf";
import { useShelfSearchMode, useLibrarySearchRuntime, useLibrarySearchBooks,
  useLibrarySearchResults, useLibrarySearchActions } from "./useLibrarySearch";

const ports = vi.hoisted(() => ({ create: vi.fn(), store: vi.fn(), bridge: vi.fn() }));
vi.mock("../features/ai/indexing/librarySearchRuntime", () => ({ createDefaultLibrarySearchRuntime: ports.create }));
vi.mock("./shelf", async (original) => ({ ...await original<typeof import("./shelf")>(), getShelfStore: ports.store }));
vi.mock("../platform/archiveWorkerBridge", () => ({ serveArchivePort: ports.bridge }));

function entry(id: string): ShelfEntry {
  return { id, contentHash: id.repeat(64), title: id, creator: "", fileName: `${id}.epub`,
    fileSize: 10, coverMime: "", addedAtMs: 1, lastReadAtMs: 1, spineIndex: 0,
    page: 0, progressPct: 0, anchorIndex: null, anchorRatio: null, isNew: true };
}
function setup() {
  const dom = createReactDomHarness();
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  let snapshot: LibrarySearchSnapshot = {
    query: "", results: [], searchStatus: "idle", indexState: "idle", rebuildRequested: false,
    indexSummary: { total: 0, indexed: 0, pending: 0, unavailable: 0, interrupted: false },
    indexProgress: { total: 0, completed: 0, titles: [] },
  };
  const listeners = new Set<() => void>();
  const runtime = {
    subscribe: vi.fn((fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }),
    getSnapshot: () => snapshot,
    setBooks: vi.fn(), setConcurrency: vi.fn(), checkIndex: vi.fn(),
    startIndex: vi.fn(), cancelIndex: vi.fn(), deferIndex: vi.fn(), requestRebuild: vi.fn(),
    clearIndex: vi.fn().mockResolvedValue(undefined),
    setQuery: vi.fn(function (this: unknown, query: string) { expect(this).toBe(runtime); snapshot = { ...snapshot, query }; listeners.forEach((fn) => fn()); }),
  };
  ports.create.mockReset().mockReturnValue(runtime);
  const store = { readBook: vi.fn().mockResolvedValue(new Uint8Array([1])), openArchive: vi.fn() };
  ports.store.mockReset().mockReturnValue(store);
  const owner = { dispose: vi.fn() };
  ports.bridge.mockReset().mockReturnValue(owner);
  let platform = getRuntimeCapabilities();
  const priority = { current: false };
  function useHost() {
    const mode = useShelfSearchMode();
    const library = useLibrarySearchRuntime(() => true, priority);
    const [shelfEntries, setShelfEntries] = useState<ShelfEntry[]>([]);
    const [searchNavigationBusy, setSearchNavigationBusy] = useState(false);
    const entriesByHash = useRef(new Map<string, ShelfEntry>());
    entriesByHash.current = new Map(shelfEntries.filter((e) => e.contentHash).map((e) => [e.contentHash!, e]));
    useLibrarySearchBooks({ runtime: platform, librarySearchRuntime: library.librarySearchRuntime, shelfEntries });
    const results = useLibrarySearchResults(library.librarySearchSnapshot, entriesByHash,
      shelfEntries.map((e) => `${e.id}:${e.contentHash ?? ""}:${e.available === false ? 0 : 1}`).join("|"));
    const actions = useLibrarySearchActions({ ...library, setShelfSearchMode: mode.setShelfSearchMode, setSearchNavigationBusy });
    return { ...mode, ...library, ...actions, results, setShelfEntries, searchNavigationBusy };
  }
  let api!: ReturnType<typeof useHost>;
  function Host() { api = useHost(); return createElement("div", {}, api.shelfSearchMode); }
  return { dom, runtime, store, owner, values, priority, current: () => api,
    render: () => dom.render(createElement(Host)),
    android: () => { platform = { ...platform, platform: "android" }; },
    publish: (patch: Partial<LibrarySearchSnapshot>) => dom.run(() => { snapshot = { ...snapshot, ...patch }; listeners.forEach((fn) => fn()); }),
    dispose: async () => { await dom.dispose(); vi.useRealTimers(); },
  };
}

describe("library search host extraction", () => {
  it("retains one runtime and its subscription, waits for reader priority and persists current concurrency", async () => {
    const t = setup();
    try {
      await t.render();
      const queryChange = t.current().handleLibrarySearchQueryChange;
      await t.dom.run(() => t.current().handleShelfSearchModeChange("body"));
      await t.dom.run(() => t.current().handleShelfSearchModeChange("metadata"));
      expect(t.runtime.checkIndex).toHaveBeenCalledTimes(1);
      await t.dom.run(() => t.current().handleCorpusConcurrencyChange("manual", 5));
      await t.dom.run(() => t.current().handleCorpusConcurrencyChange("automatic"));
      expect(t.current().corpusConcurrencyPreference).toEqual({ mode: "automatic", maxConcurrency: 5 });
      expect(JSON.parse(t.values.get(CORPUS_CONCURRENCY_STORAGE_KEY)!)).toEqual({ mode: "automatic", maxConcurrency: 5 });
      expect(t.runtime.setConcurrency.mock.calls.map(([value]) => value)).toEqual([2, 5, 2]);
      await t.dom.run(() => queryChange("Alice"));
      expect(t.current().librarySearchSnapshot.query).toBe("Alice");
      expect(t.current().handleLibrarySearchQueryChange).toBe(queryChange);
      expect(ports.create).toHaveBeenCalledTimes(1);
      expect(t.runtime.subscribe).toHaveBeenCalledTimes(1);
      const { waitUntilRunnable } = ports.create.mock.calls[0][1];
      t.priority.current = true;
      let finished = false;
      const wait = waitUntilRunnable(new AbortController().signal).then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(50);
      expect(finished).toBe(false);
      t.priority.current = false;
      await vi.advanceTimersByTimeAsync(50);
      await wait;
      expect(finished).toBe(true);
    } finally { await t.dispose(); }
  });

  it("keeps book reads lazy and native archive channels owned by the requested content identity", async () => {
    const t = setup();
    t.android();
    try {
      await t.render();
      await t.dom.run(() => t.current().setShelfEntries([entry("a"), { ...entry("b"), available: false }, { ...entry("c"), contentHash: undefined }]));
      const books = t.runtime.setBooks.mock.calls.at(-1)![0] as LibrarySearchBook[];
      expect(books.map((b) => [b.id, b.contentHash, b.available])).toEqual([["a", "a".repeat(64), true], ["b", "b".repeat(64), false]]);
      expect(t.store.readBook).not.toHaveBeenCalled();
      expect(ports.bridge).not.toHaveBeenCalled();
      const replacement = { readBook: vi.fn().mockResolvedValue(new Uint8Array([2])) };
      ports.store.mockReturnValue(replacement);
      expect(await books[0].read()).toEqual(new Uint8Array([2]));
      expect(replacement.readBook).toHaveBeenCalledExactlyOnceWith("a");
      const input = books[0].openArchiveInput!();
      expect(ports.bridge.mock.calls[0][1]).toBe("a".repeat(64));
      input.dispose();
      expect(t.owner.dispose).toHaveBeenCalledTimes(1);
      // The mocked native owner has no port cleanup; close its input here.
      ports.bridge.mock.calls[0][0].close();
    } finally { await t.dispose(); }
  });

  it("rebinds existing cross-book hits after shelf changes and releases the navigation gate after index clearing", async () => {
    const t = setup();
    try {
      await t.render();
      await t.publish({ query: "ABC", results: [{ contentHash: "a".repeat(64), title: "Book", creator: "", chunkId: "c",
        spineIndex: 1, chapterPath: "c.xhtml", contentType: "paragraph", originalText: "前文ABC", normalizedText: "前文abc",
        textAnchor: { start: 100, end: 105, snippet: "前文ABC" } }] });
      expect(t.current().results[0].disabledReason).toBeTruthy();
      await t.dom.run(() => t.current().setShelfEntries([entry("a")]));
      expect(t.current().results[0].disabledReason).toBeUndefined();
      expect(t.current().results[0].hit.textAnchor.start).toBe(102);
      let resolve!: () => void;
      t.runtime.clearIndex.mockImplementationOnce(() => new Promise<void>((res) => { resolve = res; }));
      await t.dom.run(() => t.current().handleClearTextIndex());
      expect(t.current().searchNavigationBusy).toBe(true);
      await t.dom.run(resolve);
      expect(t.current().searchNavigationBusy).toBe(false);
      expect(ports.create).toHaveBeenCalledTimes(1);
    } finally { await t.dispose(); }
  });
});
