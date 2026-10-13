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

const EMPTY_NOTES: ReaderNote[] = [];
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
  } | null>(null);
  const bookmarkToastTimerRef = useRef<number | null>(null);

  const showBookmarkToast = useCallback((text: string, action: "add" | "remove") => {
    if (bookmarkToastTimerRef.current) {
      window.clearTimeout(bookmarkToastTimerRef.current);
      bookmarkToastTimerRef.current = null;
    }
    setBookmarkToast({ text, action, closing: false });
    bookmarkToastTimerRef.current = window.setTimeout(() => {
      setBookmarkToast((prev) => (prev ? { ...prev, closing: true } : null));
      bookmarkToastTimerRef.current = window.setTimeout(() => {
        setBookmarkToast(null);
        bookmarkToastTimerRef.current = null;
      }, 180);
    }, 1400);
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

  return { currentNotes, currentChapterNotes, noteViewModels };
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
  const isCurrentPageBookmarked =
    chapterState.status === "ready" &&
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
  showBookmarkToast(text: string, action: "add" | "remove"): void;
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
