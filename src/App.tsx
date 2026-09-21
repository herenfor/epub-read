import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { loadBook, spineIndexForPath, spineItemPath, DrmError, disposeBook } from "./core/book";
import type { Book } from "./core/types";
import { isFragmentOnly, splitHref } from "./core/paths";
import {
  createSearchSession,
  type SearchResult,
  type SearchSession,
} from "./core/search";
import type { ExactTextHit } from "./core/exactTextHits";
import { ResourceServer } from "./render/resources";
import { sanitizePersistedTextAnchor } from "./render/textAnchor";
import { clearDocumentSelection, isSelectAllShortcut } from "./render/selectionGuard";
import {
  DEFAULT_SETTINGS,
  type ReaderSettings,
  type Theme,
} from "./render/settings";
import type { ChapterState, PreciseNavigationStatus } from "./render/paginator";
import { normalizePageOptions } from "./render/pageLayout";
import type { ImageViewRequest } from "./render/imageActivation";
import { ImageViewer } from "./ui/ImageViewer";
import { TitleBar } from "./ui/TitleBar";
import { Toolbar } from "./ui/Toolbar";
import { MenuPanel } from "./ui/MenuPanel";
import { FontSettingsPanel } from "./ui/FontSettingsPanel";
import { SearchPanel, type SearchPanelResult, type SearchScope, type SearchStatus } from "./ui/SearchPanel";
import { presentCrossBookHit, type CrossBookPanelResult } from "./ui/crossBookSearch";
import type { ResolvedCrossBookSearchHit } from "./features/ai/indexing/indexStore";
import { createDefaultLibrarySearchRuntime } from "./features/ai/indexing/librarySearchRuntime";
import {
  detectedLogicalCores,
  loadCorpusConcurrencyPreference,
  normalizeCorpusConcurrencyPreference,
  resolveCorpusConcurrency,
  saveCorpusConcurrencyPreference,
} from "./features/ai/indexing/corpusConcurrencyPreference";
import { ReaderContextMenu } from "./ui/ReaderContextMenu";
import { NoteComposer } from "./ui/NoteComposer";
import { NotesPanel, type NoteViewModel } from "./ui/NotesPanel";
import type { ReaderNote } from "./ui/notes";
import { createLazyFontController } from "./ui/fontRuntime";
import { FootnotePop } from "./ui/FootnotePop";
import { TocPanel } from "./ui/TocPanel";
import { LogPanel, type LogItem } from "./ui/LogPanel";
import { ReaderView, type ReaderHandle } from "./ui/ReaderView";
import type { ReaderNoteForPaginator } from "./render/paginator";
import { ShelfView } from "./ui/ShelfView";
import {
  applyShelfProgressPatch,
  getShelfStore,
  deleteShelfBooks,
  markShelfEntryOpened,
  readingAnchorFromShelfEntry,
  shelfThumbnailProvider,
  type Bookmark,
  type ShelfEntry,
  type ShelfProgressPatch,
} from "./ui/shelf";
import {
  formatImportNotice,
  findDuplicateEntry,
  mergeShelfEntries,
  sha256Hex,
} from "./ui/importBooks";
import { ShelfProgressWriter } from "./ui/progressWriter";
import { currentChapterCharsRead } from "./ui/readingProgress";
import {
  applyChapterCount,
  applyChapterCountError,
  computeProgressPct,
  createChapterCountCollection,
  measuredChapterWeight,
  resolveProgressPct,
  summarizeLinearCounts,
  type ChapterCountCollection,
} from "./ui/chapterCounts";
import { createChapterCountJob } from "./ui/chapterCountJob";
import { readCachedChapterCounts, writeChapterCountCache } from "./ui/chapterCountCache";
import {
  archiveRecordsForBackend,
  buildLibraryArchiveWithIssues,
} from "./ui/libraryArchiveBridge";
import {
  exportLibraryArchive,
  mergeLibraryArchives,
  parseLibraryArchive,
} from "./ui/libraryArchive";
import {
  emptyReaderNavigationHistory,
  readerHistoryBack,
  readerHistoryForward,
  recordReaderNavigation,
  type ReaderNavigationHistory,
  type ReaderNavigationPosition,
} from "./ui/readerNavigationHistory";
import {
  commitDirectHistory,
  commitHistoryTransition,
  sameChapterRoute,
} from "./ui/sameChapterNavigation";
import {
  fontFamilyFromFileName,
  fontIdFromHash,
  getFontStore,
  listSystemFonts,
  type SystemFont,
  type UserFont,
} from "./ui/fontStore";
import {
  readProgress,
  writeProgress,
  readSavedSettings,
  writeSavedSettings,
  type SavedProgress,
} from "./ui/storage";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isPhysicalPointInsideRect, isSupportedFontFileName, partitionFontItems, runFontImportBatch } from "./ui/fontDrop";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, stat as statFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stepSettingValue } from "./ui/settingsStepper";
import {
  closeReaderForeground,
  openNoteComposer,
  openReaderPanel,
  openReaderTransient,
  setMenuSubview,
  type ReaderForeground,
  type ReaderPanelId,
  type NoteComposerDraft,
} from "./ui/readerForeground";
import { createEditionAiRuntime } from "./features/ai/lifecycle/editionRuntime";
import { APP_EDITION, IS_AI_EDITION } from "./config/edition";
import { shouldShowAiFoundationEntry } from "./ui/aiEntry";

// This is intentionally a compile-time edition branch. The core build has no
// static dependency on the AI panel or its model-asset subtree; AI builds keep
// the existing development-only panel as a lazy chunk.
const LazyAiFoundationPanel = IS_AI_EDITION
  ? lazy(() => import("./features/ai/ui/AiFoundationPanel").then(({ AiFoundationPanel }) => ({ default: AiFoundationPanel })))
  : null;

const EMPTY_NOTES: ReaderNote[] = [];
const EMPTY_CHAPTER_NOTES: ReaderNoteForPaginator[] = [];

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type AppPhase =
  | { phase: "idle" }
  | { phase: "loading"; fileName: string }
  | { phase: "error"; message: string }
  | { phase: "ready" };

type ReaderHistoryPosition = ReaderNavigationPosition;

type PersistedReaderAnchor = {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
};

function toPersistedReaderAnchor(value: {
  index?: number | null;
  ratio?: number | null;
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
} | null | undefined): PersistedReaderAnchor | null {
  if (!value) return null;
  const text = sanitizePersistedTextAnchor({
    textOffset: value.anchorTextOffset,
    textSnippet: value.anchorTextSnippet,
  });
  const legacy =
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.ratio === "number" &&
    Number.isFinite(value.ratio) &&
    value.ratio >= 0 &&
    value.ratio <= 1;
  if (!legacy && text.textOffset === null) return null;
  return {
    index: legacy ? value.index! : -1,
    ratio: legacy ? value.ratio! : 0,
    anchorTextOffset: text.textOffset,
    anchorTextSnippet: text.textSnippet,
  };
}

type ImportSource =
  | { kind: "file"; file: File }
  | { kind: "path"; path: string; name: string };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 页面四边距按值比较；用于避免同值对象触发章节重载。 */
function samePageMarginsPx(a: ReaderSettings["pageMarginsPx"], b: ReaderSettings["pageMarginsPx"]): boolean {
  if (a === b) return true;
  const sides = ["top", "bottom", "left", "right"] as const;
  return sides.every((side) => (a?.[side] ?? null) === (b?.[side] ?? null));
}

function firstLinear(b: Book): number {
  const i = b.spine.findIndex((s) => s.linear);
  return i >= 0 ? i : 0;
}

function bookKeyOf(b: Book, name: string, size: number): string {
  const id = b.metadata.identifier || `${name}:${size}`;
  return `${id}::${b.metadata.modified ?? ""}`;
}

/** 根据 spine 下标查目录章节标题（用于书签右下角展示）。 */
function chapterLabelForIndex(b: Book, index: number): string {
  const path = spineItemPath(b, index);
  if (!path) return "";
  const { path: normalized } = splitHref(path);
  const walk = (nodes: import("./core/types").TocNode[]): string => {
    for (const n of nodes) {
      if (splitHref(n.href).path === normalized && n.label) return n.label;
      const c = walk(n.children);
      if (c) return c;
    }
    return "";
  };
  return walk(b.toc);
}

/**
 * 模块级阅读器闭包工厂：严禁在 App 组件体内内联创建带词法作用域的闭包，
 * 避免 long-lived 的 LibrarySearchRuntime.books 隐式持有 App 内部的 Book / ResourceServer。
 */
function createShelfBookReader(id: string): () => Promise<Uint8Array> {
  return () => getShelfStore().readBook(id);
}

