import { createElement, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AndroidImportBatchResult, AndroidImportProgress } from "../platform/androidNativeBridge";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization, type LibraryOrganization } from "./libraryOrganization";
import type { ShelfEntry } from "./shelf";
import { useShelfEntriesState, useShelfNoticeState, useShelfContentHashes } from "./useShelfLibrary";
import { useBookImportState, useBookImport, useFolderImport } from "./useBookImport";

const ports = vi.hoisted(() => ({ store: vi.fn(), activate: vi.fn(), picker: vi.fn(), native: vi.fn(), cancel: vi.fn(), directory: vi.fn() }));
vi.mock("./shelf", async (original) => ({ ...await original<typeof import("./shelf")>(), getShelfStore: ports.store, activatePortableShelfState: ports.activate }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: ports.picker }));
vi.mock("../platform/androidNativeBridge", () => ({ importDocuments: ports.native, cancelDocumentImport: ports.cancel }));
vi.mock("./folderImport", () => ({ createNativeDirectoryImportPort: ports.directory, createWebDirectoryImportPort: vi.fn(), supportsWebDirectoryPicker: () => false }));

function entry(id: string): ShelfEntry {
  return { id, contentHash: id.repeat(64), title: id, creator: "", fileName: `${id}.epub`, fileSize: 1, coverMime: "", addedAtMs: 1, lastReadAtMs: 1, spineIndex: 1, page: 3, progressPct: 70, anchorIndex: null, anchorRatio: null, isNew: false };
}
const FOLDER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const stamp = { deviceId: "d", counter: 1 };
/** Folder FOLDER ("Target") and OTHER ("Elsewhere"); book "b" is filed in OTHER. */
function organization(options: { targetDeleted?: boolean } = {}): LibraryOrganization {
  return {
    schemaVersion: 1,
    folders: {
      [FOLDER]: { name: { value: "Target", stamp }, ...(options.targetDeleted ? { deleted: stamp } : {}) },
      [OTHER]: { name: { value: "Elsewhere", stamp } },
    },
    books: { ["b".repeat(64)]: { folderId: { value: OTHER, stamp } } },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function setup() {
  const dom = createReactDomHarness();
  for (const mock of Object.values(ports)) mock.mockReset();
  const store = { list: vi.fn().mockResolvedValue([]), importPaths: vi.fn(), importRecords: vi.fn(async (records: ShelfEntry[]) => records), getOrganization: vi.fn().mockResolvedValue(emptyOrganization()), applyOrganization: vi.fn() };
  const setOrganization = vi.fn();
  ports.store.mockReturnValue(store);
  ports.activate.mockResolvedValue(undefined);
  ports.directory.mockReturnValue({});
  const busy = { current: false }, organizationBusy = { current: false };
  const saveState = { current: { kind: "idle" as const } }, saveLaunch = { current: false }, lanActive = { current: false };
  const refresh = vi.fn().mockResolvedValue(undefined);
  function useHost() {
    const entries = useShelfEntriesState();
    const notices = useShelfNoticeState();
    const imports = useBookImportState();
    const entriesRef = useRef(entries.shelfEntries);
    entriesRef.current = entries.shelfEntries;
    const hashes = useShelfContentHashes(entries.shelfEntries);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const commands = useBookImport({ importState: imports, runtime: { ...getRuntimeCapabilities(), platform: "android" }, isTauriEnv: () => true, fileInputRef, shelfBusyRef: busy, shelfEntriesRef: entriesRef, ...hashes, setShelfEntries: entries.setShelfEntries, setShelfNotice: notices.setShelfNotice, setOrganization });
    const folders = useFolderImport({ importState: imports, shelfBusyRef: busy, organizationBusyRef: organizationBusy, saveFileJobStateRef: saveState, saveFileLaunchRef: saveLaunch, lanSaveActiveRef: lanActive, isTauriEnv: () => true, setShelfNotice: notices.setShelfNotice, refreshShelfProjection: refresh });
    return { entries, notices, imports, commands, folders };
  }
  let api!: ReturnType<typeof useHost>;
  function Host() { api = useHost(); return createElement("div", {}, api.entries.shelfEntries.length); }
  return { dom, store, busy, refresh, setOrganization, current: () => api, render: () => dom.render(createElement(Host)) };
}

describe("book import host extraction", () => {
  it("reserves the batch gate and keeps a committed rebound even if list refresh fails", async () => {
    const t = setup();
    const result = deferred<unknown>();
    t.store.importPaths.mockReturnValue(result.promise);
    t.store.list.mockRejectedValue(new Error("refresh unavailable"));
    try {
      await t.render();
      let work!: Promise<void>;
      const sources = [{ kind: "path" as const, path: "a.epub", name: "a.epub" }];
      await t.dom.run(() => { work = t.current().commands.handleImportSources(sources); });
      expect(t.busy.current).toBe(true);
      await t.dom.run(() => t.current().commands.handleImportSources(sources));
      expect(t.store.importPaths).toHaveBeenCalledTimes(1);
      await t.dom.run(async () => { result.resolve({ results: [{ inputIndex: 0, status: "duplicate", record: entry("a") }] }); await work; });
      expect(t.current().entries.shelfEntries).toEqual([entry("a")]);
      expect(t.current().notices.shelfNotice?.kind).toBe("warn");
      expect(t.current().notices.shelfNotice?.text).toContain("refresh unavailable");
      expect(t.busy.current).toBe(false);
      expect(t.current().imports.shelfBusy).toBe(false);
    } finally { await t.dom.dispose(); }
  });

  it("keeps native request identity through collapse, stale progress and too-late cancellation", async () => {
    const t = setup();
    const result = deferred<AndroidImportBatchResult>();
    const cancel = deferred<string>();
    let requestId = "";
    let progress!: (value: AndroidImportProgress) => void;
    ports.picker.mockResolvedValue(["content://books/a.epub"]);
    ports.native.mockImplementation((id: string, _documents: unknown, callback: typeof progress) => { requestId = id; progress = callback; return result.promise; });
    ports.cancel.mockReturnValue(cancel.promise);
    try {
      await t.render();
      let work!: Promise<void>;
      await t.dom.run(() => { work = t.current().commands.handleChooseBooks(); });
      expect(t.current().imports.nativeImportRef.current).toBe(requestId);
      await t.dom.run(() => progress({ requestId, phase: "preparing", completed: 0, total: 1 }));
      await t.dom.run(() => t.current().commands.handleToggleNativeImportCollapsed());
      expect(t.current().imports.nativeImport?.collapsed).toBe(true);
      await t.dom.run(() => t.current().commands.handleChooseBooks());
      expect(ports.picker).toHaveBeenCalledTimes(1);
      let cancelling!: Promise<void>;
      await t.dom.run(() => { cancelling = t.current().commands.handleCancelNativeImport(); });
      await t.dom.run(() => progress({ requestId: "old-request", phase: "committing", completed: 1, total: 1 }));
      expect(t.current().imports.nativeImport?.phase).toBe("preparing");
      await t.dom.run(() => progress({ requestId, phase: "committing", completed: 1, total: 1 }));
      await t.dom.run(async () => { cancel.resolve("too_late"); await cancelling; });
      expect(t.current().imports.nativeImport?.cancelState).toBe("too_late");
      await t.dom.run(async () => { result.resolve({ results: [{ inputIndex: 0, status: "duplicate", record: entry("a"), contentHash: "a".repeat(64), error: null }] }); await work; });
      expect(t.current().entries.shelfEntries).toEqual([entry("a")]);
      expect(t.current().imports.nativeImportRef.current).toBeNull();
      expect(t.current().imports.nativeImport).toBeNull();
    } finally { await t.dom.dispose(); }
  });

  it("reserves directory ownership before awaiting its snapshot and releases it on close", async () => {
    const t = setup();
    const snapshot = deferred<ReturnType<typeof emptyOrganization>>();
    t.store.getOrganization.mockReturnValue(snapshot.promise);
    try {
      await t.render();
      let work!: Promise<void>;
      await t.dom.run(() => { work = t.current().folders.handleOpenFolderImport(); });
      expect(t.current().imports.nativeImportRef.current).toBe("directory-import");
      await t.dom.run(() => t.current().folders.handleOpenFolderImport());
      await t.dom.run(() => t.current().commands.handleChooseBooks());
      expect(t.store.getOrganization).toHaveBeenCalledTimes(1);
      expect(ports.picker).not.toHaveBeenCalled();
      await t.dom.run(async () => { snapshot.resolve(emptyOrganization()); await work; });
      expect(t.current().imports.folderImport?.supported).toBe(true);
      await t.dom.run(() => t.current().folders.handleFolderImportSettled());
      expect(t.refresh).toHaveBeenCalledTimes(1);
      await t.dom.run(() => t.current().folders.closeFolderImport());
      expect(t.current().imports.folderImport).toBeNull();
      expect(t.current().imports.nativeImportRef.current).toBeNull();
    } finally { await t.dom.dispose(); }
  });

  it("files an import started in a folder there, leaving books other folders hold", async () => {
    const t = setup();
    const before = organization();
    const after = { ...before };
    t.store.getOrganization.mockResolvedValue(before);
    t.store.applyOrganization.mockResolvedValue(after);
    t.store.importPaths.mockResolvedValue({ results: [
      { inputIndex: 0, status: "saved", record: entry("a") },
      { inputIndex: 1, status: "duplicate", record: entry("b") },
      { inputIndex: 2, status: "duplicate", record: entry("c") },
    ] });
    try {
      await t.render();
      const sources = ["a", "b", "c"].map((id) => ({ kind: "path" as const, path: `${id}.epub`, name: `${id}.epub` }));
      await t.dom.run(() => t.current().commands.handleImportSources(sources, { folderId: FOLDER, name: "Target" }));
      // One write: the new book and the unclassified duplicate; "b" stays in its folder.
      expect(t.store.applyOrganization).toHaveBeenCalledTimes(1);
      expect(t.store.applyOrganization).toHaveBeenCalledWith({ type: "moveBooks", contentHashes: ["a".repeat(64), "c".repeat(64)], folderId: FOLDER });
      expect(t.setOrganization).toHaveBeenLastCalledWith(after);
      const notice = t.current().notices.shelfNotice;
      expect(notice?.kind).toBe("warn");
      expect(notice?.text).toContain("Target");
      expect(notice?.text).toContain("1");
    } finally { await t.dom.dispose(); }
  });

  it("keeps the books unclassified when the target folder was dissolved meanwhile", async () => {
    const t = setup();
    t.store.getOrganization.mockResolvedValue(organization({ targetDeleted: true }));
    t.store.importPaths.mockResolvedValue({ results: [{ inputIndex: 0, status: "saved", record: entry("a") }] });
    try {
      await t.render();
      await t.dom.run(() => t.current().commands.handleImportSources(
        [{ kind: "path" as const, path: "a.epub", name: "a.epub" }],
        { folderId: FOLDER, name: "Target" },
      ));
      expect(t.store.applyOrganization).not.toHaveBeenCalled();
      expect(t.current().notices.shelfNotice?.kind).toBe("warn");
      expect(t.current().notices.shelfNotice?.text).toContain("Target");
    } finally { await t.dom.dispose(); }
  });

  it("files an Android picker import into the folder it was started from", async () => {
    const t = setup();
    t.store.getOrganization.mockResolvedValue(organization());
    t.store.applyOrganization.mockResolvedValue(organization());
    ports.picker.mockResolvedValue(["content://doc/a.epub"]);
    ports.native.mockResolvedValue({ results: [{ inputIndex: 0, status: "saved", record: entry("a") }] });
    try {
      await t.render();
      await t.dom.run(() => t.current().commands.handleChooseBooks({ folderId: FOLDER, name: "Target" }));
      expect(t.store.applyOrganization).toHaveBeenCalledWith({ type: "moveBooks", contentHashes: ["a".repeat(64)], folderId: FOLDER });
      expect(t.current().notices.shelfNotice?.kind).toBe("ok");
    } finally { await t.dom.dispose(); }
  });

  it("opens directory import on a dropped folder and scans it without a picker", async () => {
    const t = setup();
    try {
      await t.render();
      const source = { kind: "path" as const, path: "D:\\Books" };
      await t.dom.run(() => t.current().folders.handleOpenFolderImport(source));
      expect(ports.directory).toHaveBeenCalledWith(source);
      expect(t.current().imports.folderImport?.autoScan).toBe(true);
      await t.dom.run(() => t.current().folders.closeFolderImport());
      await t.dom.run(() => t.current().folders.handleOpenFolderImport());
      expect(ports.directory).toHaveBeenLastCalledWith(undefined);
      expect(t.current().imports.folderImport?.autoScan).toBe(false);
    } finally { await t.dom.dispose(); }
  });
});
