import { useCallback, useEffect, useMemo, useRef, useState,
  type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { spineItemPath } from "../core/book";
import type { Book } from "../core/types";
import { splitHref } from "../core/paths";
import type { Annotation } from "../core/portableState/portable-register-core";
import type { BookmarkValue, NoteValue } from "../core/portableState/portable-state-types";
import { latestVersion } from "../core/portableState/projection";
import type { ChapterState, MediaReadingAnchor, ReadingAnchor, ReaderNoteForPaginator } from "../render/paginator";
import { getShelfStore, type Bookmark, type NoteEditContext, type ShelfEntry } from "./shelf";
import type { ReaderNote } from "./notes";
import type { NoteViewModel } from "./sidebarModel";
import type { ReaderHandle } from "./ReaderView";
import type { SidebarTab } from "./SidebarDrawer";
import { generateFolderId } from "./libraryOrganization";
import { closeReaderForeground, type NoteComposerDraft, type ReaderForeground } from "./readerForeground";
import { uiText } from "./localization/UiLanguageProvider";
import { bookmarkButtonAction, RIBBON_LIFT_MS, screenBookmarkIds, type RibbonCue } from "./bookmarkRibbons";
import { prefersReducedMotion } from "./pagedSlide";

const EMPTY_NOTES: ReaderNote[] = [];
/** 删除提示（带撤销）停留时长；Ctrl+Z 也只在这段时间内有效。 */
const BOOKMARK_UNDO_MS = 5000;
const EMPTY_CHAPTER_NOTES: ReaderNoteForPaginator[] = [];

function portableNoteAnnotations(entry: ShelfEntry): Readonly<Record<string, Annotation<NoteValue>>> {
  return (entry as unknown as {
    readonly portableNoteAnnotations?: Readonly<Record<string, Annotation<NoteValue>>>;
  }).portableNoteAnnotations ?? {};
}

export function hasOwnField(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mergeNoteProjection(entry: ShelfEntry, written: ShelfEntry, fallback: ReaderNote[]): ShelfEntry {
  const source = written as unknown as {
    readonly portableNoteAnnotations?: Readonly<Record<string, Annotation<NoteValue>>>;
  };
  return {
    ...entry,
    notes: written.notes ?? fallback,
    ...(hasOwnField(source, "portableNoteAnnotations")
      ? { portableNoteAnnotations: source.portableNoteAnnotations ?? {} }
      : {}),
  } as ShelfEntry;
}

function mergeBookmarkProjection(entry: ShelfEntry, written: ShelfEntry, fallback: Bookmark[]): ShelfEntry {
  const source = written as unknown as {
    readonly portableBookmarkAnnotations?: Readonly<Record<string, Annotation<BookmarkValue>>>;
  };
  return {
    ...entry,
    bookmarks: written.bookmarks ?? fallback,
    ...(hasOwnField(source, "portableBookmarkAnnotations")
      ? { portableBookmarkAnnotations: source.portableBookmarkAnnotations ?? {} }
      : {}),
  } as ShelfEntry;
}

function sameMediaReadingAnchor(
  a: MediaReadingAnchor | null | undefined,
  b: MediaReadingAnchor | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.index === b.index &&
    a.tag === b.tag &&
    a.signature === b.signature &&
    Math.abs(a.ratio - b.ratio) <= 0.001
  );
}

function isExactBookmarkMatch(
  bookmark: Bookmark,
  anchor: Pick<ReadingAnchor, "textOffset" | "mediaAnchor"> | null,
): boolean {
  if (!anchor) return false;
  const savedText = bookmark.anchorTextOffset;
  const currentText = anchor.textOffset ?? null;
  if (savedText !== undefined && savedText !== null && currentText !== null) {
    return savedText === currentText;
  }
  return sameMediaReadingAnchor(bookmark.mediaAnchor, anchor.mediaAnchor ?? null);
}

function bookmarkMatchesPosition(
  bookmark: Bookmark,
  spineIndex: number,
  chapterState: ChapterState,
  anchor: Pick<ReadingAnchor, "textOffset" | "mediaAnchor"> | null,
  resolveBookmarkPage?: (bookmark: Bookmark) => number | null,
): boolean {
  if (bookmark.spineIndex !== spineIndex) return false;
  if (chapterState.status !== "ready" || chapterState.mode !== "scroll") {
    if (chapterState.status !== "ready") return false;
    const resolved = resolveBookmarkPage ? resolveBookmarkPage(bookmark) : bookmark.page;
    return resolved === chapterState.currentPage;
  }
  const savedText = bookmark.anchorTextOffset;
  const currentText = anchor?.textOffset ?? null;
  if (savedText !== undefined && savedText !== null && currentText !== null) {
    return savedText === currentText;
  }
  return sameMediaReadingAnchor(bookmark.mediaAnchor, anchor?.mediaAnchor ?? null);
}

/** 根据 spine 下标查目录章节标题（用于书签右下角展示）。 */
export function chapterLabelForIndex(b: Book, index: number): string {
  const path = spineItemPath(b, index);
  if (!path) return "";
  const normalized = b.archiveReferences ? path : splitHref(path).path;
  const walk = (nodes: import("../core/types").TocNode[]): string => {
    for (const n of nodes) {
      if ((b.archiveReferences ? b.archiveReferences.resolve(b.opfPath, n.href).path : splitHref(n.href).path) === normalized && n.label) return n.label;
      const c = walk(n.children);
      if (c) return c;
    }
    return "";
  };
  return walk(b.toc);
}

// Separate initialization/effect call sites retain App's existing ordering.
export function useNoteEditRef() {
  const activeNoteEditContextRef = useRef<NoteEditContext | null>(null);
  return activeNoteEditContextRef;
}

export function replaceNoteEditContext(draft: NoteComposerDraft, activeNoteEditContextRef: MutableRefObject<NoteEditContext | null>) {
  const previousContext = activeNoteEditContextRef.current;
  const nextContext = draft.mode === "edit" ? draft.editContext ?? null : null;
  activeNoteEditContextRef.current = nextContext;
  if (previousContext && previousContext !== nextContext) {
    void getShelfStore().endNoteEdit?.(previousContext).catch(() => undefined);
  }
}

export function useBookmarkToast() {
  const [bookmarkToast, setBookmarkToast] = useState<{
    text: string;
    action: "add" | "remove";
    closing: boolean;
    /** A15：删除后带“撤销”，停留更久。 */
    undo?: boolean;
  } | null>(null);
  const bookmarkToastTimerRef = useRef<number | null>(null);

  const showBookmarkToast = useCallback((text: string, action: "add" | "remove", options?: { undo?: boolean }) => {
    if (bookmarkToastTimerRef.current) {
      window.clearTimeout(bookmarkToastTimerRef.current);
      bookmarkToastTimerRef.current = null;
    }
    const undo = options?.undo === true;
    setBookmarkToast({ text, action, closing: false, ...(undo ? { undo } : {}) });
    bookmarkToastTimerRef.current = window.setTimeout(() => {
      setBookmarkToast((prev) => (prev ? { ...prev, closing: true } : null));
      bookmarkToastTimerRef.current = window.setTimeout(() => {
        setBookmarkToast(null);
        bookmarkToastTimerRef.current = null;
      }, 180);
    }, undo ? BOOKMARK_UNDO_MS : 1400);
  }, []);
  return { bookmarkToast, bookmarkToastTimerRef, showBookmarkToast };
}

export function useBookmarkToastCleanup(bookmarkToastTimerRef: MutableRefObject<number | null>) {
  useEffect(() => {
    return () => {
      if (bookmarkToastTimerRef.current) {
        window.clearTimeout(bookmarkToastTimerRef.current);
      }
    };
  }, []);
}

export function useNoteBusyState() {
  const [noteBusy, setNoteBusy] = useState(false);
  const noteBusyRef = useRef(false);
  return { noteBusy, setNoteBusy, noteBusyRef };
}

export function useNoteProjection(shelfEntries: ShelfEntry[], currentShelfId: string | null, book: Book | null, spineIndex: number) {
  const currentNotes: ReaderNote[] = currentShelfId
    ? (shelfEntries.find((entry) => entry.id === currentShelfId)?.notes ?? EMPTY_NOTES)
    : EMPTY_NOTES;
  const currentChapterPath = book ? spineItemPath(book, spineIndex) : undefined;
  const currentChapterNotes = useMemo(() => {
    if (!currentChapterPath || currentNotes.length === 0) return EMPTY_CHAPTER_NOTES;
    const filtered = currentNotes.filter(
      (note) => note.spineIndex === spineIndex && note.chapterPath === currentChapterPath
    );
    if (filtered.length === 0) return EMPTY_CHAPTER_NOTES;
    return filtered.map((note) => ({
      id: note.id,
      startTextOffset: note.startTextOffset,
      endTextOffset: note.endTextOffset,
      startTextSnippet: note.startTextSnippet,
      endTextSnippet: note.endTextSnippet,
      selectedText: note.selectedText,
    }));
  }, [currentNotes, spineIndex, currentChapterPath]);
  // A13：一页章并排时另一章也显示笔记；按章缓存，引用稳定，只在笔记变化时重建。
  const notesByChapter = useMemo(() => {
    const map = new Map<number, ReaderNoteForPaginator[]>();
    if (!book) return map;
    for (const note of currentNotes) {
      if (note.chapterPath !== spineItemPath(book, note.spineIndex)) continue;
      const list = map.get(note.spineIndex) ?? [];
      list.push({
        id: note.id,
        startTextOffset: note.startTextOffset,
        endTextOffset: note.endTextOffset,
        startTextSnippet: note.startTextSnippet,
        endTextSnippet: note.endTextSnippet,
        selectedText: note.selectedText,
      });
      map.set(note.spineIndex, list);
    }
    return map;
  }, [currentNotes, book]);
  const notesForChapter = useCallback(
    (index: number) => notesByChapter.get(index) ?? EMPTY_CHAPTER_NOTES,
    [notesByChapter],
  );
  const noteViewModels: NoteViewModel[] = book
    ? currentNotes.map((note) => ({
        id: note.id,
        content: note.content,
        selectedText: note.selectedText,
        chapterTitle: chapterLabelForIndex(book, note.spineIndex) || note.chapterPath.split("/").pop() || note.chapterPath,
        chapterPath: note.chapterPath,
        createdAtMs: note.createdAtMs,
        updatedAtMs: note.updatedAtMs,
      }))
    : [];

  return { currentNotes, currentChapterNotes, notesForChapter, noteViewModels };
}

type NoteBusyState = ReturnType<typeof useNoteBusyState>;
export function useNoteActions({ currentShelfId, currentNotes, noteBusyRef, setNoteBusy, noteBusy,
  setShelfEntries, setRuntimeIssues, noteComposer, book, setForeground, shelfEntriesRef, openComposer,
}: NoteBusyState & {
  currentShelfId: string | null;
  currentNotes: ReaderNote[];
  setShelfEntries: Dispatch<SetStateAction<ShelfEntry[]>>;
  setRuntimeIssues: Dispatch<SetStateAction<string[]>>;
  noteComposer: NoteComposerDraft | null;
  book: Book | null;
  setForeground: Dispatch<SetStateAction<ReaderForeground>>;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  openComposer(draft: NoteComposerDraft): void;
}) {
  const saveNoteChange = useCallback(async (
    next: ReaderNote[],
    commit: () => Promise<ShelfEntry>,
  ): Promise<boolean> => {
    if (!currentShelfId || noteBusyRef.current) return false;
    const previous = currentNotes;
    noteBusyRef.current = true;
    setNoteBusy(true);
    setShelfEntries((entries) => entries.map((entry) =>
      entry.id === currentShelfId ? { ...entry, notes: next } : entry
    ));
    try {
      const written = await commit();
      setShelfEntries((entries) => entries.map((entry) =>
        entry.id === currentShelfId ? mergeNoteProjection(entry, written, next) : entry
      ));
      return true;
    } catch (error) {
      setShelfEntries((entries) => entries.map((entry) =>
        entry.id === currentShelfId ? { ...entry, notes: previous } : entry
      ));
      setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.noteSaveFailed", { error: String(error) })]);
      return false;
    } finally {
      noteBusyRef.current = false;
      setNoteBusy(false);
    }
  }, [currentShelfId, currentNotes]);

  const handleSaveNote = useCallback(async (content: string): Promise<void> => {
    const draft = noteComposer;
    if (!draft || !book || !currentShelfId || noteBusy) return;
    const now = Date.now();
    let next: ReaderNote[];
    let commit: () => Promise<ShelfEntry>;
    if (draft.mode === "create") {
      const expectedPath = spineItemPath(book, draft.spineIndex);
      if (
        !expectedPath ||
        expectedPath !== draft.selection.chapterPath ||
        !draft.selection.startTextSnippet ||
        !draft.selection.endTextSnippet
      ) {
        setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.selectionGone")]);
        return;
      }
      const created: ReaderNote = {
        id: generateFolderId(),
        spineIndex: draft.spineIndex,
        chapterPath: expectedPath,
        startTextOffset: draft.selection.startTextOffset,
        endTextOffset: draft.selection.endTextOffset,
        startTextSnippet: draft.selection.startTextSnippet,
        endTextSnippet: draft.selection.endTextSnippet,
        selectedText: draft.selection.originalSelectedText ?? draft.selection.selectedText,
        content: content.trim(),
        createdAtMs: now,
        updatedAtMs: now,
      };
      next = [...currentNotes, created];
      commit = () => {
        const store = getShelfStore();
        return store.createNote
          ? store.createNote(currentShelfId, created)
          : store.setNotes(currentShelfId, next);
      };
    } else {
      const updated: ReaderNote = {
        ...draft.note,
        content: content.trim(),
        updatedAtMs: Math.max(now, draft.note.updatedAtMs + 1),
      };
      next = currentNotes.map((note) => note.id === updated.id ? updated : note);
      const store = getShelfStore();
      if (draft.editContext && store.writeNoteEdit) {
        const context = draft.editContext;
        commit = () => store.writeNoteEdit!(currentShelfId, updated, context);
      } else {
        commit = () => store.setNotes(currentShelfId, next);
      }
    }
    if (await saveNoteChange(next, commit)) setForeground(closeReaderForeground());
  }, [noteComposer, book, currentShelfId, noteBusy, currentNotes, saveNoteChange]);

  const handleDeleteNote = useCallback(async (noteId: string): Promise<void> => {
    if (noteBusy || !currentShelfId) return;
    const next = currentNotes.filter((note) => note.id !== noteId);
    const commit = () => {
      const store = getShelfStore();
      return store.deleteNote
        ? store.deleteNote(currentShelfId, noteId)
        : store.setNotes(currentShelfId, next);
    };
    await saveNoteChange(next, commit);
  }, [noteBusy, currentShelfId, currentNotes, saveNoteChange]);

  const handleEditNote = useCallback(async (noteId: string): Promise<void> => {
    const note = currentNotes.find((item) => item.id === noteId);
    if (!note || !currentShelfId) return;
    const store = getShelfStore();
    if (!store.beginNoteEdit) {
      openComposer({ mode: "edit", note });
      return;
    }
    const entry = shelfEntriesRef.current.find((item) => item.id === currentShelfId);
    const annotation = entry ? portableNoteAnnotations(entry)[noteId] : undefined;
    const displayedVersion = annotation && !annotation.deleted
      ? latestVersion(annotation.versions)
      : null;
    if (!displayedVersion) {
      setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.noteVersionMissing")]);
      return;
    }
    try {
      const context = await store.beginNoteEdit(currentShelfId, noteId, displayedVersion.stamp);
      openComposer({ mode: "edit", note, ...(context ? { editContext: context } : {}) });
    } catch (error) {
      setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.noteEditFailed", { error: String(error) })]);
    }
  }, [currentNotes, currentShelfId, openComposer]);

  return { handleSaveNote, handleDeleteNote, handleEditNote };
}

export function useBookmarkProjection({ currentShelfId, shelfEntries, chapterState, readerRef, spineIndex, book }: {
  currentShelfId: string | null;
  shelfEntries: ShelfEntry[];
  chapterState: ChapterState;
  readerRef: MutableRefObject<ReaderHandle | null>;
  spineIndex: number;
  book: Book | null;
}) {
  const currentBookmarks = currentShelfId
    ? (shelfEntries.find((entry) => entry.id === currentShelfId)?.bookmarks ?? [])
    : [];
  const currentBookmarkAnchor =
    chapterState.status === "ready" && chapterState.mode === "scroll"
      ? readerRef.current?.getReadingAnchor() ?? null
      : null;
  // A15：滚动模式下屏上能看到任何一条丝带就亮，不再要求恰好在那一行。
  const scrollScreen = chapterState.status === "ready" && chapterState.mode === "scroll"
    ? readerRef.current?.screenBookmarks?.(currentBookmarks) ?? null
    : null;
  const isCurrentPageBookmarked = scrollScreen
    ? screenBookmarkIds(scrollScreen).length > 0
    : chapterState.status === "ready" &&
    currentBookmarks.some((bookmark) =>
      bookmarkMatchesPosition(
        bookmark,
        spineIndex,
        chapterState,
        currentBookmarkAnchor,
        (bm) => readerRef.current?.resolveBookmarkPage?.(bm) ?? bm.page,
      )
    );
  // 书签按书中实际顺序排列，并补上章节标题供右下角展示
  const sortedBookmarks = book
    ? [...currentBookmarks]
        .sort(
          (a, b) =>
            a.spineIndex - b.spineIndex ||
            a.page - b.page ||
            (a.anchorTextOffset ?? a.anchorIndex ?? 0) - (b.anchorTextOffset ?? b.anchorIndex ?? 0)
        )
        .map((bookmark) => ({
          ...bookmark,
          chapterLabel: chapterLabelForIndex(book, bookmark.spineIndex),
        }))
    : [];

  return { currentBookmarks, isCurrentPageBookmarked, sortedBookmarks };
}

export function useBookmarkSidebarToggle({ isSidebarOpen, sidebarSide, activeSidebarTab, handleSidebarClose, handleOpenBookmarks }: {
  isSidebarOpen: boolean;
  sidebarSide: "left" | "right";
  activeSidebarTab: SidebarTab;
  handleSidebarClose(): void;
  handleOpenBookmarks(): void;
}) {
  // 标题栏书签列表入口：直接从右侧展开抽屉至书签 Tab
  const handleToggleBookmarks = useCallback((): void => {
    if (isSidebarOpen && sidebarSide === "right" && activeSidebarTab === "bookmarks") {
      handleSidebarClose();
      return;
    }
    handleOpenBookmarks();
  }, [isSidebarOpen, sidebarSide, activeSidebarTab, handleSidebarClose, handleOpenBookmarks]);

  return handleToggleBookmarks;
}

export function useBookmarkActions({ currentShelfId, readReaderPosition, currentBookmarks, spineIndex, book,
  readerRef, showBookmarkToast, setShelfEntries, setShelfError,
}: {
  currentShelfId: string | null;
  readReaderPosition(withText?: boolean): { state: ChapterState; readingAnchor: ReadingAnchor | null; anchorText: string | null };
  currentBookmarks: Bookmark[];
  spineIndex: number;
  book: Book | null;
  readerRef: MutableRefObject<ReaderHandle | null>;
  showBookmarkToast(text: string, action: "add" | "remove", options?: { undo?: boolean }): void;
  setShelfEntries: Dispatch<SetStateAction<ShelfEntry[]>>;
  setShelfError: Dispatch<SetStateAction<string | null>>;
}) {
  const handleToggleBookmark = useCallback(() => {
    if (!currentShelfId) return;
    // 页号、锚点与书签文字取同一次读数；原生滑动途中按视觉屏记录。
    const position = readReaderPosition(true);
    const chapterState = position.state;
    if (chapterState.status !== "ready") return;
    const anchor = position.readingAnchor;
    const previous = currentBookmarks;
    let next: Bookmark[];
    let added: Bookmark | null = null;
    let removedId: string | null = null;
    const makeBookmark = (): Bookmark => {
      const text = position.anchorText ?? "";
      return {
        id: generateFolderId(),
        spineIndex,
        page: chapterState.currentPage,
        anchorIndex: anchor && anchor.index >= 0 ? anchor.index : null,
        anchorRatio: anchor && anchor.index >= 0 ? anchor.ratio : null,
        anchorTextOffset: anchor?.textOffset ?? null,
        anchorTextSnippet: anchor?.textSnippet ?? null,
        mediaAnchor: anchor?.mediaAnchor ?? null,
        chapterPath: book ? spineItemPath(book, spineIndex) ?? null : null,
        text: text.slice(0, 80),
        createdAtMs: Date.now(),
      };
    };
    if (chapterState.mode === "scroll") {
      const existing = currentBookmarks.find((bookmark) =>
        bookmarkMatchesPosition(bookmark, spineIndex, chapterState, anchor)
      );
      if (existing) {
        removedId = existing.id;
        next = currentBookmarks.filter((bookmark) => bookmark.id !== existing.id);
      } else {
        added = makeBookmark();
        next = [...currentBookmarks, added];
      }
    } else {
      const resolvePage = (bm: Bookmark) =>
        readerRef.current?.resolveBookmarkPage?.(bm) ?? bm.page;
      const pageBookmarks = currentBookmarks.filter(
        (bm) => bm.spineIndex === spineIndex && resolvePage(bm) === chapterState.currentPage
      );
      if (pageBookmarks.length > 0) {
        const exactMatch = pageBookmarks.find((bm) => isExactBookmarkMatch(bm, anchor));
        const targetToDelete =
          exactMatch ??
          [...pageBookmarks].sort((a, b) => {
            const aPos = a.anchorTextOffset ?? a.anchorIndex ?? 0;
            const bPos = b.anchorTextOffset ?? b.anchorIndex ?? 0;
            if (aPos !== bPos) return aPos - bPos;
            return a.createdAtMs - b.createdAtMs;
          })[0];
        removedId = targetToDelete.id;
        next = currentBookmarks.filter((bm) => bm.id !== targetToDelete.id);
      } else {
        added = makeBookmark();
        next = [...currentBookmarks, added];
      }
    }
    const isAdded = added !== null;
    const addedBookmark = added;
    const removedBookmarkId = removedId;
    showBookmarkToast(isAdded ? uiText("notice.bookmark.added") : uiText("notice.bookmark.removed"), isAdded ? "add" : "remove");
    setShelfEntries((prev) =>
      prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: next } : entry))
    );
    const store = getShelfStore();
    const commit: Promise<ShelfEntry> = addedBookmark && store.createBookmark
      ? store.createBookmark(currentShelfId, addedBookmark)
      : removedBookmarkId && store.deleteBookmark
        ? store.deleteBookmark(currentShelfId, removedBookmarkId)
        : store.setBookmarks(currentShelfId, next);
    void commit
      .then((written) =>
        setShelfEntries((prev) =>
          // 后端返回的是写入时刻的完整记录；期间用户可能已经翻页，
          // 因此这里只确认书签字段及其可移植注解，不用旧快照覆盖进度。
          prev.map((entry) =>
            entry.id === currentShelfId ? mergeBookmarkProjection(entry, written, next) : entry
          )
        )
      )
      .catch((error) => {
        setShelfEntries((prev) =>
          prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: previous } : entry))
        );
        setShelfError(uiText("notice.bookmark.saveFailed", { error: String(error) }));
      });
  }, [currentShelfId, currentBookmarks, spineIndex, readReaderPosition, showBookmarkToast, book]);

  const handleDeleteBookmark = useCallback(
    (bookmarkId: string) => {
      if (!currentShelfId) return;
      const previous = currentBookmarks;
      const next = currentBookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
      showBookmarkToast(uiText("notice.bookmark.removed"), "remove");
      setShelfEntries((prev) =>
        prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: next } : entry))
      );
      const store = getShelfStore();
      const commit = store.deleteBookmark
        ? store.deleteBookmark(currentShelfId, bookmarkId)
        : store.setBookmarks(currentShelfId, next);
      void commit
        .then((written) =>
          setShelfEntries((prev) =>
            prev.map((entry) =>
              entry.id === currentShelfId ? mergeBookmarkProjection(entry, written, next) : entry
            )
          )
        )
        .catch((error) => {
          setShelfEntries((prev) =>
            prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: previous } : entry))
          );
          setShelfError(uiText("notice.bookmark.deleteFailed", { error: String(error) }));
        });
    },
    [currentShelfId, currentBookmarks, showBookmarkToast]
  );

  return { handleToggleBookmark, handleDeleteBookmark };
}

