import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test/reactDomHarness";
import type { ShelfEntry } from "../shelf";
import { useReadestImport } from "./useReadestImport";

const ports = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), read: vi.fn(), targets: vi.fn(), config: vi.fn(),
  commit: vi.fn(), convert: vi.fn(), target: vi.fn(), notice: vi.fn(), refresh: vi.fn(), dirty: vi.fn(),
  shelfChanged: null as null | (() => void),
}));
vi.mock("../../platform/readestImportNativeBridge", () => ({
  openReadestBackup: ports.open, closeReadestBackup: ports.close, readReadestEntryText: ports.read,
  readestImportTargets: ports.targets, findReadestConfig: ports.config, commitReadestImport: ports.commit,
  READEST_TARGET_BATCH: 128, READEST_COMMIT_MAX_BOOKS: 128, READEST_COMMIT_MAX_RECORDS: 20000,
}));
vi.mock("../shelf", () => ({ getShelfStore: () => ({}) }));
vi.mock("../shelfSpaces", () => ({
  activeShelfSpace: () => ({ kind: "public" }),
  subscribeShelfSpace: (listener: () => void) => { ports.shelfChanged = listener; return () => { ports.shelfChanged = null; }; },
}));
vi.mock("../cloudSync/cloudSyncStore", () => ({ noteCloudSyncChange: ports.dirty }));
vi.mock("../localization/UiLanguageProvider", () => ({ uiText: (key: string) => key }));
vi.mock("./readestBackup", () => ({
  parseReadestLibrary: () => ({ ok: true, value: { books: [{ hash: "b".repeat(32), format: "EPUB", title: "Book", author: "", deleted: false }] } }),
  parseReadestBookConfig: () => ({ ok: true, value: {} }),
}));
vi.mock("./readestLocalTarget", () => ({ openReadestTarget: ports.target }));
vi.mock("./readestConvert", () => ({ convertReadestBook: ports.convert }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const outcome = { importedBooks: 1, bookmarksAdded: 1, notesAdded: 0, progressWritten: 0, skippedExisting: 0, progressUnchanged: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  ports.open.mockImplementation(async ({ sessionId }) => ({ sessionId, library: { entryIndex: 0, bytes: 2 } }));
  ports.close.mockResolvedValue("closed"); ports.read.mockResolvedValue("{}");
  ports.config.mockResolvedValue({ entryIndex: 1, bytes: 2 });
  ports.targets.mockResolvedValue([{ bookHash: "a".repeat(64), partialMd5: "b".repeat(32), targetToken: "token", progress: { versions: [], display: null, conflict: false } }]);
  ports.target.mockResolvedValue({ target: {}, close: vi.fn() });
  ports.convert.mockResolvedValue({ progress: null, notes: [], bookmarks: [{ sourceKey: `readest:${"b".repeat(32)}:bookmark`, grade: "exact", reasons: [], source: {}, value: {
    locator: { locatorVersion: 1, chapterPath: "c.xhtml", spineIndexHint: 0, target: { kind: "chapter-start" } }, text: "bookmark", createdAtMs: 1,
  } }] });
  ports.commit.mockResolvedValue(outcome); ports.refresh.mockResolvedValue(undefined);
});

async function setup(withLocalBook = false) {
  const dom = createReactDomHarness();
  let current!: ReturnType<typeof useReadestImport>;
  const shelfEntriesRef = { current: withLocalBook ? [{ id: "local", contentHash: "a".repeat(64), title: "Book", fileName: "book.epub" } as ShelfEntry] : [] };
  function Host() { current = useReadestImport({ shelfEntriesRef, refreshShelfProjection: ports.refresh, setShelfNotice: ports.notice }); return null; }
  await dom.render(createElement(Host));
  const start = (name: string) => current.tryStart({ kind: "path", path: `/${name}` }, name);
  return { dom, current: () => current, start };
}

describe("Readest import session ownership", () => {
  it("does not reopen the UI when a library read finishes after cancellation", async () => {
    const t = await setup(); const read = deferred<string>(); ports.read.mockReturnValueOnce(read.promise);
    let pending!: Promise<unknown>;
    try {
      await t.dom.run(() => { pending = t.start("old.zip"); });
      await t.dom.run(() => t.current().cancel());
      await t.dom.run(async () => { read.resolve("{}"); await pending; });
      expect(t.current().state.kind).toBe("idle"); expect(ports.targets).not.toHaveBeenCalled();
    } finally { await t.dom.dispose(); }
  });

  it("does not hand an abandoned open to the legacy importer or reset a newer dialog", async () => {
    const t = await setup(); const opening = deferred<never>(); ports.open.mockReturnValueOnce(opening.promise);
    let pending!: Promise<unknown>;
    try {
      await t.dom.run(() => { pending = t.start("old.zip"); });
      await t.dom.run(() => t.current().cancel());
      await t.dom.run(async () => { await t.start("new.zip"); });
      let result: unknown;
      await t.dom.run(async () => { opening.reject({ code: "not-readest" }); result = await pending; });
      expect(result).toBe("handled");
      expect(t.current().state).toMatchObject({ kind: "match", sourceLabel: "new.zip" });
    } finally { await t.dom.dispose(); }
  });

  it.each(["commit", "refresh"] as const)("keeps a new dialog when the old %s finishes after a shelf change", async stage => {
    const t = await setup(true); const gate = deferred<unknown>();
    if (stage === "commit") ports.commit.mockReturnValueOnce(gate.promise);
    else ports.refresh.mockReturnValueOnce(gate.promise);
    let pending!: Promise<void>;
    try {
      await t.dom.run(async () => { await t.start("old.zip"); });
      await t.dom.run(async () => { await t.current().next(); });
      await t.dom.run(() => { pending = t.current().commit(); });
      await t.dom.run(() => ports.shelfChanged!());
      await t.dom.run(async () => { await t.start("new.zip"); });
      const newId = ports.open.mock.calls.at(-1)![0].sessionId;
      await t.dom.run(async () => { gate.resolve(stage === "commit" ? outcome : undefined); await pending; });
      expect(t.current().state).toMatchObject({ kind: "match", sourceLabel: "new.zip" });
      expect(ports.close.mock.calls.some(([id]) => id === newId)).toBe(false);
      expect(ports.dirty).toHaveBeenCalledWith("data-changed");
    } finally { await t.dom.dispose(); }
  });
});
