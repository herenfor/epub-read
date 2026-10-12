import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization } from "./libraryOrganization";
import {
  createLibraryReader,
  LIBRARY_LOADING,
  LibraryReadInterruptedError,
  MAX_LIBRARY_REREADS,
  libraryReadFailed,
  libraryReadSucceeded,
  shelfLibraryView,
  type ShelfLibraryView,
} from "./libraryLoad";
import type { ShelfEntry } from "./shelf";
import { ShelfView, type ShelfViewProps } from "./ShelfView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The production reader wired like App: a write counter, repository identity, publish/fail sinks and a scripted store. */
function harness() {
  const reads: Array<ReturnType<typeof deferred<string[]>>> = [];
  let writes = 0;
  let repository: object = { name: "legacy" };
  const published: string[][] = [];
  const failed: unknown[] = [];
  const reader = createLibraryReader<string[]>({
    read: () => { const next = deferred<string[]>(); reads.push(next); return next.promise; },
    writeCount: () => writes,
    repository: () => repository,
    publish: (value) => published.push(value),
    fail: (error) => failed.push(error),
  });
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return {
    reader, reads, published, failed, settle,
    write: () => { writes += 1; },
    switchRepository: () => { repository = { name: "portable" }; },
  };
}

describe("library reader (startup read, retry, late answers)", () => {
  it("joins a retry pressed while a read is in flight instead of queueing another", async () => {
    const h = harness();
    const first = h.reader.load();
    expect(h.reader.load()).toBe(first);
    expect(h.reads).toHaveLength(1);
    h.reads[0].resolve(["a"]);
    await first;
    expect(h.published).toEqual([["a"]]);
  });

  it("retries a failed first read through the same entry and publishes an empty list as a real answer", async () => {
    const h = harness();
    const first = h.reader.load();
    h.reads[0].reject(new Error("db locked"));
    await first;
    expect(h.failed).toHaveLength(1);
    const retry = h.reader.load();
    h.reads[1].resolve([]);
    await retry;
    expect(h.published).toEqual([[]]);
  });

  it("re-reads when an import lands during the first read, so the late answer cannot drop the new book", async () => {
    const h = harness();
    const load = h.reader.load();
    h.write(); // import merged "new" into the list while the first read was out
    h.reads[0].resolve(["old"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.published).toEqual([]);
    expect(h.reads).toHaveLength(2);
    h.reads[1].resolve(["old", "new"]);
    await load;
    expect(h.published).toEqual([["old", "new"]]);
  });

  it("drops an old read's late failure or success once an authoritative projection superseded it", async () => {
    const h = harness();
    const stale = h.reader.load();
    h.reader.invalidate(); // refreshShelfProjection published a fresh snapshot
    h.reads[0].reject(new Error("late failure"));
    await stale;
    expect(h.failed).toEqual([]);
    const again = h.reader.load();
    h.reader.invalidate();
    h.reads[1].resolve(["stale"]);
    await again;
    expect(h.published).toEqual([]);
  });
});

describe("library reader publish gate (review L1/L2)", () => {
  it("never publishes a stale snapshot once the re-read budget is spent, and a later retry publishes the latest", async () => {
    const h = harness();
    const load = h.reader.load();
    // Every read returns snapshot-n, and an import commits before it answers.
    for (let n = 0; n <= MAX_LIBRARY_REREADS; n++) {
      h.write();
      h.reads[n].resolve([`snapshot-${n}`]);
      await h.settle();
    }
    const outcome = await load;
    expect(h.published).toEqual([]);
    expect(outcome.kind).toBe("failed");
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]).toBeInstanceOf(LibraryReadInterruptedError);
    // Writes stop: Retry reads once more and publishes the current list.
    const retry = h.reader.load();
    h.reads[MAX_LIBRARY_REREADS + 1].resolve(["snapshot-latest"]);
    expect(await retry).toEqual({ kind: "published", value: ["snapshot-latest"] });
    expect(h.published).toEqual([["snapshot-latest"]]);
  });

  it("does not publish a read error that writes made stale, even on the last attempt", async () => {
    const h = harness();
    const load = h.reader.load();
    for (let n = 0; n <= MAX_LIBRARY_REREADS; n++) {
      h.write();
      h.reads[n].reject(new Error(`old failure ${n}`));
      await h.settle();
    }
    await load;
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]).toBeInstanceOf(LibraryReadInterruptedError);
  });

  it("A starts, B starts, B answers, A answers late: only B is published, whether A succeeds or fails", async () => {
    for (const lateA of ["success", "failure"] as const) {
      const h = harness();
      const a = h.reader.refresh();
      const b = h.reader.refresh();
      h.reads[1].resolve(["B"]);
      expect(await b).toEqual({ kind: "published", value: ["B"] });
      if (lateA === "success") h.reads[0].resolve(["A"]);
      else h.reads[0].reject(new Error("A failed"));
      expect(await a).toEqual({ kind: "superseded" });
      expect(h.published).toEqual([["B"]]);
      expect(h.failed).toEqual([]);
    }
  });

  it("a refresh during an import re-reads, so the imported book is kept; Retry joins the refresh in flight", async () => {
    const h = harness();
    const refresh = h.reader.refresh();
    expect(h.reader.load()).toBe(refresh);
    h.write(); // import committed while the refresh read was out
    h.reads[0].resolve(["old"]);
    await h.settle();
    h.reads[1].resolve(["old", "imported"]);
    await refresh;
    expect(h.published).toEqual([["old", "imported"]]);
  });

  it("a read that started on another repository is read again on the current one", async () => {
    const h = harness();
    const load = h.reader.load();
    h.switchRepository(); // portable activation swapped the store behind the facade
    h.reads[0].resolve(["legacy rows"]);
    await h.settle();
    h.reads[1].resolve(["portable rows"]);
    await load;
    expect(h.published).toEqual([["portable rows"]]);
  });

  it("teardown supersedes a refresh: its late answer touches nothing", async () => {
    const h = harness();
    const refresh = h.reader.refresh();
    h.reader.invalidate();
    h.reads[0].resolve(["late"]);
    expect(await refresh).toEqual({ kind: "superseded" });
    expect(h.published).toEqual([]);
  });
});

