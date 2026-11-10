import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test/reactDomHarness";
import type { ShelfEntry } from "../shelf";
import { useReadestImport } from "./useReadestImport";

const REMOTE = "b".repeat(32);
const NEW = "c".repeat(32);
const ports = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), read: vi.fn(), targets: vi.fn(), config: vi.fn(), commit: vi.fn(),
  stage: vi.fn(), release: vi.fn(), probe: vi.fn(), pick: vi.fn(),
  convert: vi.fn(), target: vi.fn(), notice: vi.fn(), refresh: vi.fn(), dirty: vi.fn(),
  importPaths: vi.fn(), library: [] as unknown[],
  shelfChanged: null as null | (() => void),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: ports.pick }));
vi.mock("../../platform/readestImportNativeBridge", () => ({
  openReadestBackup: ports.open, closeReadestBackup: ports.close, readReadestEntryText: ports.read,
  readestImportTargets: ports.targets, findReadestConfig: ports.config, commitReadestImport: ports.commit,
  stageReadestBooks: ports.stage, releaseReadestBooks: ports.release, probeReadestLibrary: ports.probe,
  READEST_TARGET_BATCH: 128, READEST_COMMIT_MAX_BOOKS: 128, READEST_COMMIT_MAX_RECORDS: 20000,
}));
vi.mock("../../platform/androidNativeBridge", () => ({ importDocuments: vi.fn() }));
vi.mock("../shelf", () => ({ getShelfStore: () => ({ importPaths: ports.importPaths }) }));
vi.mock("../shelfSpaces", () => ({
  activeShelfSpace: () => ({ kind: "public" }),
  subscribeShelfSpace: (listener: () => void) => { ports.shelfChanged = listener; return () => { ports.shelfChanged = null; }; },
}));
vi.mock("../cloudSync/cloudSyncStore", () => ({ noteCloudSyncChange: ports.dirty }));
vi.mock("../localization/UiLanguageProvider", () => ({ uiText: (key: string) => key }));
vi.mock("./readestBackup", () => ({
  parseReadestLibrary: () => ({ ok: true, value: { books: ports.library } }),
  parseReadestBookConfig: () => ({ ok: true, value: { skipped: [] } }),
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
const readestBook = (hash: string, title: string) => ({ hash, format: "EPUB", title, author: "", deleted: false });
const localTarget = (bookHash: string, partialMd5: string) =>
  ({ bookHash, partialMd5, targetToken: `token-${bookHash[0]}`, progress: { versions: [], display: null, conflict: false } });
const newEntry = { id: "new", contentHash: "d".repeat(64), title: "New", fileName: "New.epub" } as ShelfEntry;

beforeEach(() => {
  vi.clearAllMocks();
  ports.library = [readestBook(REMOTE, "Shelved"), readestBook(NEW, "New")];
  ports.open.mockImplementation(async ({ sessionId }) => ({
    sessionId, library: { entryIndex: 0, bytes: 2 }, kind: "zip", books: [{ readestHash: NEW, fileName: "New.epub", bytes: 2048 }],
  }));
  ports.close.mockResolvedValue("closed"); ports.read.mockResolvedValue("{}"); ports.release.mockResolvedValue(undefined);
  ports.probe.mockResolvedValue(null);
  ports.config.mockResolvedValue({ entryIndex: 1, bytes: 2 });
  ports.targets.mockImplementation(async (_id: string, hashes: string[]) => hashes.map((bookHash) =>
    localTarget(bookHash, bookHash === newEntry.contentHash ? NEW : REMOTE)));
  ports.target.mockResolvedValue({ target: {}, close: vi.fn() });
  ports.convert.mockImplementation(async (readestHash: string) => ({ progress: null, notes: [], bookmarks: [{
    sourceKey: `readest:${readestHash}:bookmark`, grade: "exact", reasons: [], source: { cfi: "", text: null }, value: {
      locator: { locatorVersion: 1, chapterPath: "c.xhtml", spineIndexHint: 0, target: { kind: "chapter-start" } }, text: "bookmark", createdAtMs: 1,
    } }] }));
  ports.stage.mockResolvedValue([{ readestHash: NEW, bookHash: newEntry.contentHash, targetToken: "token-new", fileName: "New.epub", existing: false }]);
  ports.importPaths.mockResolvedValue({ results: [{ inputIndex: 0, status: "saved", contentHash: newEntry.contentHash, record: newEntry }] });
  ports.commit.mockResolvedValue({ ...outcome, bookmarksAdded: 2, booksAdded: 1, booksAlready: 0 }); ports.refresh.mockResolvedValue(undefined);
});

async function setup(options: { withLocalBook?: boolean; platform?: string } = {}) {
  const dom = createReactDomHarness();
  let current!: ReturnType<typeof useReadestImport>;
  const shelfEntriesRef = { current: options.withLocalBook ? [{ id: "local", contentHash: "a".repeat(64), title: "Shelved", fileName: "book.epub" } as ShelfEntry] : [] };
  const importSlotRef = { current: null as string | null };
  const shelfBusyRef = { current: false };
  function Host() {
    current = useReadestImport({
      shelfEntriesRef, refreshShelfProjection: ports.refresh, setShelfNotice: ports.notice,
      platform: options.platform ?? "windows", importSlotRef, shelfBusyRef,
    });
    return null;
  }
  await dom.render(createElement(Host));
  const start = (name: string) => current.tryStart({ kind: "path", path: `/${name}` }, name);
  return { dom, current: () => current, start, importSlotRef };
}

describe("Readest import flow", () => {
  it("offers the Readest library found on this computer and opens it as a folder source", async () => {
    ports.probe.mockResolvedValue({ path: "/data/Readest/Books", books: 2 });
    const t = await setup();
    try {
      await t.dom.run(async () => { t.current().open(); });
      expect(t.current().state).toMatchObject({ kind: "source", probe: { books: 2 }, canPickFolder: true });
      await t.dom.run(async () => { await t.current().startFound(); });
      expect(ports.open.mock.calls[0][0].source).toEqual({ kind: "path", path: "/data/Readest/Books" });
      expect(t.current().state.kind).toBe("list");
    } finally { await t.dom.dispose(); }
  });

  it("takes only a backup file on Android and shows a wrong pick on the source screen", async () => {
    const t = await setup({ platform: "android" });
    ports.pick.mockResolvedValue("content://docs/document/primary%3ADownload%2Fnotes.zip");
    ports.open.mockRejectedValueOnce({ code: "not-readest" });
    try {
      await t.dom.run(async () => { t.current().open(); });
      expect(ports.probe).not.toHaveBeenCalled();
      expect(t.current().state).toMatchObject({ kind: "source", probe: null, canPickFolder: false });
      await t.dom.run(async () => { await t.current().pickBackup(); });
      expect(ports.open.mock.calls[0][0].source).toEqual({ kind: "uri", uri: "content://docs/document/primary%3ADownload%2Fnotes.zip" });
      expect(t.current().state).toMatchObject({ kind: "source", error: "readestImport.error.notReadest" });
      expect(ports.close).toHaveBeenCalledTimes(1);
    } finally { await t.dom.dispose(); }
  });

  it("merges records for a shelved book, adds a new book with its records, and reports the result", async () => {
    const t = await setup({ withLocalBook: true });
    try {
      await t.dom.run(async () => { await t.start("backup.zip"); });
      const listed = t.current().state;
      expect(listed.kind === "list" && listed.rows.map((row) => [row.title, row.kind])).toEqual([["New", "new"], ["Shelved", "existing"]]);
      await t.dom.run(async () => { await t.current().run(); });
      // Originals never pass through a separately committing shelf importer.
      expect(ports.stage.mock.calls[0].slice(0, 2)).toEqual([ports.open.mock.calls[0][0].sessionId, [NEW]]);
      expect(ports.importPaths).not.toHaveBeenCalled();
      expect(ports.release).not.toHaveBeenCalled();
      expect(ports.commit).toHaveBeenCalledTimes(1);
      expect(ports.commit.mock.calls[0][1]).toHaveLength(2);
      expect(ports.commit.mock.calls[0][3]).toEqual([NEW]);
      expect(t.current().state).toMatchObject({ kind: "done", result: { booksAdded: 1, bookmarksAdded: 2, failed: [], stopped: false, notReached: 0, error: null } });
      expect(t.importSlotRef.current).toBeNull();
      expect(ports.refresh).toHaveBeenCalledTimes(1);
      expect(ports.dirty).toHaveBeenCalledWith("data-changed");
      expect(ports.close).toHaveBeenCalledTimes(1);
    } finally { await t.dom.dispose(); }
  });

  it("stops by cutting extraction short and leaves the unreached book untouched", async () => {
    const t = await setup({ withLocalBook: true }); const staging = deferred<never>();
    ports.stage.mockReturnValueOnce(staging.promise);
    let pending!: Promise<void>;
    try {
      await t.dom.run(async () => { await t.start("backup.zip"); });
      await t.dom.run(async () => { pending = t.current().run(); await Promise.resolve(); });
      await t.dom.run(async () => { await vi.waitFor(() => expect(ports.stage).toHaveBeenCalled()); });
      await t.dom.run(() => t.current().stop());
      expect(ports.close).toHaveBeenCalledTimes(1);
      await t.dom.run(async () => { staging.reject({ code: "cancelled" }); await pending; });
      expect(ports.importPaths).not.toHaveBeenCalled();
      // Existing records also remain uncommitted until every original is ready.
      expect(ports.commit).not.toHaveBeenCalled();
      expect(t.current().state).toMatchObject({ kind: "done", result: { stopped: true, notReached: 2, booksAdded: 0, bookmarksAdded: 0, error: null } });
    } finally { await t.dom.dispose(); }
  });

  it("does not commit other records when an original fails verification or staging", async () => {
    const t = await setup({ withLocalBook: true });
    ports.stage.mockResolvedValueOnce([{ readestHash: NEW, errorCode: "storage-error" }]);
    try {
      await t.dom.run(async () => { await t.start("backup.zip"); });
      await t.dom.run(async () => { await t.current().run(); });
      expect(ports.importPaths).not.toHaveBeenCalled();
      expect(ports.commit).not.toHaveBeenCalled();
      expect(t.current().state).toMatchObject({ kind: "done", result: { booksAdded: 0, failed: [{ title: "New", reason: "readestImport.fail.storage" }], bookmarksAdded: 0, notReached: 2 } });
    } finally { await t.dom.dispose(); }
  });

  it("refuses to start while another import holds the shelf", async () => {
    const t = await setup({ withLocalBook: true });
    try {
      await t.dom.run(async () => { await t.start("backup.zip"); });
      t.importSlotRef.current = "directory-import";
      await t.dom.run(async () => { await t.current().run(); });
      expect(t.current().state.kind).toBe("list");
      expect(ports.notice).toHaveBeenCalledWith({ kind: "warn", text: "notice.import.busy" });
      expect(t.importSlotRef.current).toBe("directory-import");
    } finally { await t.dom.dispose(); }
  });
});

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
      expect(t.current().state).toMatchObject({ kind: "list", sourceLabel: "new.zip" });
    } finally { await t.dom.dispose(); }
  });

  it.each(["commit", "refresh"] as const)("keeps a new dialog when the old %s finishes after a shelf change", async stage => {
    const t = await setup({ withLocalBook: true }); const gate = deferred<unknown>();
    ports.library = [readestBook(REMOTE, "Shelved")];
    if (stage === "commit") ports.commit.mockReturnValueOnce(gate.promise);
    else ports.refresh.mockReturnValueOnce(gate.promise);
    let pending!: Promise<void>;
    try {
      await t.dom.run(async () => { await t.start("old.zip"); });
      await t.dom.run(async () => { pending = t.current().run(); await Promise.resolve(); });
      await t.dom.run(async () => { await vi.waitFor(() => expect(stage === "commit" ? ports.commit : ports.refresh).toHaveBeenCalled()); });
      await t.dom.run(() => ports.shelfChanged!());
      await t.dom.run(async () => { await t.start("new.zip"); });
      const newId = ports.open.mock.calls.at(-1)![0].sessionId;
      await t.dom.run(async () => { gate.resolve(stage === "commit" ? outcome : undefined); await pending; });
      expect(t.current().state).toMatchObject({ kind: "list", sourceLabel: "new.zip" });
      expect(ports.close.mock.calls.some(([id]) => id === newId)).toBe(false);
      expect(ports.dirty).toHaveBeenCalledWith("data-changed");
      expect(t.importSlotRef.current).toBeNull();
    } finally { await t.dom.dispose(); }
  });
});

