import { createElement } from "react";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAPTER_1, CHAPTER_2 } from "../../render/interop/epubCfi.fixture";
import { createReactDomHarness } from "../../test/reactDomHarness";
import type { ShelfEntry } from "../shelf";
import { useKoreaderImport } from "./useKoreaderImport";

const ports = vi.hoisted(() => ({
  open: vi.fn(), read: vi.fn(), target: vi.fn(), commit: vi.fn(), close: vi.fn(),
  openLocal: vi.fn(), notice: vi.fn(), refresh: vi.fn(), dirty: vi.fn(), barrier: vi.fn(), pick: vi.fn(),
  shelfChanged: null as null | (() => void),
}));
vi.mock("../../platform/koreaderImportNativeBridge", () => ({
  openKoreaderSidecar: ports.open, readKoreaderSidecarText: ports.read, koreaderImportTarget: ports.target,
  commitKoreaderProgress: ports.commit, closeKoreaderSidecar: ports.close,
}));
vi.mock("../shelf", () => ({ getShelfStore: () => ({}), activatePortableShelfState: async () => undefined }));
vi.mock("../shelfSpaces", () => ({
  activeShelfSpace: () => ({ kind: "public" }),
  subscribeShelfSpace: (listener: () => void) => { ports.shelfChanged = listener; return () => { ports.shelfChanged = null; }; },
}));
vi.mock("../cloudSync/cloudSyncStore", () => ({ noteCloudSyncChange: ports.dirty }));
vi.mock("../localization/UiLanguageProvider", () => ({ uiText: (key: string) => key }));
vi.mock("../readestImport/readestLocalTarget", () => ({ openReadestTarget: ports.openLocal }));

const HASH = "a".repeat(64);
const MD5 = "b".repeat(32);
const sidecar = (dom = 20240114, xpointer = "/body/DocFragment[2]/body/p[2]/text().11") => `return {
  ["cre_dom_version"] = ${dom},
  ["doc_props"] = { ["title"] = "CFI" },
  ["last_xpointer"] = "${xpointer}",
  ["partial_md5_checksum"] = "${MD5}",
  ["percent_finished"] = 0.99,
}`;
const xml = (source: string) => new DOMParser().parseFromString(source, "text/xml") as unknown as Document;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

let closeLocal: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  ports.pick.mockResolvedValue({ source: { kind: "path", path: "/m.lua" }, label: "metadata.epub.lua" });
  ports.open.mockImplementation(async ({ sessionId }) => ({ sessionId, bytes: 10 }));
  ports.read.mockResolvedValue(sidecar());
  ports.target.mockResolvedValue({ bookHash: HASH, partialMd5: MD5, targetToken: "token", progress: { versions: [], display: null, conflict: false } });
  ports.close.mockResolvedValue("closed");
  ports.commit.mockResolvedValue({ progressWritten: 1, progressUnchanged: 0 });
  ports.refresh.mockResolvedValue(undefined);
  ports.barrier.mockResolvedValue(undefined);
  closeLocal = vi.fn();
  ports.openLocal.mockResolvedValue({
    target: {
      spineIdrefs: ["c1", "c2"],
      chapterPath: (i: number) => ["OEBPS/Text/c1.xhtml", "OEBPS/Text/c2.xhtml"][i],
      opfDocument: null,
      loadChapter: async (i: number) => xml([CHAPTER_1, CHAPTER_2][i]),
    },
    close: closeLocal,
  });
});

async function setup() {
  const dom = createReactDomHarness();
  let current!: ReturnType<typeof useKoreaderImport>;
  const shelfEntriesRef = { current: [{ id: "local", contentHash: HASH, title: "Book", creator: "", fileName: "book.epub" } as ShelfEntry] };
  function Host() {
    current = useKoreaderImport({
      shelfEntriesRef, refreshShelfProjection: ports.refresh, setShelfNotice: ports.notice,
      pickSidecar: ports.pick, beforeCommit: ports.barrier,
    });
    return null;
  }
  await dom.render(createElement(Host));
  return { dom, current: () => current };
}

