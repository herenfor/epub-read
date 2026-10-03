import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { loadBook, spineIndexForPath, spineItemPath, DrmError, disposeBook, nextLinearIndex } from "./core/book";
import type { Book } from "./core/types";
import type { Annotation, Stamp, Version } from "./core/portableState/portable-register-core";
import { compareStamp } from "./core/portableState/portable-register-core";
import { latestVersion, projectProgressVersion, versionForStamp } from "./core/portableState/projection";
import type { Locator, NoteValue, ProgressValue } from "./core/portableState/portable-state-types";
import { isExternalUrl, isFragmentOnly, resolvePath, splitHref } from "./core/paths";
import {
  createSearchSession,
  type SearchResult,
  type SearchSession,
} from "./core/search";
import type { ExactTextHit } from "./core/exactTextHits";
import type { SearchOccurrence } from "./core/searchOccurrence";
import { ResourceServer } from "./render/resources";
import { sanitizePersistedTextAnchor } from "./render/textAnchor";
import { clearDocumentSelection, isSelectAllShortcut } from "./render/selectionGuard";
import {
  DEFAULT_SETTINGS,
  type ReaderSettings,
  type Theme,
} from "./render/settings";
import type { ChapterState, MediaReadingAnchor, PreciseNavigationStatus, ReadingAnchor } from "./render/paginator";
import { DEFAULT_PAGE_GAP_PX, normalizePageOptions } from "./render/pageLayout";
import type { ImageViewRequest } from "./render/imageActivation";
import { ImageViewer } from "./ui/ImageViewer";
import { TitleBar } from "./ui/TitleBar";
import {
  createNativeFullscreenController,
  type NativeFullscreenController,
  type NativeFullscreenPort,
} from "./ui/windowFullscreen";
import { getRuntimeCapabilities } from "./platform/runtimeCapabilities";
import { useAndroidBack } from "./platform/useAndroidBack";
import { SidebarDrawer, type SidebarMode, type SidebarTab } from "./ui/SidebarDrawer";
import { AaPopover } from "./ui/AaPopover";
import { AboutInfo } from "./ui/AboutInfo";
import { resolveReaderLoadFeedback } from "./ui/loadingFeedback";
import { WhisperFooter, type WhisperFooterChapterTick } from "./ui/WhisperFooter";
import { useResponsiveEnvironment } from "./ui/responsiveEnvironment";
import { shouldConfirmNoteDiscard } from "./ui/readerCloseGuards";
import {
  createContentAxis,
  reduceScrubUi,
  initialScrubUi,
  type ContentAxis,
  type ScrubUiState,
  type ScrubUiEvent,
  type ScrubToken,
  type AxisInput,
} from "./ui/readerProgressAxis";
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
import type { NoteViewModel } from "./ui/NotesPanel";
import type { ReaderNote } from "./ui/notes";
import { createLazyFontController } from "./ui/fontRuntime";
import { FootnotePop } from "./ui/FootnotePop";
import { LogPanel, type LogItem } from "./ui/LogPanel";
import { ReaderView, type ReaderHandle } from "./ui/ReaderView";
import type { ReaderNoteForPaginator } from "./render/paginator";
import { ShelfView } from "./ui/ShelfView";
import { NativeImportPanel, type NativeImportCancelState } from "./ui/NativeImportPanel";
import {
  cancelDocumentImport,
  importDocuments,
  readContentUriText,
  writeTextContentUri,
  type AndroidDocumentSelection,
  type AndroidImportBatchResult,
  type AndroidNativeImportError,
} from "./platform/androidNativeBridge";
import {
  activatePortableShelfState,
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
  emptyOrganization,
  generateFolderId,
  type LibraryOrganization,
  type OrganizationCommand,
  type ShelfScope,
} from "./ui/libraryOrganization";
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
import { isPhysicalPointInsideRect, isSupportedFontFileName } from "./ui/fontDrop";
import { createFontImportController } from "./ui/fontImport";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, stat as statFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import { IS_AI_EDITION } from "./config/edition";

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

function displayNameFromContentUri(uri: string): string {
  try {
    const last = decodeURIComponent(uri.split("/").filter(Boolean).pop() ?? "");
    const base = last.split(/[\\/]/).pop() ?? "";
    return base || "选中文件";
  } catch {
    return "选中文件";
  }
}

function createNativeImportRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `android-import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  /** B-155：纯图片页的可选媒体身份/比例；旧记录可读，缺省即低精度。 */
  mediaAnchor?: MediaReadingAnchor | null;
};

function sanitizeMediaAnchor(value: unknown): MediaReadingAnchor | null {
  if (!value || typeof value !== "object") return null;
  const media = value as Partial<MediaReadingAnchor>;
  if (
    !Number.isSafeInteger(media.index) ||
    (media.index as number) < 0 ||
    typeof media.tag !== "string" ||
    media.tag.length === 0 ||
    typeof media.signature !== "string" ||
    media.signature.length === 0 ||
    typeof media.ratio !== "number" ||
    !Number.isFinite(media.ratio) ||
    media.ratio < 0 ||
    media.ratio > 1
  ) {
    return null;
  }
  return {
    index: media.index as number,
    tag: media.tag,
    signature: media.signature,
    ratio: media.ratio,
  };
}

function toPersistedReaderAnchor(value: {
  index?: number | null;
  ratio?: number | null;
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
  mediaAnchor?: MediaReadingAnchor | null;
} | null | undefined): PersistedReaderAnchor | null {
  if (!value) return null;
  const text = sanitizePersistedTextAnchor({
    textOffset: value.anchorTextOffset,
    textSnippet: value.anchorTextSnippet,
  });
  const mediaAnchor = sanitizeMediaAnchor(value.mediaAnchor);
  const legacy =
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.ratio === "number" &&
    Number.isFinite(value.ratio) &&
    value.ratio >= 0 &&
    value.ratio <= 1;
  if (!legacy && text.textOffset === null && !mediaAnchor) return null;
  return {
    index: legacy ? value.index! : -1,
    ratio: legacy ? value.ratio! : (mediaAnchor?.ratio ?? 0),
    anchorTextOffset: text.textOffset,
    anchorTextSnippet: text.textSnippet,
    mediaAnchor,
  };
}

type PortableProgressChoiceCandidate = {
  readonly stamp: Stamp;
  readonly version: Version<ProgressValue>;
  readonly chapterPath: string | null;
  readonly spineIndex: number;
  readonly progressPct: number;
  readonly updatedAtMs: number;
};

function portableProgressVersions(entry: ShelfEntry): readonly Version<ProgressValue>[] {
  return (entry as unknown as { readonly portableProgressVersions?: readonly Version<ProgressValue>[] })
    .portableProgressVersions ?? [];
}

function portableLocatorOf(entry: ShelfEntry): Locator | null {
  return (entry as unknown as { readonly portableLocator?: Locator | null }).portableLocator ?? null;
}

function portableNoteAnnotations(entry: ShelfEntry): Readonly<Record<string, Annotation<NoteValue>>> {
  return (entry as unknown as {
    readonly portableNoteAnnotations?: Readonly<Record<string, Annotation<NoteValue>>>;
  }).portableNoteAnnotations ?? {};
}

function legacySavedProgress(entry: ShelfEntry): SavedProgress {
  return {
    spineIndex: Number.isSafeInteger(entry.spineIndex) ? entry.spineIndex : 0,
    page: Number.isSafeInteger(entry.page) ? entry.page : 0,
    anchor: readingAnchorFromShelfEntry(entry),
  };
}

function savedProgressFromPortableLocator(
  book: Book,
  locator: Locator,
  fallback: SavedProgress,
): SavedProgress {
  if (locator.locatorVersion !== 1) return fallback;
  const targetIndex = spineIndexForPath(book, locator.chapterPath);
  if (targetIndex < 0) {
    throw new Error("保存的阅读位置对应章节已失效，未按默认章节打开");
  }
  const target = locator.target;
  if (target.kind === "chapter-start") {
    return { spineIndex: targetIndex, page: 0, anchor: null };
  }
  if (target.kind === "text") {
    const anchor = toPersistedReaderAnchor({
      index: -1,
      ratio: 0,
      anchorTextOffset: target.offset,
      anchorTextSnippet: target.snippet,
    });
    if (!anchor) throw new Error("保存的文本锚点无效，未按默认位置打开");
    return { spineIndex: targetIndex, page: 0, anchor };
  }
  const anchor = toPersistedReaderAnchor({
    index: -1,
    ratio: target.ratio,
    mediaAnchor: {
      index: target.indexHint,
      tag: target.tag,
      signature: target.signature,
      ratio: target.ratio,
    },
  });
  if (!anchor) throw new Error("保存的媒体锚点无效，未按默认位置打开");
  return { spineIndex: targetIndex, page: 0, anchor };
}

function savedProgressFromShelfEntry(book: Book, entry: ShelfEntry): SavedProgress {
  const locator = portableLocatorOf(entry);
  const fallback = legacySavedProgress(entry);
  return locator ? savedProgressFromPortableLocator(book, locator, fallback) : fallback;
}

function savedProgressFromVersion(book: Book, version: Version<ProgressValue>): SavedProgress {
  const projection = projectProgressVersion(version);
  const fallback: SavedProgress = {
    spineIndex: projection.spineIndex,
    page: projection.page,
    anchor: toPersistedReaderAnchor({
      index: projection.anchorIndex,
      ratio: projection.anchorRatio,
      anchorTextOffset: projection.anchorTextOffset,
      anchorTextSnippet: projection.anchorTextSnippet,
      mediaAnchor: projection.mediaAnchor,
    }),
  };
  const value = version.value;
  if (!value) return fallback;
  return savedProgressFromPortableLocator(book, value.locator, fallback);
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

type ImportSource =
  | { kind: "file"; file: File }
  | { kind: "path"; path: string; name: string };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  const runtime = getRuntimeCapabilities();
  const responsive = useResponsiveEnvironment();
  const mobileChrome = responsive.touchUi;
  const phoneChrome = mobileChrome && responsive.layout === "compact";
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
        spreadGapMode: saved.spreadGapMode,
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
  const [initialAlignment, setInitialAlignment] = useState<"reading-line" | "context">("context");
  /** 正文图片浮层请求；null = 未打开。 */
  const [imageRequest, setImageRequest] = useState<ImageViewRequest | null>(null);
  const imageRequestRef = useRef<ImageViewRequest | null>(null);
  const [preciseTarget, setPreciseTarget] = useState<{
    requestId: number;
    kind: "search" | "note";
    chapterPath: string;
    textHits?: ExactTextHit[];
    occurrence?: SearchOccurrence;
  } | null>(null);
  const [progressChoice, setProgressChoice] = useState<{
    title: string;
    candidates: readonly PortableProgressChoiceCandidate[];
  } | null>(null);
  const progressChoiceResolverRef = useRef<((stamp: Stamp | null) => void) | null>(null);
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
  /** 统一固定内容轴：全书结构统计完成后冻结，跨模式、跨字号保持映射稳定 */
  const [contentAxis, setContentAxis] = useState<ContentAxis | null>(null);
  const contentAxisRef = useRef<ContentAxis | null>(null);
  const scrubSessionRef = useRef(0);
  const scrubRequestIdRef = useRef(0);
  const [scrubUiState, setScrubUiState] = useState<ScrubUiState>(() => initialScrubUi(0));
  const scrubUiStateRef = useRef(scrubUiState);
  scrubUiStateRef.current = scrubUiState;

  const dispatchScrub = useCallback((event: ScrubUiEvent) => {
    setScrubUiState((prev) => {
      const next = reduceScrubUi(prev, event);
      scrubUiStateRef.current = next;
      return next;
    });
  }, []);

  const [dragActive, setDragActive] = useState(false);
  const [fontNativeDragActive, setFontNativeDragActive] = useState(false);
  // ---- 书架 ----
  const [view, setView] = useState<"shelf" | "reader">("shelf");
  const [readerToolsVisible, setReaderToolsVisible] = useState(true);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [shelfBackActive, setShelfBackActive] = useState(false);
  const shelfBackHandlerRef = useRef<(() => boolean) | null>(null);
  const noteComposerDirtyRef = useRef(false);
  const [shelfEntries, setShelfEntries] = useState<ShelfEntry[]>([]);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const [shelfNotice, setShelfNotice] = useState<{
    kind: "ok" | "warn" | "error";
    text: string;
  } | null>(null);
  const [shelfNoticeFading, setShelfNoticeFading] = useState(false);
  const [shelfBusy, setShelfBusy] = useState(false);
  const [shelfBusyMessage, setShelfBusyMessage] = useState("正在处理…");
  const [nativeImport, setNativeImport] = useState<{
    requestId: string;
    phase: "starting" | "preparing" | "committing";
    completed: number;
    total: number;
    cancelState: NativeImportCancelState;
    collapsed: boolean;
    fileNameSummary: string;
  } | null>(null);
  const nativeImportRef = useRef<string | null>(null);
  const [currentShelfId, setCurrentShelfId] = useState<string | null>(null);
  const shelfBusyRef = useRef(false);
  const shelfEntriesRef = useRef<ShelfEntry[]>([]);
  shelfEntriesRef.current = shelfEntries;
  const currentShelfIdRef = useRef<string | null>(null);
  currentShelfIdRef.current = currentShelfId;
  // ---- 收藏与文件夹 ----
  const [organization, setOrganization] = useState<LibraryOrganization>(emptyOrganization);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [shelfScope, setShelfScope] = useState<ShelfScope>({ type: "root" });
  const organizationRef = useRef<LibraryOrganization>(organization);
  organizationRef.current = organization;
  const organizationBusyRef = useRef(false);
  // ---- 阅读跳转历史（后退/前进各最多 3 步） ----
  const [readerHistory, setReaderHistory] = useState<ReaderNavigationHistory>(
    emptyReaderNavigationHistory
  );
  // ---- 书签反馈轻量弹窗 ----
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

  /** 统一前景关闭入口：笔记未保存时确认放弃，其他层直接关闭。 */
  const requestCloseForeground = useCallback((): void => {
    const current = foregroundRef.current;
    if (shouldConfirmNoteDiscard(current, noteComposerDirtyRef.current)) {
      if (typeof window !== "undefined" && !window.confirm("放弃未保存的笔记？")) return;
    }
    closeForeground();
  }, [closeForeground]);

  // ---- 统一抽屉（Zen UI Packet B） ----
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("toc");
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("left");
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("overlay");
  const [sidebarPinned, setSidebarPinned] = useState(false);

  // 手机窄窗只派生 overlay 呈现，保留用户的 dock/pinned 偏好，放宽后恢复。
  const effectiveSidebarMode: SidebarMode = phoneChrome ? "overlay" : sidebarMode;

  const isSidebarOpen =
    view === "reader" &&
    ((effectiveSidebarMode === "docked" && sidebarPinned) ||
      (foreground.kind === "panel" &&
        (foreground.panel === "toc" || foreground.panel === "bookmarks" || foreground.panel === "notes")));

  const activeSidebarTab: SidebarTab = (() => {
    if (foreground.kind === "panel") {
      if (foreground.panel === "toc") return "toc";
      if (foreground.panel === "bookmarks") return "bookmarks";
      if (foreground.panel === "notes") return "notes";
    }
    return sidebarTab;
  })();

  const isDockedSidebar = view === "reader" && effectiveSidebarMode === "docked" && sidebarPinned;

  const handleSidebarTabChange = useCallback((tab: SidebarTab) => {
    setSidebarTab(tab);
    if (effectiveSidebarMode === "overlay") {
      openPanel(tab);
    }
  }, [effectiveSidebarMode, openPanel]);

  const handleSidebarModeChange = useCallback((mode: SidebarMode) => {
    setSidebarMode(mode);
    if (mode === "docked") {
      setSidebarPinned(true);
      if (
        foregroundRef.current.kind === "panel" &&
        (foregroundRef.current.panel === "toc" ||
          foregroundRef.current.panel === "bookmarks" ||
          foregroundRef.current.panel === "notes")
      ) {
        closeForeground();
      }
    } else {
      setSidebarPinned(false);
      openPanel(sidebarTab);
    }
  }, [sidebarTab, openPanel, closeForeground]);

  const handleSidebarClose = useCallback(() => {
    if (!phoneChrome && sidebarMode === "docked") {
      setSidebarPinned(false);
    }
    closeForeground();
  }, [closeForeground, phoneChrome, sidebarMode]);

  /** 键盘/返回键关闭当前可见层；笔记模态先走统一 dirty 确认。 */
  const requestCloseCurrentSurface = useCallback((): void => {
    const current = foregroundRef.current;
    if (current.kind === "modal" && current.modal === "note-composer") {
      requestCloseForeground();
      return;
    }
    if (isSidebarOpen) {
      handleSidebarClose();
      return;
    }
    requestCloseForeground();
  }, [handleSidebarClose, isSidebarOpen, requestCloseForeground]);

  const handleToggleSidebar = useCallback((side?: "left" | "right") => {
    const targetSide = side || "left";
    if (isSidebarOpen && sidebarSide === targetSide) {
      handleSidebarClose();
    } else {
      setSidebarSide(targetSide);
      if (effectiveSidebarMode === "docked") {
        setSidebarPinned(true);
      } else {
        openPanel(sidebarTab);
      }
    }
  }, [isSidebarOpen, sidebarSide, handleSidebarClose, effectiveSidebarMode, sidebarTab, openPanel]);

  const handleOpenBookmarks = useCallback(() => {
    setSidebarSide("right");
    setSidebarTab("bookmarks");
    if (effectiveSidebarMode === "docked") {
      setSidebarPinned(true);
    } else {
      openPanel("bookmarks");
    }
  }, [effectiveSidebarMode, openPanel]);

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
  const hasReaderDisplayedRef = useRef(false);
  /** 语义锚点失败后先结束 loading，但禁止把失败落点当作成功进度写盘。 */
  const suppressShelfProgressRef = useRef(false);
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
      contentAxisRef.current = null;
      setContentAxis(null);
      scrubSessionRef.current += 1;
      dispatchScrub({ type: "reset", session: scrubSessionRef.current });
      const start = clamp(saved?.spineIndex ?? firstLinear(b), 0, b.spine.length - 1);
      setBook(b);
      setServer(srv);
      setBookKey(key);
      setRuntimeIssues([]);
      setChapterState({ status: "loading" });
      hasReaderDisplayedRef.current = false;
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
    setShelfBusyMessage("正在导入书籍…");
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

            const b = await loadBook(buf, { selective: true });
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

  const runNativeDocumentImport = useCallback(async (
    documents: AndroidDocumentSelection[],
    options: { silentError?: boolean } = {}
  ): Promise<AndroidImportBatchResult | null> => {
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: "已有导入任务正在进行，请等待当前任务结束" });
      return null;
    }
    const requestId = createNativeImportRequestId();
    nativeImportRef.current = requestId;
    setNativeImport({
      requestId,
      phase: "starting",
      completed: 0,
      total: documents.length,
      cancelState: "idle",
      collapsed: false,
      fileNameSummary: documents.length === 1 ? "1 本 EPUB" : `${documents.length} 个文件`,
    });
    try {
      return await importDocuments(requestId, documents, (progress) => {
        setNativeImport((previous) => (
          previous && previous.requestId === progress.requestId
            ? { ...previous, phase: progress.phase, completed: progress.completed, total: progress.total }
            : previous
        ));
      });
    } catch (error) {
      const nativeError = error as AndroidNativeImportError;
      if (nativeError.requiresReload) {
        try {
          const entries = await getShelfStore().list();
          setShelfEntries(entries);
        } catch {
          // Keep the error visible even if the refresh fails.
        }
      }
      if (!options.silentError) {
        setShelfNotice({ kind: "error", text: `导入失败：${nativeError.message}` });
      }
      return null;
    } finally {
      nativeImportRef.current = null;
      setNativeImport(null);
    }
  }, []);

  const applyNativeImportBatch = useCallback(async (batch: AndroidImportBatchResult, documents: AndroidDocumentSelection[]): Promise<void> => {
    const imported: ShelfEntry[] = [];
    const duplicateTitles: string[] = [];
    const failed: string[] = [];
    const cancelled: string[] = [];
    for (const item of batch.results) {
      const document = documents[item.inputIndex];
      const label = document ? displayNameFromContentUri(document.uri) : `第 ${item.inputIndex + 1} 本`;
      if (item.status === "failed") {
        failed.push(`${label}：${item.error || "导入失败"}`);
        continue;
      }
      if (item.status === "cancelled") {
        cancelled.push(label);
        continue;
      }
      if (!item.record) {
        failed.push(`${label}：后端未返回书架记录`);
        continue;
      }
      contentHashByIdRef.current.set(item.record.id, item.record.contentHash ?? item.record.id);
      entryByContentHashRef.current.set(item.record.contentHash ?? item.record.id, item.record);
      if (item.status === "duplicate") {
        duplicateTitles.push(item.record.title || label);
      } else {
        imported.push(item.record);
      }
    }
    if (imported.length > 0) {
      await getShelfStore().importRecords?.(imported);
      setShelfEntries((previous) => mergeShelfEntries(previous, imported));
    }
    const notice = formatImportNotice({
      sourceCount: documents.length,
      importedCount: imported.length,
      duplicateTitles,
      failed,
    });
    if (cancelled.length > 0) {
      notice.text += `；已取消 ${cancelled.length} 本`;
      if (notice.kind === "ok") notice.kind = "warn";
    }
    setShelfNotice(notice);
  }, []);

  const handleCancelNativeImport = useCallback(async (): Promise<void> => {
    const current = nativeImport;
    if (!current || current.phase !== "preparing" || current.cancelState !== "idle") return;
    setNativeImport((previous) => (
      previous && previous.requestId === current.requestId
        ? { ...previous, cancelState: "requesting" }
        : previous
    ));
    try {
      const status = await cancelDocumentImport(current.requestId);
      setNativeImport((previous) => (
        previous && previous.requestId === current.requestId
          ? { ...previous, cancelState: status === "too_late" ? "too_late" : previous.cancelState }
          : previous
      ));
    } catch (error) {
      setShelfNotice({ kind: "error", text: `取消导入失败：${String(error)}` });
      setNativeImport((previous) => (
        previous && previous.requestId === current.requestId
          ? { ...previous, cancelState: "idle" }
          : previous
      ));
    }
  }, [nativeImport]);

  const handleToggleNativeImportCollapsed = useCallback((): void => {
    setNativeImport((previous) => (
      previous ? { ...previous, collapsed: !previous.collapsed } : previous
    ));
  }, []);

  const reimportAndroidMissing = useCallback(async (entry: ShelfEntry): Promise<ShelfEntry | null> => {
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: "已有导入任务正在进行，请等待当前任务结束" });
      return null;
    }
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: `重新导入《${entry.title}》`,
    });
    const uri = Array.isArray(selected) ? selected[0] : selected;
    if (!uri) return null;
    const documents: AndroidDocumentSelection[] = [{ uri }];
    const batch = await runNativeDocumentImport(documents);
    if (!batch) return null;
    const wanted = entry.contentHash && /^[a-f0-9]{64}$/.test(entry.contentHash)
      ? entry.contentHash
      : /^[a-f0-9]{64}$/.test(entry.id)
        ? entry.id
        : null;
    const match = batch.results.find((item) =>
      (item.status === "saved" || item.status === "duplicate") &&
      item.record &&
      (wanted ? item.record.contentHash === wanted : true)
    );
    if (!match?.record) {
      const cancelled = batch.results.some((item) => item.status === "cancelled");
      setShelfNotice({
        kind: cancelled ? "warn" : "error",
        text: cancelled
          ? `《${entry.title}》重新导入已取消`
          : `选择的文件与《${entry.title}》内容不一致，无法恢复`,
      });
      return null;
    }
    contentHashByIdRef.current.set(match.record.id, match.record.contentHash ?? match.record.id);
    entryByContentHashRef.current.set(match.record.contentHash ?? match.record.id, match.record);
    await getShelfStore().importRecords?.([match.record]);
    setShelfEntries((previous) => mergeShelfEntries(previous, [match.record!]));
    return match.record;
  }, [runNativeDocumentImport]);

  const handleChooseBooks = useCallback(async () => {
    if (!isTauriEnv()) {
      fileInputRef.current?.click();
      return;
    }
    if (runtime.platform === "android") {
      if (nativeImportRef.current) {
        setShelfNotice({ kind: "warn", text: "已有导入任务正在进行，请等待当前任务结束" });
        return;
      }
      try {
        const selected = await openFileDialog({
          multiple: true,
          directory: false,
          title: "选择 EPUB 书籍",
        });
        const uris = (Array.isArray(selected) ? selected : selected ? [selected] : []).filter(
          (value): value is string => typeof value === "string" && value.length > 0
        );
        if (uris.length === 0) return;
        const documents: AndroidDocumentSelection[] = uris.map((uri) => ({ uri }));
        const batch = await runNativeDocumentImport(documents);
        if (batch) await applyNativeImportBatch(batch, documents);
      } catch (error) {
        setShelfNotice({ kind: "error", text: `无法打开文件选择器：${String(error)}` });
      }
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
  }, [applyNativeImportBatch, handleImportSources, runNativeDocumentImport]);

  const resolveContentHashForEntry = useCallback(async (entry: ShelfEntry): Promise<string> => {
    if (entry.contentHash && /^[a-f0-9]{64}$/.test(entry.contentHash)) {
      return entry.contentHash;
    }
    if (/^[a-f0-9]{64}$/.test(entry.id)) {
      return entry.id;
    }
    if (entry.available === false) {
      throw new Error(`《${entry.title}》文件失联且无指纹，${runtime.platform === "android" ? "请重新导入文件" : "请重新关联文件"}后再加入分类或收藏`);
    }
    try {
      const buf = await getShelfStore().readBook(entry.id);
      const hash = await sha256Hex(buf);
      const updated = await getShelfStore().setContentHash(entry.id, hash);
      setShelfEntries((prev) => prev.map((item) => (item.id === entry.id ? updated : item)));
      return hash;
    } catch (err) {
      throw new Error(`无法读取《${entry.title}》计算内容指纹：${String(err)}`);
    }
  }, []);

  const handleApplyOrganization = useCallback(
    async (command: OrganizationCommand): Promise<void> => {
      if (organizationBusyRef.current || shelfBusyRef.current) {
        return;
      }
      if (organizationError) {
        setShelfNotice({
          kind: "error",
          text: "收藏与文件夹读取失败，已禁用修改以防止覆盖现有数据",
        });
        throw new Error("收藏与文件夹处于错误状态，已禁用修改");
      }
      organizationBusyRef.current = true;
      try {
        let finalCommand = command;
        if ("contentHashes" in command) {
          const resolvedHashes: string[] = [];
          for (const idOrHash of command.contentHashes) {
            const entry = shelfEntriesRef.current.find(
              (e) => e.id === idOrHash || e.contentHash === idOrHash
            );
            if (!entry) throw new Error("所选书籍在书架中不存在");
            const hash = await resolveContentHashForEntry(entry);
            resolvedHashes.push(hash);
          }
          finalCommand = { ...command, contentHashes: resolvedHashes } as OrganizationCommand;
        }
        const nextOrg = await getShelfStore().applyOrganization(finalCommand);
        setOrganization(nextOrg);
      } catch (error) {
        setShelfNotice({ kind: "error", text: `操作失败：${String(error)}` });
        throw error;
      } finally {
        organizationBusyRef.current = false;
      }
    },
    [organizationError, resolveContentHashForEntry]
  );

  const handleExportArchive = useCallback(async () => {
    if (organizationBusyRef.current) {
      setShelfNotice({ kind: "warn", text: "正在保存分类修改，请稍后再试" });
      return;
    }
    try {
      const built = buildLibraryArchiveWithIssues(
        shelfEntriesRef.current,
        organizationRef.current,
        {
          ...settings,
          uiScale,
        }
      );
      if (built.skipped.length > 0) {
        throw new Error(`有 ${built.skipped.length} 条书架记录缺少有效内容指纹`);
      }
      const text = exportLibraryArchive(built.archive);
      if (runtime.platform === "android") {
        const uri = await saveFileDialog({
          title: "导出阅读存档",
          defaultPath: `epub-reader-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: "EPUB Reader 存档", extensions: ["application/json", "json"] }],
        });
        if (!uri || Array.isArray(uri)) return;
        await writeTextContentUri(uri, text);
      } else if (isTauriEnv()) {
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
      setShelfNotice({
        kind: "ok",
        text: `已导出 ${Object.keys(built.archive.records).length} 本书及分类组织存档`,
      });
    } catch (error) {
      setShelfNotice({ kind: "error", text: `存档导出失败：${String(error)}` });
    }
  }, [settings, uiScale]);

  const handleImportArchive = useCallback(async () => {
    if (shelfBusyRef.current || organizationBusyRef.current) return;
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: "正在导入书籍，暂不能替换书库记录" });
      return;
    }
    shelfBusyRef.current = true;
    organizationBusyRef.current = true;
    setShelfBusyMessage("正在导入存档…");
    setShelfBusy(true);
    try {
      let text: string | null = null;
      if (runtime.platform === "android") {
        const selected = await openFileDialog({
          multiple: false,
          directory: false,
          title: "导入阅读存档",
        });
        const uri = Array.isArray(selected) ? selected[0] : selected;
        if (uri) {
          text = await readContentUriText(uri, 16 * 1024 * 1024);
        }
      } else if (isTauriEnv()) {
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
            } else void file.text().then(resolve, () => resolve(null));
          };
          input.addEventListener("cancel", () => resolve(null), { once: true });
          input.click();
        });
      }
      if (text === null) return;
      const incoming = parseLibraryArchive(text);
      if (incoming.errors.length > 0) {
        const first = incoming.errors[0];
        throw new Error(`存档解析失败（${first.path}：${first.message}，共 ${incoming.errors.length} 项错误）`);
      }

      const current = buildLibraryArchiveWithIssues(
        shelfEntriesRef.current,
        organizationRef.current,
        {
          ...settings,
          uiScale,
        }
      );
      if (current.skipped.length > 0) {
        throw new Error(`当前书架有 ${current.skipped.length} 条记录缺少有效内容指纹`);
      }

      // 预检查组织数据合并
      mergeLibraryArchives(current.archive, incoming.archive);

      // 记录与 organization 必须在本机仓储边界内一并合并；旧 v3 进度不被旧包导入时间覆盖。
      let unavailableCount = 0;
      try {
        const store = getShelfStore();
        const nextEntries = await store.replacePortableRecords(
          archiveRecordsForBackend(incoming.archive),
          incoming.archive.organization,
        );
        unavailableCount = nextEntries.filter((entry) => entry.available === false).length;
        setShelfEntries(nextEntries);
        setOrganization(await store.getOrganization());
      } catch (err) {
        throw new Error(`书籍记录与组织导入失败：${String(err)}`);
      }

      // 第三步：应用外观与阅读设置
      try {
        const importedSettings = incoming.archive.settings ?? {};
        setSettings((previous) => {
          // 存档可能来自旧版本：带非默认 gap 但缺 mode 时按 manual；
          // 两者都缺时不覆盖本机 mode/gap。显式新 mode 始终优先。
          const importedGapValid =
            typeof importedSettings.gapPx === "number" &&
            Number.isFinite(importedSettings.gapPx) &&
            importedSettings.gapPx >= 0 &&
            importedSettings.gapPx <= 96;
          const importedGapMode =
            importedSettings.spreadGapMode === "auto" || importedSettings.spreadGapMode === "manual"
              ? importedSettings.spreadGapMode
              : importedGapValid
                ? (importedSettings.gapPx === DEFAULT_PAGE_GAP_PX ? "auto" : "manual")
                : previous.spreadGapMode ?? "auto";
          return {
            ...previous,
            ...(typeof importedSettings.fontSizePx === "number" && importedSettings.fontSizePx >= 12 && importedSettings.fontSizePx <= 32
              ? { fontSizePx: importedSettings.fontSizePx }
              : {}),
            ...(importedSettings.theme === "light" || importedSettings.theme === "dark" || importedSettings.theme === "sepia" || importedSettings.theme === "gray"
              ? { theme: importedSettings.theme }
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
            ...normalizePageOptions({
              readingMode: importedSettings.readingMode,
              pageMarginsPx: importedSettings.pageMarginsPx,
              columnsPerView: importedSettings.columnsPerView,
              gapPx: importedGapValid ? (importedSettings.gapPx as number) : previous.gapPx,
              spreadGapMode: importedGapMode,
            }),
          };
        });
        if (typeof importedSettings.uiScale === "number" && importedSettings.uiScale >= 0.75 && importedSettings.uiScale <= 1.5) {
          setUiScale(importedSettings.uiScale);
        }
      } catch (err) {
        setShelfNotice({
          kind: "warn",
          text: `书籍记录与分类已导入，但阅读设置应用失败：${String(err)}`,
        });
        return;
      }

      setShelfNotice({
        kind: unavailableCount > 0 ? "warn" : "ok",
        text: `已导入 ${Object.keys(incoming.archive.records).length} 本书的记录与分类${unavailableCount > 0 ? `；${unavailableCount} 本需重新定位源文件` : ""}`,
      });
    } catch (error) {
      setShelfNotice({ kind: "error", text: `存档导入失败：${String(error)}` });
    } finally {
      shelfBusyRef.current = false;
      organizationBusyRef.current = false;
      setShelfBusy(false);
    }
  }, [settings, uiScale]);

  // ---- 书架与组织启动加载（先完成一次 CP-I 激活，失败保持旧模式） ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await activatePortableShelfState();
      } catch (error) {
        if (!cancelled) {
          setShelfNotice({
            kind: "error",
            text: `跨平台资料未激活，继续使用旧模式：${String(error)}`,
          });
        }
      }
      if (cancelled) return;
      const store = getShelfStore();
      store
        .list()
        .then((entries) => {
          if (!cancelled) setShelfEntries(entries);
        })
        .catch((e) => {
          if (!cancelled) setShelfError(`无法读取书架：${String(e)}`);
        });

      store
        .getOrganization()
        .then((org) => {
          if (!cancelled) {
            setOrganization(org);
            setOrganizationError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setOrganizationError(`无法读取收藏与文件夹：${String(e)}`);
            setShelfNotice({
              kind: "error",
              text: `无法读取收藏与文件夹：${String(e)}；已禁用分类写入以保护现有数据`,
            });
          }
        });
    })();

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

  // 本地文件与原生路径共用同一控制器：同一时刻只有一个在途批次，路径入口不再重入 busy。
  const fontImportRef = useRef<ReturnType<typeof createFontImportController> | null>(null);
  if (!fontImportRef.current) {
    fontImportRef.current = createFontImportController({
      store: getFontStore,
      importFile: importFontFile,
      onBusyChange: setFontBusy,
    });
  }

  const handleImportFonts = useCallback(async (files: File[]) => {
    const result = await fontImportRef.current!.importFiles(files);
    if (result.kind === "busy") {
      setShelfNotice({ kind: "error", text: "正在导入字体，请稍候" });
      return;
    }
    if (result.kind === "error") {
      setShelfNotice({ kind: "error", text: result.message });
      return;
    }
    if (result.unsupported > 0) {
      setShelfNotice({
        kind: "error",
        text: result.imported > 0
          ? `已导入 ${result.imported} 个字体；忽略 ${result.unsupported} 个非字体文件`
          : `已忽略 ${result.unsupported} 个非字体文件，仅支持 TTF/OTF/WOFF/WOFF2`,
      });
      return;
    }
    if (result.message) setShelfNotice({ kind: "ok", text: result.message });
  }, []);

  const handleImportFontPaths = useCallback(async (paths: string[]) => {
    const result = await fontImportRef.current!.importPaths(paths);
    if (result.kind === "busy") {
      setShelfNotice({ kind: "error", text: "正在导入字体，请稍候" });
      return;
    }
    if (result.kind === "error") {
      setShelfNotice({ kind: "error", text: result.message });
      return;
    }
    const entry = result.entry;
    if (entry) {
      setUserFonts((prev) => [entry, ...prev.filter((f) => f.id !== entry.id)]);
      setSettings((previous) => ({
        ...previous,
        fontSource: "imported",
        customFontId: entry.id,
        customFontName: entry.family,
      }));
    }
    if (result.unsupported > 0) {
      setShelfNotice({
        kind: "error",
        text: result.imported > 0
          ? `已导入 ${result.imported} 个字体；忽略 ${result.unsupported} 个非字体文件`
          : `已忽略 ${result.unsupported} 个非字体文件，仅支持 TTF/OTF/WOFF/WOFF2`,
      });
      return;
    }
    if (result.message) setShelfNotice({ kind: "ok", text: result.message });
  }, []);

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

  useEffect(() => {
    return () => {
      if (bookmarkToastTimerRef.current) {
        window.clearTimeout(bookmarkToastTimerRef.current);
      }
    };
  }, []);

  const showReaderNotice = useCallback((text: string, kind: "ok" | "warn" | "error" = "warn"): void => {
    setReaderNotice({ kind, text });
  }, []);

  /** 语义锚点失败：解除显示门，但守住进度，直到读者真实移动后再写。 */
  const handleReaderNavigationUnresolved = useCallback((reported: boolean): void => {
    navigationPendingRef.current = false;
    historyCaptureAllowedRef.current = true;
    readerDisplayReadyRef.current = true;
    setReaderDisplayReady(true);
    setSearchNavigationBusy(false);
    setInitialAnchor(null);
    setInitialPage(0);
    setInitialAlignment("context");
    suppressShelfProgressRef.current = true;
    if (!reported) showReaderNotice("未能定位保存位置，已停留在章节开头", "warn");
  }, [showReaderNotice]);

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
    async (
      id: string,
      searchTarget?: ResolvedCrossBookSearchHit,
      searchTextHits?: ExactTextHit[],
      searchOccurrence?: SearchOccurrence,
    ) => {
      if (shelfBusyRef.current) return;
      const originalEntry = shelfEntriesRef.current.find((e) => e.id === id);
      if (!originalEntry) return;
      // R1: when a book has divergent progress candidates, the user chooses
      // which version is restored. Stamp ordering only keeps the list stable.
      let chosenProgressStamp: Stamp | undefined;
      let chosenProgressVersion: Version<ProgressValue> | null = null;
      const progressVersions = portableProgressVersions(originalEntry);
      if (progressVersions.length > 1) {
        const candidates = [...progressVersions]
          .sort((left, right) => compareStamp(left.stamp, right.stamp))
          .map((version): PortableProgressChoiceCandidate => {
            const projection = projectProgressVersion(version);
            return {
              stamp: version.stamp,
              version,
              chapterPath: projection.chapterPath,
              spineIndex: projection.spineIndex,
              progressPct: projection.value?.progressPctHint ?? 0,
              updatedAtMs: version.updatedAtMs,
            };
          });
        const selectedStamp = await new Promise<Stamp | null>((resolve) => {
          progressChoiceResolverRef.current = resolve;
          setProgressChoice({ title: originalEntry.title, candidates });
        });
        progressChoiceResolverRef.current = null;
        setProgressChoice(null);
        if (!selectedStamp) return;
        chosenProgressStamp = selectedStamp;
        chosenProgressVersion = versionForStamp(progressVersions, selectedStamp);
        if (!chosenProgressVersion) {
          setShelfNotice({ kind: "error", text: "所选进度版本已失效，请重新打开" });
          return;
        }
      }
      shelfBusyRef.current = true;
      setShelfBusyMessage("正在打开书籍…");
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
        const previousShelfId = currentShelfIdRef.current;
        if (previousShelfId) {
          await getShelfStore().closeProgressSession?.(previousShelfId).catch(() => undefined);
        }
        progressWriterRef.current?.beginSession(id);
        let entry = originalEntry;
        if (entry.available === false) {
          if (runtime.platform === "android") {
            const restored = await reimportAndroidMissing(entry);
            if (!restored) {
              shelfBusyRef.current = false;
              setShelfBusy(false);
              setPhase({ phase: "idle" });
              setSearchNavigationBusy(false);
              return;
            }
            entry = restored;
          } else if (isTauriEnv()) {
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
        const chosenProjection = chosenProgressVersion
          ? projectProgressVersion(chosenProgressVersion)
          : null;
        const initialSpineIndex = searchTarget
          ? searchTarget.spineIndex
          : (chosenProjection?.spineIndex ?? entry.spineIndex ?? 0);
        const b = await loadBook(buf, { selective: true, initialSpineIndex });
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
        } else if (chosenProgressVersion) {
          saved = savedProgressFromVersion(b, chosenProgressVersion);
        } else {
          saved = savedProgressFromShelfEntry(b, entry);
        }
        // R1: the session is pinned to the version that is actually about to be
        // rendered; a failed/cancelled open never writes a default position.
        if (getShelfStore().beginProgressSession) {
          await getShelfStore().beginProgressSession!(id, chosenProgressStamp);
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
          chosenProgressVersion
            ? (projectProgressVersion(chosenProgressVersion).value?.progressPctHint ?? entry.progressPct)
            : entry.progressPct,
        );
        if (preciseRequestId !== null && searchTarget) {
          latestPreciseRequestRef.current = preciseRequestId;
          setInitialPage(null);
          setPreciseTarget({
            requestId: preciseRequestId,
            kind: "search",
            chapterPath: searchTarget.chapterPath,
            textHits: searchTextHits,
            occurrence: searchOccurrence,
          });
        }
        shelfBusyRef.current = false;
        setShelfBusy(false);
      } catch (e) {
        shelfBusyRef.current = false;
        setShelfBusy(false);
        setShelfError(`打开失败：${(e as Error).message}`);
        setPhase({ phase: "error", message: (e as Error).message });
        setSearchNavigationBusy(false);
      }
    },
    [openParsedBook, reimportAndroidMissing]
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

  // 统一固定内容轴：在本次书籍会话第一次得到完整有效 linear 章节权重时冻结一份轴
  useEffect(() => {
    if (view !== "reader" || !book || contentAxisRef.current) return;
    const linearSpine = book.spine
      .map((item, idx) => ({ item, idx, path: spineItemPath(book, idx) }))
      .filter((entry): entry is { item: typeof book.spine[0]; idx: number; path: string } =>
        entry.item.linear !== false && Boolean(entry.path)
      );
    if (linearSpine.length === 0) return;
    const counts = chapterCountsState.counts;
    const allAvailable = linearSpine.every(({ idx }) => {
      const c = counts[idx];
      return c && c.value !== null && Number.isFinite(c.value);
    });
    if (!allAvailable) return;

    const inputs: AxisInput[] = linearSpine.map(({ idx, path }) => ({
      key: `${idx}:${path}`,
      spineIndex: idx,
      weight: counts[idx]?.value ?? 0,
    }));
    const axis = createContentAxis(inputs);
    contentAxisRef.current = axis;
    setContentAxis(axis);
    if (!scrubUiStateRef.current.actual) {
      const baseRatio = Math.max(0, Math.min(1, baselineProgressPctRef.current / 100));
      dispatchScrub({
        type: "sample",
        session: scrubSessionRef.current,
        actual: { ratio: baseRatio, atEnd: false },
      });
    }
  }, [view, book, chapterCountsState, dispatchScrub]);

  const handleShelfDelete = useCallback(async (id: string) => {
    if (shelfBusyRef.current || nativeImportRef.current) {
      if (nativeImportRef.current) setShelfNotice({ kind: "warn", text: "正在导入书籍，暂不能删除" });
      return;
    }
    shelfBusyRef.current = true;
    setShelfBusyMessage("正在移除书籍…");
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
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: "正在导入书籍，暂不能删除" });
      return;
    }
    shelfBusyRef.current = true;
    setShelfBusyMessage("正在移除书籍…");
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
  const handleUserReadingPositionChange = useCallback(() => {
    // 只有宿主实际用户位移才解除失败保护，重排和采样变化不能代替用户输入。
    suppressShelfProgressRef.current = false;
  }, []);

  const onPageState = useCallback((s: ChapterState) => {
    chapterStateRef.current = s;
    setChapterState(s);
    if (s.status === "ready" && s.mode !== "scroll" && !navigationPendingRef.current) {
      const axis = contentAxisRef.current;
      const currentBook = bookRef.current;
      if (currentBook) {
        const linearIndices = currentBook.spine.map((item, i) => (item.linear ? i : -1)).filter((i) => i >= 0);
        const isLastLinear = nextLinearIndex(currentBook, spineIndexRef.current, 1) === -1 || linearIndices.at(-1) === spineIndexRef.current;
        const atEnd = s.atEnd === true || (isLastLinear && s.currentPage >= s.pageCount - 1);
        if (axis) {
          const seg = axis.segments.find((item) => item.spineIndex === spineIndexRef.current);
          if (seg) {
            const intra = s.pageCount > 1 ? s.currentPage / (s.pageCount - 1) : 1;
            const ratio = atEnd ? 1 : axis.ratioAt({ key: seg.key, fraction: intra });
            if (ratio !== null) {
              dispatchScrub({
                type: "sample",
                session: scrubSessionRef.current,
                actual: { ratio, atEnd },
              });
            }
          } else if (atEnd) {
            dispatchScrub({
              type: "sample",
              session: scrubSessionRef.current,
              actual: { ratio: 1, atEnd: true },
            });
          }
        } else if (atEnd) {
          dispatchScrub({
            type: "sample",
            session: scrubSessionRef.current,
            actual: { ratio: 1, atEnd: true },
          });
        }
      }
    }
  }, [dispatchScrub]);

  const handleReaderDisplayReady = useCallback(() => {
    navigationPendingRef.current = false;
    historyCaptureAllowedRef.current = true;
    readerDisplayReadyRef.current = true;
    hasReaderDisplayedRef.current = true;
    suppressShelfProgressRef.current = false;
    setReaderDisplayReady(true);
    setSearchNavigationBusy(false);
    setInitialAlignment("context");
    const state = chapterStateRef.current;
    const readingAnchor = readerRef.current?.getReadingAnchor();
    const currentBook = bookRef.current;
    const currentIndex = spineIndexRef.current;
    if (state.status === "ready" && state.mode !== "scroll" && currentBook) {
      const linearIndices = currentBook.spine.map((item, i) => (item.linear ? i : -1)).filter((i) => i >= 0);
      const isLastLinear = nextLinearIndex(currentBook, currentIndex, 1) === -1 || linearIndices.at(-1) === currentIndex;
      const atEnd = state.atEnd === true || (isLastLinear && state.currentPage >= state.pageCount - 1);
      const axis = contentAxisRef.current;
      if (axis) {
        const seg = axis.segments.find((item) => item.spineIndex === currentIndex);
        if (seg) {
          const intra = state.pageCount > 1 ? state.currentPage / (state.pageCount - 1) : 1;
          const ratio = atEnd ? 1 : axis.ratioAt({ key: seg.key, fraction: intra });
          if (ratio !== null) {
            dispatchScrub({
              type: "sample",
              session: scrubSessionRef.current,
              actual: { ratio, atEnd },
            });
          }
        } else if (atEnd) {
          dispatchScrub({
            type: "sample",
            session: scrubSessionRef.current,
            actual: { ratio: 1, atEnd: true },
          });
        }
      } else if (atEnd) {
        dispatchScrub({
          type: "sample",
          session: scrubSessionRef.current,
          actual: { ratio: 1, atEnd: true },
        });
      }
    }
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
            mediaAnchor: readingAnchor.mediaAnchor ?? null,
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

  const handleVisibleChapterChange = useCallback(
    (index: number, anchor: ReadingAnchor | null) => {
      // 连续滚动模式观察到的章节变化：只更新目录高亮、阅读线归属及持久化锚点，
      // 绝不调用 handleRequestChapter、不清前台、不设置 readerDisplayReady(false)。
      spineIndexRef.current = index;
      setSpineIndex(index);
      if (anchor) {
        lastStablePositionRef.current = {
          spineIndex: index,
          page: 0,
          anchor: toPersistedReaderAnchor({
            index: anchor.index,
            ratio: anchor.ratio,
            anchorTextOffset: anchor.textOffset,
            anchorTextSnippet: anchor.textSnippet,
            mediaAnchor: anchor.mediaAnchor ?? null,
          }),
        };
      }
    },
    []
  );

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
    const currentBook = bookRef.current;
    let targetSpineIndex = spineIndex;
    if (readingAnchor?.path && currentBook) {
      const resolved = spineIndexForPath(currentBook, readingAnchor.path);
      if (resolved >= 0) {
        targetSpineIndex = resolved;
      }
    }
    return {
      spineIndex: targetSpineIndex,
      page: state.status === "ready" ? state.currentPage : lastStablePositionRef.current.page,
      anchor: toPersistedReaderAnchor(
        readingAnchor
          ? {
              index: readingAnchor.index,
              ratio: readingAnchor.ratio,
              anchorTextOffset: readingAnchor.textOffset,
              anchorTextSnippet: readingAnchor.textSnippet,
              mediaAnchor: readingAnchor.mediaAnchor ?? null,
            }
          : null
      ) ?? lastStablePositionRef.current.anchor,
    };
  }, [spineIndex]);

  const handlePresentationChange = useCallback(
    (patch: { readingMode?: "paginated" | "scroll"; columnsPerView?: 1 | 2 }) => {
      const isModeChange = patch.readingMode !== undefined && patch.readingMode !== settings.readingMode;
      const isColChange = patch.columnsPerView !== undefined && patch.columnsPerView !== settings.columnsPerView;
      if (!isModeChange && !isColChange) return;

      const pos = currentReaderPosition();
      if (pos) {
        lastStablePositionRef.current = pos;
        if (isModeChange) {
          if (pos.anchor) setInitialAnchor(toPersistedReaderAnchor(pos.anchor));
          if (typeof pos.page === "number") setInitialPage(pos.page);
          if (typeof pos.spineIndex === "number") {
            spineIndexRef.current = pos.spineIndex;
            setSpineIndex(pos.spineIndex);
          }
          setAnchorNonce((n) => n + 1);
        }
      }
      setSettings((s2) => ({ ...s2, ...patch }));
    },
    [currentReaderPosition, settings.columnsPerView, settings.readingMode]
  );

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

  const handleCommitSeek = useCallback((ratio: number) => {
    const r = Math.max(0, Math.min(1, ratio));
    const axis = contentAxisRef.current;
    scrubRequestIdRef.current += 1;
    const token: ScrubToken = {
      session: scrubSessionRef.current,
      request: scrubRequestIdRef.current,
    };
    navigationPendingRef.current = true;
    historyCaptureAllowedRef.current = false;
    dispatchScrub({ type: "begin", token, ratio: r });

    if (settings.readingMode === "scroll") {
      if (axis) {
        const target = axis.locate(r);
        if (target) {
          readerRef.current?.seekContentFraction?.(
            { key: target.key, spineIndex: target.spineIndex, fraction: target.fraction },
            token
          );
          return;
        }
      }
      readerRef.current?.scrollToRatio?.(r);
    } else {
      if (axis) {
        const target = axis.locate(r);
        if (target) {
          if (target.spineIndex === spineIndexRef.current) {
            readerRef.current?.seekContentFraction?.(
              { key: target.key, spineIndex: target.spineIndex, fraction: target.fraction },
              token
            );
          } else {
            const currentBook = bookRef.current;
            const path = currentBook ? spineItemPath(currentBook, target.spineIndex) : undefined;
            if (path) handleTocNavigate(path);
          }
          dispatchScrub({
            type: "settled",
            token,
            actual: { ratio: r, atEnd: r >= 1 },
          });
          navigationPendingRef.current = false;
          historyCaptureAllowedRef.current = true;
          return;
        }
      }
      readerRef.current?.scrollToRatio?.(r);
      dispatchScrub({
        type: "settled",
        token,
        actual: { ratio: r, atEnd: r >= 1 },
      });
      navigationPendingRef.current = false;
      historyCaptureAllowedRef.current = true;
    }
  }, [settings.readingMode, handleTocNavigate, dispatchScrub]);

  const handleScrubPreviewChange = useCallback((ratio: number | null) => {
    dispatchScrub({
      type: "preview",
      session: scrubSessionRef.current,
      ratio,
    });
  }, [dispatchScrub]);

  const handleContentFractionSettled = useCallback((
    token: ScrubToken,
    location: { key: string; spineIndex: number; fraction: number; atEnd: boolean }
  ) => {
    navigationPendingRef.current = false;
    historyCaptureAllowedRef.current = true;
    readerDisplayReadyRef.current = true;
    setReaderDisplayReady(true);
    const axis = contentAxisRef.current;
    const ratio = axis ? axis.ratioAt({ key: location.key, fraction: location.fraction }) : null;
    const actualRatio = ratio !== null ? ratio : (scrubUiStateRef.current.pending?.ratio ?? 0);
    dispatchScrub({
      type: "settled",
      token,
      actual: { ratio: actualRatio, atEnd: location.atEnd },
    });
  }, [dispatchScrub]);

  const handleContentFractionCancelled = useCallback((token: ScrubToken) => {
    navigationPendingRef.current = false;
    dispatchScrub({ type: "cancelled", token });
  }, [dispatchScrub]);

  const handleContentFractionFailed = useCallback((token: ScrubToken) => {
    navigationPendingRef.current = false;
    dispatchScrub({ type: "failed", token });
    setReaderNotice({ kind: "warn", text: "未能定位到指定进度" });
  }, [dispatchScrub]);

  const handleUserProgressSample = useCallback((
    location: { key: string; spineIndex: number; fraction: number; atEnd: boolean }
  ) => {
    const axis = contentAxisRef.current;
    if (!axis) return;
    const ratio = axis.ratioAt({ key: location.key, fraction: location.fraction });
    if (ratio !== null) {
      dispatchScrub({
        type: "sample",
        session: scrubSessionRef.current,
        actual: { ratio, atEnd: location.atEnd },
      });
    }
  }, [dispatchScrub]);

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
    const occurrence = result.occurrence;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: result.spineIndex,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const snapshot = currentReaderPosition();
      if (textHits.length > 0 || occurrence) {
        const status = readerRef.current?.navigateToSearchTarget({
          requestId,
          kind: "search",
          textHits,
          occurrence,
          chapterPath: result.chapterPath,
        });
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
    setInitialAlignment("context");
    latestPreciseRequestRef.current = requestId;
    setPreciseTarget({
      requestId,
      kind: "search",
      chapterPath: result.chapterPath,
      textHits: textHits.length > 0 ? textHits : undefined,
      occurrence,
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
        mediaAnchor: pos.anchor?.mediaAnchor ?? null,
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
    setInitialAlignment("context");
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
        mediaAnchor: pos.anchor?.mediaAnchor ?? null,
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
    setInitialAlignment("context");
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

  const saveNoteChange = useCallback(async (
    next: ReaderNote[],
    commit: () => Promise<unknown>,
  ): Promise<boolean> => {
    if (!currentShelfId || noteBusyRef.current) return false;
    const previous = currentNotes;
    noteBusyRef.current = true;
    setNoteBusy(true);
    setShelfEntries((entries) => entries.map((entry) =>
      entry.id === currentShelfId ? { ...entry, notes: next } : entry
    ));
    try {
      await commit();
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
    let commit: () => Promise<unknown>;
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
      const created: ReaderNote = {
        id: generateFolderId(),
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
      const entry = shelfEntriesRef.current.find((item) => item.id === currentShelfId);
      const annotation = entry ? portableNoteAnnotations(entry)[updated.id] : undefined;
      const displayedVersion = annotation && !annotation.deleted
        ? latestVersion(annotation.versions)
        : null;
      const store = getShelfStore();
      if (store.updateNote) {
        if (!displayedVersion) {
          setRuntimeIssues((issues) => [...issues, "笔记版本信息缺失，已取消保存以避免覆盖后台更新"]);
          return;
        }
        const chosenStamp = displayedVersion.stamp;
        commit = () => store.updateNote!(currentShelfId, updated, chosenStamp);
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
    setInitialAlignment("context");
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

  // 标题栏书签列表入口：直接从右侧展开抽屉至书签 Tab
  const handleToggleBookmarks = useCallback((): void => {
    if (isSidebarOpen && sidebarSide === "right" && activeSidebarTab === "bookmarks") {
      handleSidebarClose();
      return;
    }
    handleOpenBookmarks();
  }, [isSidebarOpen, sidebarSide, activeSidebarTab, handleSidebarClose, handleOpenBookmarks]);

  const handleToggleBookmark = useCallback(() => {
    if (!currentShelfId || chapterState.status !== "ready") return;
    const anchor = readerRef.current?.getReadingAnchor() ?? null;
    const previous = currentBookmarks;
    let next: Bookmark[];
    let added: Bookmark | null = null;
    let removedId: string | null = null;
    const makeBookmark = (): Bookmark => {
      const text = readerRef.current?.getAnchorText() ?? "";
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
    showBookmarkToast(isAdded ? "已加入书签" : "已移除书签", isAdded ? "add" : "remove");
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
      .then(() =>
        setShelfEntries((prev) =>
          // 后端返回的是写入时刻的完整记录；期间用户可能已经翻页，
          // 因此这里只确认书签字段，不能用旧快照覆盖乐观进度。
          prev.map((entry) =>
            entry.id === currentShelfId ? { ...entry, bookmarks: next } : entry
          )
        )
      )
      .catch((error) => {
        setShelfEntries((prev) =>
          prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: previous } : entry))
        );
        setShelfError(`书签保存失败：${String(error)}`);
      });
  }, [currentShelfId, currentBookmarks, spineIndex, chapterState, showBookmarkToast, book]);

  const handleDeleteBookmark = useCallback(
    (bookmarkId: string) => {
      if (!currentShelfId) return;
      const previous = currentBookmarks;
      const next = currentBookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
      showBookmarkToast("已移除书签", "remove");
      setShelfEntries((prev) =>
        prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: next } : entry))
      );
      const store = getShelfStore();
      const commit = store.deleteBookmark
        ? store.deleteBookmark(currentShelfId, bookmarkId)
        : store.setBookmarks(currentShelfId, next);
      void commit
        .then(() => undefined)
        .catch((error) => {
          setShelfEntries((prev) =>
            prev.map((entry) => (entry.id === currentShelfId ? { ...entry, bookmarks: previous } : entry))
          );
          setShelfError(`书签删除失败：${String(error)}`);
        });
    },
    [currentShelfId, currentBookmarks, showBookmarkToast]
  );

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
        mediaAnchor: bookmark.mediaAnchor ?? null,
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
          mediaAnchor: bookmarkAnchor?.mediaAnchor ?? null,
          fallbackPage: bookmark.page,
          alignment: "reading-line",
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
      setInitialAlignment("reading-line");
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
      !suppressShelfProgressRef.current &&
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
                  mediaAnchor: a.mediaAnchor ?? null,
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
      spreadGapMode: settings.spreadGapMode ?? "auto",
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
    settings.spreadGapMode,
    uiScale,
  ]);

  const changeTheme = (theme: Theme): void => {
    setSettings((s) => ({ ...s, theme }));
  };

  // 同步主题至 html 与 body，保证全屏与全端窗口背景无死角对齐
  useEffect(() => {
    const themeVal = settings.theme && settings.theme !== "light" ? settings.theme : null;
    if (themeVal) {
      document.documentElement.setAttribute("data-theme", themeVal);
      document.body.setAttribute("data-theme", themeVal);
    } else {
      document.documentElement.removeAttribute("data-theme");
      document.body.removeAttribute("data-theme");
    }
  }, [settings.theme]);

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

  useEffect(() => {
    if (view !== "reader") return;
    clearDocumentSelection(document);
  }, [view, bookKey]);


  // ---- 拖拽打开 ----
  // Tauri 环境：打包后 WebView2 会拦截原生拖放，HTML5 drop 事件不会触发，
  // 必须走 Tauri 原生 onDragDropEvent：只把文件路径交给 Rust 链接书库流式导入，WebView 不预读正文。
  // 纯浏览器环境：用 HTML5 事件兜底。
  useEffect(() => {
    if (!isTauriEnv()) {
      const prevent = (e: DragEvent): void => e.preventDefault();
      const drop = (e: DragEvent): void => {
        e.preventDefault();
        // 字体面板内部拖放由面板自己处理（onDrop 已 stopPropagation），
        // 这里只覆盖面板外的窗口拖放，行为与原生入口一致。
        const files = Array.from(e.dataTransfer?.files ?? []);
        const epubFiles = files.filter((f) => f.name.toLowerCase().endsWith(".epub"));
        const fontFiles = files.filter((f) => isSupportedFontFileName(f.name));
        if (fontFiles.length > 0 && !fontSettingsOpen) {
          setShelfNotice({ kind: "error", text: "请打开字体设置后拖入字体" });
        }
        if (epubFiles.length > 0) {
          void handleImportSources(epubFiles.map((file) => ({ kind: "file" as const, file })));
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
          // 字体面板优先：面板内的落点只走字体链路，残留的 EPUB 不抢读书会话。
          const overFontPanel = isOverFontPanel(p.position);
          const epubPaths = p.paths.filter((path) => path.toLowerCase().endsWith(".epub"));
          const hasNonFont = p.paths.length > epubPaths.length;
          if (overFontPanel) {
            void handleImportFontPaths(p.paths);
            if (epubPaths.length > 0) {
              setShelfNotice({ kind: "error", text: "字体面板仅支持 TTF/OTF/WOFF/WOFF2 字体文件" });
            }
            return;
          }
          if (hasNonFont) {
            setShelfNotice({ kind: "error", text: "请打开字体设置后拖入字体" });
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
        // 注册期间 effect 已清理时立即退订，避免字体面板开关留下重复监听。
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((error) => {
        console.error("原生拖放监听注册失败，字体面板仍可用导入按钮", error);
        setShelfNotice({ kind: "error", text: "拖放不可用，可用导入按钮重试" });
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fontSettingsOpen, handleImportFontPaths, handleImportSources]);

  // ---- 派生 ----
  const ready = phase.phase === "ready" && book !== null && server !== null;
  const readerLoadFeedback = resolveReaderLoadFeedback({
    visible: view === "reader" && ready,
    displayReady: readerDisplayReady,
    displayedOnce: hasReaderDisplayedRef.current,
    chapter: chapterState,
  });
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
          const isLastLinear = lastLinear === spineIndex || nextLinearIndex(book, spineIndex, 1) === -1;
          const atBookEnd =
            settings.readingMode === "scroll"
              ? chapterState.status === "ready" && chapterState.atEnd === true
              : chapterState.status === "ready" && (chapterState.atEnd === true || (isLastLinear && chapterState.currentPage >= chapterState.pageCount - 1));
          if (atBookEnd) return 100;
          const pct = computeProgressPct(countSummary, anchorChars);
          return pct === null ? null : Math.min(99, pct);
        })()
      : null;
  const progressPct = resolveProgressPct(exactProgressPct, baselineProgressPctRef.current);

  const estimatedMinutesLeft = useMemo(() => {
    if (chapterState.status !== "ready") return undefined;
    const currentChars = countSummary.current;
    if (typeof currentChars === "number" && currentChars > 0) {
      const charsRemaining = Math.max(0, currentChars - anchorChars);
      return Math.max(1, Math.round(charsRemaining / 400));
    }
    if (chapterState.pageCount > 0) {
      const pagesRemaining = Math.max(0, chapterState.pageCount - 1 - chapterState.currentPage);
      return Math.max(1, Math.ceil(pagesRemaining * 0.8));
    }
    return undefined;
  }, [chapterState, countSummary.current, anchorChars]);

  const chapterTicks: WhisperFooterChapterTick[] = useMemo(() => {
    if (!book) return [];
    if (contentAxis && contentAxis.segments.length > 0) {
      return contentAxis.segments.map((seg) => ({
        spineIndex: seg.spineIndex,
        title: chapterLabelForIndex(book, seg.spineIndex),
        positionPct: Math.round(seg.start * 100),
        startRatio: seg.start,
        endRatio: seg.end,
      }));
    }
    const linearSpine = book.spine
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.linear !== false);
    const count = linearSpine.length;
    if (count <= 1) return [];
    return linearSpine.map(({ idx }, i) => ({
      spineIndex: idx,
      title: chapterLabelForIndex(book, idx),
      positionPct: Math.round((i / (count - 1)) * 100),
    }));
  }, [book, contentAxis]);

  // ---- 书架进度回写（阅读器状态→书架索引，不修改阅读器本体） ----
  const persistShelfProgress = useCallback(() => {
    const state = chapterStateRef.current;
    if (
      suppressShelfProgressRef.current ||
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
    const lastLinear = linearIndices.at(-1);
    const isLastLinear = lastLinear === spineIndex || (book ? nextLinearIndex(book, spineIndex, 1) === -1 : false);
    const atBookEnd =
      settings.readingMode === "scroll"
        ? state.status === "ready" && state.atEnd === true
        : state.status === "ready" && (state.atEnd === true || (isLastLinear && state.currentPage >= state.pageCount - 1));
    const exactProgressPct = atBookEnd
      ? 100
      : (() => {
          const pct = computeProgressPct(currentSummary, exactChars);
          return pct === null ? null : Math.min(99, pct);
        })();
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
      mediaAnchor: a?.mediaAnchor ?? null,
      // R5: this is an actually displayed chapter, so a modern locator can be
      // built even for image-only/media and chapter-start positions.
      chapterPath: book ? spineItemPath(book, spineIndex) ?? null : null,
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
    setShelfBusyMessage("正在保存进度…");
    setShelfBusy(true);
    try {
      await progressWriterRef.current?.flush();
      const closingShelfId = currentShelfIdRef.current;
      if (closingShelfId) {
        await getShelfStore().closeProgressSession?.(closingShelfId);
      }
      persistChapterCountCache();
    } catch (error) {
      const message = `阅读进度保存失败：${String(error)}`;
      setShelfError(message);
      showReaderNotice(message, "error");
      shelfBusyRef.current = false;
      setShelfBusy(false);
      return;
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
  }, [persistShelfProgress, persistChapterCountCache, closeForeground, closeImageOverlay, showReaderNotice]);

  const toggleAppearancePanel = useCallback((): void => {
    if (menuOpen) closePanel("menu");
    else openPanel("menu");
  }, [closePanel, menuOpen, openPanel]);

  const toggleSearchPanel = useCallback((): void => {
    if (searchOpen) closePanel("search");
    else openPanel("search");
  }, [closePanel, openPanel, searchOpen]);

  const handleReaderPlainTap = useCallback((): void => {
    if (
      !mobileChrome ||
      view !== "reader" ||
      imageRequestRef.current !== null ||
      foregroundRef.current.kind !== "none"
    ) return;
    setMobileMoreOpen(false);
    setReaderToolsVisible((visible) => !visible);
  }, [mobileChrome, view]);

  const revealReaderTools = useCallback((): void => {
    setReaderToolsVisible(true);
  }, []);

  const handleOpenMobileMore = useCallback((): void => {
    setMobileMoreOpen((open) => !open);
  }, []);

  const registerShelfBackHandler = useCallback((handler: (() => boolean) | null): void => {
    shelfBackHandlerRef.current = handler;
  }, []);

  const reportShelfBackActive = useCallback((active: boolean): void => {
    setShelfBackActive(active);
  }, []);

  const handleAndroidBack = useCallback((): void => {
    const activeElement = typeof document !== "undefined"
      ? document.activeElement as HTMLElement | null
      : null;
    const editingField = activeElement && (
      activeElement.tagName === "INPUT" ||
      activeElement.tagName === "TEXTAREA" ||
      activeElement.isContentEditable
    );
    if (responsive.imeBottom > 80 && editingField) {
      activeElement.blur();
      return;
    }
    if (imageRequestRef.current) {
      closeImageOverlay();
      return;
    }
    if (mobileMoreOpen) {
      setMobileMoreOpen(false);
      return;
    }
    const current = foregroundRef.current;
    if (current.kind !== "none" || isSidebarOpen) {
      requestCloseCurrentSurface();
      return;
    }
    if (view === "reader") {
      void handleBackToShelf();
      return;
    }
    if (view === "shelf") {
      shelfBackHandlerRef.current?.();
    }
  }, [
    closeImageOverlay,
    handleBackToShelf,
    isSidebarOpen,
    mobileMoreOpen,
    requestCloseCurrentSurface,
    responsive.imeBottom,
    view,
  ]);

  useAndroidBack(
    runtime.usesAndroidBack && (
      view === "reader" ||
      foreground.kind !== "none" ||
      imageRequest !== null ||
      shelfBackActive ||
      mobileMoreOpen
    ),
    handleAndroidBack
  );

  // 进入一本新书时恢复工具栏；手机/平板只切换覆盖层，不参与阅读几何。
  useEffect(() => {
    if (view !== "reader") {
      setMobileMoreOpen(false);
      return;
    }
    setReaderToolsVisible(true);
    setMobileMoreOpen(false);
  }, [currentShelfId, view]);

  useEffect(() => {
    if (!readerToolsVisible) setMobileMoreOpen(false);
  }, [readerToolsVisible]);

  useEffect(() => {
    if (foreground.kind !== "none" || imageRequest !== null) setMobileMoreOpen(false);
  }, [foreground.kind, imageRequest]);

  useEffect(() => {
    if (!noteComposer) noteComposerDirtyRef.current = false;
  }, [noteComposer]);

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
    contentAxisRef.current = null;
    setContentAxis(null);
    scrubSessionRef.current += 1;
    dispatchScrub({ type: "reset", session: scrubSessionRef.current });
    setChapterState({ status: "loading" });
    hasReaderDisplayedRef.current = false;
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
    if (!runtime.hasDesktopWindowChrome) {
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

  // ---- 全屏 / 沉浸禅模式（Zen Mode） ----
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenBusy, setFullscreenBusy] = useState(false);
  const [readerZenMode, setReaderZenMode] = useState(true);

  const fullscreenControllerRef = useRef<NativeFullscreenController | null>(null);
  if (!fullscreenControllerRef.current && runtime.hasDesktopWindowChrome) {
    try {
      const win = getCurrentWindow();
      const port: NativeFullscreenPort = {
        isFullscreen: () => win.isFullscreen(),
        isMaximized: () => win.isMaximized(),
        unmaximize: () => win.unmaximize(),
        maximize: () => win.maximize(),
        setFullscreen: (v) => win.setFullscreen(v),
      };
      const isWindows = runtime.platform === "windows";
      fullscreenControllerRef.current = createNativeFullscreenController(
        port,
        isWindows,
        (fs) => setIsFullscreen(fs),
        (busy) => setFullscreenBusy(busy)
      );
    } catch {}
  }

  const toggleWebFullscreen = useCallback(async () => {
    if (typeof document === "undefined") return;
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        } else {
          throw new Error("当前环境不支持全屏 API");
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (err) {
      setRuntimeIssues((issues) => [...issues, `全屏切换失败：${String(err)}`]);
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isTauriEnv()) {
      const controller = fullscreenControllerRef.current;
      if (controller) {
        try {
          await controller.toggle();
        } catch (err) {
          console.warn("Tauri setFullscreen failed", err);
          setRuntimeIssues((issues) => [...issues, `窗口全屏切换失败：${String(err)}`]);
        }
      }
      return;
    }
    await toggleWebFullscreen();
  }, [toggleWebFullscreen]);

  const toggleZenMode = useCallback(() => {
    setReaderZenMode((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isTauriEnv()) {
      const handleFullscreenChange = () => {
        setIsFullscreen(Boolean(document.fullscreenElement));
      };
      document.addEventListener("fullscreenchange", handleFullscreenChange);
      return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
    }
    if (!runtime.hasDesktopWindowChrome) return;
    try {
      const controller = fullscreenControllerRef.current;
      if (controller) {
        void controller.refresh();
        const win = getCurrentWindow();
        const unlistenPromise = win.onResized(() => {
          void controller.refresh();
        });
        return () => {
          void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
        };
      }
    } catch {}
  }, []);

  // 跨 iframe 键盘事件穿透代理：解决阅读器焦点落入正文 iframe 时桌面全局快捷键失效的问题
  useEffect(() => {
    const attachedDocs = new WeakSet<Document>();

    const attachIframeKeyboardForwarder = (iframe: HTMLIFrameElement) => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc || attachedDocs.has(doc)) return;
        attachedDocs.add(doc);

        const handleIframeKey = (e: KeyboardEvent) => {
          const t = e.target as HTMLElement | null;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
            if (e.key !== "Escape") return;
          }

          const isModifier = e.ctrlKey || e.metaKey || e.altKey;
          const isSpecial =
            e.key === "F11" ||
            e.key === "Escape" ||
            e.key === "[" ||
            e.key === "]";

          if (isModifier || isSpecial) {
            // 拦截浏览器/WebView 内置默认行为（如 Ctrl+T 新建标签页、Ctrl+F 默认查找等）
            if (
              (e.ctrlKey || e.metaKey) &&
              (e.key === "f" || e.key === "F" || e.key === "t" || e.key === "T" || e.key === "b" || e.key === "B")
            ) {
              e.preventDefault();
            }
            if (e.key === "F11") {
              e.preventDefault();
            }

            // 构造合成事件分发至宿主主窗口
            const synthetic = new KeyboardEvent(e.type, {
              key: e.key,
              code: e.code,
              keyCode: e.keyCode,
              which: e.which,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
              metaKey: e.metaKey,
              repeat: e.repeat,
              bubbles: true,
              cancelable: true,
            });
            window.dispatchEvent(synthetic);
          }
        };

        doc.addEventListener("keydown", handleIframeKey, true);
      } catch {}
    };

    const scanAndAttach = () => {
      const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe");
      iframes.forEach(attachIframeKeyboardForwarder);
    };

    scanAndAttach();

    const observer = new MutationObserver(() => {
      scanAndAttach();
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    const timer = setInterval(scanAndAttach, 400);

    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, []);

  const isReaderPanelOpen = Boolean(
    menuOpen ||
    fontSettingsOpen ||
    tocOpen ||
    searchOpen ||
    notesOpen ||
    logOpen ||
    assistantOpen ||
    noteComposer !== null
  );

  // 保存快捷键所需最新状态 ref，避免闭包捕获旧状态或频繁解绑事件
  const latestShortcutStateRef = useRef({
    view,
    ready,
    book,
    spineIndex,
    searchOpen,
    tocOpen,
    menuOpen,
    bookmarkMenuOpen,
    noteComposer,
    isFullscreen,
    readerHistory,
    readerDisplayReady,
    isReaderPanelOpen,
    navigationPending: navigationPendingRef.current,
  });

  latestShortcutStateRef.current = {
    view,
    ready,
    book,
    spineIndex,
    searchOpen,
    tocOpen,
    menuOpen,
    bookmarkMenuOpen,
    noteComposer,
    isFullscreen,
    readerHistory,
    readerDisplayReady,
    isReaderPanelOpen,
    navigationPending: navigationPendingRef.current,
  };

  // ---- 桌面全局快捷键集中分发与键盘翻页（Zen UI Packet 3 键盘流） ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      if (isSelectAllShortcut(e)) {
        e.preventDefault();
        clearDocumentSelection(document);
        return;
      }
      const t = e.target as HTMLElement | null;
      const st = latestShortcutStateRef.current;

      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        // 在文本输入框/搜索框按下 Escape 时失焦并收起当前活动弹窗
        if (e.key === "Escape") {
          t.blur();
          if (st.isReaderPanelOpen || isSidebarOpen || st.bookmarkMenuOpen || st.noteComposer !== null) {
            requestCloseCurrentSurface();
          }
        }
        return;
      }

      // 1. Ctrl + F / Cmd + F：打开/切换正文搜索
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (st.view === "reader" && st.ready && !st.book?.fixedLayout) {
          if (st.searchOpen) closePanel("search");
          else openPanel("search");
        }
        return;
      }

      // 2. Ctrl + Shift + B：呼出/切换书签抽屉
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        if (st.view === "reader") {
          handleToggleBookmarks();
        }
        return;
      }

      // 3. Ctrl + T：切换展开/关闭侧边栏（目录/书签/笔记）
      if ((e.ctrlKey || e.metaKey) && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        if (st.view === "reader") {
          handleToggleSidebar();
        }
        return;
      }

      // 4. Ctrl + B：添加/移除当前页书签
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        if (st.view === "reader") {
          handleToggleBookmark();
        }
        return;
      }

      // 5. F11：进入/退出全屏（纯净沉浸模式）
      if (e.key === "F11") {
        e.preventDefault();
        if (e.repeat) return;
        void toggleFullscreen();
        return;
      }

      // 6. Alt + Left / Alt + Right：历史阅读位置后退 / 前进，若无跳转历史则切上一章/下一章
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending) {
          if (st.readerHistory.back.length > 0) {
            handleHistoryBack();
          } else if (st.spineIndex > 0 && st.book) {
            const path = spineItemPath(st.book, st.spineIndex - 1);
            if (path) handleTocNavigate(path);
          }
        }
        return;
      }
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending) {
          if (st.readerHistory.forward.length > 0) {
            handleHistoryForward();
          } else if (st.book && st.spineIndex < st.book.spine.length - 1) {
            const path = spineItemPath(st.book, st.spineIndex + 1);
            if (path) handleTocNavigate(path);
          }
        }
        return;
      }

      // 7. [ 与 ] 键：快速跳转上一章 / 下一章
      if (e.key === "[" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending && st.spineIndex > 0 && st.book) {
          const path = spineItemPath(st.book, st.spineIndex - 1);
          if (path) handleTocNavigate(path);
        }
        return;
      }
      if (e.key === "]" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending && st.book && st.spineIndex < st.book.spine.length - 1) {
          const path = spineItemPath(st.book, st.spineIndex + 1);
          if (path) handleTocNavigate(path);
        }
        return;
      }

      // 8. Esc：优先关闭任意处于激活状态的前景/弹窗/抽屉；若无浮层且全屏中，退回窗口模式
      if (e.key === "Escape") {
        if (st.isReaderPanelOpen || isSidebarOpen || st.bookmarkMenuOpen || st.noteComposer !== null) {
          requestCloseCurrentSurface();
          return;
        }
        if (st.isFullscreen) {
          if (fullscreenBusy) return;
          void toggleFullscreen();
          return;
        }
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
  }, [
    closeForeground,
    fullscreenBusy,
    handleHistoryBack,
    handleHistoryForward,
    handleToggleBookmark,
    handleToggleBookmarks,
    handleToggleSidebar,
    handleSidebarClose,
    requestCloseCurrentSurface,
    isSidebarOpen,
    toggleFullscreen,
    openPanel,
    closePanel,
    handleTocNavigate,
  ]);

  const resolveProgressChoice = useCallback((stamp: Stamp | null): void => {
    const resolve = progressChoiceResolverRef.current;
    progressChoiceResolverRef.current = null;
    setProgressChoice(null);
    resolve?.(stamp);
  }, []);

  return (
    <div
      className={`app${dragActive ? " drag-active" : ""}${isFullscreen ? " is-fullscreen" : ""}${isDockedSidebar ? ` has-docked-sidebar docked-side-${sidebarSide}` : ""}`}
      data-platform={runtime.platform}
      data-shell={runtime.shell}
      data-layout={responsive.layout}
      data-touch-ui={responsive.touchUi ? "true" : undefined}
      data-mobile-chrome={mobileChrome ? "true" : undefined}
      data-mobile-reader={mobileChrome && view === "reader" ? "true" : undefined}
      data-tools-visible={mobileChrome && view === "reader" ? String(readerToolsVisible) : undefined}
      data-theme={settings.theme === "dark" ? "dark" : settings.theme === "sepia" ? "sepia" : settings.theme === "gray" ? "gray" : undefined}
      style={{
        "--ui-scale": uiScale,
        // UI 缩放下的触摸命中区补偿；只用于触摸入口，不改用户存储的 uiScale。
        "--ui-touch-comp": `${1 / uiScale}`,
        "--visual-viewport-height": `${responsive.visualViewportHeight}px`,
        "--visual-viewport-top": `${responsive.visualViewportOffsetTop}px`,
        "--ime-bottom": `${responsive.imeBottom}px`,
      } as CSSProperties}
    >
      <TitleBar
        view={view}
        title={view === "reader" ? (ready ? book!.metadata.title : (book?.metadata.title ?? "")) : "EPUB 阅读器"}
        chapterTitle={view === "reader" && ready ? currentChapterLabel : undefined}
        onBackToShelf={view === "reader" ? handleBackToShelf : undefined}
        onToggleSidebar={view === "reader" ? handleToggleSidebar : undefined}
        sidebarOpen={view === "reader" && isSidebarOpen}
        mobileCompact={phoneChrome}
        toolsVisible={readerToolsVisible}
        onToggleTools={view === "reader" ? () => setReaderToolsVisible((visible) => !visible) : undefined}
        onToggleAppearance={view === "reader" ? toggleAppearancePanel : undefined}
        appearanceOpen={view === "reader" && menuOpen}
        onOpenSearch={
          view === "reader" && ready && !book!.fixedLayout
            ? toggleSearchPanel
            : undefined
        }
        searchOpen={view === "reader" && searchOpen}
        isBookmarked={view === "reader" && isCurrentPageBookmarked}
        onToggleBookmark={view === "reader" ? handleToggleBookmark : undefined}
        bookmarksOpen={view === "reader" && isSidebarOpen && activeSidebarTab === "bookmarks"}
        onOpenBookmarks={view === "reader" ? handleToggleBookmarks : undefined}
        zenMode={view === "reader" && !mobileChrome && (readerZenMode || isFullscreen)}
        onToggleZenMode={view === "reader" ? toggleZenMode : undefined}
        progressPct={view === "reader" && ready ? progressPct : undefined}
        chapterIndex={view === "reader" && ready ? spineIndex : undefined}
        totalChapters={view === "reader" && ready && book ? book.spine.length : undefined}
        isFullscreen={isFullscreen}
        fullscreenBusy={fullscreenBusy}
        onToggleFullscreen={view === "reader" ? toggleFullscreen : undefined}
        onToggleAssistant={
          view === "reader" && IS_AI_EDITION
            ? () => {
                if (assistantOpen) closePanel("assistant");
                else openPanel("assistant");
              }
            : undefined
        }
        assistantOpen={view === "reader" && assistantOpen}
      />
      {mobileChrome && view === "reader" && !readerToolsVisible && (
        <button
          type="button"
          className="reader-tools-reveal"
          onClick={revealReaderTools}
          aria-label="显示阅读工具"
        >
          显示阅读工具
        </button>
      )}
      {view === "reader" && ready && (
        <SidebarDrawer
          open={isSidebarOpen}
          side={sidebarSide}
          activeTab={activeSidebarTab}
          onTabChange={handleSidebarTabChange}
          mode={effectiveSidebarMode}
          onModeChange={handleSidebarModeChange}
          onClose={handleSidebarClose}
          compact={phoneChrome}
          toc={book!.toc}
          activeHref={activeHref}
          onNavigateToc={handleTocNavigate}
          bookmarks={sortedBookmarks}
          onSelectBookmark={handleSelectBookmark}
          onDeleteBookmark={handleDeleteBookmark}
          notes={noteViewModels}
          onNavigateNote={(viewNote) => {
            const note = currentNotes.find((candidate) => candidate.id === viewNote.id);
            if (note) handleNoteNavigate(note);
          }}
          onEditNote={(viewNote) => {
            const note = currentNotes.find((candidate) => candidate.id === viewNote.id);
            if (!note) return;
            openComposer({ mode: "edit", note });
          }}
          onDeleteNote={(viewNote) => void handleDeleteNote(viewNote.id)}
        />
      )}
      <div className="main">
        {view === "shelf" ? (
          <div className="shelf-stack">
            {shelfError && (
              <div className="shelf-error" role="alert">
                {shelfError}
              </div>
            )}
            <ShelfView
              compact={phoneChrome}
              entries={shelfEntries}
              organization={organization}
              scope={shelfScope}
              onScopeChange={setShelfScope}
              onApplyOrganization={handleApplyOrganization}
              busy={shelfBusy}
              importActive={nativeImport !== null}
              theme={settings.theme}
              onThemeChange={changeTheme}
              onOpen={handleShelfOpen}
              onImport={() => void handleChooseBooks()}
              onDelete={handleShelfDelete}
              onDeleteMany={handleShelfDeleteMany}
              registerBackHandler={registerShelfBackHandler}
              onBackAvailabilityChange={reportShelfBackActive}
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
                  if (entry) void handleShelfOpen(entry.id, result.hit, result.textHits, result.occurrence);
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
                /> : <AaPopover
                  fontSize={settings.fontSizePx}
                  onFontSizeChange={(v) =>
                    setSettings((s2) => {
                      const fontSizePx = clamp(v, 12, 32);
                      return fontSizePx === s2.fontSizePx ? s2 : { ...s2, fontSizePx };
                    })
                  }
                  onFontDec={() => adjustFont(-2)}
                  onFontInc={() => adjustFont(2)}
                  theme={settings.theme}
                  onThemeChange={changeTheme}
                  customFontName={settings.customFontName}
                  onOpenFontSettings={() => setForeground((current) => setMenuSubview(current, "fonts"))}
                  lineHeight={settings.lineHeight}
                  onLineHeightChange={(v) =>
                    setSettings((s2) => {
                      const lineHeight = clamp(v, 1.2, 2.4);
                      return lineHeight === s2.lineHeight ? s2 : { ...s2, lineHeight };
                    })
                  }
                  onResetLineHeight={() =>
                    setSettings((s2) => ({ ...s2, lineHeight: undefined }))
                  }
                  fontWeight={settings.fontWeight}
                  onFontWeightChange={(v) =>
                    setSettings((s2) => ({ ...s2, fontWeight: v }))
                  }
                  letterSpacingPx={settings.letterSpacingPx}
                  onLetterSpacingChange={(v) =>
                    setSettings((s2) => ({ ...s2, letterSpacingPx: v }))
                  }
                  wordSpacingPx={settings.wordSpacingPx}
                  onWordSpacingChange={(v) =>
                    setSettings((s2) => ({ ...s2, wordSpacingPx: v }))
                  }
                  gapPx={settings.gapPx}
                  spreadGapMode={settings.spreadGapMode ?? "auto"}
                  onGapPxChange={(gap) =>
                    setSettings((s2) => ({ ...s2, gapPx: gap, spreadGapMode: "manual" }))
                  }
                  onSpreadGapModeChange={(mode) =>
                    setSettings((s2) => ({ ...s2, spreadGapMode: mode }))
                  }
                  spreadArea={chapterState.status === "ready" ? chapterState.spreadArea : undefined}
                  uiScale={uiScale}
                  onUiScaleChange={(scale) => setUiScale(scale)}
                  pageMargins={settings.pageMarginsPx}
                  onPageMarginsChange={(margins) =>
                    setSettings((s2) => ({ ...s2, pageMarginsPx: margins }))
                  }
                  columnsPerView={settings.columnsPerView === 2 ? 2 : 1}
                  onColumnsChange={(cols) => handlePresentationChange({ columnsPerView: cols })}
                  readingMode={settings.readingMode === "scroll" ? "scroll" : "paginated"}
                  onReadingModeChange={(mode) => handlePresentationChange({ readingMode: mode })}
                  effectiveColumns={chapterState.status === "ready" ? chapterState.effectiveColumns : undefined}
                  onPresentationChange={handlePresentationChange}
                  instantTurn={settings.instantTurn === true}
                  onInstantTurnChange={(enabled) =>
                    setSettings((s2) => ({ ...s2, instantTurn: enabled }))
                  }
                  forceHorizontal={settings.forceHorizontal === true}
                  onForceHorizontalChange={(enabled) =>
                    setSettings((s2) => ({ ...s2, forceHorizontal: enabled }))
                  }
                  preloadNextChapter={settings.preloadNextChapter === true}
                  preloadNextChapterDisabled={book?.fixedLayout === true}
                  onPreloadNextChapterChange={(enabled) =>
                    setSettings((s2) => ({ ...s2, preloadNextChapter: enabled }))
                  }
                  customCss={settings.customCss}
                  onCustomCssChange={(css) =>
                    setSettings((s2) => ({ ...s2, customCss: css }))
                  }
                  onResetDefaults={resetDefaults}
                  onToggleLog={handleToggleLog}
                  issueCount={logItems.length}
                  onOpenFile={() => {
                    void handleChooseBooks();
                    closeForeground();
                  }}
                  onClose={closeForeground}
                />}
              </>
            )}
            {ready ? (
              <>
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
                          if (entry) void handleShelfOpen(entry.id, crossResult.hit, crossResult.textHits, crossResult.occurrence);
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
                  onVisibleChapterChange={handleVisibleChapterChange}
                  onDisplayReady={handleReaderDisplayReady}
                  onRequestChapter={handleRequestChapter}
                  onIssues={handleIssues}
                  onInternalLink={handleInternalNavigate}
                  onBeforeInternalNavigate={captureReaderHistory}
                  onInternalNavigationSettled={handleReaderDisplayReady}
                  onNavigationUnresolved={handleReaderNavigationUnresolved}
                  onUserReadingPositionChange={handleUserReadingPositionChange}
                  onExternalLink={handleExternalLink}
                   onFootnote={(payload) => openTransient("footnote", payload)}
                  onFootnoteClose={handleFootnoteClose}
                  onImageActivation={handleImageActivation}
                  inputPaused={imageRequest !== null}
                  onPlainTap={mobileChrome ? handleReaderPlainTap : undefined}
                  initialAnchor={initialAnchor}
                  initialPage={initialPage}
                  initialAlignment={initialAlignment}
                  startAtEnd={startAtEnd}
                  preciseTarget={preciseTarget}
                  onPreciseNavigationStatus={handlePreciseNavigationStatus}
                  onContentFractionSettled={handleContentFractionSettled}
                  onContentFractionCancelled={handleContentFractionCancelled}
                  onContentFractionFailed={handleContentFractionFailed}
                  onUserProgressSample={handleUserProgressSample}
                />
                {readerLoadFeedback && (
                  <div
                    className={`reader-load-feedback ${readerLoadFeedback.kind}`}
                    role={readerLoadFeedback.kind === "error" ? "alert" : "status"}
                    aria-live={readerLoadFeedback.kind === "error" ? "assertive" : "polite"}
                  >
                    {readerLoadFeedback.kind === "loading" && (
                      <span className="reader-load-feedback-spinner" aria-hidden="true" />
                    )}
                    <span className="reader-load-feedback-text">{readerLoadFeedback.text}</span>
                  </div>
                )}
                <ImageViewer
                  image={imageRequest}
                  onClose={closeImageOverlay}
                  onFollowLink={(image) => {
                    // 带链接的图片：交回既有安全路由与历史路径，不直接 window.location。
                    const href = image.linkHref;
                    closeImageOverlay();
                    if (!href) return;
                    if (isExternalUrl(href) || href.startsWith("//")) {
                      handleExternalLink(href);
                      return;
                    }
                    if (isFragmentOnly(href)) {
                      const snapshot = currentReaderPosition();
                      if (readerRef.current?.navigateWithinCurrentChapter({ fragment: href.slice(1) })) {
                        commitReaderHistorySnapshot(snapshot);
                      }
                      return;
                    }
                    // ImageViewRequest keeps the original anchor href, which is
                    // relative to its chapter. Resolve it before App routing.
                    const { path, anchor } = splitHref(href);
                    const resolved = resolvePath(image.chapterPath, path);
                    handleTocNavigate(anchor ? `${resolved}#${anchor}` : resolved);
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
                      onCancel={requestCloseForeground}
                      onDirtyChange={(dirty) => { noteComposerDirtyRef.current = dirty; }}
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
        <WhisperFooter
          currentPage={chapterState.status === "ready" ? chapterState.currentPage : 0}
          pageCount={chapterState.status === "ready" ? chapterState.pageCount : 1}
          leafRange={chapterState.status === "ready" ? chapterState.leafRange : null}
          readingMode={settings.readingMode === "scroll" ? "scroll" : "paginated"}
          scrollProgress={chapterState.status === "ready" ? chapterState.scrollProgress ?? 0 : 0}
          totalScrollProgress={chapterState.status === "ready" ? chapterState.totalScrollProgress : undefined}
          chapterTitle={currentChapterLabel || book!.metadata.title}
          chapterIndex={spineIndex}
          totalChapters={book!.spine.length}
          estimatedMinutesLeft={estimatedMinutesLeft}
          bookProgressPct={progressPct}
          onSeekPage={(targetPage) => {
            readerRef.current?.setPage(targetPage);
          }}
          onSeekChapter={(targetSpineIndex) => {
            if (targetSpineIndex >= 0 && targetSpineIndex < book!.spine.length) {
              const path = spineItemPath(book!, targetSpineIndex);
              if (path) handleTocNavigate(path);
            }
          }}
          onSeekRatio={(targetRatio) => {
            handleCommitSeek(targetRatio);
          }}
          chapterTicks={chapterTicks}
          zenMode={view === "reader" && !mobileChrome && (readerZenMode || isFullscreen)}
          scrubState={scrubUiState}
          contentAxis={contentAxis}
          onCommitSeek={handleCommitSeek}
          onPreviewChange={handleScrubPreviewChange}
          mobile={mobileChrome}
          toolsVisible={readerToolsVisible}
          onToggleSidebar={() => handleToggleSidebar("left")}
          sidebarOpen={isSidebarOpen}
          onOpenSearch={!book!.fixedLayout ? toggleSearchPanel : undefined}
          searchOpen={searchOpen}
          onToggleAppearance={toggleAppearancePanel}
          appearanceOpen={menuOpen}
          onOpenMore={handleOpenMobileMore}
          moreOpen={mobileMoreOpen}
        />
      )}
      {mobileChrome && view === "reader" && ready && mobileMoreOpen && (
        <>
          <div
            className="mobile-more-backdrop"
            onClick={() => setMobileMoreOpen(false)}
            aria-hidden="true"
          />
          <div className="mobile-more-sheet" role="dialog" aria-modal="true" aria-label="更多阅读操作">
            <div className="mobile-more-title">更多</div>
            <button
              type="button"
              onClick={() => {
                handleOpenBookmarks();
                setMobileMoreOpen(false);
              }}
            >
              书签列表
            </button>
            <button
              type="button"
              onClick={() => {
                openPanel("notes");
                setMobileMoreOpen(false);
              }}
            >
              笔记
            </button>
            {IS_AI_EDITION && (
              <button
                type="button"
                onClick={() => {
                  openPanel("assistant");
                  setMobileMoreOpen(false);
                }}
              >
                AI 助手
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                openPanel("log");
                setMobileMoreOpen(false);
              }}
            >
              诊断日志
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileMoreOpen(false);
                void handleChooseBooks();
              }}
            >
              打开本地文件
            </button>
            <div className="mobile-more-about">
              <AboutInfo />
            </div>
          </div>
        </>
      )}
      {logOpen && (
        <LogPanel
          items={logItems}
          diagText={diagText}
          onClose={() => {
            closePanel("log");
            setDiagText(null);
          }}
        />
      )}
      {(shelfNotice || readerNotice) && (
        <div
          className={`shelf-toast ${(shelfNotice ?? readerNotice)!.kind}${(shelfNotice ? shelfNoticeFading : readerNoticeFading) ? " fading" : ""}`}
          role="status"
        >
          {(shelfNotice ?? readerNotice)!.text}
        </div>
      )}
      {bookmarkToast && (
        <div
          className={`reader-bookmark-toast ${bookmarkToast.action}${bookmarkToast.closing ? " is-closing" : ""}`}
          role="status"
          aria-live="polite"
        >
          <span className="bookmark-toast-icon" aria-hidden="true">
            {bookmarkToast.action === "add" ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                <line x1="3" y1="3" x2="21" y2="21" />
              </svg>
            )}
          </span>
          <span className="bookmark-toast-text">{bookmarkToast.text}</span>
        </div>
      )}
      {nativeImport && (
        <NativeImportPanel
          phase={nativeImport.phase}
          completed={nativeImport.completed}
          total={nativeImport.total}
          fileNameSummary={nativeImport.fileNameSummary}
          cancelState={nativeImport.cancelState}
          collapsed={nativeImport.collapsed}
          onToggleCollapsed={handleToggleNativeImportCollapsed}
          onCancel={() => void handleCancelNativeImport()}
        />
      )}
      {(shelfBusy || phase.phase === "loading") && nativeImport === null && (
        <div className="app-busy" role="status" aria-live="polite" aria-busy="true">
          <div className="app-busy-spinner" />
          <div
            className="app-busy-text"
            title={phase.phase === "loading" ? `正在打开《${phase.fileName}》…` : shelfBusyMessage}
          >
            {phase.phase === "loading" ? `正在打开《${phase.fileName}》…` : shelfBusyMessage}
          </div>
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
      <div id="shelf-menu-portal-host" className="shelf-menu-portal-host" />
      {progressChoice && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="选择恢复进度"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(0, 0, 0, 0.45)",
          }}
        >
          <div
            style={{
              width: "min(520px, 100%)",
              maxHeight: "80vh",
              overflow: "auto",
              background: "var(--surface, #fff)",
              color: "var(--text, #222)",
              borderRadius: 12,
              padding: 20,
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.3)",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>选择恢复进度</h3>
            <p style={{ margin: "0 0 14px", fontSize: 14, lineHeight: 1.5 }}>
              《{progressChoice.title}》有 {progressChoice.candidates.length} 个阅读进度版本，请选择要恢复的一项。
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {progressChoice.candidates.map((candidate) => (
                <button
                  key={`${candidate.stamp.deviceId}:${candidate.stamp.counter}`}
                  type="button"
                  onClick={() => resolveProgressChoice(candidate.stamp)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 4,
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid var(--border, #d0d0d0)",
                    borderRadius: 8,
                    background: "var(--surface, #fff)",
                    color: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <strong style={{ fontSize: 14 }}>
                    {candidate.chapterPath
                      ? candidate.chapterPath.split("/").pop() || candidate.chapterPath
                      : `第 ${candidate.spineIndex + 1} 章`}
                  </strong>
                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                    {candidate.progressPct}% · {new Date(candidate.updatedAtMs).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => resolveProgressChoice(null)}
              style={{
                marginTop: 14,
                width: "100%",
                padding: "9px 12px",
                border: "1px solid var(--border, #d0d0d0)",
                borderRadius: 8,
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
