import { createElement, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import type { ChapterState, ReadingAnchor, SelectionContextPayload } from "../render/paginator";
import { createReactDomHarness } from "../test/reactDomHarness";
import type { Bookmark, ShelfEntry } from "./shelf";
import type { ReaderNote } from "./notes";
import type { ReaderHandle } from "./ReaderView";
import { useShelfEntriesState } from "./useShelfLibrary";
import { readerForegroundSurfaces, useReaderForeground, useReaderForegroundState } from "./useReaderForeground";
import { useNoteEditRef, replaceNoteEditContext, useBookmarkToast, useBookmarkToastCleanup,
  useNoteBusyState, useNoteProjection, useNoteActions, useBookmarkProjection,
  useBookmarkSidebarToggle, useBookmarkActions, useNoteEditRelease } from "./useBookmarksAndNotes";

const ports = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock("./shelf", async (original) => ({ ...await original<typeof import("./shelf")>(), getShelfStore: ports.store }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const entry: ShelfEntry = {
  id: "book", title: "Book", creator: "", fileName: "book.epub", fileSize: 1, coverMime: "",
  addedAtMs: 1, lastReadAtMs: 1, spineIndex: 0, page: 0, progressPct: 10,
  anchorIndex: null, anchorRatio: null, isNew: false, contentHash: "a".repeat(64),
};
const book: Book = {
  version: 3, guide: [], resources: new Map(), fixedLayout: false, issues: [], drmProtected: false,
  opfPath: "content.opf", metadata: { title: "Book", identifier: "book", language: "en" },
  manifest: new Map([0, 1].map((i) => [String(i), { id: String(i), href: `c${i}.xhtml`, mediaType: "application/xhtml+xml", properties: [] }])),
  spine: [0, 1].map((i) => ({ idref: String(i), linear: true })),
  toc: [{ href: "c0.xhtml", label: "Chapter 0", children: [] }],
};
const selection: SelectionContextPayload = {
  chapterPath: "c0.xhtml", selectedText: "display", originalSelectedText: "original",
  startTextOffset: 10, endTextOffset: 18, startTextSnippet: "original", endTextSnippet: "original",
  rect: { left: 0, top: 0, right: 10, bottom: 10 },
};
const note: ReaderNote = {
  id: "n", spineIndex: 0, chapterPath: "c0.xhtml", startTextOffset: 10, endTextOffset: 18,
  startTextSnippet: "original", endTextSnippet: "original", selectedText: "original", content: "old",
  createdAtMs: 1, updatedAtMs: 100,
};
function bookmark(id: string, offset: number): Bookmark {
  return { id, spineIndex: 0, page: 0, anchorIndex: 0, anchorRatio: 0,
    anchorTextOffset: offset, anchorTextSnippet: "text", text: "text", createdAtMs: 1 };
}
function setup() {
  const dom = createReactDomHarness();
  vi.useFakeTimers();
  const store = {
    createBookmark: vi.fn().mockResolvedValue(entry), deleteBookmark: vi.fn().mockResolvedValue(entry),
    setBookmarks: vi.fn().mockResolvedValue(entry),
    createNote: vi.fn().mockResolvedValue(entry), deleteNote: vi.fn().mockResolvedValue(entry),
    setNotes: vi.fn().mockResolvedValue(entry), writeNoteEdit: vi.fn().mockResolvedValue(entry),
    beginNoteEdit: vi.fn().mockResolvedValue({ readId: "read", basisId: "basis" }),
    endNoteEdit: vi.fn().mockResolvedValue(undefined),
  };
  ports.store.mockReset().mockReturnValue(store);
  let position = {
    state: { status: "ready", mode: "paginated", pageCount: 10, currentPage: 3, empty: false } as ChapterState,
    readingAnchor: { index: 0, ratio: 0.3, charsRead: 30, totalChars: 100, textOffset: 30, textSnippet: "text" } as ReadingAnchor,
    anchorText: "text",
  };
  const readPosition = vi.fn(() => position);
  const reader = {
    getReadingAnchor: () => position.readingAnchor,
    resolveBookmarkPage: vi.fn((bm: Bookmark) => bm.page),
    dismissFootnote: vi.fn(), clearTextSelection: vi.fn(),
  };
  const dirty = { current: false }, overlay = { current: false };
  const closeSidebar = vi.fn(), openBookmarks = vi.fn();
  let sidebarOpen = false;
  function useHost() {
    const editRef = useNoteEditRef();
    const shelf = useShelfEntriesState();
    const [foreground, setForeground] = useReaderForegroundState();
    const foregroundRef = useRef(foreground);
    foregroundRef.current = foreground;
    const shelfRef = useRef(shelf.shelfEntries);
    shelfRef.current = shelf.shelfEntries;
    const toast = useBookmarkToast();
    const busy = useNoteBusyState();
    const [issues, setRuntimeIssues] = useState<string[]>([]);
    const commands = useReaderForeground({ foregroundRef, setForeground, overlayHoverRef: overlay,
      reader: () => reader, beforeOpenComposer: (draft) => replaceNoteEditContext(draft, editRef), noteComposerDirtyRef: dirty });
    const { noteComposer } = readerForegroundSurfaces(foreground);
    useBookmarkToastCleanup(toast.bookmarkToastTimerRef);
    const notes = useNoteProjection(shelf.shelfEntries, "book", book, 0);
    const noteActions = useNoteActions({ ...busy, ...notes, currentShelfId: "book", book, setShelfEntries: shelf.setShelfEntries,
      setRuntimeIssues, noteComposer, setForeground, shelfEntriesRef: shelfRef, openComposer: commands.openComposer });
    const readerRef = useRef(reader as unknown as ReaderHandle);
    const bookmarks = useBookmarkProjection({ currentShelfId: "book", shelfEntries: shelf.shelfEntries,
      chapterState: position.state, readerRef, spineIndex: 0, book });
    const toggleSidebar = useBookmarkSidebarToggle({ isSidebarOpen: sidebarOpen, sidebarSide: "right", activeSidebarTab: "bookmarks",
      handleSidebarClose: closeSidebar, handleOpenBookmarks: openBookmarks });
    const bookmarkActions = useBookmarkActions({ currentShelfId: "book", readReaderPosition: readPosition,
      ...bookmarks, spineIndex: 0, book, readerRef, showBookmarkToast: toast.showBookmarkToast,
      setShelfEntries: shelf.setShelfEntries, setShelfError: shelf.setShelfError });
    useNoteEditRelease({ noteComposer, noteComposerDirtyRef: dirty, activeNoteEditContextRef: editRef });
    return { ...shelf, ...toast, ...busy, ...notes, ...noteActions, ...bookmarks, ...bookmarkActions,
      editRef, foreground, commands, issues, toggleSidebar };
  }
  let api!: ReturnType<typeof useHost>;
  function Host() { api = useHost(); return createElement("div", {}, api.currentBookmarks.length); }
  return { dom, store, reader, readPosition, dirty, closeSidebar, openBookmarks, current: () => api,
    render: () => dom.render(createElement(Host)),
    setPosition: (patch: Partial<typeof position>) => { position = { ...position, ...patch }; },
    sidebar: (value: boolean) => { sidebarOpen = value; },
    advance: (ms: number) => dom.run(async () => { await vi.advanceTimersByTimeAsync(ms); }),
    dispose: async () => { await dom.dispose(); vi.useRealTimers(); },
  };
}

describe("annotation responsibilities extracted from App", () => {
  it("confirms only bookmark fields from a delayed write and preserves newer progress and notes on failure", async () => {
    const t = setup();
    try {
      await t.render();
      await t.dom.run(() => t.current().setShelfEntries([{ ...entry, notes: [note] }]));
      const write = deferred<ShelfEntry>();
      t.store.createBookmark.mockReturnValueOnce(write.promise);
      await t.dom.run(() => t.current().handleToggleBookmark());
      const added = t.current().currentBookmarks[0];
      expect(added).toMatchObject({ page: 3, anchorTextOffset: 30, chapterPath: "c0.xhtml", text: "text" });
      expect(t.readPosition).toHaveBeenCalledExactlyOnceWith(true);
      expect(t.current().sortedBookmarks[0].chapterLabel).toBe("Chapter 0");
      await t.dom.run(() => t.current().setShelfEntries((rows) => rows.map((e) => ({ ...e, progressPct: 80, page: 8 }))));
      const annotations = { [added.id]: { versions: [] } };
      await t.dom.run(() => write.resolve({ ...entry, bookmarks: [added], portableBookmarkAnnotations: annotations } as ShelfEntry));
      expect(t.current().shelfEntries[0]).toMatchObject({ progressPct: 80, page: 8, notes: [note], portableBookmarkAnnotations: annotations });
      t.store.deleteBookmark.mockRejectedValueOnce(new Error("locked"));
      await t.dom.run(() => t.current().handleDeleteBookmark(added.id));
      expect(t.current().currentBookmarks).toEqual([added]);
      expect(t.current().shelfEntries[0].progressPct).toBe(80);
      expect(t.current().shelfError).toContain("locked");
    } finally { await t.dispose(); }
  });

  it("uses exact scroll identities and resolved page identities for highlight and bookmark removal", async () => {
    const t = setup();
    try {
      await t.render();
      await t.dom.run(() => t.current().setShelfEntries([{ ...entry, bookmarks: [bookmark("n20", 20), bookmark("n30", 30)] }]));
      t.setPosition({ state: { status: "ready", mode: "scroll", pageCount: 1, currentPage: 0, empty: false } });
      await t.render();
      expect(t.current().isCurrentPageBookmarked).toBe(true);
      await t.dom.run(() => t.current().handleToggleBookmark());
      expect(t.store.deleteBookmark).toHaveBeenLastCalledWith("book", "n30");
      expect(t.current().currentBookmarks.map((b) => b.id)).toEqual(["n20"]);
      const media = { index: 0, tag: "img", signature: "image", ratio: 0.4 };
      t.setPosition({ readingAnchor: { index: -1, ratio: 0, charsRead: 0, totalChars: 0, textOffset: null, textSnippet: null, mediaAnchor: media } });
      await t.dom.run(() => t.current().setShelfEntries([{ ...entry, bookmarks: [{ ...bookmark("media", 0), anchorTextOffset: null, mediaAnchor: media }] }]));
      expect(t.current().isCurrentPageBookmarked).toBe(true);
      await t.dom.run(() => t.current().handleToggleBookmark());
      expect(t.store.deleteBookmark).toHaveBeenLastCalledWith("book", "media");
      t.setPosition({ state: { status: "ready", mode: "paginated", pageCount: 10, currentPage: 3, empty: false },
        readingAnchor: { index: 0, ratio: 0, charsRead: 30, totalChars: 100, textOffset: 30, textSnippet: "text" } });
      t.reader.resolveBookmarkPage.mockReturnValue(3);
      await t.dom.run(() => t.current().setShelfEntries([{ ...entry, bookmarks: [bookmark("earlier", 20), bookmark("exact", 30)] }]));
      expect(t.current().isCurrentPageBookmarked).toBe(true);
      await t.dom.run(() => t.current().handleToggleBookmark());
      expect(t.store.deleteBookmark).toHaveBeenLastCalledWith("book", "exact");
      expect(t.current().currentBookmarks.map((b) => b.id)).toEqual(["earlier"]);
    } finally { await t.dispose(); }
  });

  it("keeps the note write gate synchronous and merges confirmation without overwriting newer shelf fields", async () => {
    const t = setup();
    try {
      await t.render();
      await t.dom.run(() => t.current().setShelfEntries([entry]));
      await t.dom.run(() => t.current().commands.openComposer({ mode: "create", spineIndex: 0, selection }));
      const write = deferred<ShelfEntry>();
      t.store.createNote.mockReturnValueOnce(write.promise);
      let first!: Promise<void>, second!: Promise<void>;
      await t.dom.run(() => { const save = t.current().handleSaveNote; first = save(" first "); second = save(" second "); });
      expect(t.store.createNote).toHaveBeenCalledTimes(1);
      expect(t.current().noteBusyRef.current).toBe(true);
      const created = t.current().currentNotes[0];
      expect(created).toMatchObject({ selectedText: "original", content: "first", chapterPath: "c0.xhtml" });
      await t.dom.run(() => t.current().setShelfEntries((rows) => rows.map((e) => ({ ...e, progressPct: 80, bookmarks: [bookmark("b", 0)] }))));
      const annotations = { [created.id]: { versions: [] } };
      await t.dom.run(async () => { write.resolve({ ...entry, notes: [created], portableNoteAnnotations: annotations } as ShelfEntry); await Promise.all([first, second]); });
      expect(t.current().shelfEntries[0]).toMatchObject({ progressPct: 80, bookmarks: [bookmark("b", 0)], portableNoteAnnotations: annotations });
      expect(t.current().foreground.kind).toBe("none");
      expect(t.current().noteBusyRef.current).toBe(false);
      expect(t.current().currentChapterNotes[0].id).toBe(created.id);
      expect(t.current().noteViewModels[0].chapterTitle).toBe("Chapter 0");
    } finally { await t.dispose(); }
  });

  it("edits from the displayed version, retains the editor on write failure and releases its basis on close", async () => {
    const t = setup();
    try {
      await t.render();
      const stamp = { deviceId: "device", counter: 2 };
      const annotations = { n: { versions: [{ stamp: { deviceId: "device", counter: 1 }, clock: { device: 1 }, value: {}, updatedAtMs: 1 },
        { stamp, clock: { device: 2 }, value: {}, updatedAtMs: 2 }] } };
      await t.dom.run(() => t.current().setShelfEntries([{ ...entry, notes: [note], portableNoteAnnotations: annotations } as ShelfEntry]));
      await t.dom.run(() => t.current().handleEditNote("n"));
      expect(t.store.beginNoteEdit).toHaveBeenCalledExactlyOnceWith("book", "n", stamp);
      expect(t.current().editRef.current).toEqual({ readId: "read", basisId: "basis" });
      t.store.writeNoteEdit.mockRejectedValueOnce(new Error("write failed"));
      await t.dom.run(() => t.current().handleSaveNote("updated"));
      expect(t.store.writeNoteEdit.mock.calls[0][2]).toEqual({ readId: "read", basisId: "basis" });
      expect(t.current().currentNotes).toEqual([note]);
      expect(t.current().foreground.kind).toBe("modal");
      expect(t.current().issues.at(-1)).toContain("write failed");
      expect(t.current().noteBusy).toBe(false);
      expect(t.store.endNoteEdit).not.toHaveBeenCalled();
      t.dirty.current = true;
      t.store.endNoteEdit.mockRejectedValueOnce(new Error("release failed"));
      await t.dom.run(() => t.current().commands.closeForeground());
      expect(t.store.endNoteEdit).toHaveBeenCalledExactlyOnceWith({ readId: "read", basisId: "basis" });
      expect(t.current().editRef.current).toBeNull();
      expect(t.dirty.current).toBe(false);
    } finally { await t.dispose(); }
  });

  it("retains legacy note writes and rejects a missing or tombstoned edit basis", async () => {
    const t = setup();
    try {
      await t.render();
      await t.dom.run(() => t.current().setShelfEntries([{ ...entry, notes: [note] }]));
      await t.dom.run(() => t.current().handleEditNote("n"));
      expect(t.store.beginNoteEdit).not.toHaveBeenCalled();
      expect(t.current().foreground.kind).toBe("none");
      ports.store.mockReturnValue({ setNotes: t.store.setNotes });
      await t.dom.run(() => t.current().handleEditNote("n"));
      expect(t.current().foreground.kind).toBe("modal");
      await t.dom.run(() => t.current().handleSaveNote(" legacy "));
      expect(t.store.setNotes.mock.calls[0][1][0]).toMatchObject({ content: "legacy", createdAtMs: 1 });
      await t.dom.run(() => t.current().handleDeleteNote("n"));
      expect(t.store.setNotes).toHaveBeenLastCalledWith("book", []);
      ports.store.mockReturnValue(t.store);
      await t.dom.run(() => t.current().setShelfEntries([{ ...entry, notes: [note], portableNoteAnnotations: { n: { deleted: { deviceId: "device", counter: 1 }, versions: [] } } } as ShelfEntry]));
      await t.dom.run(() => t.current().handleEditNote("n"));
      expect(t.store.beginNoteEdit).not.toHaveBeenCalled();
    } finally { await t.dispose(); }
  });

  it("restarts bookmark feedback during exit and keeps the sidebar toggle tied to its live open state", async () => {
    const t = setup();
    try {
      await t.render();
      const show = t.current().showBookmarkToast;
      await t.dom.run(() => show("added", "add"));
      await t.advance(1999);
      expect(t.current().bookmarkToast!.closing).toBe(false);
      await t.advance(1);
      expect(t.current().bookmarkToast!.closing).toBe(true);
      const first = t.current().bookmarkToast!.id;
      await t.dom.run(() => show("removed", "remove", { undo: true }));
      await t.advance(220);
      // A new message is a new toast; the old exit timer cannot close or drop it.
      expect(t.current().bookmarkToast).toMatchObject({ text: "removed", action: "remove", closing: false, undo: true });
      expect(t.current().bookmarkToast!.id).not.toBe(first);
      // A17: the undo toast shows as long as the others, then plays its exit before unmounting.
      await t.advance(1780);
      expect(t.current().bookmarkToast!.closing).toBe(true);
      await t.advance(219);
      expect(t.current().bookmarkToast).not.toBeNull();
      await t.advance(1);
      expect(t.current().bookmarkToast).toBeNull();
      await t.dom.run(() => t.current().toggleSidebar());
      expect(t.openBookmarks).toHaveBeenCalledTimes(1);
      t.sidebar(true); await t.render();
      await t.dom.run(() => t.current().toggleSidebar());
      expect(t.closeSidebar).toHaveBeenCalledTimes(1);
      expect(t.current().showBookmarkToast).toBe(show);
    } finally {
      try { await t.dom.dispose(); expect(vi.getTimerCount()).toBe(0); }
      finally { vi.useRealTimers(); }
    }
  });
});
