import { createElement, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization } from "./libraryOrganization";
import type { ShelfEntry } from "./shelf";
import {
  useShelfEntriesState, useShelfNoticeState, useShelfOrganizationState,
  useShelfContentHashes, useShelfLibrary, useShelfOrganizationActions, useShelfDeletion,
} from "./useShelfLibrary";

const ports = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock("./shelf", async (original) => ({ ...await original<typeof import("./shelf")>(), getShelfStore: ports.store }));

function entry(id: string): ShelfEntry {
  return {
    id, contentHash: id.repeat(64), title: id, creator: "", fileName: `${id}.epub`,
    fileSize: 1, coverMime: "", addedAtMs: 1, lastReadAtMs: 1, spineIndex: 1,
    page: 3, progressPct: 70, anchorIndex: null, anchorRatio: null, isNew: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function setup() {
  const dom = createReactDomHarness();
  const store = {
    list: vi.fn().mockResolvedValue([]), getOrganization: vi.fn().mockResolvedValue(emptyOrganization()),
    runtimeStatus: vi.fn().mockResolvedValue({ repositoryGeneration: "one" }),
    applyOrganization: vi.fn().mockResolvedValue(emptyOrganization()), deleteBook: vi.fn().mockResolvedValue(undefined),
  };
  ports.store.mockReturnValue(store);
  const busy = { current: false }, native = { current: null as string | null };
  const removeCheckpoint = vi.fn();
  const published = vi.fn(), failed = vi.fn();
  const checkpoint = { current: { remove: removeCheckpoint } };
  function useHost() {
    const entries = useShelfEntriesState();
    const notices = useShelfNoticeState();
    const organization = useShelfOrganizationState();
    const entriesRef = useRef(entries.shelfEntries);
    entriesRef.current = entries.shelfEntries;
    const hashes = useShelfContentHashes(entries.shelfEntries);
    const library = useShelfLibrary({ entriesState: entries, organizationState: organization, setShelfNotice: notices.setShelfNotice, onListPublished: published, onListFailed: failed });
    const actions = useShelfOrganizationActions({ runtime: getRuntimeCapabilities(), shelfEntriesRef: entriesRef, shelfBusyRef: busy, organizationState: organization, setShelfEntries: entries.setShelfEntries, setShelfNotice: notices.setShelfNotice });
    const [currentId, setCurrentShelfId] = useState<string | null>("a");
    const [isBusy, setShelfBusy] = useState(false);
    const [, setShelfBusyMessage] = useState("");
    const deletion = useShelfDeletion({ shelfBusyRef: busy, nativeImportRef: native, shelfEntriesRef: entriesRef, localCheckpointsRef: checkpoint, setShelfBusyMessage, setShelfBusy, setShelfEntries: entries.setShelfEntries, setCurrentShelfId, setShelfError: entries.setShelfError, setShelfNotice: notices.setShelfNotice, refreshOrganization: library.organizationReader.refresh });
    return { entries, notices, organization, hashes, library, actions, deletion, currentId, isBusy };
  }
  let api!: ReturnType<typeof useHost>;
  function Host() { api = useHost(); return createElement("div", {}, api.entries.shelfEntries.length); }
  return { dom, store, busy, native, published, failed, removeCheckpoint, current: () => api, render: () => dom.render(createElement(Host)) };
}

describe("shelf library host extraction", () => {
  it("keeps deletion busy until the purged organization has been read", async () => {
    const t = setup();
    const next = deferred<ReturnType<typeof emptyOrganization>>();
    try {
      await t.render();
      t.store.getOrganization.mockReturnValue(next.promise);
      let deletion!: Promise<void>;
      await t.dom.run(() => { deletion = t.current().deletion.handleShelfDelete("a"); });
      expect(t.busy.current).toBe(true);
      expect(t.store.getOrganization).toHaveBeenCalled();
      await t.dom.run(async () => { next.resolve(emptyOrganization()); await deletion; });
      expect(t.busy.current).toBe(false);
      expect(t.current().organization.organization).toEqual(emptyOrganization());
    } finally { await t.dom.dispose(); }
  });
  it("keeps the read gate on external writes and retains a snapshot after refresh failure", async () => {
    const t = setup();
    const stale = deferred<ShelfEntry[]>();
    const written = entry("a");
    t.store.list.mockReturnValueOnce(stale.promise).mockResolvedValue([written]);
    try {
      await t.render();
      const reader = t.current().library.libraryReader;
      let load!: ReturnType<typeof reader.load>;
      await t.dom.run(() => { load = reader.load(); });
      await t.dom.run(() => t.current().entries.setShelfEntries([written]));
      await t.dom.run(async () => { stale.resolve([entry("b")]); await load; });
      expect(t.store.list).toHaveBeenCalledTimes(2);
      expect(t.current().entries.shelfEntries).toEqual([written]);
      expect(t.current().entries.shelfWritesRef.current).toBe(1);
      expect(t.current().library.libraryReader).toBe(reader);
      expect(t.published).toHaveBeenCalledExactlyOnceWith([written]);
      t.store.list.mockRejectedValueOnce(new Error("disk unavailable"));
      await t.dom.run(async () => { await expect(t.current().library.refreshShelfProjection()).rejects.toThrow("disk unavailable"); });
      expect(t.current().entries.shelfEntries).toEqual([written]);
      expect(t.current().entries.libraryLoad).toEqual({ status: "ready", refreshError: "Error: disk unavailable" });
      expect(t.current().organization.organizationSettled).toBe(true);
      expect(t.failed).toHaveBeenCalledTimes(1);
    } finally { await t.dom.dispose(); }
  });

  it("uses fresh organization errors and only removes successful deletion rows and checkpoints", async () => {
    const t = setup();
    try {
      await t.render();
      await t.dom.run(() => t.current().entries.setShelfEntries([entry("a"), entry("b")]));
      await t.dom.run(() => t.current().actions.handleApplyOrganization({ type: "setFavorite", contentHashes: ["b"], value: true }));
      expect(t.store.applyOrganization).toHaveBeenCalledExactlyOnceWith({ type: "setFavorite", contentHashes: ["b".repeat(64)], value: true });
      await t.dom.run(() => t.current().organization.setOrganizationError("unreadable"));
      await t.dom.run(async () => { await expect(t.current().actions.handleApplyOrganization({ type: "deleteFolder", folderId: "f" })).rejects.toThrow("已禁用修改"); });
      expect(t.store.applyOrganization).toHaveBeenCalledTimes(1);
      expect(t.current().organization.organizationBusyRef.current).toBe(false);
      t.native.current = "directory-import";
      await t.dom.run(() => t.current().deletion.handleShelfDeleteMany(["a", "b"]));
      expect(t.store.deleteBook).not.toHaveBeenCalled();
      t.native.current = null;
      t.store.deleteBook.mockImplementation(async (id: string) => { if (id === "b") throw new Error("locked"); });
      t.store.getOrganization.mockClear();
      await t.dom.run(() => t.current().deletion.handleShelfDeleteMany(["a", "b"]));
      expect(t.current().entries.shelfEntries).toEqual([entry("b")]);
      expect(t.current().currentId).toBeNull();
      expect(t.removeCheckpoint).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
      // C5: the purge also cleared favorites/folders in the repository; the shelf re-reads them.
      expect(t.store.getOrganization).toHaveBeenCalled();
      expect(t.current().hashes.contentHashByIdRef.current.has("a")).toBe(false);
      expect(t.current().entries.shelfError).toContain("locked");
      expect(t.busy.current).toBe(false);
      expect(t.current().isBusy).toBe(false);
    } finally { await t.dom.dispose(); }
  });
});