it("keeps prepared books off the shelf if record conversion or the final transaction fails", async () => {
  const t = await setup({ withLocalBook: true });
  try {
    await t.dom.run(async () => { await t.start("backup.zip"); });
    ports.convert.mockRejectedValueOnce(new Error("bad records"));
    await t.dom.run(async () => { await t.current().run(); });
    expect(ports.commit).not.toHaveBeenCalled();
    expect(ports.importPaths).not.toHaveBeenCalled();
    expect(t.current().state).toMatchObject({ kind: "done", result: { booksAdded: 0, bookmarksAdded: 0, notReached: 2 } });
    await t.dom.run(async () => { t.current().cancel(); await t.start("retry.zip"); });
    ports.commit.mockRejectedValueOnce({ code: "storage-error" });
    await t.dom.run(async () => { await t.current().run(); });
    expect(ports.commit).toHaveBeenCalledTimes(1);
    expect(ports.commit.mock.calls[0][1]).toHaveLength(2);
    expect(t.current().state).toMatchObject({ kind: "done", result: { booksAdded: 0, bookmarksAdded: 0, notReached: 2 } });
    expect(ports.refresh).not.toHaveBeenCalled();
  } finally { await t.dom.dispose(); }
});

it("reports a staged fingerprint mismatch without publishing already converted records", async () => {
  const t = await setup({ withLocalBook: true });
  ports.stage.mockResolvedValueOnce([{ readestHash: NEW, errorCode: "source-mismatch" }]);
  try {
    await t.dom.run(async () => { await t.start("wrong-file.zip"); });
    await t.dom.run(async () => { await t.current().run(); });
    expect(ports.commit).not.toHaveBeenCalled();
    expect(ports.importPaths).not.toHaveBeenCalled();
    expect(t.current().state).toMatchObject({ kind: "done", result: { booksAdded: 0, bookmarksAdded: 0, failed: [{ title: "New", reason: "readestImport.fail.mismatch" }] } });
  } finally { await t.dom.dispose(); }
});