export default function App() {
  const [phase, setPhase] = useState<AppPhase>({ phase: "idle" });
  const [book, setBook] = useState<Book | null>(null);
  const [server, setServer] = useState<ResourceServer | null>(null);
  const [bookKey, setBookKey] = useState("");
  const [spineIndex, setSpineIndex] = useState(0);
  const [anchor, setAnchor] = useState<string | undefined>(undefined);
  const [anchorNonce, setAnchorNonce] = useState(0);
  const [startAtEnd, setStartAtEnd] = useState({ nonce: 0, atEnd: false });
  const [foreground, setForeground] = useState<ReaderForeground>({ kind: "none" });
  // The runtime is inert until the development panel explicitly enables it.
  const aiRuntimeRef = useRef<ReturnType<typeof createEditionAiRuntime> | null>(null);
  if (!aiRuntimeRef.current) aiRuntimeRef.current = createEditionAiRuntime();
  const aiRuntime = aiRuntimeRef.current;
  const aiRuntimeSnapshot = useSyncExternalStore(
    aiRuntime.subscribe,
    aiRuntime.getSnapshot,
    aiRuntime.getSnapshot,
  );
  const [chapterState, setChapterState] = useState<ChapterState>({ status: "loading" });
  const [readerDisplayReady, setReaderDisplayReady] = useState(false);
  const [settings, setSettings] = useState<ReaderSettings>(() => {
    const saved = readSavedSettings();
    return {
      ...DEFAULT_SETTINGS,
      fontSizePx: saved.fontSizePx ?? DEFAULT_SETTINGS.fontSizePx,
      theme: saved.theme ?? DEFAULT_SETTINGS.theme,
      lineHeight: saved.lineHeight,
      fontWeight: saved.fontWeight,
      letterSpacingPx: saved.letterSpacingPx,
      wordSpacingPx: saved.wordSpacingPx,
      customFontName: saved.customFontName,
      fontSource: saved.fontSource === "system" || saved.fontSource === "imported" ? saved.fontSource : undefined,
      customFontId: saved.customFontId,
      customCss: saved.customCss,
      forceHorizontal: saved.forceHorizontal === true,
      preloadNextChapter: saved.preloadNextChapter === true,
      // 页面选项只在读取边界规范化一次；后续布局函数不再重复校验。
      ...normalizePageOptions({
        readingMode: saved.readingMode,
        pageMarginsPx: saved.pageMarginsPx,
        columnsPerView: saved.columnsPerView,
        gapPx: saved.gapPx,
      }),
    };
  });
  // UI 界面缩放（独立于正文字号）
  const [uiScale, setUiScale] = useState<number>(() => {
    const saved = readSavedSettings();
    return saved.uiScale !== undefined &&
      saved.uiScale >= 0.75 &&
      saved.uiScale <= 1.5
      ? saved.uiScale
      : 1;
  });
  const [runtimeIssues, setRuntimeIssues] = useState<string[]>([]);
  const [diagText, setDiagText] = useState<string | null>(null);
  const [initialAnchor, setInitialAnchor] = useState<PersistedReaderAnchor | null>(null);
  const [initialPage, setInitialPage] = useState<number | null>(0);
  /** 正文图片浮层请求；null = 未打开。 */
  const [imageRequest, setImageRequest] = useState<ImageViewRequest | null>(null);
  const imageRequestRef = useRef<ImageViewRequest | null>(null);
  const [preciseTarget, setPreciseTarget] = useState<{
    requestId: number;
    kind: "search" | "note";
    chapterPath: string;
    textHits?: ExactTextHit[];
  } | null>(null);
  const [readerNotice, setReaderNotice] = useState<{
    kind: "ok" | "warn" | "error";
    text: string;
  } | null>(null);
  const [readerNoticeFading, setReaderNoticeFading] = useState(false);
  const preciseRequestRef = useRef(0);
  const latestPreciseRequestRef = useRef<number | null>(null);
  /** 异步章节字数统计：ref 是权威，state 只是 UI/派生快照。 */
  const [chapterCountsState, setChapterCountsState] = useState<ChapterCountCollection>(() =>
    createChapterCountCollection(0, [])
  );
  const chapterCountsRef = useRef(chapterCountsState);
  const sessionGenerationRef = useRef(0);
  const activeSessionRef = useRef<{
    generation: number;
    book: Book;
    server: ResourceServer;
    bookKey: string;
    countCacheKey: string | null;
  } | null>(null);
  const baselineProgressPctRef = useRef(0);
  const chapterCountJobRef = useRef<{ cancel(): void } | null>(null);
  const lastCountProgressSignatureRef = useRef<string | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [dragActive, setDragActive] = useState(false);
  const [fontNativeDragActive, setFontNativeDragActive] = useState(false);
  // ---- 书架 ----
  const [view, setView] = useState<"shelf" | "reader">("shelf");
  const [shelfEntries, setShelfEntries] = useState<ShelfEntry[]>([]);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const [shelfNotice, setShelfNotice] = useState<{
    kind: "ok" | "warn" | "error";
    text: string;
  } | null>(null);
  const [shelfNoticeFading, setShelfNoticeFading] = useState(false);
  const [shelfBusy, setShelfBusy] = useState(false);
  const [currentShelfId, setCurrentShelfId] = useState<string | null>(null);
  const shelfBusyRef = useRef(false);
  const shelfEntriesRef = useRef<ShelfEntry[]>([]);
  shelfEntriesRef.current = shelfEntries;
  // ---- 阅读跳转历史（后退/前进各最多 3 步） ----
  const [readerHistory, setReaderHistory] = useState<ReaderNavigationHistory>(
    emptyReaderNavigationHistory
  );
  // ---- 用户自定义字体 ----
  const [userFonts, setUserFonts] = useState<UserFont[]>([]);
  const [fontUrls, setFontUrls] = useState<Record<string, string>>({});
  const [fontBusy, setFontBusy] = useState(false);
  const [systemFonts, setSystemFonts] = useState<SystemFont[]>([]);
  const [userFontsLoaded, setUserFontsLoaded] = useState(false);
  const [systemFontsStatus, setSystemFontsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null);
  // ---- 当前书正文搜索（索引仅在本次打开书籍期间存在） ----
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchProgress, setSearchProgress] = useState({ processed: 0, total: 0 });
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [searchNavigationBusy, setSearchNavigationBusy] = useState(false);
  const [searchScope, setSearchScope] = useState<SearchScope>("current");
  const [shelfSearchMode, setShelfSearchMode] = useState<"metadata" | "body">("metadata");
  const readerPriorityBusyRef = useRef(false);
  readerPriorityBusyRef.current = view === "reader"
    && (!readerDisplayReady || chapterState.status === "loading" || searchNavigationBusy);
  const librarySearchRuntimeRef = useRef<ReturnType<typeof createDefaultLibrarySearchRuntime> | null>(null);
  if (!librarySearchRuntimeRef.current) {
    librarySearchRuntimeRef.current = createDefaultLibrarySearchRuntime(isTauriEnv(), {
      waitUntilRunnable: async (signal) => {
        while (readerPriorityBusyRef.current && !signal.aborted) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
        }
      },
    });
  }
  const librarySearchRuntime = librarySearchRuntimeRef.current;
  const librarySearchSnapshot = useSyncExternalStore(
    librarySearchRuntime.subscribe,
    librarySearchRuntime.getSnapshot,
    librarySearchRuntime.getSnapshot,
  );
  const logicalCores = useMemo(() => detectedLogicalCores(), []);
  const [corpusConcurrencyPreference, setCorpusConcurrencyPreference] = useState(
    () => loadCorpusConcurrencyPreference(undefined, logicalCores),
  );
  const recommendedCorpusConcurrency = useMemo(
    () => resolveCorpusConcurrency({ mode: "automatic", maxConcurrency: 1 }, logicalCores),
    [logicalCores],
  );
  const effectiveCorpusConcurrency = useMemo(
    () => resolveCorpusConcurrency(corpusConcurrencyPreference, logicalCores),
    [corpusConcurrencyPreference, logicalCores],
  );
  useEffect(() => {
    librarySearchRuntime.setConcurrency(effectiveCorpusConcurrency);
    saveCorpusConcurrencyPreference(corpusConcurrencyPreference);
  }, [corpusConcurrencyPreference, effectiveCorpusConcurrency, librarySearchRuntime]);
  const searchSessionRef = useRef<SearchSession | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchGenerationRef = useRef(0);
  // ---- 正文笔记 ----
  const [noteBusy, setNoteBusy] = useState(false);
  const noteBusyRef = useRef(false);
  const fontRuntimeRef = useRef<ReturnType<typeof createLazyFontController> | null>(null);
  if (!fontRuntimeRef.current) {
    fontRuntimeRef.current = createLazyFontController((id) => getFontStore().readFont(id));
  }
  const contentHashByIdRef = useRef(new Map<string, string>());
  const entryByContentHashRef = useRef(new Map<string, ShelfEntry>());
  const currentShelfIds = new Set(shelfEntries.map((entry) => entry.id));
  for (const [id, hash] of contentHashByIdRef.current) {
    if (!currentShelfIds.has(id)) {
      contentHashByIdRef.current.delete(id);
      entryByContentHashRef.current.delete(hash);
    }
  }
  for (const entry of shelfEntries) {
    if (!entry.contentHash) continue;
    contentHashByIdRef.current.set(entry.id, entry.contentHash);
    entryByContentHashRef.current.set(entry.contentHash, entry);
  }
  const libraryIndexSignature = shelfEntries
    .map((entry) => `${entry.id}:${entry.contentHash ?? ""}:${entry.available === false ? 0 : 1}`)
    .join("|");
  const progressWriterRef = useRef<ShelfProgressWriter | null>(null);
  if (!progressWriterRef.current) {
    progressWriterRef.current = new ShelfProgressWriter(async (id, patch) => {
      await getShelfStore().updateProgress(id, patch);
    });
  }
  /** 指针是否悬停在交互式浮层（脚注弹窗等）上：此时不响应翻页键/后续可扩展书签等 */
  const overlayHoverRef = useRef(false);
  const foregroundRef = useRef<ReaderForeground>({ kind: "none" });
  foregroundRef.current = foreground;

  // All reader-facing surfaces share one discriminated state. These values
  // are deliberately derived, never independently writable booleans.
  const menuOpen = foreground.kind === "panel" && foreground.panel === "menu";
  const fontSettingsOpen = foreground.kind === "panel" && foreground.panel === "menu" && foreground.view === "fonts";
  const tocOpen = foreground.kind === "panel" && foreground.panel === "toc";
  const bookmarkMenuOpen = foreground.kind === "panel" && foreground.panel === "bookmarks";
  const searchOpen = foreground.kind === "panel" && foreground.panel === "search";
  const notesOpen = foreground.kind === "panel" && foreground.panel === "notes";
  const logOpen = foreground.kind === "panel" && foreground.panel === "log";
  const assistantOpen = foreground.kind === "panel" && foreground.panel === "assistant";
  const selectionContext = foreground.kind === "transient" && foreground.transient === "selection"
    ? foreground.payload
    : null;
  const footnote = foreground.kind === "transient" && foreground.transient === "footnote"
    ? foreground.payload
    : null;
  const noteComposer = foreground.kind === "modal" && foreground.modal === "note-composer"
    ? foreground.draft
    : null;

  const openPanel = useCallback((panel: ReaderPanelId): void => {
    const current = foregroundRef.current;
    if (current.kind === "transient" && current.transient === "footnote") {
      overlayHoverRef.current = false;
      readerRef.current?.dismissFootnote();
    } else if (current.kind === "transient" && current.transient === "selection") {
      readerRef.current?.clearTextSelection();
    }
    setForeground((current) => openReaderPanel(current, panel));
  }, []);
  const openTransient = useCallback(
    (transient: "selection" | "footnote", payload: Parameters<typeof openReaderTransient>[2]): void => {
      const current = foregroundRef.current;
      if (current.kind === "transient" && current.transient === "footnote" && transient === "selection") {
        overlayHoverRef.current = false;
        readerRef.current?.dismissFootnote();
      } else if (current.kind === "transient" && current.transient === "selection" && transient === "footnote") {
        readerRef.current?.clearTextSelection();
      }
      setForeground((state) => openReaderTransient(state, transient, payload));
    },
  []);
  const openComposer = useCallback((draft: NoteComposerDraft): void => {
    const current = foregroundRef.current;
    if (current.kind === "transient" && current.transient === "footnote") {
      overlayHoverRef.current = false;
      readerRef.current?.dismissFootnote();
    } else if (current.kind === "transient" && current.transient === "selection") {
      readerRef.current?.clearTextSelection();
    }
    setForeground((state) => openNoteComposer(state, draft));
  }, []);
  const closePanel = useCallback((panel: ReaderPanelId): void => {
    setForeground((current) =>
      current.kind === "panel" && current.panel === panel ? closeReaderForeground() : current
    );
  }, []);
  const closeForeground = useCallback((): void => {
    setForeground(closeReaderForeground());
    overlayHoverRef.current = false;
    readerRef.current?.dismissFootnote();
  }, []);

  /** 关闭正文图片浮层；不改变页码/滚动位置，也不记入阅读历史。 */
  const closeImageOverlay = useCallback((): void => {
    imageRequestRef.current = null;
    setImageRequest(null);
  }, []);

  /**
   * 正文图片激活（仅活动章节转发）：先收起弹注/选区菜单，再打开独立浮层。
   * 浮层打开期间正文按键、滚轮与翻页输入由 ReaderView 暂停。
   */
  const handleImageActivation = useCallback(
    (image: ImageViewRequest): void => {
      readerRef.current?.dismissFootnote();
      readerRef.current?.clearTextSelection();
      overlayHoverRef.current = false;
      setForeground(closeReaderForeground());
      imageRequestRef.current = image;
      setImageRequest(image);
    },
    []
  );

  const reportAiLifecycleError = useCallback((error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    setRuntimeIssues((issues) => [...issues, `AI 地基：${message}`]);
  }, []);
  const enableAi = useCallback((): void => {
    void aiRuntime.enable().catch(reportAiLifecycleError);
  }, [aiRuntime, reportAiLifecycleError]);
  const disableAi = useCallback((): void => {
    void aiRuntime.disable().catch(reportAiLifecycleError);
  }, [aiRuntime, reportAiLifecycleError]);

  useEffect(() => () => {
    void aiRuntime.dispose().catch((error: unknown) => {
      console.error("AI runtime disposal failed", error);
    });
  }, [aiRuntime]);

  const readerRef = useRef<ReaderHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chapterStateRef = useRef<ChapterState>(chapterState);
  chapterStateRef.current = chapterState;
  const bookRef = useRef<Book | null>(book);
  bookRef.current = book;
  const serverRef = useRef<ResourceServer | null>(server);
  serverRef.current = server;
  const spineIndexRef = useRef(spineIndex);
  spineIndexRef.current = spineIndex;
  const navigationPendingRef = useRef(false);
  const readerDisplayReadyRef = useRef(false);
  // 每个稳定位置只能被一次显式跳转捕获；新书初始加载时
  // 仍允许以已保存的基线位置记录“第一次跳转”。
  const historyCaptureAllowedRef = useRef(true);
  const lastStablePositionRef = useRef<ReaderHistoryPosition>({
    spineIndex: 0,
    page: 0,
    anchor: null,
  });
  const persistShelfProgressRef = useRef<() => void>(() => {});
  readerDisplayReadyRef.current = readerDisplayReady;

  // 搜索索引按“打开一本书”的会话持有；创建本身不读取章节，首次查询才
  // 按 spine 渐进提取。换书/返回书架时释放全部正文和位置映射。
  useEffect(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    searchSessionRef.current?.dispose();
    searchSessionRef.current = null;
    searchGenerationRef.current++;
    setSearchResults([]);
    setSearchStatus("idle");
    setSearchProgress({ processed: 0, total: 0 });
    setSearchError(undefined);
    setSearchNavigationBusy(false);
    if (view !== "reader" || !book || !server || book.fixedLayout) return;
    const session = createSearchSession(book, { resourceServer: server });
    searchSessionRef.current = session;
    return () => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      if (searchSessionRef.current === session) searchSessionRef.current = null;
      session.dispose();
      searchGenerationRef.current++;
    };
  }, [view, book, server]);

  // 全库搜索属于应用级运行时：两个 UI 入口只订阅，不以面板生命周期
  // 启停任务。书架变化只更新候选，下次状态检查/续建会精确补齐。
  useEffect(() => {
    librarySearchRuntime.setBooks(shelfEntries
      .filter((entry): entry is ShelfEntry & { contentHash: string } => Boolean(entry.contentHash))
      .map((entry) => ({
        id: entry.id,
        contentHash: entry.contentHash,
        title: entry.title,
        creator: entry.creator,
        language: entry.language,
        available: entry.available !== false,
        fileSize: entry.fileSize,
        read: createShelfBookReader(entry.id),
      })));
  }, [librarySearchRuntime, shelfEntries]);

  useEffect(() => {
    if (searchOpen && searchScope === "all") void librarySearchRuntime.checkIndex();
  }, [librarySearchRuntime, searchOpen, searchScope]);

  // 输入防抖只延迟查询，不延迟取消：每次改字都会立即终止旧扫描，已完成
  // 的章节仍保留在 SearchSession 内供新查询复用。
  useEffect(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    const generation = ++searchGenerationRef.current;
    const query = searchQuery.trim();
    const session = searchSessionRef.current;
    if (!searchOpen || searchScope !== "current" || !session) {
      setSearchResults([]);
      setSearchStatus("idle");
      setSearchProgress({ processed: 0, total: 0 });
      setSearchError(undefined);
      return;
    }
    if (!query) {
      setSearchResults([]);
      setSearchStatus("idle");
      setSearchProgress({ processed: 0, total: 0 });
      setSearchError(undefined);
      return;
    }
    setSearchStatus("searching");
    setSearchProgress({
      processed: 0,
      total: book?.spine.filter((item) => item.linear).length ?? 0,
    });
    setSearchError(undefined);
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const request = session.search(query, {
        signal: controller.signal,
        maxResults: 101,
        onProgress: ({ completed, total }) => {
          if (generation !== searchGenerationRef.current) return;
          setSearchProgress({ processed: completed, total });
        },
      });
      void request.then((results) => {
        if (generation !== searchGenerationRef.current) return;
        setSearchResults(results);
        setSearchStatus("complete");
      }).catch((error: unknown) => {
        if (generation !== searchGenerationRef.current || (error as Error)?.name === "AbortError") return;
        setSearchError(String(error));
        setSearchStatus("error");
      }).finally(() => {
        if (searchAbortRef.current === controller) searchAbortRef.current = null;
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
    };
  }, [searchOpen, searchQuery, searchScope, book]);

  const applyCount = useCallback(
    (generation: number, index: number, value: number, source: "estimated" | "measured"): boolean => {
      const result = applyChapterCount(
        chapterCountsRef.current,
        generation,
        index,
        value,
        source
      );
      if (!result.accepted) return false;
      chapterCountsRef.current = result.collection;
      setChapterCountsState(result.collection);
      return true;
    },
    []
  );

  const applyCountBatch = useCallback(
    (generation: number, values: readonly (readonly [number, number])[]): void => {
      let next = chapterCountsRef.current;
      let changed = false;
      for (const [index, value] of values) {
        const result = applyChapterCount(next, generation, index, value, "estimated");
        if (!result.accepted) continue;
        next = result.collection;
        changed = true;
      }
      if (!changed) return;
      chapterCountsRef.current = next;
      setChapterCountsState(next);
    },
    []
  );

  const applyCountError = useCallback((generation: number, index: number): void => {
    const result = applyChapterCountError(chapterCountsRef.current, generation, index);
    if (!result.accepted) return;
    chapterCountsRef.current = result.collection;
    setChapterCountsState(result.collection);
  }, []);

  // ---- 打开书（书架导入/书架打开共用；只承载阅读器状态，不改渲染核心） ----
  const openParsedBook = useCallback(
    (
      b: Book,
      srv: ResourceServer,
      fileName: string,
      fileSize: number,
      savedOverride: SavedProgress | null,
      shelfId: string | null,
      countCacheKey: string | null,
      baselineProgressPct: number
    ) => {
      if (activeSessionRef.current && activeSessionRef.current.server !== srv) {
        activeSessionRef.current.server.revokeAll();
        disposeBook(activeSessionRef.current.book);
      }
      const key = bookKeyOf(b, fileName, fileSize);
      const saved = savedOverride ?? readProgress(key);
      const generation = ++sessionGenerationRef.current;
      activeSessionRef.current = {
        generation,
        book: b,
        server: srv,
        bookKey: key,
        countCacheKey,
      };
      const linearMask = b.spine.map((item) => item.linear);
      let counts = createChapterCountCollection(
        generation,
        linearMask
      );
      const cached = readCachedChapterCounts(countCacheKey, linearMask);
      for (const [index, value] of cached) {
        counts = applyChapterCount(counts, generation, index, value, "estimated").collection;
      }
      chapterCountsRef.current = counts;
      setChapterCountsState(chapterCountsRef.current);
      baselineProgressPctRef.current =
        Number.isSafeInteger(baselineProgressPct) && baselineProgressPct >= 0
          ? Math.min(100, baselineProgressPct)
          : 0;
      lastCountProgressSignatureRef.current = null;
      const start = clamp(saved?.spineIndex ?? firstLinear(b), 0, b.spine.length - 1);
      setBook(b);
      setServer(srv);
      setBookKey(key);
      setRuntimeIssues([]);
      setChapterState({ status: "loading" });
      setReaderDisplayReady(false);
      setSpineIndex(start);
      setAnchor(undefined);
      setInitialPage(saved?.page ?? 0);
      setInitialAnchor(toPersistedReaderAnchor(saved?.anchor));
      lastStablePositionRef.current = {
        spineIndex: start,
        page: saved?.page ?? 0,
        anchor: toPersistedReaderAnchor(saved?.anchor),
      };
      navigationPendingRef.current = true;
      historyCaptureAllowedRef.current = true;
      setCurrentShelfId(shelfId);
      setReaderHistory(emptyReaderNavigationHistory());
      setForeground(closeReaderForeground());
      setSearchQuery("");
      setNoteBusy(false);
      noteBusyRef.current = false;
      setView("reader");
      setPhase({ phase: "ready" });
    },
    []
  );

  // ---- 批量导入 EPUB 并入库（逐本有界处理；结束后只刷新一次书架） ----
  const handleImportSources = useCallback(async (sources: ImportSource[]) => {
    const list = sources.filter((source) => {
      const name = source.kind === "file" ? source.file.name : source.name;
      return name.toLowerCase().endsWith(".epub");
    });
    if (list.length === 0 || shelfBusyRef.current) return;
    shelfBusyRef.current = true;
    setShelfBusy(true);
    setShelfNotice(null);
    const imported: ShelfEntry[] = [];
    const duplicateTitles: string[] = [];
    const failed: string[] = [];
    const store = getShelfStore();

    try {
      if (isTauriEnv()) {
        const paths = list.flatMap((source) => source.kind === "path" ? [source.path] : []);
        if (paths.length !== list.length) {
          throw new Error("桌面版导入必须保留用户选择的源文件路径");
        }
        const batch = await store.importPaths(paths);
        for (const item of batch.results) {
          const source = list[item.inputIndex];
          const fileName = source?.kind === "path" ? source.name : `第 ${item.inputIndex + 1} 本`;
          if (item.status === "failed") {
            failed.push(`${fileName}：${item.error || "导入失败"}`);
            continue;
          }
          if (!item.record) {
            failed.push(`${fileName}：后端未返回书架记录`);
            continue;
          }
          contentHashByIdRef.current.set(item.record.id, item.record.contentHash ?? item.record.id);
          entryByContentHashRef.current.set(item.record.contentHash ?? item.record.id, item.record);
          if (item.status === "duplicate") {
            duplicateTitles.push(item.record.title || fileName.replace(/\.epub$/i, ""));
          } else {
            imported.push(item.record);
          }
        }
      } else {
        for (const source of list) {
          const fileName = source.kind === "file" ? source.file.name : source.name;
          try {
            if (source.kind !== "file") {
              throw new Error("浏览器预览无法读取原生文件路径");
            }
            const arrayBuffer = await source.file.arrayBuffer();
            const buf = new Uint8Array(arrayBuffer);
            const contentHash = await sha256Hex(buf);

            const duplicate = await findDuplicateEntry({
              incomingHash: contentHash,
              incomingSize: buf.byteLength,
              entries: shelfEntriesRef.current,
              contentHashById: contentHashByIdRef.current,
              entryByContentHash: entryByContentHashRef.current,
              readBook: (id) => store.readBook(id),
              setContentHash: (id, hash) => store.setContentHash(id, hash),
            });

            if (duplicate && duplicate.available !== false) {
              duplicateTitles.push(duplicate.title || fileName.replace(/\.epub$/i, ""));
              continue;
            }

            const b = await loadBook(buf);
            if (b.spine.length === 0) {
              throw new Error("书中没有可阅读的内容（spine 为空）");
            }
            const cover = b.coverHref ? b.resources.get(b.coverHref) : undefined;
            const result = await store.save({
              entry: {
                id: contentHash,
                title: b.metadata.title || fileName.replace(/\.epub$/i, ""),
                creator: b.metadata.creator ?? "",
                language: b.metadata.language || undefined,
                fileName,
                fileSize: buf.byteLength,
                coverMime: cover?.mediaType ?? "",
                contentHash,
                addedAtMs: Date.now(),
              },
              bytes: buf,
              coverBytes: cover?.data,
              coverMime: cover?.mediaType,
            });
            contentHashByIdRef.current.set(result.entry.id, contentHash);
            entryByContentHashRef.current.set(contentHash, result.entry);
            if (result.status === "duplicate") {
              duplicateTitles.push(result.entry.title || fileName.replace(/\.epub$/i, ""));
            } else {
              imported.push(result.entry);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push(
              `${fileName}：${error instanceof DrmError ? error.message : message}`
            );
          }
        }
      }

      if (imported.length > 0) {
        setShelfEntries((previous) => mergeShelfEntries(previous, imported));
      }
      setShelfNotice(
        formatImportNotice({
          sourceCount: list.length,
          importedCount: imported.length,
          duplicateTitles,
          failed,
        })
      );
    } catch (error) {
      setShelfNotice({ kind: "error", text: `导入失败：${String(error)}` });
    } finally {
      shelfBusyRef.current = false;
      setShelfBusy(false);
    }
  }, []);

  const handleChooseBooks = useCallback(async () => {
    if (!isTauriEnv()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const selected = await openFileDialog({
        multiple: true,
        directory: false,
        title: "选择 EPUB 书籍",
        filters: [{ name: "EPUB 电子书", extensions: ["epub"] }],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (paths.length === 0) return;
      await handleImportSources(
        paths.map((path) => ({
          kind: "path" as const,
          path,
          name: path.split(/[\\/]/).pop() || "book.epub",
        }))
      );
    } catch (error) {
      setShelfNotice({ kind: "error", text: `无法打开文件选择器：${String(error)}` });
    }
  }, [handleImportSources]);

  const handleExportArchive = useCallback(async () => {
    try {
      const built = buildLibraryArchiveWithIssues(shelfEntriesRef.current, {
        ...settings,
        uiScale,
      });
      if (built.skipped.length > 0) {
        throw new Error(`有 ${built.skipped.length} 条书架记录缺少有效内容指纹`);
      }
      const text = exportLibraryArchive(built.archive);
      if (isTauriEnv()) {
        const path = await saveFileDialog({
          title: "导出阅读存档",
          defaultPath: `epub-reader-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: "EPUB Reader 存档", extensions: ["json"] }],
        });
        if (!path) return;
        await writeTextFile(path, text);
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `epub-reader-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setShelfNotice({ kind: "ok", text: `已导出 ${Object.keys(built.archive.records).length} 本书的存档` });
    } catch (error) {
      setShelfNotice({ kind: "error", text: `存档导出失败：${String(error)}` });
    }
  }, [settings, uiScale]);

  const handleImportArchive = useCallback(async () => {
    if (shelfBusyRef.current) return;
    shelfBusyRef.current = true;
    setShelfBusy(true);
    try {
      let text: string | null = null;
      if (isTauriEnv()) {
        const path = await openFileDialog({
          multiple: false,
          directory: false,
          title: "导入阅读存档",
          filters: [{ name: "EPUB Reader 存档", extensions: ["json"] }],
        });
        if (path && !Array.isArray(path)) {
          if ((await statFile(path)).size > 16 * 1024 * 1024) {
            throw new Error("存档文件超过 16 MiB，已拒绝读取");
          }
          text = await readTextFile(path);
        }
      } else {
        text = await new Promise<string | null>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "application/json,.json";
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) resolve(null);
            else if (file.size > 16 * 1024 * 1024) {
              setShelfNotice({ kind: "error", text: "存档文件超过 16 MiB，已拒绝读取" });
              resolve(null);
            }
            else void file.text().then(resolve, () => resolve(null));
          };
          input.addEventListener("cancel", () => resolve(null), { once: true });
          input.click();
        });
      }
      if (text === null) return;
      const incoming = parseLibraryArchive(text);
      if (incoming.errors.length > 0) {
        const first = incoming.errors[0];
        throw new Error(`${first.path}：${first.message}（共 ${incoming.errors.length} 项）`);
      }
      const current = buildLibraryArchiveWithIssues(shelfEntriesRef.current, {
        ...settings,
        uiScale,
      });
      if (current.skipped.length > 0) {
        throw new Error(`当前书架有 ${current.skipped.length} 条记录缺少有效内容指纹`);
      }
      const merged = mergeLibraryArchives(current.archive, incoming.archive);
      const nextEntries = await getShelfStore().replacePortableRecords(
        archiveRecordsForBackend(merged)
      );
      setShelfEntries(nextEntries);

      const importedSettings = merged.settings ?? {};
      setSettings((previous) => ({
        ...previous,
        ...(typeof importedSettings.fontSizePx === "number" && importedSettings.fontSizePx >= 12 && importedSettings.fontSizePx <= 32
          ? { fontSizePx: importedSettings.fontSizePx }
          : {}),
        ...(importedSettings.theme === "light" || importedSettings.theme === "dark" || importedSettings.theme === "sepia"
          ? { theme: importedSettings.theme }
          : {}),
        ...(typeof importedSettings.gapPx === "number" && importedSettings.gapPx >= 0 && importedSettings.gapPx <= 96
          ? { gapPx: importedSettings.gapPx }
          : {}),
        ...(typeof importedSettings.fontFamily === "string" ? { fontFamily: importedSettings.fontFamily } : {}),
        ...(typeof importedSettings.lineHeight === "number" && importedSettings.lineHeight >= 1 && importedSettings.lineHeight <= 3 ? { lineHeight: importedSettings.lineHeight } : {}),
        ...(typeof importedSettings.fontWeight === "number" && importedSettings.fontWeight >= 100 && importedSettings.fontWeight <= 900 ? { fontWeight: importedSettings.fontWeight } : {}),
        ...(typeof importedSettings.letterSpacingPx === "number" && importedSettings.letterSpacingPx >= 0 && importedSettings.letterSpacingPx <= 32 ? { letterSpacingPx: importedSettings.letterSpacingPx } : {}),
        ...(typeof importedSettings.wordSpacingPx === "number" && importedSettings.wordSpacingPx >= 0 && importedSettings.wordSpacingPx <= 64 ? { wordSpacingPx: importedSettings.wordSpacingPx } : {}),
        ...(typeof importedSettings.customFontName === "string" ? { customFontName: importedSettings.customFontName } : {}),
        ...(importedSettings.fontSource === "system" || importedSettings.fontSource === "imported" ? { fontSource: importedSettings.fontSource } : {}),
        ...(typeof importedSettings.customFontId === "string" ? { customFontId: importedSettings.customFontId } : {}),
        ...(typeof importedSettings.customCss === "string" ? { customCss: importedSettings.customCss } : {}),
        ...(typeof importedSettings.forceHorizontal === "boolean" ? { forceHorizontal: importedSettings.forceHorizontal } : {}),
        ...(typeof importedSettings.preloadNextChapter === "boolean" ? { preloadNextChapter: importedSettings.preloadNextChapter } : {}),
        // 导入的页面选项与本地读取走同一处归一化。
        ...normalizePageOptions({
          readingMode: importedSettings.readingMode,
          pageMarginsPx: importedSettings.pageMarginsPx,
          columnsPerView: importedSettings.columnsPerView,
          gapPx:
            typeof importedSettings.gapPx === "number"
              ? importedSettings.gapPx
              : previous.gapPx,
        }),
      }));
      if (typeof importedSettings.uiScale === "number" && importedSettings.uiScale >= 0.75 && importedSettings.uiScale <= 1.5) {
        setUiScale(importedSettings.uiScale);
      }
      const unavailableCount = nextEntries.filter((entry) => entry.available === false).length;
      setShelfNotice({
        kind: unavailableCount > 0 ? "warn" : "ok",
        text: `已合并 ${Object.keys(incoming.archive.records).length} 本书的存档${unavailableCount > 0 ? `；${unavailableCount} 本需重新定位源文件` : ""}`,
      });
    } catch (error) {
      setShelfNotice({ kind: "error", text: `存档导入失败：${String(error)}` });
    } finally {
      shelfBusyRef.current = false;
      setShelfBusy(false);
    }
  }, [settings, uiScale]);

  // ---- 书架启动加载 ----
  useEffect(() => {
    let cancelled = false;
    getShelfStore()
      .list()
      .then((entries) => {
        if (!cancelled) setShelfEntries(entries);
      })
      .catch((e) => {
        if (!cancelled) setShelfError(`无法读取书架：${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 字体元数据启动加载（只列元数据，绝不预读所有字体文件） ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fonts = await getFontStore().list();
        if (cancelled) return;
        setUserFonts(fonts);
      } catch {
        /* 字体库不可用不阻塞阅读 */
      } finally {
        if (!cancelled) setUserFontsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 旧设置只有 customFontName：元数据到达后尽量绑定到 imported id。
  useEffect(() => {
    if (settings.fontSource === "imported" && userFontsLoaded && settings.customFontId
      && !userFonts.some((font) => font.id === settings.customFontId)) {
      setSettings((previous) => ({ ...previous, fontSource: undefined, customFontName: undefined, customFontId: undefined }));
      return;
    }
    if (settings.fontSource || !settings.customFontName || !userFontsLoaded) return;
    const match = userFonts.find((font) => font.family === settings.customFontName);
    if (match) {
      setSettings((previous) => previous.fontSource || previous.customFontId
        ? previous
        : { ...previous, fontSource: "imported", customFontId: match.id });
    } else {
      setSettings((previous) => previous.fontSource || !previous.customFontName
        ? previous
        : { ...previous, customFontName: undefined, customFontId: undefined });
    }
  }, [settings.fontSource, settings.customFontName, settings.customFontId, userFonts, userFontsLoaded]);

  // 仅为当前选中的 imported 字体读文件并创建一个 Blob URL。
  useEffect(() => {
    const selectedId = settings.fontSource === "imported" ? settings.customFontId : undefined;
    const selected = selectedId ? userFonts.find((font) => font.id === selectedId) : undefined;
    const runtime = fontRuntimeRef.current!;
    let cancelled = false;
    void runtime.select(selected?.id).then((url) => {
      if (cancelled) return;
      setFontUrls(url && selected ? { [selected.id]: url } : {});
    }).catch(() => {
      // Controller keeps the previous URL alive when the replacement cannot be read.
      // The reader therefore remains usable while the panel can report the error.
    });
    return () => { cancelled = true; };
  }, [settings.fontSource, settings.customFontId, userFonts]);

  useEffect(() => () => { fontRuntimeRef.current?.dispose(); }, []);

  const fontImportBusyRef = useRef(false);
  const importFontFile = useCallback(async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(bytes);
    const id = fontIdFromHash(hash);
    const family = fontFamilyFromFileName(file.name);
    const entry = await getFontStore().importFont({ id, fileName: file.name, family, bytes });
    setUserFonts((prev) => [entry, ...prev.filter((f) => f.id !== id)]);
    setSettings((previous) => ({
      ...previous,
      fontSource: "imported",
      customFontId: id,
      customFontName: entry.family,
    }));
  }, []);

  const handleImportFontBatch = useCallback(async <T,>(items: T[], nameOf: (item: T) => string, toFile: (item: T) => Promise<File>) => {
    if (fontImportBusyRef.current || items.length === 0) return;
    fontImportBusyRef.current = true;
    setFontBusy(true);
    const { supported, unsupported } = partitionFontItems(items, nameOf);
    let imported = 0;
    try {
      await runFontImportBatch(supported, async (item) => {
        const file = await toFile(item);
        await importFontFile(file);
        imported += 1;
      });
      if (unsupported.length > 0) {
        setShelfNotice({
          kind: "error",
          text: imported > 0
            ? `已导入 ${imported} 个字体；忽略 ${unsupported.length} 个非字体文件`
            : `已忽略 ${unsupported.length} 个非字体文件，仅支持 TTF/OTF/WOFF/WOFF2`,
        });
      } else if (imported > 0) {
        setShelfNotice({ kind: "ok", text: imported === 1 ? `已导入字体：${fontFamilyFromFileName(nameOf(supported[0]))}` : `已导入 ${imported} 个字体` });
      }
    } catch (e) {
      setShelfNotice({ kind: "error", text: `字体导入失败：${String(e)}` });
    } finally {
      fontImportBusyRef.current = false;
      setFontBusy(false);
    }
  }, [importFontFile]);

  const handleImportFonts = useCallback((files: File[]) => handleImportFontBatch(files, (file) => file.name, async (file) => file), [handleImportFontBatch]);
  const handleImportFont = useCallback((file: File) => handleImportFonts([file]), [handleImportFonts]);
    const handleImportFontPaths = useCallback(async (paths: string[]) => {
    if (fontImportBusyRef.current || paths.length === 0) return;
    fontImportBusyRef.current = true;
    setFontBusy(true);
    try {
      const store = getFontStore();
      if (store.importFontPaths) {
        const entries = await store.importFontPaths(paths);
        if (entries.length > 0) {
          setUserFonts((prev) => {
            const newIds = new Set(entries.map((e) => e.id));
            return [...entries, ...prev.filter((f) => !newIds.has(f.id))];
          });
          const last = entries[0];
          setSettings((previous) => ({
            ...previous,
            fontSource: "imported",
            customFontId: last.id,
            customFontName: last.family,
          }));
          setShelfNotice({
            kind: "ok",
            text: entries.length === 1 ? `已导入字体：${last.family}` : `已导入 ${entries.length} 个字体`,
          });
        } else {
          setShelfNotice({
            kind: "error",
            text: "未发现支持的字体文件，仅支持 TTF/OTF/WOFF/WOFF2",
          });
        }
      } else {
        await handleImportFontBatch(
          paths,
          (path) => path.split(/[\\/]/).pop() || path,
          async (path) => {
            const name = path.split(/[\\/]/).pop() || "font";
            const bytes = await readFile(path);
            return new File([bytes.slice().buffer as ArrayBuffer], name);
          }
        );
      }
    } catch (e) {
      setShelfNotice({ kind: "error", text: `字体导入失败：${String(e)}` });
    } finally {
      fontImportBusyRef.current = false;
      setFontBusy(false);
    }
  }, [handleImportFontBatch]);

  useEffect(() => {
    if (!fontSettingsOpen) setFontNativeDragActive(false);
  }, [fontSettingsOpen]);

  const handleDeleteFont = useCallback(
    async (id: string) => {
      const font = userFonts.find((f) => f.id === id);
      setFontBusy(true);
      try {
        await getFontStore().deleteFont(id);
        setUserFonts((prev) => prev.filter((f) => f.id !== id));
        setFontUrls((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (font && settings.customFontId === id) {
          setSettings((s) => ({ ...s, fontSource: undefined, customFontId: undefined, customFontName: undefined }));
        }
      } catch (e) {
        setShelfNotice({ kind: "error", text: `字体删除失败：${String(e)}` });
      } finally {
        setFontBusy(false);
      }
    },
    [fontUrls, userFonts, settings.customFontId]
  );

  // 导入结果 toast：展示 3 秒后用 1 秒淡出，期间不拦截鼠标
  useEffect(() => {
    if (!shelfNotice) {
      setShelfNoticeFading(false);
      return;
    }
    setShelfNoticeFading(false);
    const fadeTimer = window.setTimeout(() => setShelfNoticeFading(true), 3000);
    const closeTimer = window.setTimeout(() => setShelfNotice(null), 4000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(closeTimer);
    };
  }, [shelfNotice]);

  useEffect(() => {
    if (!readerNotice) {
      setReaderNoticeFading(false);
      return;
    }
    setReaderNoticeFading(false);
    const fadeTimer = window.setTimeout(() => setReaderNoticeFading(true), 3000);
    const closeTimer = window.setTimeout(() => setReaderNotice(null), 4000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(closeTimer);
    };
  }, [readerNotice]);

  const showReaderNotice = useCallback((text: string, kind: "ok" | "warn" | "error" = "warn"): void => {
    setReaderNotice({ kind, text });
  }, []);

  const handlePreciseNavigationStatus = useCallback((status: {
    requestId: number;
    status: PreciseNavigationStatus;
    exact: boolean;
  }): void => {
    if (latestPreciseRequestRef.current !== status.requestId) return;
    latestPreciseRequestRef.current = null;
    setPreciseTarget(null);
    if (status.status === "unresolved") {
      showReaderNotice("未能定位原文，请重新搜索或检查笔记", "warn");
    } else if (status.status === "located-reference") {
      showReaderNotice("已定位结果段落，未能标出精确匹配", "warn");
    } else if (status.status === "unsupported-highlight") {
      showReaderNotice("当前内核不支持正文高亮；已定位原文", "warn");
    }
  }, [showReaderNotice]);

  // ---- 从书架打开 ----
  const handleShelfOpen = useCallback(
    async (id: string, searchTarget?: ResolvedCrossBookSearchHit, searchTextHits?: ExactTextHit[]) => {
      if (shelfBusyRef.current) return;
      const originalEntry = shelfEntriesRef.current.find((e) => e.id === id);
      if (!originalEntry) return;
      shelfBusyRef.current = true;
      setShelfBusy(true);
      setShelfError(null);
      if (searchTarget) setSearchNavigationBusy(true);
      setPhase({ phase: "loading", fileName: originalEntry.fileName });
      let preciseRequestId: number | null = null;
      try {
        // A new open is a new session even when the same book is reopened.
        // Flush any prior session before resetting the immediate-write gate.
        persistShelfProgressRef.current();
        await progressWriterRef.current?.flush();
        progressWriterRef.current?.beginSession(id);
        let entry = originalEntry;
        if (isTauriEnv() && entry.available === false) {
          const selected = await openFileDialog({
            multiple: false,
            directory: false,
            title: `重新定位《${entry.title}》`,
            filters: [{ name: "EPUB 电子书", extensions: ["epub"] }],
          });
          if (!selected || Array.isArray(selected)) {
            shelfBusyRef.current = false;
            setShelfBusy(false);
            setPhase({ phase: "idle" });
            setSearchNavigationBusy(false);
            return;
          }
          entry = await getShelfStore().relink(id, selected);
          setShelfEntries((prev) =>
            prev.map((item) => (item.id === id ? entry : item))
          );
        }
        let buf: Uint8Array;
        try {
          buf = await getShelfStore().readBook(id);
        } catch (error) {
          setShelfEntries((prev) =>
            prev.map((item) => (item.id === id ? { ...item, available: false } : item))
          );
          throw error;
        }
        // Legacy browser shelf IDs may be UUIDs; index identity always comes from EPUB bytes.
        if (IS_AI_EDITION && !isTauriEnv() && !/^[a-f0-9]{64}$/.test(entry.contentHash ?? "")) {
          entry = await getShelfStore().setContentHash(id, await sha256Hex(buf));
          setShelfEntries((prev) => prev.map((item) => item.id === id ? entry : item));
        }
        const b = await loadBook(buf);
        if (b.spine.length === 0) {
          setShelfError("这本书没有可阅读的内容");
          shelfBusyRef.current = false;
          setShelfBusy(false);
          setSearchNavigationBusy(false);
          return;
        }
        const srv = new ResourceServer(b);
        let saved: SavedProgress;
        if (searchTarget) {
          let targetIndex = searchTarget.spineIndex;
          if (spineItemPath(b, targetIndex) !== searchTarget.chapterPath) {
            targetIndex = spineIndexForPath(b, searchTarget.chapterPath);
          }
          if (targetIndex < 0 || targetIndex >= b.spine.length) {
            throw new Error("索引结果对应的章节已不存在，请重建该书索引");
          }
          preciseRequestId = ++preciseRequestRef.current;
          saved = {
            spineIndex: targetIndex,
            page: 0,
            anchor: {
              index: -1,
              ratio: 0,
              anchorTextOffset: searchTarget.textAnchor.start,
              anchorTextSnippet: searchTarget.textAnchor.snippet || null,
            },
          };
        } else {
          saved = {
            spineIndex: entry.spineIndex,
            page: entry.page,
            anchor: readingAnchorFromShelfEntry(entry),
          };
        }
        // 第一次打开：立即清除“新”标记（后端落盘异步完成，不阻塞阅读）
        if (entry.isNew) {
          setShelfEntries((prev) => markShelfEntryOpened(prev, id));
          void getShelfStore()
            .markOpened(id)
            .then(() => setShelfEntries((prev) => markShelfEntryOpened(prev, id)))
            .catch(() => {
              /* 下次打开时再尝试清除 */
            });
        }
        openParsedBook(
          b,
          srv,
          entry.fileName,
          entry.fileSize,
          saved,
          id,
          entry.contentHash ?? id,
          entry.progressPct,
        );
        if (preciseRequestId !== null && searchTarget) {
          latestPreciseRequestRef.current = preciseRequestId;
          setInitialPage(null);
          setPreciseTarget({
            requestId: preciseRequestId,
            kind: "search",
            chapterPath: searchTarget.chapterPath,
            textHits: searchTextHits,
          });
        }
        shelfBusyRef.current = false;
        setShelfBusy(false);
      } catch (e) {
        shelfBusyRef.current = false;
        setShelfBusy(false);
        setShelfError(`打开失败：${(e as Error).message}`);
        setSearchNavigationBusy(false);
      }
    },
    [openParsedBook]
  );

  // 打开书后渐进统计章节字数；同一本书切章不重建该任务。
  useEffect(() => {
    chapterCountJobRef.current?.cancel();
    chapterCountJobRef.current = null;
    const active = activeSessionRef.current;
    if (view !== "reader" || !book || !server || !active) return;
    const cachedIndices = new Set<number>();
    for (const [index, count] of chapterCountsRef.current.counts.entries()) {
      if (count.source === "estimated") cachedIndices.add(index);
    }
    const job = createChapterCountJob({
      book,
      server,
      generation: active.generation,
      isCurrent: (generation, candidateBook, candidateServer) => {
        const current = activeSessionRef.current;
        return (
          current?.generation === generation &&
          current.book === candidateBook &&
          current.server === candidateServer &&
          current.bookKey === bookKey
        );
      },
      skipIndices: cachedIndices,
      onCounts: (values) => {
        applyCountBatch(active.generation, values);
      },
      onCount: (index, value) => {
        applyCount(active.generation, index, value, "estimated");
      },
      onError: (index) => applyCountError(active.generation, index),
      onIssue: (message) => {
        setRuntimeIssues((previous) =>
          previous.includes(message) ? previous : [...previous, message]
        );
      },
    });
    chapterCountJobRef.current = job;
    return () => {
      job.cancel();
      if (chapterCountJobRef.current === job) chapterCountJobRef.current = null;
    };
  }, [view, book, server, bookKey, applyCount, applyCountBatch, applyCountError]);

  const handleShelfDelete = useCallback(async (id: string) => {
    if (shelfBusyRef.current) return;
    shelfBusyRef.current = true;
    setShelfBusy(true);
    try {
      await getShelfStore().deleteBook(id);
      setShelfEntries((prev) => prev.filter((e) => e.id !== id));
      setCurrentShelfId((curr) => (curr === id ? null : curr));
      setShelfError(null);
    } catch (e) {
      setShelfError(`删除失败：${String(e)}`);
    } finally {
      shelfBusyRef.current = false;
      setShelfBusy(false);
    }
  }, []);

  const handleShelfDeleteMany = useCallback(async (ids: string[]) => {
    if (shelfBusyRef.current || ids.length === 0) return;
    shelfBusyRef.current = true;
    setShelfBusy(true);
    try {
      const { deleted, failed } = await deleteShelfBooks(getShelfStore(), ids);
      const deletedIds = new Set(deleted);
      setShelfEntries((prev) => prev.filter((entry) => !deletedIds.has(entry.id)));
      setCurrentShelfId((curr) => (curr && deletedIds.has(curr) ? null : curr));
      if (failed.length === 0) {
        setShelfError(null);
        setShelfNotice({ kind: "ok", text: `已删除 ${deleted.length} 本` });
      } else {
        setShelfError(`删除失败 ${failed.length} 本：${[...new Set(failed.map((item) => item.error))].join("；")}`);
      }
    } finally {
      shelfBusyRef.current = false;
      setShelfBusy(false);
    }
  }, []);

  // ---- 章节状态回调 ----
  const onPageState = useCallback((s: ChapterState) => {
    chapterStateRef.current = s;
    setChapterState(s);
  }, []);

  const handleReaderDisplayReady = useCallback(() => {
    navigationPendingRef.current = false;
    historyCaptureAllowedRef.current = true;
    readerDisplayReadyRef.current = true;
    setReaderDisplayReady(true);
    setSearchNavigationBusy(false);
    const state = chapterStateRef.current;
    const readingAnchor = readerRef.current?.getReadingAnchor();
    const currentBook = bookRef.current;
    const currentIndex = spineIndexRef.current;
    const active = activeSessionRef.current;
    const expectedPath = currentBook ? spineItemPath(currentBook, currentIndex) : undefined;
    if (
      active &&
      expectedPath &&
      state.status === "ready" &&
      !state.empty &&
      readingAnchor?.path === expectedPath &&
      Number.isSafeInteger(readingAnchor.totalChars) &&
      readingAnchor.totalChars >= 0
    ) {
      const measuredChars = measuredChapterWeight(
        readingAnchor.totalChars,
        readingAnchor.mediaUnits,
        state.pageCount,
      );
      applyCount(active.generation, currentIndex, measuredChars, "measured");
      lastStablePositionRef.current = {
        spineIndex: currentIndex,
        page: state.currentPage,
        anchor: toPersistedReaderAnchor(
          {
            index: readingAnchor.index,
            ratio: readingAnchor.ratio,
            anchorTextOffset: readingAnchor.textOffset,
            anchorTextSnippet: readingAnchor.textSnippet,
          }
        ),
      };
    }
    // Future chapter changes are ordinary navigation, not another attempt to
    // apply this opening/history restore.
    setInitialAnchor(null);
    setInitialPage(0);
    // Display-ready flips a state gate; the following render runs the normal
    // progress effect with the newest derived percentage and anchor.
  }, [applyCount]);

  const handleRequestChapter = useCallback(
    (index: number, opts?: { atEnd?: boolean }) => {
      // 换章前先关闭图片浮层，避免继续引用即将撤销的资源 URL。
      closeImageOverlay();
      setPreciseTarget(null);
      latestPreciseRequestRef.current = null;
      navigationPendingRef.current = true;
      historyCaptureAllowedRef.current = false;
      readerDisplayReadyRef.current = false;
      setReaderDisplayReady(false);
      setSpineIndex(index);
      setAnchor(undefined);
      // 对象每次请求都新建：连续回翻多次时每次都能触发 atEnd 武装
      setStartAtEnd((prev) => ({ nonce: prev.nonce + 1, atEnd: opts?.atEnd === true }));
      closeForeground();
    },
    [closeForeground, closeImageOverlay]
  );

  const handleIssues = useCallback((issues: string[]) => {
    if (issues.length > 0) setRuntimeIssues((prev) => [...prev, ...issues]);
  }, []);

  const handleToggleLog = useCallback(() => {
    setForeground((current) => {
      if (current.kind === "modal") return current;
      if (current.kind === "panel" && current.panel === "log") {
        setDiagText(null);
        return closeReaderForeground();
      }
      if (current.kind === "transient" && current.transient === "footnote") {
        overlayHoverRef.current = false;
        readerRef.current?.dismissFootnote();
      } else if (current.kind === "transient" && current.transient === "selection") {
        readerRef.current?.clearTextSelection();
      }
      setDiagText(readerRef.current?.diagnose() ?? "（阅读器未初始化）");
      return openReaderPanel(current, "log");
    });
  }, []);

  const handleFootnoteClose = useCallback(() => {
    setForeground((current) =>
      current.kind === "transient" && current.transient === "footnote"
        ? closeReaderForeground()
        : current
    );
    overlayHoverRef.current = false;
    readerRef.current?.dismissFootnote();
  }, []);

  const handleFootnoteAnchor = useCallback((anchor: string) => {
    readerRef.current?.jumpToAnchor(anchor);
    handleFootnoteClose();
  }, [handleFootnoteClose]);

  // ---- 目录/书内链接跳转 ----
  /** 当前稳定阅读位置；同步 ref 避免 ready 更新尚未完成 React render 的竞态。 */
  const currentReaderPosition = useCallback((): ReaderHistoryPosition => {
    const state = chapterStateRef.current;
    const readingAnchor = readerRef.current?.getReadingAnchor();
    return {
      spineIndex,
      page: state.status === "ready" ? state.currentPage : lastStablePositionRef.current.page,
      anchor: toPersistedReaderAnchor(
        readingAnchor
          ? {
              index: readingAnchor.index,
              ratio: readingAnchor.ratio,
              anchorTextOffset: readingAnchor.textOffset,
              anchorTextSnippet: readingAnchor.textSnippet,
            }
          : null
      ) ?? lastStablePositionRef.current.anchor,
    };
  }, [spineIndex]);

  /** 捕获当前位置供一次普通书内跳转撤销；调用方负责保证一次点击只调用一次。 */
  const captureReaderHistory = useCallback((href: string): void => {
    const state = chapterStateRef.current;
    if (!book || view !== "reader" || !historyCaptureAllowedRef.current) return;
    if (state.status === "ready" && state.empty) return;
    // 跨章链接必须确实命中 spine；纯 fragment 则必须属于当前有效章节。
    // 这样 paginator 的通用 before 通知不会把无效 href 变成假历史。
    if (
      isFragmentOnly(href)
        ? spineIndex < 0 || spineIndex >= book.spine.length
        : spineIndexForPath(book, href) < 0
    ) {
      return;
    }
    const snapshot =
      !navigationPendingRef.current && state.status === "ready"
        ? currentReaderPosition()
        : {
            spineIndex: lastStablePositionRef.current.spineIndex,
            page: lastStablePositionRef.current.page,
            anchor: lastStablePositionRef.current.anchor
              ? { ...lastStablePositionRef.current.anchor }
              : null,
          };
    lastStablePositionRef.current = snapshot;
    historyCaptureAllowedRef.current = false;
    setReaderHistory((prev) => recordReaderNavigation(prev, snapshot));
  }, [book, view, spineIndex, currentReaderPosition]);

  /** Commit a previously captured snapshot only after direct navigation succeeds. */
  const commitReaderHistorySnapshot = useCallback((snapshot: ReaderHistoryPosition): void => {
    setReaderHistory((prev) => commitDirectHistory(prev, snapshot, true));
    // Same-chapter navigation never enters the display gate. The paginator
    // settles synchronously, so the next explicit jump may be captured now.
    historyCaptureAllowedRef.current = true;
    readerDisplayReadyRef.current = true;
  }, []);

  /** 只执行 href 跳转，不记录历史；UI 入口和 paginator 通知入口共用。 */
  const navigateReaderHref = useCallback((href: string): boolean => {
    if (!book) return false;
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    const idx = spineIndexForPath(book, href);
    const { anchor: a } = splitHref(href);
    if (idx < 0) return false;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: idx,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const direct = readerRef.current?.navigateWithinCurrentChapter(
        a ? { fragment: a } : { toStart: true }
      );
      if (direct) {
        setAnchor(a || undefined);
        closePanel("bookmarks");
        return true;
      }
      return false;
    }
    if (idx >= 0) {
      navigationPendingRef.current = true;
      historyCaptureAllowedRef.current = false;
      readerDisplayReadyRef.current = false;
      setReaderDisplayReady(false);
      closePanel("bookmarks");
      setSpineIndex(idx);
      setAnchor(a || undefined);
      setAnchorNonce((n) => n + 1);
      // 保持目录展开：方便连续选择章节；用 ✕/遮罩/Esc 关闭
      return true;
    }
    return false;
  }, [book, spineIndex]);

  /** 侧边目录入口：先记录一次，再执行跳转。 */
  const handleTocNavigate = useCallback((href: string): void => {
    if (!book) return;
    const target = spineIndexForPath(book, href);
    if (target < 0) return;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: target,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const snapshot = currentReaderPosition();
      if (navigateReaderHref(href)) commitReaderHistorySnapshot(snapshot);
      return;
    }
    captureReaderHistory(href);
    navigateReaderHref(href);
  }, [book, captureReaderHistory, navigateReaderHref, spineIndex, currentReaderPosition, commitReaderHistorySnapshot]);

  /** 搜索结果使用文本锚点定位；预览不写进度，只有用户点击才进入历史。 */
  const handleSearchNavigate = useCallback((result: SearchResult): void => {
    if (!book || searchNavigationBusy || result.spineIndex < 0 || result.spineIndex >= book.spine.length) return;
    const targetAnchor: PersistedReaderAnchor = {
      index: -1,
      ratio: 0,
      anchorTextOffset: result.textOffset,
      anchorTextSnippet: result.textSnippet,
    };
    const requestId = ++preciseRequestRef.current;
    const textHits = result.textHits ?? [];
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: result.spineIndex,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const snapshot = currentReaderPosition();
      if (textHits.length > 0) {
        const status = readerRef.current?.navigateToSearchTarget({ requestId, kind: "search", textHits });
        if (status === "located" || status === "unsupported-highlight") {
          setAnchor(undefined);
          commitReaderHistorySnapshot(snapshot);
          if (status === "unsupported-highlight") {
            showReaderNotice("当前内核不支持正文高亮；已定位原文", "warn");
          }
          handleFootnoteClose();
          closeForeground();
          return;
        }
        showReaderNotice("未能定位原文，请重新搜索", "warn");
        return;
      }
      const direct = readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: targetAnchor,
        fallbackPage: null,
      });
      if (direct) {
        setAnchor(undefined);
        commitReaderHistorySnapshot(snapshot);
        showReaderNotice("已定位结果段落，未能标出精确匹配", "warn");
        handleFootnoteClose();
        closeForeground();
        return;
      }
      showReaderNotice("未能定位原文，请重新搜索", "warn");
      return;
    }

    // 跨章先进入目标章节；精确范围/高亮在显示门内解析，失败不冒充命中。
    captureReaderHistory(result.chapterPath);
    navigationPendingRef.current = true;
    historyCaptureAllowedRef.current = false;
    readerDisplayReadyRef.current = false;
    setReaderDisplayReady(false);
    setSearchNavigationBusy(true);
    setInitialPage(null);
    setInitialAnchor(targetAnchor);
    latestPreciseRequestRef.current = requestId;
    setPreciseTarget({
      requestId,
      kind: "search",
      chapterPath: result.chapterPath,
      textHits: textHits.length > 0 ? textHits : undefined,
    });
    setSpineIndex(result.spineIndex);
    setAnchor(undefined);
    setAnchorNonce((nonce) => nonce + 1);
    handleFootnoteClose();
    closeForeground();
  }, [
    book,
    searchNavigationBusy,
    spineIndex,
    currentReaderPosition,
    commitReaderHistorySnapshot,
    captureReaderHistory,
    handleFootnoteClose,
    showReaderNotice,
  ]);

  /** iframe 普通书内链接：历史由 paginator 的 before 通知记录一次。 */
  const handleInternalNavigate = useCallback((href: string): void => {
    navigateReaderHref(href);
  }, [navigateReaderHref]);


  const handleHistoryBack = useCallback(() => {    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    const current = currentReaderPosition();
    const transition = readerHistoryBack(readerHistory, current);
    if (!transition.target) return;
    const pos = transition.target;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: pos.spineIndex,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const direct = readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: pos.anchor
          ? {
              index: pos.anchor.index,
              ratio: pos.anchor.ratio,
              anchorTextOffset: pos.anchor.anchorTextOffset ?? null,
              anchorTextSnippet: pos.anchor.anchorTextSnippet ?? null,
            }
          : null,
        fallbackPage: pos.page,
      });
      if (direct) {
        setAnchor(undefined);
        setReaderHistory(commitHistoryTransition(readerHistory, transition, true));
        historyCaptureAllowedRef.current = true;
        readerDisplayReadyRef.current = true;
        return;
      }
    }
    lastStablePositionRef.current = transition.target;
    navigationPendingRef.current = true;
    historyCaptureAllowedRef.current = false;
    readerDisplayReadyRef.current = false;
    setReaderDisplayReady(false);
    setReaderHistory(transition.history);
    // 恢复跳转前位置：章节 + 页码 + 内容锚点
    setSpineIndex(pos.spineIndex);
    setAnchor(undefined);
    setAnchorNonce((n) => n + 1);
    setInitialPage(pos.page ?? 0);
    setInitialAnchor(toPersistedReaderAnchor(pos.anchor));
    handleFootnoteClose();
    closeForeground();
  }, [readerHistory, currentReaderPosition, spineIndex, handleFootnoteClose]);

  const handleHistoryForward = useCallback(() => {
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    const current = currentReaderPosition();
    const transition = readerHistoryForward(readerHistory, current);
    if (!transition.target) return;
    const pos = transition.target;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: pos.spineIndex,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const direct = readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: pos.anchor
          ? {
              index: pos.anchor.index,
              ratio: pos.anchor.ratio,
              anchorTextOffset: pos.anchor.anchorTextOffset ?? null,
              anchorTextSnippet: pos.anchor.anchorTextSnippet ?? null,
            }
          : null,
        fallbackPage: pos.page,
      });
      if (direct) {
        setAnchor(undefined);
        setReaderHistory(commitHistoryTransition(readerHistory, transition, true));
        historyCaptureAllowedRef.current = true;
        readerDisplayReadyRef.current = true;
        return;
      }
    }
    lastStablePositionRef.current = transition.target;
    navigationPendingRef.current = true;
    historyCaptureAllowedRef.current = false;
    readerDisplayReadyRef.current = false;
    setReaderDisplayReady(false);
    setReaderHistory(transition.history);
    setSpineIndex(pos.spineIndex);
    setAnchor(undefined);
    setAnchorNonce((n) => n + 1);
    setInitialPage(pos.page);
    setInitialAnchor(toPersistedReaderAnchor(pos.anchor));
    handleFootnoteClose();
    closeForeground();
  }, [readerHistory, currentReaderPosition, spineIndex, handleFootnoteClose]);

  // ---- 正文笔记 ----
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

  const saveNotes = useCallback(async (next: ReaderNote[]): Promise<boolean> => {
    if (!currentShelfId || noteBusyRef.current) return false;
    const previous = currentNotes;
    noteBusyRef.current = true;
    setNoteBusy(true);
    setShelfEntries((entries) => entries.map((entry) =>
      entry.id === currentShelfId ? { ...entry, notes: next } : entry
    ));
    try {
      await getShelfStore().setNotes(currentShelfId, next);
      return true;
    } catch (error) {
      setShelfEntries((entries) => entries.map((entry) =>
        entry.id === currentShelfId ? { ...entry, notes: previous } : entry
      ));
      setRuntimeIssues((issues) => [...issues, `笔记保存失败：${String(error)}`]);
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
    if (draft.mode === "create") {
      const expectedPath = spineItemPath(book, draft.spineIndex);
      if (
        !expectedPath ||
        expectedPath !== draft.selection.chapterPath ||
        !draft.selection.startTextSnippet ||
        !draft.selection.endTextSnippet
      ) {
        setRuntimeIssues((issues) => [...issues, "选区已失效，无法保存笔记"]);
        return;
      }
      next = [...currentNotes, {
        id: `note_${now}_${Math.random().toString(36).slice(2, 9)}`,
        spineIndex: draft.spineIndex,
        chapterPath: expectedPath,
        startTextOffset: draft.selection.startTextOffset,
        endTextOffset: draft.selection.endTextOffset,
        startTextSnippet: draft.selection.startTextSnippet,
        endTextSnippet: draft.selection.endTextSnippet,
        selectedText: draft.selection.selectedText,
        content: content.trim(),
        createdAtMs: now,
        updatedAtMs: now,
      }];
    } else {
      next = currentNotes.map((note) => note.id === draft.note.id
        ? { ...note, content: content.trim(), updatedAtMs: Math.max(now, note.updatedAtMs + 1) }
        : note
      );
    }
    if (await saveNotes(next)) setForeground(closeReaderForeground());
  }, [noteComposer, book, currentShelfId, noteBusy, currentNotes, saveNotes]);

  const handleDeleteNote = useCallback(async (noteId: string): Promise<void> => {
    if (noteBusy) return;
    await saveNotes(currentNotes.filter((note) => note.id !== noteId));
  }, [noteBusy, currentNotes, saveNotes]);

  const handleNoteNavigate = useCallback((note: ReaderNote): void => {
    if (!book || noteBusy) return;
    const target = spineIndexForPath(book, note.chapterPath);
    if (target < 0 || target !== note.spineIndex) {
      setRuntimeIssues((issues) => [...issues, "笔记对应的章节已不存在"]);
      return;
    }
    const targetAnchor: PersistedReaderAnchor = {
      index: -1,
      ratio: 0,
      anchorTextOffset: note.startTextOffset,
      anchorTextSnippet: note.startTextSnippet,
    };
    const requestId = ++preciseRequestRef.current;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: target,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const snapshot = currentReaderPosition();
      if (readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: targetAnchor,
        fallbackPage: null,
      })) {
        setAnchor(undefined);
        commitReaderHistorySnapshot(snapshot);
        closePanel("notes");
        closeForeground();
        return;
      }
      showReaderNotice("未能定位笔记原文，请检查笔记锚点", "warn");
      return;
    }
    captureReaderHistory(note.chapterPath);
    navigationPendingRef.current = true;
    historyCaptureAllowedRef.current = false;
    readerDisplayReadyRef.current = false;
    setReaderDisplayReady(false);
    setInitialPage(null);
    setInitialAnchor(targetAnchor);
    latestPreciseRequestRef.current = requestId;
    setPreciseTarget({
      requestId,
      kind: "note",
      chapterPath: note.chapterPath,
    });
    setSpineIndex(target);
    setAnchor(undefined);
    setAnchorNonce((nonce) => nonce + 1);
    closePanel("notes");
    handleFootnoteClose();
    closeForeground();
  }, [
    book,
    noteBusy,
    spineIndex,
    currentReaderPosition,
    commitReaderHistorySnapshot,
    captureReaderHistory,
    handleFootnoteClose,
    showReaderNotice,
  ]);

  // ---- 书签 ----
  const currentBookmarks = currentShelfId
    ? (shelfEntries.find((entry) => entry.id === currentShelfId)?.bookmarks ?? [])
    : [];
  const isCurrentPageBookmarked =
    chapterState.status === "ready" &&
    currentBookmarks.some(
      (bookmark) =>
        bookmark.spineIndex === spineIndex && bookmark.page === chapterState.currentPage
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

  const handleToggleBookmark = useCallback(() => {
    if (!currentShelfId || chapterState.status !== "ready") return;
    const existing = currentBookmarks.find(
      (bookmark) =>
        bookmark.spineIndex === spineIndex && bookmark.page === chapterState.currentPage
    );
    let next: Bookmark[];
    if (existing) {
      next = currentBookmarks.filter((bookmark) => bookmark.id !== existing.id);
    } else {
      const anchor = readerRef.current?.getReadingAnchor();
      const text = readerRef.current?.getAnchorText() ?? "";
      next = [
        ...currentBookmarks,
        {
          id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          spineIndex,
          page: chapterState.currentPage,
          anchorIndex: anchor && anchor.index >= 0 ? anchor.index : null,
          anchorRatio: anchor && anchor.index >= 0 ? anchor.ratio : null,
          anchorTextOffset: anchor?.textOffset ?? null,
          anchorTextSnippet: anchor?.textSnippet ?? null,
          text: text.slice(0, 80),
          createdAtMs: Date.now(),
        },
      ];
    }
    // 乐观更新 UI，再落盘
    setShelfEntries((prev) =>
      prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: next } : entry))
    );
    void getShelfStore()
      .setBookmarks(currentShelfId, next)
      .then(() =>
        setShelfEntries((prev) =>
          // 后端返回的是写入时刻的完整记录；期间用户可能已经翻页，
          // 因此这里只确认书签字段，不能用旧快照覆盖乐观进度。
          prev.map((entry) =>
            entry.id === currentShelfId ? { ...entry, bookmarks: next } : entry
          )
        )
      )
      .catch((error) => setShelfError(`书签保存失败：${String(error)}`));
  }, [currentShelfId, currentBookmarks, spineIndex, chapterState]);

  const handleSelectBookmark = useCallback(
    (bookmarkId: string) => {
      setPreciseTarget(null);
      latestPreciseRequestRef.current = null;
      const bookmark = currentBookmarks.find((item) => item.id === bookmarkId);
      if (!bookmark || !book) return;
      const bookmarkAnchor = toPersistedReaderAnchor({
        index: bookmark.anchorIndex,
        ratio: bookmark.anchorRatio,
        anchorTextOffset: bookmark.anchorTextOffset,
        anchorTextSnippet: bookmark.anchorTextSnippet,
      });
      if (
        sameChapterRoute({
          currentSpineIndex: spineIndex,
          targetSpineIndex: bookmark.spineIndex,
          readerDisplayReady: readerDisplayReadyRef.current,
          navigationPending: navigationPendingRef.current,
        }) === "direct"
      ) {
        const snapshot = currentReaderPosition();
        const direct = readerRef.current?.navigateWithinCurrentChapter({
          readingAnchor: bookmarkAnchor
            ? {
                index: bookmarkAnchor.index,
                ratio: bookmarkAnchor.ratio,
                anchorTextOffset: bookmarkAnchor.anchorTextOffset,
                anchorTextSnippet: bookmarkAnchor.anchorTextSnippet,
              }
            : null,
          fallbackPage: bookmark.page,
        });
        if (direct) {
          setAnchor(undefined);
          commitReaderHistorySnapshot(snapshot);
          closeForeground();
          return;
        }
      }
      captureReaderHistory(spineItemPath(book, spineIndex) ?? "");
      navigationPendingRef.current = true;
      historyCaptureAllowedRef.current = false;
      readerDisplayReadyRef.current = false;
      setReaderDisplayReady(false);
      setSpineIndex(bookmark.spineIndex);
      setAnchor(undefined);
      setAnchorNonce((n) => n + 1);
      setInitialPage(bookmark.page ?? 0);
      setInitialAnchor(bookmarkAnchor);
      closeForeground();
    },
    [
      currentBookmarks,
      spineIndex,
      book,
      captureReaderHistory,
      currentReaderPosition,
      commitReaderHistorySnapshot,
      closeForeground,
    ]
  );

  // ---- 外部链接：Tauri 用系统默认浏览器，浏览器开发模式开新标签页 ----
  const handleExternalLink = useCallback((rawUrl: string): void => {
    const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    if (!/^(https?|mailto|tel):/i.test(url)) return;
    if (isTauriEnv()) {
      void openUrl(url).catch((err: unknown) => {
        setRuntimeIssues((prev) => [...prev, `打开外部链接失败：${String(err)}`]);
      });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, []);

  // ---- 阅读进度保存 ----
  useEffect(() => {
    if (phase.phase !== "ready" || !book) return;
    if (
      readerDisplayReady &&
      !navigationPendingRef.current &&
      chapterState.status === "ready" &&
      !chapterState.empty
    ) {
      writeProgress(bookKey, {
        spineIndex,
        page: chapterState.currentPage,
        anchor: toPersistedReaderAnchor(
          (() => {
            const a = readerRef.current?.getReadingAnchor();
            return a
              ? {
                  index: a.index,
                  ratio: a.ratio,
                  anchorTextOffset: a.textOffset,
                  anchorTextSnippet: a.textSnippet,
                }
              : null;
          })()
        ),
      });
    }
  }, [phase, book, bookKey, spineIndex, chapterState, readerDisplayReady]);

  // ---- 设置持久化 ----
  useEffect(() => {
    writeSavedSettings({
      fontSizePx: settings.fontSizePx,
      theme: settings.theme,
      uiScale,
      lineHeight: settings.lineHeight,
      fontWeight: settings.fontWeight,
      letterSpacingPx: settings.letterSpacingPx,
      wordSpacingPx: settings.wordSpacingPx,
      customFontName: settings.customFontName,
      fontSource: settings.fontSource,
      customFontId: settings.customFontId,
      customCss: settings.customCss,
      forceHorizontal: settings.forceHorizontal === true,
      preloadNextChapter: settings.preloadNextChapter === true,
      readingMode: settings.readingMode === "scroll" ? "scroll" : "paginated",
      pageMarginsPx: settings.pageMarginsPx,
      columnsPerView: settings.columnsPerView === 2 ? 2 : 1,
      gapPx: settings.gapPx,
    });
  }, [
    settings.fontSizePx,
    settings.theme,
    settings.lineHeight,
    settings.fontWeight,
    settings.letterSpacingPx,
    settings.wordSpacingPx,
    settings.customFontName,
    settings.fontSource,
    settings.customFontId,
    settings.customCss,
    settings.forceHorizontal,
    settings.preloadNextChapter,
    settings.readingMode,
    settings.pageMarginsPx,
    settings.columnsPerView,
    settings.gapPx,
    uiScale,
  ]);

  const changeTheme = (theme: Theme): void => {
    setSettings((s) => ({ ...s, theme }));
  };

  const resetDefaults = (): void => {
    setSettings({ ...DEFAULT_SETTINGS });
    setUiScale(1);
  };

  const adjustFont = (delta: number): void => {
    setSettings((s) => {
      const fontSizePx = clamp(s.fontSizePx + delta, 12, 32);
      return fontSizePx === s.fontSizePx ? s : { ...s, fontSizePx };
    });
  };

  // 排版属性步进（undefined=自动跟随书；按界面可见默认值步进，数值边界不循环）
  const LINE_HEIGHTS = [1.4, 1.6, 1.8, 2.0, 2.2];
  const FONT_WEIGHTS = [300, 400, 500, 600, 700];
  const SPACINGS = [0, 2, 4, 6, 8];
  const WORD_SPACINGS = [0, 4, 8, 12, 16];
  const adjustLineHeight = (dir: 1 | -1): void =>
    setSettings((s2) => {
      const lineHeight = stepSettingValue(LINE_HEIGHTS, s2.lineHeight, dir, 1.6);
      return lineHeight === s2.lineHeight ? s2 : { ...s2, lineHeight };
    });
  const adjustWeight = (dir: 1 | -1): void =>
    setSettings((s2) => {
      const fontWeight = stepSettingValue(FONT_WEIGHTS, s2.fontWeight, dir, 400);
      return fontWeight === s2.fontWeight ? s2 : { ...s2, fontWeight };
    });
  const adjustLetterSpacing = (dir: 1 | -1): void =>
    setSettings((s2) => {
      const letterSpacingPx = stepSettingValue(SPACINGS, s2.letterSpacingPx, dir, 0);
      return letterSpacingPx === s2.letterSpacingPx ? s2 : { ...s2, letterSpacingPx };
    });
  const adjustWordSpacing = (dir: 1 | -1): void =>
    setSettings((s2) => {
      const wordSpacingPx = stepSettingValue(WORD_SPACINGS, s2.wordSpacingPx, dir, 0);
      return wordSpacingPx === s2.wordSpacingPx ? s2 : { ...s2, wordSpacingPx };
    });

  // ---- 脚注弹层随重排重定位 ----
  useEffect(() => {
    if (!footnote) return;
    const r = readerRef.current?.getFootnoteMarkerRect();
    if (r) {
      setForeground((current) =>
        current.kind === "transient" && current.transient === "footnote"
          ? { ...current, payload: { ...current.payload, rect: r } }
          : current
      );
    } else {
      handleFootnoteClose(); // 文档被替换（字号变化等）：关闭弹层
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterState, uiScale, handleFootnoteClose]);

  // ---- 状态栏时钟（时:分） ----
  // 书架不显示时钟；在这里继续每秒 setState 会让 100+ 书籍卡片无意义地
  // 参与整棵 App 的 React 重渲染。进入阅读界面时再启动并立即校时。
  useEffect(() => {
    if (view !== "reader") return;
    clearDocumentSelection(document);
    setClock(new Date());
    const t = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(t);
  }, [view, bookKey]);

  const clockText = `${String(clock.getHours()).padStart(2, "0")}:${String(
    clock.getMinutes()
  ).padStart(2, "0")}`;

  // ---- 键盘翻页 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isSelectAllShortcut(e)) {
        e.preventDefault();
        clearDocumentSelection(document);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (e.key === "Escape") {
        closeForeground();
        return;
      }
      // 指针位于交互式浮层（脚注弹窗等）上时不翻页，滚轮/按钮交给浮层自身处理
      if (overlayHoverRef.current) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        readerRef.current?.nextPage();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        readerRef.current?.prevPage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeForeground]);

  // ---- 拖拽打开 ----
  // Tauri 环境：打包后 WebView2 会拦截原生拖放，HTML5 drop 事件不会触发，
  // 必须走 Tauri 原生 onDragDropEvent：只把文件路径交给 Rust 链接书库流式导入，WebView 不预读正文。
  // 纯浏览器环境：用 HTML5 事件兜底。
  useEffect(() => {
    if (!isTauriEnv()) {
      const prevent = (e: DragEvent): void => e.preventDefault();
      const drop = (e: DragEvent): void => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files ?? []);
        const epubFiles = files.filter((f) => f.name.toLowerCase().endsWith(".epub"));
        const fontFiles = files.filter((f) => isSupportedFontFileName(f.name));
        if (epubFiles.length > 0) {
          void handleImportSources(epubFiles.map((file) => ({ kind: "file" as const, file })));
        }
        if (fontFiles.length > 0) {
          void handleImportFonts(fontFiles);
        }
      };
      window.addEventListener("dragover", prevent);
      window.addEventListener("drop", drop);
      return () => {
        window.removeEventListener("dragover", prevent);
        window.removeEventListener("drop", drop);
      };
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let nativeDragHasEpub = false;
    let nativeDragHasFont = false;
    const isOverFontPanel = (position: { x: number; y: number }): boolean => {
      if (!fontSettingsOpen) return false;
      const panel = document.querySelector<HTMLElement>(".font-settings-panel");
      if (!panel) return false;
      return isPhysicalPointInsideRect(position, window.devicePixelRatio, panel.getBoundingClientRect());
    };
    const updateNativeDragVisual = (overFontPanel: boolean): void => {
      setFontNativeDragActive(overFontPanel);
      setDragActive(!overFontPanel && (nativeDragHasEpub || nativeDragHasFont));
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter") {
          nativeDragHasEpub = p.paths.some((path) => path.toLowerCase().endsWith(".epub"));
          nativeDragHasFont = p.paths.some((path) => isSupportedFontFileName(path));
          updateNativeDragVisual(isOverFontPanel(p.position));
        } else if (p.type === "over") {
          updateNativeDragVisual(isOverFontPanel(p.position));
        } else if (p.type === "leave") {
          nativeDragHasEpub = false;
          nativeDragHasFont = false;
          setDragActive(false);
          setFontNativeDragActive(false);
        } else if (p.type === "drop") {
          nativeDragHasEpub = false;
          nativeDragHasFont = false;
          setDragActive(false);
          setFontNativeDragActive(false);
          const fontPaths = p.paths.filter((path) => isSupportedFontFileName(path));
          const epubPaths = p.paths.filter((path) => path.toLowerCase().endsWith(".epub"));
          if (fontPaths.length > 0) {
            void handleImportFontPaths(fontPaths);
          }
          if (epubPaths.length > 0) {
            void handleImportSources(
              epubPaths.map((path) => ({
                kind: "path" as const,
                path,
                name: path.split(/[\\/]/).pop() || "book.epub",
              }))
            );
          }
        }
      })
      .then((u) => {
        if (!cancelled) unlisten = u;
      })
      .catch(() => {
        /* 非 Tauri 运行时忽略 */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fontSettingsOpen, handleImportFontPaths, handleImportSources]);

  // ---- 派生 ----
  const ready = phase.phase === "ready" && book !== null && server !== null;
  const reading = chapterState.status === "ready" && !chapterState.empty;
  const currentPath = ready ? spineItemPath(book!, spineIndex) : undefined;
  const activeHref = currentPath
    ? `${currentPath}${anchor ? `#${anchor}` : ""}`
    : undefined;
  // 阅读进度：以"标准页 = 1000 字"为尺度，按锚点所在字数位置推算
  // （标题页等短章节只占零点几个百分点，长章节按字数占大头）
  const linearIndices = book
    ? book.spine.map((item, i) => (item.linear ? i : -1)).filter((i) => i >= 0)
    : [];
  const linearPos = linearIndices.indexOf(spineIndex);
  const linearCount = linearIndices.length;
  const countSummary = book
    ? summarizeLinearCounts(chapterCountsState, spineIndex)
    : { total: 0, before: 0, current: null, complete: false, approximate: false };
  const anchorChars = (() => {
    if (!reading) return 0;
    const a = readerRef.current?.getReadingAnchor();
    return currentChapterCharsRead({
      textOffset: a?.textOffset,
      page: chapterState.currentPage,
      pageCount: chapterState.pageCount,
      chapterChars: countSummary.current ?? 0,
    });
  })();
  // 标准页口径：固定 1000 字/页，进度 = 已读标准页 / 全书标准页
  const exactProgressPct =
    reading && book
      ? (() => {
          const lastLinear = linearIndices.at(-1);
          const atBookEnd =
            countSummary.complete &&
            lastLinear === spineIndex &&
            chapterState.currentPage >= chapterState.pageCount - 1;
          return atBookEnd ? 100 : computeProgressPct(countSummary, anchorChars);
        })()
      : null;
  const progressPct = resolveProgressPct(exactProgressPct, baselineProgressPctRef.current);
  const progressLabel = !countSummary.complete
    ? "计算中"
    : countSummary.approximate
      ? `约 ${progressPct}%`
      : `${progressPct}%`;

  // ---- 书架进度回写（阅读器状态→书架索引，不修改阅读器本体） ----
  const persistShelfProgress = useCallback(() => {
    const state = chapterStateRef.current;
    if (
      navigationPendingRef.current ||
      !readerDisplayReady ||
      view !== "reader" ||
      !currentShelfId ||
      state.status !== "ready"
    ) return;
    const a = readerRef.current?.getReadingAnchor();
    const currentSummary = summarizeLinearCounts(chapterCountsRef.current, spineIndex);
    const exactChars = currentChapterCharsRead({
      textOffset: a?.textOffset,
      page: state.currentPage,
      pageCount: state.pageCount,
      chapterChars: currentSummary.current ?? 0,
    });
    const exactProgressPct =
      linearIndices.at(-1) === spineIndex && state.currentPage >= state.pageCount - 1 && currentSummary.complete
        ? 100
        : computeProgressPct(currentSummary, exactChars);
    if (exactProgressPct !== null) {
      baselineProgressPctRef.current = resolveProgressPct(
        exactProgressPct,
        baselineProgressPctRef.current
      );
    }
    const patch: ShelfProgressPatch = {
      lastReadAtMs: Date.now(),
      spineIndex,
      page: state.currentPage,
      progressPct: resolveProgressPct(exactProgressPct, baselineProgressPctRef.current),
      // -1 is an internal text-only anchor sentinel, never persisted.
      anchorIndex: a && a.index >= 0 ? a.index : null,
      anchorRatio: a && a.index >= 0 ? a.ratio : null,
      anchorTextOffset: a?.textOffset ?? null,
      anchorTextSnippet: a?.textSnippet ?? null,
    };
    // 先更新内存态：即使用户立刻返回并重新打开，也不会读到旧位置。
    setShelfEntries((prev) =>
      applyShelfProgressPatch(prev, currentShelfId, patch)
    );
    progressWriterRef.current?.enqueue(currentShelfId, patch);
  // page/anchor 变化必须触发写入；不能只依赖取整后的 progressPct，
  // 否则长书连续数页保持同一百分比时会漏掉最新位置。
  }, [view, currentShelfId, spineIndex, readerDisplayReady, chapterState]);
  persistShelfProgressRef.current = persistShelfProgress;

  useEffect(() => {
    persistShelfProgress();
  }, [persistShelfProgress]);

  // 未完成的扫描始终保持同一个 pending 状态；只有完成/可计算摘要变化时
  // 才补写一次进度，避免每章 estimated 回调反复 enqueue 相同 baseline。
  const countProgressSignature = !book
    ? "none"
    : countSummary.complete
      ? `${countSummary.total}:${countSummary.before}:${countSummary.current ?? ""}`
      : "pending";
  const persistChapterCountCache = useCallback(() => {
    const active = activeSessionRef.current;
    if (!active?.countCacheKey) return;
    writeChapterCountCache(active.countCacheKey, chapterCountsRef.current);
  }, []);
  useEffect(() => {
    if (lastCountProgressSignatureRef.current === countProgressSignature) return;
    lastCountProgressSignatureRef.current = countProgressSignature;
    persistShelfProgressRef.current();
    if (countSummary.complete) persistChapterCountCache();
  }, [countProgressSignature, countSummary.complete, persistChapterCountCache]);

  const handleBackToShelf = useCallback(async () => {
    // 返回书架前先关浮层，再释放整本书的 ResourceServer。
    closeImageOverlay();
    persistShelfProgress();
    shelfBusyRef.current = true;
    setShelfBusy(true);
    try {
      await progressWriterRef.current?.flush();
      persistChapterCountCache();
    } catch (error) {
      setShelfError(`阅读进度保存失败：${String(error)}`);
    }
    closeForeground();
    setSearchQuery("");
    setDiagText(null);
    chapterCountJobRef.current?.cancel();
    chapterCountJobRef.current = null;
    sessionGenerationRef.current++;
    activeSessionRef.current = null;
    if (bookRef.current) {
      disposeBook(bookRef.current);
      bookRef.current = null;
    }
    setCurrentShelfId(null);
    // 只先切换视图。下一次 React 提交会卸载 ReaderView；ReaderView cleanup
    // 先 dispose paginator、再 revoke ResourceServer，随后会话清理 effect
    // 才清空 book/server 等状态，避免 iframe 仍在读资源时提前撤销。
    setView("shelf");
    shelfBusyRef.current = false;
    setShelfBusy(false);
  }, [persistShelfProgress, persistChapterCountCache, closeForeground, closeImageOverlay]);

  // 视图提交后清空整本书会话状态。ResourceServer 的实际 revoke 与 Book 释放由
  // 会话退出执行，并且发生在 ReaderView 卸载与 paginator dispose 之后。
  useEffect(() => {
    if (view === "reader") return;
    chapterCountJobRef.current?.cancel();
    chapterCountJobRef.current = null;
    sessionGenerationRef.current++;
    activeSessionRef.current = null;
    serverRef.current?.revokeAll();
    serverRef.current = null;
    if (bookRef.current) {
      disposeBook(bookRef.current);
      bookRef.current = null;
    }
    if (book) {
      disposeBook(book);
    }
    setBook(null);
    setServer(null);
    setCurrentShelfId(null);
    setBookKey("");
    setSpineIndex(0);
    setAnchor(undefined);
    setAnchorNonce(0);
    setStartAtEnd({ nonce: 0, atEnd: false });
    setInitialAnchor(null);
    chapterCountsRef.current = createChapterCountCollection(
      sessionGenerationRef.current,
      []
    );
    setChapterCountsState(chapterCountsRef.current);
    setCurrentShelfId(null);
    setChapterState({ status: "loading" });
    setReaderDisplayReady(false);
    setReaderHistory(emptyReaderNavigationHistory());
    overlayHoverRef.current = false;
    closeForeground();
    setSearchNavigationBusy(false);
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    navigationPendingRef.current = false;
    historyCaptureAllowedRef.current = true;
  }, [view]);

  useEffect(() => {
    if (chapterState.status !== "error") return;
    setSearchNavigationBusy(false);
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
  }, [chapterState.status]);

  // 切到后台时尽快冲刷；Tauri 关闭窗口时等待最后位置落盘后再销毁窗口。
  useEffect(() => {
    const flushWhenHidden = (): void => {
      if (document.visibilityState !== "hidden") return;
      persistShelfProgressRef.current();
      persistChapterCountCache();
      void progressWriterRef.current?.flush().catch(() => {
        /* 后台切换不打断阅读；返回书架或关闭时会再次报告。 */
      });
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    if (!isTauriEnv()) {
      return () => document.removeEventListener("visibilitychange", flushWhenHidden);
    }

    let unlisten: (() => void) | undefined;
    let closing = false;
    const appWindow = getCurrentWindow();
    void appWindow
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        persistShelfProgressRef.current();
        persistChapterCountCache();
        try {
          await progressWriterRef.current?.flush();
          await appWindow.destroy();
        } catch (error) {
          closing = false;
          setShelfNotice({ kind: "error", text: `阅读进度保存失败：${String(error)}` });
        }
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {
        /* 非桌面窗口或关闭监听不可用时，仍保留逐页写入与 visibility flush。 */
      });
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      unlisten?.();
    };
  }, []);

  const currentChapterLabel = (() => {
    if (!ready || !currentPath) return "";
    const { path } = splitHref(currentPath);
    const walk = (nodes: import("./core/types").TocNode[]): string => {
      for (const n of nodes) {
        if (splitHref(n.href).path === path && n.label) return n.label;
        const c = walk(n.children);
        if (c) return c;
      }
      return "";
    };
    return walk(book!.toc);
  })();

  const renderUserFonts = useMemo(
    () =>
      userFonts
        .filter((f) => fontUrls[f.id])
        .map((f) => ({ family: f.family, url: fontUrls[f.id] })),
    [userFonts, fontUrls]
  );

  const crossBookPanelResults = useMemo<CrossBookPanelResult[]>(() =>
    librarySearchSnapshot.results.map((hit) => presentCrossBookHit(
      hit,
      librarySearchSnapshot.query,
      entryByContentHashRef.current.has(hit.contentHash) ? undefined : "书架中未绑定源文件",
    )), [librarySearchSnapshot.results, librarySearchSnapshot.query, libraryIndexSignature]);
  const searchPanelResults = useMemo<SearchPanelResult[]>(() =>
    searchScope === "all"
      ? crossBookPanelResults
      : searchResults.map((result) => ({
          id: `${result.spineIndex}:${result.originalRange.start}:${result.originalRange.end}:${result.matchType}`,
          chapterTitle: result.chapterTitle,
          chapterPath: result.chapterPath,
          snippet: result.snippet,
          matchRanges: result.snippetMatchRanges,
        })), [searchScope, crossBookPanelResults, searchResults]);

  const handleStartLibraryIndex = useCallback((): void => librarySearchRuntime.startIndex(), [librarySearchRuntime]);
  const handleCancelLibraryIndex = useCallback((): void => librarySearchRuntime.cancelIndex(), [librarySearchRuntime]);
  const handleDeferLibraryIndex = useCallback((): void => librarySearchRuntime.deferIndex(), [librarySearchRuntime]);
  const handleRebuildTextIndex = useCallback((): void => librarySearchRuntime.requestRebuild(), [librarySearchRuntime]);
  const handleClearTextIndex = useCallback((): void => {
    setSearchNavigationBusy(true);
    void librarySearchRuntime.clearIndex().finally(() => setSearchNavigationBusy(false));
  }, [librarySearchRuntime]);
  const loadSystemFonts = useCallback(async (): Promise<void> => {
    if (systemFontsStatus === "loading" || systemFontsStatus === "ready") return;
    setSystemFontsStatus("loading");
    setSystemFontsError(null);
    try {
      const fonts = await listSystemFonts();
      setSystemFonts(fonts);
      setSystemFontsStatus("ready");
    } catch (error) {
      setSystemFontsStatus("error");
      setSystemFontsError(String(error));
    }
  }, [systemFontsStatus]);

  const logItems: LogItem[] = [
    ...(book?.issues ?? []).map((i) => ({ kind: i.kind, source: i.source, message: i.message })),
    ...runtimeIssues.map((m) => ({ kind: "reader_error", source: "render", message: m })),
  ];

  const isReaderPanelOpen =
    menuOpen ||
    fontSettingsOpen ||
    tocOpen ||
    searchOpen ||
    notesOpen ||
    logOpen ||
    assistantOpen ||
    noteComposer !== null;

  return (
    <div
      className={`app${dragActive ? " drag-active" : ""}`}
      data-theme={settings.theme === "dark" ? "dark" : settings.theme === "sepia" ? "sepia" : undefined}
      style={{ "--ui-scale": uiScale } as CSSProperties}
    >
      <TitleBar
        view={view}
        title={view === "reader" ? (ready ? book!.metadata.title : (book?.metadata.title ?? "")) : "EPUB 阅读器"}
        onBackToShelf={view === "reader" ? handleBackToShelf : undefined}
        isBookmarked={view === "reader" && isCurrentPageBookmarked}
        onToggleBookmark={view === "reader" ? handleToggleBookmark : undefined}
        onOpenBookmarks={view === "reader" ? () => openPanel("bookmarks") : undefined}
      />
      {view === "reader" && <Toolbar
        title={ready ? book!.metadata.title : (book?.metadata.title ?? "")}
        issueCount={logItems.length}
        isPanelOpen={isReaderPanelOpen}
        onBackToShelf={view === "reader" ? handleBackToShelf : undefined}
        onHistoryBack={view === "reader" ? handleHistoryBack : undefined}
        canHistoryBack={readerHistory.back.length > 0 && readerDisplayReady && !navigationPendingRef.current}
        onHistoryForward={view === "reader" ? handleHistoryForward : undefined}
        canHistoryForward={readerHistory.forward.length > 0 && readerDisplayReady && !navigationPendingRef.current}
        onToggleBookmark={view === "reader" ? handleToggleBookmark : undefined}
        isBookmarked={view === "reader" && isCurrentPageBookmarked}
        onOpenBookmarks={view === "reader" ? () => openPanel("bookmarks") : undefined}
        onCloseBookmarks={() => closePanel("bookmarks")}
        bookmarkMenuOpen={view === "reader" && bookmarkMenuOpen}
        bookmarks={view === "reader" ? sortedBookmarks : []}
        onSelectBookmark={handleSelectBookmark}
        onOpenToc={
          view === "reader"
            ? () => openPanel("toc")
            : undefined
        }
        onOpenSearch={
          view === "reader" && ready && !book!.fixedLayout
            ? () => openPanel("search")
            : undefined
        }
        onOpenNotes={
          view === "reader" && ready
            ? () => {
                openPanel("notes");
                readerRef.current?.clearTextSelection();
              }
            : undefined
        }
        onOpenAssistant={
          shouldShowAiFoundationEntry(APP_EDITION, view)
            ? () => openPanel("assistant")
            : undefined
        }
        onToggleMenu={
          view === "reader"
            ? () => {
                if (menuOpen) closePanel("menu");
                else openPanel("menu");
              }
            : undefined
        }
        onToggleLog={view === "reader" ? handleToggleLog : undefined}
      />}
      <div className="main">
        {view === "shelf" ? (
          <div className="shelf-stack">
            {shelfError && (
              <div className="shelf-error" role="alert">
                {shelfError}
              </div>
            )}
            <ShelfView
              entries={shelfEntries}
              busy={shelfBusy}
              theme={settings.theme}
              onThemeChange={changeTheme}
              onOpen={handleShelfOpen}
              onImport={() => void handleChooseBooks()}
              onDelete={handleShelfDelete}
              onDeleteMany={handleShelfDeleteMany}
              onExportArchive={() => void handleExportArchive()}
              onImportArchive={() => void handleImportArchive()}
              thumbnailProvider={shelfThumbnailProvider}
              searchMode={shelfSearchMode}
              onSearchModeChange={(mode) => {
                setShelfSearchMode(mode);
                if (mode === "body") void librarySearchRuntime.checkIndex();
              }}
              bodySearch={{
                query: librarySearchSnapshot.query,
                onQueryChange: librarySearchRuntime.setQuery.bind(librarySearchRuntime),
                results: crossBookPanelResults,
                status: librarySearchSnapshot.searchStatus,
                processed: librarySearchSnapshot.indexSummary.indexed,
                total: librarySearchSnapshot.indexSummary.total,
                truncated: librarySearchSnapshot.results.length > 100,
                errorMessage: librarySearchSnapshot.searchError,
                navigationBusy: searchNavigationBusy,
                indexStatus: librarySearchSnapshot.indexState,
                indexProgress: {
                  total: librarySearchSnapshot.indexState === "indexing" || librarySearchSnapshot.indexState === "cancelling"
                    ? librarySearchSnapshot.indexProgress.total
                    : librarySearchSnapshot.indexSummary.total,
                  completed: librarySearchSnapshot.indexState === "indexing" || librarySearchSnapshot.indexState === "cancelling"
                    ? librarySearchSnapshot.indexProgress.completed
                    : librarySearchSnapshot.indexSummary.indexed,
                  pending: librarySearchSnapshot.indexSummary.pending,
                  currentBookTitle: librarySearchSnapshot.indexProgress.titles.join("、") || undefined,
                },
                indexErrorMessage: librarySearchSnapshot.rebuildRequested
                  ? "重新建立会清除现有全文索引，并重新处理全部可用书籍。"
                  : librarySearchSnapshot.indexError,
                onStartIndex: handleStartLibraryIndex,
                onDeferIndex: handleDeferLibraryIndex,
                onCancelIndex: handleCancelLibraryIndex,
                onRebuildIndex: handleRebuildTextIndex,
                onClearIndex: handleClearTextIndex,
                concurrencyMode: corpusConcurrencyPreference.mode,
                concurrency: corpusConcurrencyPreference.maxConcurrency,
                detectedCores: logicalCores,
                recommendedConcurrency: recommendedCorpusConcurrency,
                onConcurrencyChange: (mode, value) => {
                  setCorpusConcurrencyPreference(normalizeCorpusConcurrencyPreference({
                    mode,
                    maxConcurrency: value ?? corpusConcurrencyPreference.maxConcurrency,
                  }, logicalCores));
                },
                onSelect: (panelResult) => {
                  const result = crossBookPanelResults.find((candidate) => candidate.id === panelResult.id);
                  if (!result) return;
                  const entry = entryByContentHashRef.current.get(result.hit.contentHash);
                  if (entry) void handleShelfOpen(entry.id, result.hit, result.textHits);
                },
              }}
            />
          </div>
        ) : (
          <>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={closeForeground} />
                {fontSettingsOpen ? <FontSettingsPanel
                  source={settings.fontSource}
                  customFontId={settings.customFontId}
                  customFontName={settings.customFontName}
                  systemFonts={systemFonts}
                  userFonts={userFonts}
                  systemFontsStatus={systemFontsStatus}
                  systemFontsError={systemFontsError}
                  onLoadSystemFonts={() => void loadSystemFonts()}
                  busy={fontBusy}
                  onSelectSystem={(family) => setSettings((s) => ({ ...s, fontSource: "system", customFontName: family, customFontId: undefined }))}
                  onSelectBook={() => setSettings((s) => ({ ...s, fontSource: undefined, customFontName: undefined, customFontId: undefined }))}
                  onSelectImported={(font) => setSettings((s) => ({ ...s, fontSource: "imported", customFontId: font.id, customFontName: font.family }))}
                  onDelete={(id) => void handleDeleteFont(id)}
                  onImport={handleImportFonts}
                  nativeDragActive={fontNativeDragActive}
                  onClose={() => setForeground((current) => setMenuSubview(current, "main"))}
                /> : <MenuPanel
                  fontSize={settings.fontSizePx}
                  uiScale={uiScale}
                  theme={settings.theme}
                  lineHeight={settings.lineHeight}
                  fontWeight={settings.fontWeight}
                  letterSpacingPx={settings.letterSpacingPx}
                  wordSpacingPx={settings.wordSpacingPx}
                  customFontName={settings.customFontName}
                  customCss={settings.customCss}
                  forceHorizontal={settings.forceHorizontal === true}
                  preloadNextChapter={settings.preloadNextChapter === true}
                  preloadNextChapterDisabled={book?.fixedLayout === true}
                  readingMode={settings.readingMode === "scroll" ? "scroll" : "paginated"}
                  onReadingModeChange={(mode) =>
                    setSettings((s2) => (s2.readingMode === mode ? s2 : { ...s2, readingMode: mode }))
                  }
                  pageOptions={{
                    readingMode: settings.readingMode === "scroll" ? "scroll" : "paginated",
                    pageMarginsPx: settings.pageMarginsPx,
                    columnsPerView: settings.columnsPerView === 2 ? 2 : 1,
                    gapPx: settings.gapPx,
                  }}
                  pageEffectiveColumns={chapterState.status === "ready" ? chapterState.effectiveColumns ?? 1 : 1}
                  pageFixedLayout={book?.fixedLayout === true}
                  onPageOptionsChange={(value) =>
                    setSettings((s2) => {
                      const raw = normalizePageOptions(value);
                      const readingMode = raw.readingMode === "scroll" ? "scroll" : "paginated";
                      const columnsPerView = raw.columnsPerView === 2 ? 2 : 1;
                      if (
                        s2.readingMode === readingMode &&
                        s2.columnsPerView === columnsPerView &&
                        s2.gapPx === raw.gapPx &&
                        samePageMarginsPx(s2.pageMarginsPx, raw.pageMarginsPx)
                      ) {
                        return s2;
                      }
                      // 只覆盖页面选项字段，字体/主题等无关设置保持原值。
                      return {
                        ...s2,
                        readingMode,
                        columnsPerView,
                        gapPx: raw.gapPx,
                        pageMarginsPx: raw.pageMarginsPx,
                      };
                    })
                  }
                  userFonts={userFonts}
                  fontBusy={fontBusy}
                  onImportFont={(file) => void handleImportFont(file)}
                  onDeleteFont={(id) => void handleDeleteFont(id)}
                  onCustomFontNameChange={(name) =>
                    setSettings((s2) => ({ ...s2, customFontName: name }))
                  }
                  onCustomCssChange={(css) =>
                    setSettings((s2) => ({ ...s2, customCss: css }))
                  }
                  onOpenFontSettings={() => setForeground((current) => setMenuSubview(current, "fonts"))}
                  onForceHorizontalChange={(enabled) =>
                    setSettings((s2) => ({ ...s2, forceHorizontal: enabled }))
                  }
                  onPreloadNextChapterChange={(enabled) =>
                    setSettings((s2) => ({ ...s2, preloadNextChapter: enabled }))
                  }
                  onOpenFile={() => {
                    void handleChooseBooks();
                    closeForeground();
                  }}
                  onFontDec={() => adjustFont(-2)}
                  onFontInc={() => adjustFont(2)}
                  onFontSizeChange={(v) =>
                    setSettings((s2) => {
                      const fontSizePx = clamp(v, 12, 32);
                      return fontSizePx === s2.fontSizePx ? s2 : { ...s2, fontSizePx };
                    })
                  }
                  onLineHeightDec={() => adjustLineHeight(-1)}
                  onLineHeightInc={() => adjustLineHeight(1)}
                  onLineHeightChange={(v) =>
                    setSettings((s2) => {
                      const lineHeight = clamp(v, 1.4, 2.2);
                      return lineHeight === s2.lineHeight ? s2 : { ...s2, lineHeight };
                    })
                  }
                  onWeightDec={() => adjustWeight(-1)}
                  onWeightInc={() => adjustWeight(1)}
                  onWeightChange={(v) =>
                    setSettings((s2) => {
                      const fontWeight = clamp(v, 300, 700);
                      return fontWeight === s2.fontWeight ? s2 : { ...s2, fontWeight };
                    })
                  }
                  onLetterSpacingDec={() => adjustLetterSpacing(-1)}
                  onLetterSpacingInc={() => adjustLetterSpacing(1)}
                  onLetterSpacingChange={(v) =>
                    setSettings((s2) => {
                      const letterSpacingPx = clamp(v, 0, 8);
                      return letterSpacingPx === s2.letterSpacingPx
                        ? s2
                        : { ...s2, letterSpacingPx };
                    })
                  }
                  onWordSpacingDec={() => adjustWordSpacing(-1)}
                  onWordSpacingInc={() => adjustWordSpacing(1)}
                  onWordSpacingChange={(v) =>
                    setSettings((s2) => {
                      const wordSpacingPx = clamp(v, 0, 16);
                      return wordSpacingPx === s2.wordSpacingPx ? s2 : { ...s2, wordSpacingPx };
                    })
                  }
                  onUiScaleChange={(v) => setUiScale(clamp(v, 0.75, 1.5))}
                  onThemeChange={changeTheme}
                  onResetDefaults={resetDefaults}
                  onClose={closeForeground}
                  issueCount={logItems.length}
                  onToggleLog={handleToggleLog}
                />}
              </>
            )}
            {ready ? (
              <>
                {tocOpen && (
                  <>
                    <div className="toc-backdrop" onClick={() => closePanel("toc")} />
                    <TocPanel
                      toc={book!.toc}
                      activeHref={activeHref}
                      onNavigate={handleTocNavigate}
                      onClose={() => closePanel("toc")}
                    />
                  </>
                )}
                {searchOpen && (
                  <>
                    <div className="search-backdrop" onClick={() => closePanel("search")} />
                    <SearchPanel
                      query={searchScope === "all" ? librarySearchSnapshot.query : searchQuery}
                      onQueryChange={searchScope === "all" ? librarySearchRuntime.setQuery.bind(librarySearchRuntime) : setSearchQuery}
                      scope={searchScope}
                      onScopeChange={(scope) => {
                        searchAbortRef.current?.abort();
                        searchAbortRef.current = null;
                        searchGenerationRef.current++;
                        setSearchScope(scope);
                        setSearchResults([]);
                        setSearchStatus("idle");
                        setSearchError(undefined);
                        if (scope === "all") void librarySearchRuntime.checkIndex();
                      }}
                      results={searchPanelResults}
                      status={searchScope === "all" ? librarySearchSnapshot.searchStatus : searchStatus}
                      processed={searchScope === "all" ? librarySearchSnapshot.indexSummary.indexed : searchProgress.processed}
                      total={searchScope === "all" ? librarySearchSnapshot.indexSummary.total : searchProgress.total}
                      truncated={(searchScope === "all" ? librarySearchSnapshot.results.length : searchResults.length) > 100}
                      errorMessage={searchScope === "all" ? librarySearchSnapshot.searchError : searchError}
                      navigationBusy={searchNavigationBusy}
                      indexStatus={searchScope === "all" ? librarySearchSnapshot.indexState : undefined}
                      indexProgress={searchScope === "all" ? {
                        total: librarySearchSnapshot.indexState === "indexing" || librarySearchSnapshot.indexState === "cancelling"
                          ? librarySearchSnapshot.indexProgress.total
                          : librarySearchSnapshot.indexSummary.total,
                        completed: librarySearchSnapshot.indexState === "indexing" || librarySearchSnapshot.indexState === "cancelling"
                          ? librarySearchSnapshot.indexProgress.completed
                          : librarySearchSnapshot.indexSummary.indexed,
                        pending: librarySearchSnapshot.indexSummary.pending,
                        currentBookTitle: librarySearchSnapshot.indexProgress.titles.join("、") || undefined,
                      } : undefined}
                      indexErrorMessage={librarySearchSnapshot.rebuildRequested
                          ? "重新建立会清除现有全文索引，并重新处理全部可用书籍。"
                          : librarySearchSnapshot.indexError}
                      onStartIndex={searchScope === "all" ? handleStartLibraryIndex : undefined}
                      onDeferIndex={searchScope === "all" ? handleDeferLibraryIndex : undefined}
                      onCancelIndex={searchScope === "all" ? handleCancelLibraryIndex : undefined}
                      onRebuildIndex={searchScope === "all" ? handleRebuildTextIndex : undefined}
                      onClearIndex={searchScope === "all" ? handleClearTextIndex : undefined}
                      concurrencyMode={searchScope === "all" ? corpusConcurrencyPreference.mode : undefined}
                      concurrency={searchScope === "all" ? corpusConcurrencyPreference.maxConcurrency : undefined}
                      detectedCores={searchScope === "all" ? logicalCores : undefined}
                      recommendedConcurrency={searchScope === "all" ? recommendedCorpusConcurrency : undefined}
                      onConcurrencyChange={searchScope === "all" ? (mode, value) => {
                        setCorpusConcurrencyPreference(normalizeCorpusConcurrencyPreference({
                          mode,
                          maxConcurrency: value ?? corpusConcurrencyPreference.maxConcurrency,
                        }, logicalCores));
                      } : undefined}
                      onSelect={(panelResult) => {
                        if (searchScope === "all") {
                          const crossResult = crossBookPanelResults.find((candidate) => candidate.id === panelResult.id);
                          if (!crossResult) return;
                          const entry = entryByContentHashRef.current.get(crossResult.hit.contentHash);
                          if (entry) void handleShelfOpen(entry.id, crossResult.hit, crossResult.textHits);
                          return;
                        }
                        const result = searchResults.find((candidate) =>
                          `${candidate.spineIndex}:${candidate.originalRange.start}:${candidate.originalRange.end}:${candidate.matchType}` === panelResult.id
                        );
                        if (result) handleSearchNavigate(result);
                      }}
                      onCancel={searchScope === "current" ? () => {
                        searchAbortRef.current?.abort();
                        searchAbortRef.current = null;
                        searchGenerationRef.current++;
                        setSearchResults([]);
                        setSearchStatus("idle");
                        setSearchProgress({ processed: 0, total: 0 });
                      } : undefined}
                      onClose={() => closePanel("search")}
                    />
                  </>
                )}
                {notesOpen && (
                  <>
                    <div className="notes-backdrop" onClick={() => closePanel("notes")} />
                    <NotesPanel
                      notes={noteViewModels}
                      onClose={() => closePanel("notes")}
                      onNavigate={(viewNote) => {
                        const note = currentNotes.find((candidate) => candidate.id === viewNote.id);
                        if (note) handleNoteNavigate(note);
                      }}
                      onEdit={(viewNote) => {
                        const note = currentNotes.find((candidate) => candidate.id === viewNote.id);
                        if (!note) return;
                         openComposer({ mode: "edit", note });
                      }}
                      onDelete={(viewNote) => void handleDeleteNote(viewNote.id)}
                    />
                  </>
                )}
                {assistantOpen && LazyAiFoundationPanel && (
                  <>
                    <div className="ai-backdrop" onClick={() => closePanel("assistant")} aria-hidden="true" />
                    <Suspense fallback={<aside className="ai-foundation-panel" role="status">正在加载 AI 开发面板…</aside>}>
                      <LazyAiFoundationPanel
                        snapshot={aiRuntimeSnapshot}
                        preparation={book && currentShelfId ? {
                          book, fingerprint: contentHashByIdRef.current.get(currentShelfId) ?? currentShelfId,
                          readingBusy: readerPriorityBusyRef.current, onNavigate: handleSearchNavigate,
                        } : undefined}
                        semantic={book && currentShelfId ? {
                          book, fingerprint: contentHashByIdRef.current.get(currentShelfId) ?? currentShelfId,
                          readingBusy: readerPriorityBusyRef.current, onNavigate: handleSearchNavigate,
                        } : undefined}
                        onEnable={enableAi}
                        onDisable={disableAi}
                        onClose={() => closePanel("assistant")}
                      />
                    </Suspense>
                  </>
                )}
                <ReaderView
                  key={bookKey}
                  ref={readerRef}
                  book={book!}
                  server={server!}
                  spineIndex={spineIndex}
                  anchor={anchor}
                  anchorNonce={anchorNonce}
                  settings={settings}
                  userFonts={renderUserFonts}
                  notes={currentChapterNotes}
                  onSelectionContextMenu={(payload) => {
                    if (!payload) {
                      setForeground((current) =>
                        current.kind === "transient" && current.transient === "selection"
                          ? closeReaderForeground()
                          : current
                      );
                      return;
                    }
                     openTransient("selection", payload);
                  }}
                  onPageState={onPageState}
                  onDisplayReady={handleReaderDisplayReady}
                  onRequestChapter={handleRequestChapter}
                  onIssues={handleIssues}
                  onInternalLink={handleInternalNavigate}
                  onBeforeInternalNavigate={captureReaderHistory}
                  onInternalNavigationSettled={handleReaderDisplayReady}
                  onExternalLink={handleExternalLink}
                   onFootnote={(payload) => openTransient("footnote", payload)}
                  onFootnoteClose={handleFootnoteClose}
                  onImageActivation={handleImageActivation}
                  inputPaused={imageRequest !== null}
                  initialAnchor={initialAnchor}
                  initialPage={initialPage}
                  startAtEnd={startAtEnd}
                  preciseTarget={preciseTarget}
                  onPreciseNavigationStatus={handlePreciseNavigationStatus}
                />
                <ImageViewer
                  image={imageRequest}
                  onClose={closeImageOverlay}
                  onFollowLink={(image) => {
                    // 带链接的图片：交回既有链接路由，不直接 window.open。
                    const href = image.linkHref;
                    closeImageOverlay();
                    if (href) handleInternalNavigate(href);
                  }}
                />
                {selectionContext && (
                  <ReaderContextMenu
                    selection={{ ...selectionContext, text: selectionContext.selectedText }}
                    position={{ x: selectionContext.rect.right + 6, y: selectionContext.rect.bottom + 6 }}
                    onCopy={(text) => {
                      void navigator.clipboard.writeText(text).catch((error) =>
                        setRuntimeIssues((issues) => [...issues, `复制失败：${String(error)}`])
                      );
                      closeForeground();
                      readerRef.current?.clearTextSelection();
                    }}
                    onAddNote={() => {
                       openComposer({ mode: "create", selection: selectionContext, spineIndex });
                      readerRef.current?.clearTextSelection();
                    }}
                    onClose={() => {
                      setForeground(closeReaderForeground());
                      readerRef.current?.clearTextSelection();
                    }}
                  />
                )}
                {noteComposer && (
                  <>
                    <div className="note-composer-backdrop" aria-hidden="true" />
                    <NoteComposer
                      mode={noteComposer.mode}
                      selectedText={noteComposer.mode === "create" ? noteComposer.selection.selectedText : noteComposer.note.selectedText}
                      initialContent={noteComposer.mode === "edit" ? noteComposer.note.content : undefined}
                      onSave={(content) => void handleSaveNote(content)}
                      onCancel={closeForeground}
                    />
                  </>
                )}
              </>
            ) : (
              <div className={`placeholder ${phase.phase === "error" ? "error" : ""}`}>
                {phase.phase === "idle" && <div className="big">正在准备书架…</div>}
                {phase.phase === "loading" && <div>正在打开《{phase.fileName}》…</div>}
                {phase.phase === "error" && (
                  <>
                    <div className="big">无法打开</div>
                    <div>{phase.message}</div>
                    <button onClick={() => void handleChooseBooks()}>重新选择文件</button>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {footnote && (
          <FootnotePop
            text={footnote.text}
            html={footnote.html}
            pinned={footnote.pinned}
            rect={footnote.rect}
            onClose={handleFootnoteClose}
            onExternalLink={handleExternalLink}
            onAnchor={handleFootnoteAnchor}
            onHoverChange={(over) => {
              overlayHoverRef.current = over;
              readerRef.current?.setFootnoteOverlayHover(over);
            }}
          />
        )}
      </div>
      {view === "reader" && ready && (
        <div className="status-bar">
          <span className="sb-clock">{clockText}</span>
          <span className="sb-title" title={currentChapterLabel}>
            {currentChapterLabel || book!.metadata.title}
          </span>
          <div className="sb-trailing">
            <span className="sb-progress">
              {reading
                ? settings.readingMode === "scroll"
                  ? `本章 ${Math.round((chapterState.scrollProgress ?? 0) * 100)}% · 章 ${linearPos + 1}/${linearCount} · ${progressLabel}`
                : `第 ${chapterState.currentPage + 1}/${chapterState.pageCount} 页 · 章 ${linearPos + 1}/${linearCount} · ${progressLabel}`
              : "加载中…"}
            </span>

          </div>
        </div>
      )}
      {logOpen && (
        <>
          <div
            className="log-backdrop"
            onClick={() => {
              closePanel("log");
              setDiagText(null);
            }}
          />
          <LogPanel
            items={logItems}
            diagText={diagText}
            onClose={() => {
              closePanel("log");
              setDiagText(null);
            }}
          />
        </>
      )}
      {(shelfNotice || readerNotice) && (
        <div
          className={`shelf-toast ${(shelfNotice ?? readerNotice)!.kind}${(shelfNotice ? shelfNoticeFading : readerNoticeFading) ? " fading" : ""}`}
          role="status"
        >
          {(shelfNotice ?? readerNotice)!.text}
        </div>
      )}
      {shelfBusy && (
        <div className="app-busy" aria-busy="true">
          <div className="app-busy-spinner" />
          <div className="app-busy-text">正在处理…</div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".epub,application/epub+zip"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) {
            void handleImportSources(files.map((file) => ({ kind: "file" as const, file })));
          }
          e.target.value = "";
        }}
      />
    </div>
  );
}