export function useNoteEditRelease({ noteComposer, noteComposerDirtyRef, activeNoteEditContextRef }: {
  noteComposer: NoteComposerDraft | null;
  noteComposerDirtyRef: MutableRefObject<boolean>;
  activeNoteEditContextRef: MutableRefObject<NoteEditContext | null>;
}) {
  useEffect(() => {
    if (noteComposer) return;
    noteComposerDirtyRef.current = false;
    const context = activeNoteEditContextRef.current;
    activeNoteEditContextRef.current = null;
    if (context) {
      void getShelfStore().endNoteEdit?.(context).catch(() => {
        /* Closing the editor must not block on a release error. */
      });
    }
  }, [noteComposer]);
}

/**
 * A15 书签丝带的放和取（只点击）：双页总是弹出缩略书页，本屏没有书签时先放在第一页；
 * 单页、滚动没有就加、有就删本屏全部。删除先播收回动画，可撤销（按钮或 Ctrl+Z）。
 * 书签数据格式不变；撤销用新 id 重新创建，不复活已删除的注解。
 */
export function useBookmarkRibbonActions({ currentShelfId, readReaderPosition, currentBookmarks, spineIndex, book,
  readerRef, showBookmarkToast, setShelfEntries, setShelfError, legacyToggle,
}: {
  currentShelfId: string | null;
  readReaderPosition(withText?: boolean): { state: ChapterState; readingAnchor: ReadingAnchor | null; anchorText: string | null };
  currentBookmarks: Bookmark[];
  spineIndex: number;
  book: Book | null;
  readerRef: MutableRefObject<ReaderHandle | null>;
  showBookmarkToast(text: string, action: "add" | "remove", options?: { undo?: boolean }): void;
  setShelfEntries: Dispatch<SetStateAction<ShelfEntry[]>>;
  setShelfError: Dispatch<SetStateAction<string | null>>;
  /** 固定版式等没有丝带的视图沿用原来的切换。 */
  legacyToggle(): void;
}) {
  const [bookmarkCue, setBookmarkCue] = useState<(RibbonCue & { at: number }) | null>(null);
  const [bookmarkPagesOpen, setBookmarkPagesOpen] = useState(false);
  const cueNonceRef = useRef(0);
  const bookmarksRef = useRef(currentBookmarks);
  bookmarksRef.current = currentBookmarks;
  const undoRef = useRef<{ shelfId: string; bookmarks: Bookmark[]; at: number } | null>(null);
  const pendingWritesRef = useRef(0);
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const cue = useCallback((kind: RibbonCue["kind"], ids: readonly string[]) => {
    setBookmarkCue({ kind, ids, nonce: ++cueNonceRef.current, at: Date.now() });
  }, []);

  /** 乐观更新后依次写入；只有最后一次写入回来时才用存储的投影覆盖，避免中途闪回。 */
  const write = useCallback((
    shelfId: string,
    apply: (bookmarks: Bookmark[]) => Bookmark[],
    revert: (bookmarks: Bookmark[]) => Bookmark[],
    commit: () => Promise<ShelfEntry>,
    failure: "notice.bookmark.saveFailed" | "notice.bookmark.deleteFailed",
  ) => {
    setShelfEntries((prev) => prev.map((entry) =>
      entry.id === shelfId ? { ...entry, bookmarks: apply(entry.bookmarks ?? []) } : entry));
    pendingWritesRef.current += 1;
    const run = writeChainRef.current.then(commit);
    writeChainRef.current = run.catch(() => undefined);
    void run
      .then((written) => {
        if (pendingWritesRef.current > 1) return;
        setShelfEntries((prev) => prev.map((entry) =>
          entry.id === shelfId ? mergeBookmarkProjection(entry, written, entry.bookmarks ?? []) : entry));
      })
      .catch((error) => {
        setShelfEntries((prev) => prev.map((entry) =>
          entry.id === shelfId ? { ...entry, bookmarks: revert(entry.bookmarks ?? []) } : entry));
        setShelfError(uiText(failure, { error: String(error) }));
      })
      .finally(() => {
        pendingWritesRef.current -= 1;
      });
  }, []);

  const createAll = useCallback((shelfId: string, created: Bookmark[]) => {
    const ids = new Set(created.map((bookmark) => bookmark.id));
    const store = getShelfStore();
    write(
      shelfId,
      (bookmarks) => [...bookmarks, ...created],
      (bookmarks) => bookmarks.filter((bookmark) => !ids.has(bookmark.id)),
      async () => {
        let written: ShelfEntry | null = null;
        for (const bookmark of created) {
          written = store.createBookmark
            ? await store.createBookmark(shelfId, bookmark)
            : await store.setBookmarks(shelfId, [...bookmarksRef.current.filter((item) => !ids.has(item.id)), ...created]);
          if (!store.createBookmark) break;
        }
        return written!;
      },
      "notice.bookmark.saveFailed",
    );
  }, [write]);

  const makeBookmark = (
    at: { spineIndex: number; page: number; anchor: ReadingAnchor | null; text: string | null },
  ): Bookmark => ({
    id: generateFolderId(),
    spineIndex: at.spineIndex,
    page: at.page,
    anchorIndex: at.anchor && at.anchor.index >= 0 ? at.anchor.index : null,
    anchorRatio: at.anchor && at.anchor.index >= 0 ? at.anchor.ratio : null,
    anchorTextOffset: at.anchor?.textOffset ?? null,
    anchorTextSnippet: at.anchor?.textSnippet ?? null,
    mediaAnchor: at.anchor?.mediaAnchor ?? null,
    chapterPath: book ? spineItemPath(book, at.spineIndex) ?? null : null,
    text: (at.text ?? "").slice(0, 80),
    createdAtMs: Date.now(),
  });

  /**
   * lane 给了（分页）：放在这一屏第 lane 页的第一行，书签记“这一页从哪里开始”；
   * 取不到时退回阅读位置。lane 不给（滚动）：阅读线那一行（与原来相同的一次读数）。
   */
  const addBookmark = useCallback((lane?: 0 | 1): boolean => {
    if (!currentShelfId) return false;
    let bookmark: Bookmark;
    const captured = lane !== undefined ? readerRef.current?.captureBookmarkAnchor?.(lane) : null;
    if (captured) {
      bookmark = makeBookmark({ spineIndex: captured.spineIndex, page: captured.page, anchor: captured.anchor, text: captured.text });
    } else if (lane === 1) {
      return false;
    } else {
      const position = readReaderPosition(true);
      if (position.state.status !== "ready") return false;
      bookmark = makeBookmark({
        spineIndex, page: position.state.currentPage, anchor: position.readingAnchor, text: position.anchorText,
      });
    }
    undoRef.current = null;
    createAll(currentShelfId, [bookmark]);
    cue("drop", [bookmark.id]);
    showBookmarkToast(uiText("notice.bookmark.added"), "add");
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentShelfId, spineIndex, book, readReaderPosition, createAll, cue, showBookmarkToast]);

  /** 一次删掉这些书签（一页的全部或本屏全部）；丝带先收回，删除可撤销。 */
  const removeBookmarks = useCallback((ids: readonly string[], options: { animate?: boolean } = {}) => {
    const shelfId = currentShelfId;
    if (!shelfId) return;
    const removed = bookmarksRef.current.filter((bookmark) => ids.includes(bookmark.id));
    if (removed.length === 0) return;
    const finish = () => {
      const gone = new Set(removed.map((bookmark) => bookmark.id));
      const store = getShelfStore();
      write(
        shelfId,
        (bookmarks) => bookmarks.filter((bookmark) => !gone.has(bookmark.id)),
        (bookmarks) => [...bookmarks, ...removed.filter((bookmark) => !bookmarks.some((item) => item.id === bookmark.id))],
        async () => {
          if (!store.deleteBookmark) {
            return store.setBookmarks(shelfId, bookmarksRef.current.filter((bookmark) => !gone.has(bookmark.id)));
          }
          let written: ShelfEntry | null = null;
          for (const bookmark of removed) written = await store.deleteBookmark(shelfId, bookmark.id);
          return written!;
        },
        "notice.bookmark.deleteFailed",
      );
      undoRef.current = { shelfId, bookmarks: removed, at: Date.now() };
      showBookmarkToast(
        removed.length > 1
          ? uiText("notice.bookmark.removedMany", { count: removed.length })
          : uiText("notice.bookmark.removed"),
        "remove",
        { undo: true },
      );
    };
    if (options.animate && !prefersReducedMotion()) {
      cue("lift", removed.map((bookmark) => bookmark.id));
      window.setTimeout(finish, RIBBON_LIFT_MS);
    } else {
      finish();
    }
  }, [currentShelfId, write, cue, showBookmarkToast]);

  /** 撤销最近一次删除；超时、换书或之后又加过书签则不再生效。 */
  const undoBookmarkRemoval = useCallback((): boolean => {
    const undo = undoRef.current;
    if (!undo || undo.shelfId !== currentShelfId || Date.now() - undo.at > BOOKMARK_UNDO_MS) return false;
    undoRef.current = null;
    const restored = undo.bookmarks.map((bookmark) => ({ ...bookmark, id: generateFolderId() }));
    createAll(undo.shelfId, restored);
    cue("drop", restored.map((bookmark) => bookmark.id));
    showBookmarkToast(uiText("notice.bookmark.restored"), "add");
    return true;
  }, [currentShelfId, createAll, cue, showBookmarkToast]);

  /** 书签按钮、Ctrl+B 和手机右上角点击区共用。 */
  const handleBookmarkButton = useCallback(() => {
    if (!currentShelfId) return;
    const screen = readerRef.current?.screenBookmarks?.(bookmarksRef.current) ?? null;
    if (!screen) {
      legacyToggle();
      return;
    }
    const action = bookmarkButtonAction(screen);
    if (action.kind === "pages") {
      if (bookmarkPagesOpen) {
        setBookmarkPagesOpen(false);
        return;
      }
      if (action.addFirst) addBookmark(0);
      setBookmarkPagesOpen(true);
      return;
    }
    if (action.kind === "add") addBookmark(screen.kind === "paged" ? 0 : undefined);
    else removeBookmarks(action.ids, { animate: true });
  }, [currentShelfId, bookmarkPagesOpen, legacyToggle, addBookmark, removeBookmarks]);

  const closeBookmarkPages = useCallback(() => setBookmarkPagesOpen(false), []);
  const hintBookmarks = useCallback((ids: readonly string[]) => cue("hint", ids), [cue]);

  // 换书后撤销不跨书。
  useEffect(() => {
    undoRef.current = null;
    setBookmarkPagesOpen(false);
  }, [currentShelfId]);

  return {
    bookmarkCue,
    cueBookmarks: cue,
    bookmarkPagesOpen,
    closeBookmarkPages,
    hintBookmarks,
    handleBookmarkButton,
    addBookmark,
    removeBookmarks,
    undoBookmarkRemoval,
  };
}