it("commits a staged book without records, reporting native duplicate counts rather than inventing additions", async () => {
  ports.library = [readestBook(NEW, "Text")];
  ports.open.mockImplementation(async ({ sessionId }) => ({ sessionId, library: { entryIndex: 0, bytes: 2 }, kind: "zip", books: [{ readestHash: NEW, fileName: "Text.txt", bytes: 2048 }] }));
  ports.stage.mockResolvedValue([{ readestHash: NEW, bookHash: newEntry.contentHash, fileName: "Text.txt", targetToken: "t", existing: true }]);
  ports.commit.mockResolvedValue({ ...outcome, bookmarksAdded: 0, booksAdded: 0, booksAlready: 1 });
  const t = await setup();
  try {
    await t.dom.run(async () => { await t.start("text.zip"); });
    await t.dom.run(async () => { await t.current().run(); });
    expect(ports.convert).not.toHaveBeenCalled();
    expect(ports.importPaths).not.toHaveBeenCalled();
    expect(ports.commit.mock.calls[0][1]).toEqual([]);
    expect(ports.commit.mock.calls[0][3]).toEqual([NEW]);
    expect(t.current().state).toMatchObject({ kind: "done", result: { booksAdded: 0, booksAlready: 1 } });
  } finally { await t.dom.dispose(); }
});