describe("KOReader import session", () => {
  it("previews the converted position, runs the save barrier, commits it and refreshes the shelf", async () => {
    const t = await setup();
    try {
      await t.dom.run(async () => { await t.current().start(); });
      expect(t.current().state).toMatchObject({ kind: "choose", chosen: "local", books: [{ id: "local", basis: "partial-md5" }] });
      await t.dom.run(async () => { await t.current().next(); });
      const state = t.current().state;
      expect(state).toMatchObject({
        kind: "preview",
        preview: { status: { kind: "ready" }, koreader: { updatedAtMs: null }, target: { spineIndex: 1, excerpt: "同一句话。" } },
      });
      expect(closeLocal).toHaveBeenCalledTimes(1);
      await t.dom.run(async () => { await t.current().confirm(); });
      expect(ports.barrier).toHaveBeenCalledWith({ id: "local", bookHash: HASH });
      expect(ports.barrier.mock.invocationCallOrder[0]).toBeLessThan(ports.commit.mock.invocationCallOrder[0]);
      const [, book] = ports.commit.mock.calls[0];
      expect(book).toMatchObject({ bookHash: HASH, targetToken: "token", progress: { locator: { chapterPath: "OEBPS/Text/c2.xhtml", target: { offset: 11 } } } });
      expect(book.progress.progressPctHint).toBeGreaterThanOrEqual(50);
      expect(ports.refresh).toHaveBeenCalledTimes(1);
      expect(ports.notice).toHaveBeenLastCalledWith({ kind: "ok", text: "koreaderImport.done" });
      expect(t.current().state.kind).toBe("idle");
      expect(ports.close).toHaveBeenCalled();
    } finally { await t.dom.dispose(); }
  });

  it("shows an unsupported DOM version as blocked and never commits it", async () => {
    ports.read.mockResolvedValue(sidecar(20250101));
    const t = await setup();
    try {
      await t.dom.run(async () => { await t.current().start(); });
      await t.dom.run(async () => { await t.current().next(); });
      expect(t.current().state).toMatchObject({ kind: "preview", preview: { status: { kind: "blocked", reason: "dom-version-unsupported" }, target: null } });
      await t.dom.run(async () => { await t.current().confirm(); });
      expect(ports.commit).not.toHaveBeenCalled();
      expect(ports.barrier).not.toHaveBeenCalled();
    } finally { await t.dom.dispose(); }
  });

  it("drops a preview that finishes after cancel and still closes the local book", async () => {
    const gate = deferred<Document>();
    ports.openLocal.mockResolvedValueOnce({
      target: { spineIdrefs: ["c1", "c2"], chapterPath: (i: number) => `c${i}.xhtml`, opfDocument: null, loadChapter: () => gate.promise },
      close: closeLocal,
    });
    const t = await setup();
    let pending!: Promise<void>;
    try {
      await t.dom.run(async () => { await t.current().start(); });
      await t.dom.run(() => { pending = t.current().next(); });
      await t.dom.run(() => t.current().cancel());
      await t.dom.run(async () => { gate.resolve(xml(CHAPTER_2)); await pending; });
      expect(t.current().state.kind).toBe("idle");
      expect(closeLocal).toHaveBeenCalledTimes(1);
      expect(ports.close).toHaveBeenCalledTimes(1);
    } finally { await t.dom.dispose(); }
  });

  it("does not commit when the save barrier refuses, and reports reader-busy from native", async () => {
    ports.barrier.mockRejectedValueOnce(new Error("pending"));
    const t = await setup();
    try {
      await t.dom.run(async () => { await t.current().start(); });
      await t.dom.run(async () => { await t.current().next(); });
      await t.dom.run(async () => { await t.current().confirm(); });
      expect(ports.commit).not.toHaveBeenCalled();
      expect(ports.notice).toHaveBeenLastCalledWith({ kind: "error", text: "koreaderImport.error.other" });

      ports.commit.mockRejectedValueOnce({ code: "reader-busy", message: "busy" });
      await t.dom.run(async () => { await t.current().start(); });
      await t.dom.run(async () => { await t.current().next(); });
      await t.dom.run(async () => { await t.current().confirm(); });
      expect(ports.notice).toHaveBeenLastCalledWith({ kind: "error", text: "koreaderImport.error.readerBusy" });
      expect(ports.refresh).not.toHaveBeenCalled();
    } finally { await t.dom.dispose(); }
  });

  it("keeps a newer dialog when an old commit lands after a shelf switch", async () => {
    const gate = deferred<{ progressWritten: number; progressUnchanged: number }>();
    ports.commit.mockReturnValueOnce(gate.promise);
    const t = await setup();
    let pending!: Promise<void>;
    try {
      await t.dom.run(async () => { await t.current().start(); });
      await t.dom.run(async () => { await t.current().next(); });
      await t.dom.run(() => { pending = t.current().confirm(); });
      await t.dom.run(() => ports.shelfChanged!());
      await t.dom.run(async () => { await t.current().start(); });
      await t.dom.run(async () => { gate.resolve({ progressWritten: 1, progressUnchanged: 0 }); await pending; });
      expect(t.current().state.kind).toBe("choose");
      expect(ports.refresh).not.toHaveBeenCalled();
      expect(ports.dirty).toHaveBeenCalledWith("data-changed");
    } finally { await t.dom.dispose(); }
  });
});