describe("library state shown on the shelf", () => {
  it("never claims an empty shelf before a real read, and keeps a snapshot through a failed refresh", () => {
    expect(shelfLibraryView(LIBRARY_LOADING, false, false)).toEqual({ kind: "loading" });
    // The list said empty, but the folders have not answered yet.
    expect(shelfLibraryView(libraryReadSucceeded(), false, false)).toEqual({ kind: "loading" });
    expect(shelfLibraryView(libraryReadSucceeded(), false, true)).toEqual({ kind: "ready", refreshError: null });
    // Books are shown as soon as they are known, even before the folders.
    expect(shelfLibraryView(libraryReadSucceeded(), true, false)).toEqual({ kind: "ready", refreshError: null });

    const firstFailure = libraryReadFailed(LIBRARY_LOADING, "db locked");
    expect(shelfLibraryView(firstFailure, false, true)).toEqual({ kind: "failed", error: "db locked" });
    const refreshFailure = libraryReadFailed(libraryReadSucceeded(), "io error");
    expect(refreshFailure).toEqual({ status: "ready", refreshError: "io error" });
    expect(shelfLibraryView(refreshFailure, true, true)).toEqual({ kind: "ready", refreshError: "io error" });
    // An empty snapshot that was really read stays an empty shelf, not a failure page.
    expect(shelfLibraryView(refreshFailure, false, true)).toEqual({ kind: "ready", refreshError: "io error" });
  });

  it("renders loading, failure with retry, and a refresh error above the known books", async () => {
    const dom = createReactDomHarness();
    const onRetry = vi.fn();
    const entry = { id: "b1", title: "第一本", creator: "作者", fileName: "第一本.epub", fileSize: 1024, coverMime: "image/jpeg", addedAtMs: 1000, lastReadAtMs: 0, available: true } as unknown as ShelfEntry;
    const props = (entries: ShelfEntry[], libraryState: ShelfLibraryView): ShelfViewProps => ({
      entries,
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
      onApplyOrganization: async () => {},
      libraryState,
      onRetryLibraryLoad: onRetry,
    });
    const text = () => dom.container.textContent ?? "";
    try {
      await dom.render(createElement(ShelfView, props([], { kind: "loading" })));
      expect(text()).toContain("正在读取书库");
      expect(text()).not.toContain("书架还是空的");

      await dom.render(createElement(ShelfView, props([], { kind: "failed", error: "db locked" })));
      expect(text()).toContain("书库读取失败");
      expect(text()).toContain("db locked");
      expect(text()).not.toContain("书架还是空的");
      const retry = [...dom.container.querySelectorAll("button")].find((button) => button.textContent === "重试")!;
      await dom.click(retry);
      expect(onRetry).toHaveBeenCalledTimes(1);

      await dom.render(createElement(ShelfView, props([entry], { kind: "ready", refreshError: "io error" })));
      expect(dom.container.querySelector(".shelf-library-banner")?.textContent).toContain("io error");
      expect(text()).toContain("第一本");

      await dom.render(createElement(ShelfView, props([], { kind: "ready", refreshError: null })));
      expect(text()).toContain("书架还是空的");
    } finally {
      await dom.dispose();
    }
  });
});