it.each([true, false])("reports approximate placements only after the combined commit succeeds (%s)", async (succeeds) => {
  const t = await setup({ withLocalBook: true });
  const commit = deferred<unknown>();
  const exactPreview = ports.convert.getMockImplementation()!;
  ports.convert.mockImplementation(async (...args) => {
    const preview = await exactPreview(...args);
    preview.bookmarks[0].grade = "approximate";
    preview.bookmarks[0].reasons = ["anchored"];
    return preview;
  });
  ports.commit.mockReturnValueOnce(commit.promise);
  let pending!: Promise<void>;
  try {
    await t.dom.run(async () => { await t.start("approximate.zip"); });
    await t.dom.run(async () => { pending = t.current().run(); await Promise.resolve(); });
    await t.dom.run(async () => { await vi.waitFor(() => expect(ports.commit).toHaveBeenCalledTimes(1)); });
    expect(t.current().state.kind).toBe("importing");
    expect(ports.importPaths).not.toHaveBeenCalled();
    expect(ports.commit.mock.calls[0][1]).toHaveLength(2);
    expect(ports.commit.mock.calls[0][3]).toEqual([NEW]);
    expect(ports.target).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      sessionId: ports.open.mock.calls[0][0].sessionId, readestHash: NEW,
    });
    await t.dom.run(async () => {
      if (succeeds) commit.resolve({ ...outcome, bookmarksAdded: 2, booksAdded: 1, booksAlready: 0 });
      else commit.reject({ code: "storage-error" });
      await pending;
    });
    const state = t.current().state;
    expect(state.kind).toBe("done");
    if (state.kind !== "done") return;
    expect(state.result.approximate).toEqual(succeeds ? [
      { title: "Shelved", kind: "bookmark", reasons: ["anchored"] },
      { title: "New", kind: "bookmark", reasons: ["anchored"] },
    ] : []);
    expect(state.result.booksAdded).toBe(succeeds ? 1 : 0);
    expect(state.result.bookmarksAdded).toBe(succeeds ? 2 : 0);
    expect(ports.refresh).toHaveBeenCalledTimes(succeeds ? 1 : 0);
  } finally { await t.dom.dispose(); }
});
