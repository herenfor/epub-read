import { ComicReaderView } from "./ui/ComicReaderView";
import { supportedBookName } from "./core/documentFormats";
import { resolveArchiveHref, archiveHref } from "./core/archiveReferences";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { spineIndexForEntryKey, spineItemPath, spineItemHref, disposeBook, nextLinearIndex, linearChapterNumber, linearChapterTotal, tocLabelsBySpine } from "./core/book";
import type { Book } from "./core/types";
import type { Stamp, Version } from "./core/portableState/portable-register-core";
import { projectProgressVersion } from "./core/portableState/projection";
import type { Locator, PortablePreferences, ProgressValue } from "./core/portableState/portable-state-types";
import { isExternalUrl, isFragmentOnly } from "./core/paths";
import type { ExactTextHit } from "./core/exactTextHits";
import type { SearchOccurrence } from "./core/searchOccurrence";
import type { ResourceIssue } from "./render/resources";
import { sanitizePersistedTextAnchor } from "./render/textAnchor";
import { clearDocumentSelection } from "./render/selectionGuard";
import { effectivePageProgression, normalizeTurnAnimation } from "./render/settings";
import type { ChapterState, MediaReadingAnchor } from "./render/paginator";
import { useReaderSettings, useReaderSettingsPersistence } from "./ui/useReaderSettings";
import { sanitizeTextProjectionPreferences } from "./render/textProjection/preferences";
import type { ImageViewRequest } from "./render/imageActivation";
import { ImageViewer } from "./ui/ImageViewer";
import { TitleBar } from "./ui/TitleBar";
import { getRuntimeCapabilities } from "./platform/runtimeCapabilities";
import {
  closeReaderTab,
  cycleReaderTab,
  parseReaderTabs,
} from "./ui/readerTabs";
import { useReaderTabsVisible } from "./ui/readerTabLayout";
import { useReaderNavigation } from "./ui/useReaderNavigation";
import { useReaderChapterCallbacks } from "./ui/useReaderChapterCallbacks";
import { useBookSession } from "./ui/useBookSession";
import { useBookOpen } from "./ui/useBookOpen";
import { useExternalOpenFlow } from "./ui/useExternalOpenFlow";
import { useProgressRuntime } from "./ui/useProgressRuntime";
import { useScrubState } from "./ui/useScrubState";
import { useShelfProgressCommit } from "./ui/useShelfProgressCommit";
import { useReaderTabActions, useReaderTabsState } from "./ui/useReaderTabs";
import { useAndroidBack } from "./platform/useAndroidBack";
import { useExitPresence } from "./ui/menuMotion";
import { useReaderCursorIdle } from "./ui/readerCursorIdle";
import { SidebarDrawer } from "./ui/SidebarDrawer";
import { AaPopover } from "./ui/AaPopover";
import { useOpeningPanelPrep } from "./ui/openingPanelPrep";
import { PanelPaintWarmup, usePanelPaintWarmup, type PanelWarmBatch } from "./ui/panelPaintWarmup";
import { resolveReaderLoadFeedback } from "./ui/loadingFeedback";
import { WhisperFooter, type WhisperFooterChapterTick } from "./ui/WhisperFooter";
import { BatteryIndicator } from "./ui/BatteryIndicator";
import { ReaderOpening } from "./ui/ReaderOpening";
import { useReaderPlatformPreferences } from "./ui/useReaderPlatformPreferences";
import { useFullscreenControls } from "./ui/useFullscreenControls";
import { useReaderShortcuts } from "./ui/useReaderShortcuts";
import { useShelfExitBack } from "./ui/useShelfExitBack";
import { useSaveFileFlows } from "./ui/useSaveFileFlows";
import { useResponsiveEnvironment } from "./ui/responsiveEnvironment";
import {
  createContentAxis,
  type AxisInput,
} from "./ui/readerProgressAxis";
import { FontSettingsPanel } from "./ui/FontSettingsPanel";
import { SearchPanel } from "./ui/SearchPanel";
import { useReaderSearchView, useReaderSearchState, useReaderSearchRefs,
  useReaderSearchSession, useReaderSearchQuery, useReaderSearchPanel } from "./ui/useReaderSearch";
import { useShelfSearchMode, useLibrarySearchRuntime, useLibrarySearchBooks,
  useLibrarySearchResults, useLibrarySearchActions } from "./ui/useLibrarySearch";
import { TextProjectionPanel } from "./ui/textProjection/TextProjectionPanel";
import {
  loadTextProjectionPreferences,
  saveTextProjectionPreferences,
} from "./ui/textProjection/preferencesStorage";
import {
  compileTextProjection,
  isIdentityTextProjection,
  textProjectionVersion,
  type CompiledTextProjection,
} from "./render/textProjection/compile";
import type { TextProjectionPreferences } from "./render/textProjection/types";
import { ColorAssistPanel } from "./ui/colorAssist/ColorAssistPanel";
import { correctionMatrix, svgMatrixValues } from "./render/colorAssist/colorAssistCore";
import { ReaderVisualSettingsPanel } from "./ui/visual/ReaderVisualSettingsPanel";
import {
  loadVisualPreferences,
  normalizeVisualPreferences,
  saveVisualPreferences,
  type ReaderVisualPreferences,
} from "./render/visual/readerVisualPreferences";
import { setColorAssistMatrixProvider } from "./render/visual/readerVisualPaint";
import { ReaderDisplaySettingsPopover } from "./ui/ReaderDisplaySettingsPopover";
import "./ui/readerDisplaySettings.css";
import "./ui/themeTransition.css";
import { ReaderContextMenu } from "./ui/ReaderContextMenu";
import { NoteComposer } from "./ui/NoteComposer";
import type { ReaderNote } from "./ui/notes";
import { hasOwnField, chapterLabelForIndex, useNoteEditRef, replaceNoteEditContext,
  useBookmarkToast, useBookmarkToastCleanup, useNoteBusyState, useNoteProjection, useNoteActions,
  useBookmarkProjection, useBookmarkSidebarToggle, useBookmarkActions, useBookmarkRibbonActions,
  useNoteEditRelease } from "./ui/useBookmarksAndNotes";
import { BookmarkPagesPopover, WARM_BOOKMARK_PAGES_SCREEN } from "./ui/BookmarkPagesPopover";
import { uiPlural, uiText, useUiText } from "./ui/localization/UiLanguageProvider";
import { FootnotePop } from "./ui/FootnotePop";
import { LogPanel, type LogItem } from "./ui/LogPanel";
import { ReaderView, type ReaderHandle } from "./ui/ReaderView";
import { createShelfSessionMemory, ShelfView } from "./ui/ShelfView";
import { ReaderReturnControl } from "./ui/ReaderReturnControl";
import { applyDocumentTheme, documentThemeAttributes, useThemeTransition } from "./ui/themeTransitionHost";
import { useReadingInputStart } from "./ui/readerPointerEdge";
import { shelfLibraryView } from "./ui/libraryLoad";
import { useFolderWatchTriggers } from "./ui/folderWatch";
import {
  useShelfEntriesState, useShelfNoticeState, useShelfOrganizationState,
  useShelfContentHashes, useShelfLibrary, useShelfOrganizationActions,
  useShelfDeletion, useShelfNoticeLifetime,
} from "./ui/useShelfLibrary";
import { displayNameFromContentUri, useBookImportState, useBookImport, useFolderImport, type ImportFolderTarget } from "./ui/useBookImport";
import { activeShelfSpace, shelfSpaceStorage } from "./ui/shelfSpaces";
import { useShelfSpaces } from "./ui/privateShelf/useShelfSpaces";
import { PrivateShelfDialog } from "./ui/privateShelf/PrivateShelfDialog";
import { privateShelfNative } from "./platform/privateShelf";
import { emptyOrganization } from "./ui/libraryOrganization";
import { ExternalOpenFailureDialog } from "./ui/ExternalOpenFailureDialog";
import { OriginalImportRetryDialog } from "./ui/OriginalImportRetryDialog";
import { ReaderReadingSettings, SettingsSwitch } from "./ui/ReadingSettings";
import { ChevronRightIcon } from "./ui/readerIcons";
import { NativeImportPanel } from "./ui/NativeImportPanel";
import {
  FolderImportPanel,
} from "./ui/folderImport";
import { LanSavePanel } from "./ui/LanSavePanel";
import { SaveFileExportDialog, SaveFileImportPreview, SaveFileProgressPanel } from "./ui/SaveFileDialogs";
import { SaveFailureDialog } from "./ui/SaveFailureDialog";
import { releaseUnsavedLane, type SaveFailurePrompt } from "./ui/saveFailureExit";
import { useSaveFileJob } from "./ui/useSaveFileJob";
import {
  getShelfStore,
  readingAnchorFromShelfEntry,
  revealShelfSource,
  shelfThumbnailProvider,
  portableShelfStateActive,
  type ShelfEntry,
  type ShelfProgressPatch,
} from "./ui/shelf";
import {
  sameCheckpointValue,
} from "./ui/checkpointProgressRepair";
import { progressValueFromPatch } from "./ui/portableState/shelfStoreAdapter";
import { mayCommitRestoredProgress } from "./ui/restoreCommitGate";
import { useReaderSession } from "./ui/useReaderSession";
import { currentChapterCharsRead } from "./ui/readingProgress";
import {
  applyChapterCount,
  applyChapterCountError,
  computeProgressPct,
  createChapterCountCollection,
  resolveProgressPct,
  summarizeLinearCounts,
} from "./ui/chapterCounts";
import { createChapterCountJob } from "./ui/chapterCountJob";
import { forgetChapterCounts, readKnownChapterProgressKeys, writeChapterCountCache } from "./ui/chapterCountCache";
import { forgetShelfPlaceLabel, writeShelfPlaceLabel } from "./ui/shelfPlaceCache";
import { useCustomThemes } from "./ui/useCustomThemes";
import { projectShelfProgressReadiness } from "./ui/shelfProgressDisplay";
import {
  emptyReaderNavigationHistory,
  type ReaderNavigationHistory,
  type ReaderNavigationPosition,
} from "./ui/readerNavigationHistory";
import { sameChapterRoute } from "./ui/sameChapterNavigation";
import {
  writeProgress,
  type SavedProgress,
} from "./ui/storage";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isPhysicalPointInsideRect, isSupportedFontFileName } from "./ui/fontDrop";
import { folderIdAtPhysicalPoint, partitionDroppedPaths } from "./ui/shelfDrop";
import { liveFolderName } from "./ui/importIntoFolder";
import { useFontLibrary } from "./ui/useFontLibrary";
import { useLibraryActivation } from "./ui/useLibraryActivation";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { stat as statFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  closeReaderForeground,
  openReaderPanel,
  type ReaderForeground,
} from "./ui/readerForeground";
import {
  readerForegroundSurfaces,
  useReaderForeground,
  useReaderForegroundState,
  useReaderSidebar,
} from "./ui/useReaderForeground";
import { createEditionAiRuntime } from "./features/ai/lifecycle/editionRuntime";
import { IS_AI_EDITION } from "./config/edition";
import { useUiScaleRoot } from "./ui/uiScale";
import { registerAppUpdateSaveGate, startAppUpdates } from "./ui/appUpdate/appUpdateStore";
import { ProgressSourceChoices, type ProgressSourceCandidate } from "./ui/cloudSync/ProgressSourceChoices";
import { folderImportCopyChoice, importEntryCopyChoiceSupported, libraryCopyChoice, setCopyOnImport, useLibrarySettings } from "./ui/librarySettings";

// This is intentionally a compile-time edition branch. The core build has no
// static dependency on the AI panel or its model-asset subtree; AI builds keep
// the existing development-only panel as a lazy chunk.
const LazyAiFoundationPanel = IS_AI_EDITION
  ? lazy(() => import("./features/ai/ui/AiFoundationPanel").then(({ AiFoundationPanel }) => ({ default: AiFoundationPanel })))
  : null;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type AppPhase =
  | { phase: "idle" }
  | { phase: "loading"; fileName: string; title?: string; creator?: string }
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


type PortableProgressChoiceCandidate = ProgressSourceCandidate & {
  readonly stamp: Stamp;
  readonly version: Version<ProgressValue>;
};

function portableProgressVersions(entry: ShelfEntry): readonly Version<ProgressValue>[] {
  return (entry as unknown as { readonly portableProgressVersions?: readonly Version<ProgressValue>[] })
    .portableProgressVersions ?? [];
}

function portableLocatorOf(entry: ShelfEntry): Locator | null {
  return (entry as unknown as { readonly portableLocator?: Locator | null }).portableLocator ?? null;
}



function mergeProgressProjection(entry: ShelfEntry, written: ShelfEntry): ShelfEntry {
  const source = written as unknown as {
    readonly chapterPath?: string | null;
    readonly portableLocator?: Locator | null;
    readonly portableProgressVersions?: readonly Version<ProgressValue>[];
    readonly portableProgressConflict?: boolean;
  };
  return {
    ...entry,
    lastReadAtMs: written.lastReadAtMs,
    spineIndex: written.spineIndex,
    page: written.page,
    progressPct: written.progressPct,
    anchorIndex: written.anchorIndex,
    anchorRatio: written.anchorRatio,
    anchorTextOffset: written.anchorTextOffset,
    anchorTextSnippet: written.anchorTextSnippet,
    mediaAnchor: written.mediaAnchor,
    ...(hasOwnField(source, "portableProgressVersions")
      ? {
          chapterPath: source.chapterPath ?? null,
          portableLocator: source.portableLocator ?? null,
          portableProgressVersions: source.portableProgressVersions ?? [],
          portableProgressConflict: source.portableProgressConflict ?? false,
        }
      : {}),
  } as ShelfEntry;
}

function sameCheckpointPatchValue(
  patch: ShelfProgressPatch,
  version: Version<ProgressValue>,
): boolean {
  return sameCheckpointValue(progressValueFromPatch(patch), version.value);
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
  const targetIndex = spineIndexForEntryKey(book, locator.chapterPath);
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

// One panel per batch keeps each GPU burst short. The most used panels are
// drawn under the opening veil, the rest once reading is quiet.
const PANEL_WARM_VEIL_BATCHES: readonly PanelWarmBatch[] = [["aa"], ["aa-detailed"], ["toc"]];
const PANEL_WARM_IDLE_BATCHES: readonly PanelWarmBatch[] = [["search"], ["reading"], ["display"], ["fonts"], ["bookmark-pages"]];
const noopBookmarkPages = (): void => {};
/** Q5：翻页落定后这段时间内仍算“阅读在忙”，后台准备工作不开始。 */
const READER_SETTLE_QUIET_MS = 500;
/** 书签跳转落定后，角落点击再等跳转光晕（1.25 秒）播完。 */
const BOOKMARK_JUMP_GUARD_AFTER_LANDING_MS = 1300;
/** 跳转迟迟不落定（失败、被别的导航取代）时，保护最多持续这么久。 */
const BOOKMARK_JUMP_GUARD_MAX_MS = 8000;
const PANEL_WARM_TAB_BATCHES: readonly PanelWarmBatch[] = [["reader-tabs"]];
const PANEL_WARM_IDLE_BATCHES_MOBILE: readonly PanelWarmBatch[] = [["more"], ...PANEL_WARM_IDLE_BATCHES];
const EMPTY_RESOURCE_ISSUES: readonly ResourceIssue[] = [];
const getNoResourceIssues = () => EMPTY_RESOURCE_ISSUES;
const subscribeNoResourceIssues = () => () => {};

export default function App() {
  const { t } = useUiText();
  const runtime = getRuntimeCapabilities();
  const responsive = useResponsiveEnvironment();
  const mobileChrome = responsive.touchUi;
  const phoneChrome = mobileChrome && responsive.layout === "compact";
  const [phase, setPhase] = useState<AppPhase>({ phase: "idle" });
  const {
    book, setBook, bookRef, server, setServer, serverRef, bookKey, setBookKey,
    activeSessionRef, sessionGenerationRef, chapterCountsRef, chapterCountsState, setChapterCountsState,
    chapterCountJobRef, baselineProgressPctRef, lastCountProgressSignatureRef,
    contentAxis, setContentAxis, contentAxisRef,
  } = useBookSession();
  const resourceIssues = useSyncExternalStore(
    server?.subscribeResourceIssues ?? subscribeNoResourceIssues,
    server?.getResourceIssues ?? getNoResourceIssues,
    getNoResourceIssues,
  );
  const [spineIndex, setSpineIndex] = useState(0);
  const [anchor, setAnchor] = useState<string | undefined>(undefined);
  const [anchorNonce, setAnchorNonce] = useState(0);
  const [startAtEnd, setStartAtEnd] = useState({ nonce: 0, atEnd: false });
  const [foreground, setForeground] = useReaderForegroundState();
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
  // B3：阅读会话标志与开书恢复门的唯一宿主；本文件只读 ref/state、经它的动作写入。
  const {
    readerDisplayReadyRef, navigationPendingRef, historyCaptureAllowedRef, suppressShelfProgressRef, restoreGateRef,
    readerDisplayReady, displayedOnce, restoreSettled, initialRestoreTicket, setInitialRestoreTicket,
    dispatchReaderSession, beginExplicitNavigation, releaseRestoreForExplicitNavigation,
    dispatchRestoreGate, restoreResultMatches, startRestore, clearRestore,
  } = useReaderSession(() => activeSessionRef.current?.generation);
  const { settings, setSettings, uiScale, settingsActions } = useReaderSettings();
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
    displayTarget?: import("./core/search").DisplaySearchTarget;
  } | null>(null);
  const [progressChoice, setProgressChoice] = useState<{
    title: string;
    candidates: readonly PortableProgressChoiceCandidate[];
  } | null>(null);
  const progressChoiceResolverRef = useRef<((stamp: Stamp | null) => void) | null>(null);
  const [localCheckpointConflict, setLocalCheckpointConflict] = useState<{
    title: string;
    hasSynced: boolean;
  } | null>(null);
  const localCheckpointResolverRef = useRef<((choice: "local" | "synced" | null) => void) | null>(null);
  const [readerNotice, setReaderNotice] = useState<{
    kind: "ok" | "warn" | "error";
    text: string;
  } | null>(null);
  const [readerNoticeFading, setReaderNoticeFading] = useState(false);
  const preciseRequestRef = useRef(0);
  const latestPreciseRequestRef = useRef<number | null>(null);
  const {
    scrubSessionRef, scrubRequestIdRef, pendingChapterSeekRef, scrubUiState,
    tocFollowSeekRef, tocFollowGenerationRef, tocFollowRequest, setTocFollowRequest,
    activeHrefRef, scrubUiStateRef, dispatchScrub, acceptsScrubResult,
  } = useScrubState();

  const [dragActive, setDragActive] = useState(false);
  /** Overlay text of a native file drag; names the folder the drop would file into. */
  const [dropLabel, setDropLabel] = useState("");
  /** Shelf folder card under a native EPUB drag (highlighted; the drop files into it). */
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  /** Folder open on the shelf (sheet or folder view): a window drop files into it. */
  const importContextRef = useRef<ImportFolderTarget | null>(null);
  const handleImportContextChange = useCallback((target: ImportFolderTarget | null): void => {
    importContextRef.current = target;
  }, []);
  const [fontNativeDragActive, setFontNativeDragActive] = useState(false);
  // ---- 书架 ----
  const [view, setView] = useState<"shelf" | "reader">("shelf");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [readerToolsVisible, setReaderToolsVisible] = useState(true);
  // 图片激活等稳定回调需要读到当前沉浸状态。
  const readerToolsVisibleRef = useRef(readerToolsVisible);
  readerToolsVisibleRef.current = readerToolsVisible;
  const mobileChromeRef = useRef(mobileChrome);
  mobileChromeRef.current = mobileChrome;
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [shelfBackActive, setShelfBackActive] = useState(false);
  const shelfBackHandlerRef = useRef<(() => boolean) | null>(null);
  const noteComposerDirtyRef = useRef(false);
  const activeNoteEditContextRef = useNoteEditRef();
  const shelfState = useShelfEntriesState();
  const { shelfEntries, setShelfEntries, libraryLoad, shelfError, setShelfError } = shelfState;
  const [saveFailurePrompt, setSaveFailurePrompt] = useState<SaveFailurePrompt | null>(null);
  const saveFailurePromptRef = useRef(saveFailurePrompt);
  saveFailurePromptRef.current = saveFailurePrompt;
  const windowCloseRef = useRef<((leaveUnsaved: boolean) => Promise<void>) | null>(null);
  const shelfNotices = useShelfNoticeState();
  const { shelfNotice, setShelfNotice, shelfNoticeFading } = shelfNotices;

  const bookImportState = useBookImportState();
  const { shelfBusy, setShelfBusy, shelfBusyMessage, setShelfBusyMessage, nativeImport, nativeImportRef, folderImport, folderImportCloseSignal, setFolderImportCloseSignal } = bookImportState;
  // One UI-owned file job; every picker/prepare/commit generation is tracked
  // in the hook, never generated during render.
  const saveFileJob = useSaveFileJob();
  const saveFileJobStateRef = useRef(saveFileJob.state);
  saveFileJobStateRef.current = saveFileJob.state;
  const [saveFileExportSetup, setSaveFileExportSetup] = useState<{
    selectedEntries: ShelfEntry[];
  } | null>(null);
  const saveFileActive = saveFileJob.active || saveFileExportSetup !== null;
  const saveFileLaunchRef = useRef(false);
  const [lanSaveOpen, setLanSaveOpen] = useState(false);
  const [lanSaveSelection, setLanSaveSelection] = useState<ShelfEntry[]>([]);
  const lanSaveSelectionRef = useRef<ShelfEntry[]>([]);
  const lanSaveActiveRef = useRef(false);
  const [currentShelfId, setCurrentShelfId] = useState<string | null>(null);
  const shelfBusyRef = useRef(false);
  const shelfEntriesRef = useRef<ShelfEntry[]>([]);
  shelfEntriesRef.current = shelfEntries;
  const currentShelfIdRef = useRef<string | null>(null);
  currentShelfIdRef.current = currentShelfId;
  const shelfOrganization = useShelfOrganizationState();
  const { organization, setOrganization, organizationSettled, shelfScope, setShelfScope, organizationRef, organizationBusyRef } = shelfOrganization;
  // ---- 阅读跳转历史（后退/前进各最多 3 步） ----
  const [readerHistory, setReaderHistory] = useState<ReaderNavigationHistory>(
    emptyReaderNavigationHistory
  );
  // 跳转返回入口：每次跳转（或返回/前进）后自动出现，用户自己翻页/滚动即收起。
  const [returnPromptShown, setReturnPromptShown] = useState(false);
  useEffect(() => {
    setReturnPromptShown(readerHistory.back.length > 0 || readerHistory.forward.length > 0);
  }, [readerHistory]);
  // ---- 书签反馈轻量弹窗 ----
  const { bookmarkToast, bookmarkToastTimerRef, showBookmarkToast } = useBookmarkToast();
  // ---- T-1 字符替换/繁简显示（本机偏好，不进入 ReaderSettings） ----
  const [textProjectionPreferences, setTextProjectionPreferences] = useState<TextProjectionPreferences>(
    () => loadTextProjectionPreferences(),
  );
  const [compiledTextProjection, setCompiledTextProjection] = useState<CompiledTextProjection | null>(null);
  const [readerTextProjectionPreferences, setReaderTextProjectionPreferences] = useState<TextProjectionPreferences>(
    textProjectionPreferences,
  );
  const readerSearchView = useReaderSearchView();
  const { searchView } = readerSearchView;

  // ---- FX-1/FX-2 本机显示偏好（滑条只改绘制，不触发章节重载） ----
  const [visualPreferences, setVisualPreferences] = useState<ReaderVisualPreferences>(
    () => loadVisualPreferences(),
  );
  const [visualCompareOriginal, setVisualCompareOriginal] = useState(false);
  const visualPreferencesRef = useRef(visualPreferences);
  visualPreferencesRef.current = visualPreferences;

  // ---- 当前书正文搜索（索引仅在本次打开书籍期间存在） ----
  const readerSearchState = useReaderSearchState();
  const { searchQuery, setSearchQuery, searchResults, searchStatus, searchProgress, searchError,
    searchNavigationBusy, setSearchNavigationBusy } = readerSearchState;

  // The panel keeps draft rules (a new rule starts with empty from/to); only the
  // stored copy and the reader snapshot are sanitized, so drafts are not dropped
  // while the user is still typing.
  const updateTextProjectionPreferences = useCallback((next: TextProjectionPreferences): void => {
    setTextProjectionPreferences(next);
    saveTextProjectionPreferences(sanitizeTextProjectionPreferences(next));
  }, []);

  const updateVisualPreferences = useCallback((next: ReaderVisualPreferences): void => {
    const normalized = normalizeVisualPreferences(next);
    setVisualPreferences(normalized);
    saveVisualPreferences(normalized);
  }, []);

  useEffect(() => {
    setColorAssistMatrixProvider((kind, strength) => svgMatrixValues(correctionMatrix(kind, strength)));
    return () => setColorAssistMatrixProvider(null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = sanitizeTextProjectionPreferences(textProjectionPreferences);
      // Draft-only edits leave the effective projection unchanged: keep the old
      // snapshot so the reader does not re-project the chapter.
      setReaderTextProjectionPreferences((previous) =>
        textProjectionVersion(previous) === textProjectionVersion(next) ? previous : next);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [textProjectionPreferences]);

  useEffect(() => {
    let cancelled = false;
    if (isIdentityTextProjection(readerTextProjectionPreferences)) {
      setCompiledTextProjection(null);
      return;
    }
    const version = textProjectionVersion(readerTextProjectionPreferences);
    setCompiledTextProjection((previous) => previous && previous.version === version ? previous : null);
    void compileTextProjection(readerTextProjectionPreferences)
      .then((compiled) => {
        if (!cancelled) setCompiledTextProjection(compiled);
      })
      .catch(() => {
        if (!cancelled) setCompiledTextProjection(null);
      });
    return () => {
      cancelled = true;
    };
  }, [readerTextProjectionPreferences]);
  // 阅读器搜索只搜当前书；全库正文搜索在书架搜索框（librarySearchRuntime）。
  const { shelfSearchMode, setShelfSearchMode } = useShelfSearchMode();
  const readerPriorityBusyRef = useRef(false);
  readerPriorityBusyRef.current = view === "reader"
    && (!readerDisplayReady || chapterState.status === "loading" || searchNavigationBusy);
  const librarySearch = useLibrarySearchRuntime(isTauriEnv, readerPriorityBusyRef);
  const { librarySearchRuntime, librarySearchSnapshot, logicalCores, corpusConcurrencyPreference,
    recommendedCorpusConcurrency } = librarySearch;
  const readerSearchRefs = useReaderSearchRefs();
  // ---- 正文笔记 ----
  const noteBusyState = useNoteBusyState();
  const { noteBusy, setNoteBusy, noteBusyRef } = noteBusyState;
  const { contentHashByIdRef, entryByContentHashRef } = useShelfContentHashes(shelfEntries);
  const libraryIndexSignature = shelfEntries
    .map((entry) => `${entry.id}:${entry.contentHash ?? ""}:${entry.available === false ? 0 : 1}`)
    .join("|");
  const {
    progressWriterRef, activeProgressLeaseRef, progressRuntimeGateRef, ensureProgressRuntimeReady,
    localCheckpointsRef, retainUnsavedSample, lifecycleDiagnosticsRef, recordLifecycleDiagnostic,
    firstSampleFailureRecordedRef, lastRepositoryGenerationRef, lastNativeRecordsReadRef,
  } = useProgressRuntime({ contentHashByIdRef, shelfEntriesRef, sessionGenerationRef });
  /** 指针是否悬停在交互式浮层（脚注弹窗等）上：此时不响应翻页键/后续可扩展书签等 */
  const overlayHoverRef = useRef(false);
  const foregroundRef = useRef<ReaderForeground>({ kind: "none" });
  foregroundRef.current = foreground;

  const {
    menuOpen, fontSettingsOpen, displaySettingsOpen, tocOpen, bookmarkMenuOpen,
    searchOpen, notesOpen, logOpen, assistantOpen, readingSettingsOpen,
    selectionContext, footnote, noteComposer,
  } = readerForegroundSurfaces(foreground);
  // A typography slider is held in Aa: the reader relayouts per value and holds background work.
  const [typographyPreview, setTypographyPreview] = useState(false);

  useEffect(() => {
    if (!displaySettingsOpen) setVisualCompareOriginal(false);
  }, [displaySettingsOpen]);

  useEffect(() => {
    setVisualCompareOriginal(false);
  }, [book]);

  useEffect(() => {
    if (imageRequest === null) setVisualCompareOriginal(false);
  }, [imageRequest]);
  const { openPanel, openTransient, openComposer, closePanel, closeForeground, requestCloseForeground, showMenuSubview } = useReaderForeground({
    foregroundRef,
    setForeground,
    overlayHoverRef,
    reader: () => readerRef.current,
    beforeOpenComposer: (draft) => {
      replaceNoteEditContext(draft, activeNoteEditContextRef);
    },
    noteComposerDirtyRef,
  });

  const sidebarBookKey = currentShelfId ?? book?.metadata.identifier ?? "unshelved";
  const {
    sidebarSide, sidebarNavigationMemory, effectiveSidebarMode,
    isSidebarOpen, activeSidebarTab, isDockedSidebar, isDockedSearch,
    handleSidebarTabChange, handleSidebarModeChange, handleSidebarClose,
    requestCloseCurrentSurface, handleToggleSidebar, handleOpenBookmarks,
  } = useReaderSidebar({
    foreground, foregroundRef, setForeground, view, phoneChrome, mobileChrome,
    sidebarBookKey,
    openPanel, closeForeground, requestCloseForeground,
  });
  const sidebarNavigationMemoryRef = useRef(sidebarNavigationMemory);
  sidebarNavigationMemoryRef.current = sidebarNavigationMemory;

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
      // 沉浸阅读时第一次轻点（含全页插图）先呼出工具栏，工具可见时再点才打开大图；
      // 否则整页插图上无法呼出工具。
      if (mobileChromeRef.current && !readerToolsVisibleRef.current) {
        setReaderToolsVisible(true);
        return;
      }
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
    setRuntimeIssues((issues) => [...issues, uiText("appUi.runtime.ai", { message })]);
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
  // Q5：翻页在动、或刚落定不到半秒时，后台准备工作（面板首绘预热、全书统计）让路，
  // 否则 GPU 首绘会压在松手动画上掉帧。安静期从落定算起，不从按下算起。
  const lastPageSettleAtRef = useRef(0);
  useEffect(() => {
    if (chapterState.status === "ready" && !chapterState.transient) lastPageSettleAtRef.current = performance.now();
  }, [chapterState]);
  const readerBusy = useCallback((): boolean =>
    readerRef.current?.pageMotionIdle?.() === false ||
    performance.now() - lastPageSettleAtRef.current < READER_SETTLE_QUIET_MS, []);
  // 主题过渡判定用的最新提交值；busy 在算出 ready 后每次渲染更新。
  const committedThemeRef = useRef(settings.theme);
  committedThemeRef.current = settings.theme;
  const readerThemeBusyRef = useRef(false);
  const themeTransition = useThemeTransition({
    setSettings,
    committedTheme: () => committedThemeRef.current,
    reader: () => readerRef.current,
    busy: () => readerThemeBusyRef.current,
    onError: (error) => setShelfNotice({ kind: "error", text: uiText("notice.theme.applyFailed", { error: String(error) }) }),
  });
  const commitThemeSettings = themeTransition.commitSettings;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chapterStateRef = useRef<ChapterState>(chapterState);
  chapterStateRef.current = chapterState;
  const spineIndexRef = useRef(spineIndex);
  spineIndexRef.current = spineIndex;
  const readingModeRef = useRef(settings.readingMode);
  readingModeRef.current = settings.readingMode;
  const lastStablePositionRef = useRef<ReaderHistoryPosition>({
    spineIndex: 0,
    page: 0,
    anchor: null,
  });
  const persistShelfProgressRef = useRef<(explicit?: boolean) => void>(() => {});

  // Preserve session → library candidates → query effect ordering.
  const readerSearchContext = { ...readerSearchState, ...readerSearchRefs,
    view, book, server, searchView, compiledTextProjection };
  useReaderSearchSession(readerSearchContext);
  useLibrarySearchBooks({ runtime, librarySearchRuntime, shelfEntries });
  useReaderSearchQuery({ ...readerSearchContext, searchOpen });

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
      const active = activeSessionRef.current;
      if (!active || active.generation !== generation) return;
      let next = chapterCountsRef.current;
      let changed = false;
      for (const [index, value] of values) {
        // A visible chapter's measured weight wins in memory, but its
        // structural estimate is still needed for the next open's cache.
        active.structuralCounts = applyChapterCount(
          active.structuralCounts, generation, index, value, "estimated",
        ).collection;
        const result = applyChapterCount(next, generation, index, value, "estimated");
        if (!result.accepted) continue;
        next = result.collection;
        changed = true;
      }
      if (summarizeLinearCounts(active.structuralCounts, 0).complete) {
        writeChapterCountCache(active.countCacheKey, next, active.structuralCounts);
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

  const { handleImportSources, handleFileInputSources, handleCancelNativeImport, handleToggleNativeImportCollapsed, reimportAndroidMissing, handleChooseBooks, importExternalSource, retryOriginalAsCopy, dismissOriginalRetry } = useBookImport({
    importState: bookImportState,
    runtime, isTauriEnv, fileInputRef, shelfBusyRef, shelfEntriesRef,
    contentHashByIdRef, entryByContentHashRef, setShelfEntries, setShelfNotice, setOrganization,
  });

  const { resolveContentHashForEntry, handleApplyOrganization } = useShelfOrganizationActions({
    runtime, shelfEntriesRef, shelfBusyRef, organizationState: shelfOrganization,
    setShelfEntries, setShelfNotice,
  });

  const applyPortablePreferences = useCallback((preferences?: PortablePreferences): boolean => {
    if (!preferences) return false;
    // 导入偏好可能同时改主题与字号等：直接提交，并取代未提交的主题过渡请求。
    commitThemeSettings(() => settingsActions.applyPortablePreferences(preferences));
    return true;
  }, [commitThemeSettings, settingsActions]);

  const { libraryReader, organizationReader, retryLibraryLoad, refreshShelfProjection } = useShelfLibrary({
    entriesState: shelfState, organizationState: shelfOrganization, setShelfNotice,
    onListPublished(entries) {
      void (async () => {
        let repositoryGeneration: string | undefined;
        try {
          const status = await getShelfStore().runtimeStatus?.();
          repositoryGeneration = status?.repositoryGeneration;
          lastNativeRecordsReadRef.current = status?.lastRecordsRead ?? null;
          if (repositoryGeneration) lastRepositoryGenerationRef.current = repositoryGeneration;
        } catch {
          /* The list result stays authoritative; diagnostics may lack generation. */
        }
        recordLifecycleDiagnostic("startup_list", {
          stage: "list",
          result: "success",
          backend: portableShelfStateActive() ? "v3" : "legacy",
          count: entries.length,
          repositoryGeneration,
        });
      })();
    },
    onListFailed(error) {
      recordLifecycleDiagnostic("startup_list", {
        stage: "list",
        result: "failed",
        backend: portableShelfStateActive() ? "v3" : "legacy",
        errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
      });
    },
  });

  const { handleOpenFolderImport, closeFolderImport, handleFolderImportSettled } = useFolderImport({
    importState: bookImportState, shelfBusyRef, organizationBusyRef,
    saveFileJobStateRef, saveFileLaunchRef, lanSaveActiveRef,
    isTauriEnv, setShelfNotice, refreshShelfProjection,
  });

  const {
    startBookSourceExport,
    handleOpenLanSave,
    closeLanSavePanel,
    closeSaveFileUi,
    handleSaveFileImportConfirm,
    handleSaveFileExportConfirm,
    handleLegacyImportArchive,
    handleExportArchive,
    handleImportArchive,
    lanSaveSession,
  } = useSaveFileFlows({
    runtime, isTauriEnv, settings, uiScale, saveFileJob, saveFileJobStateRef,
    saveFileExportSetup, setSaveFileExportSetup, saveFileLaunchRef,
    setLanSaveOpen, setLanSaveSelection, lanSaveSelectionRef, lanSaveActiveRef,
    nativeImportRef, shelfBusyRef, organizationBusyRef, shelfEntriesRef, organizationRef,
    setShelfBusyMessage, setShelfBusy, setShelfNotice, setShelfError, setShelfEntries,
    setOrganization, refreshShelfProjection, applyPortablePreferences,
    resolveContentHashForEntry, persistShelfProgressRef, progressWriterRef,
  });

  const librarySettings = useLibrarySettings();
  const handleCopyToLibraryChange = useCallback((copy: boolean): void => { void setCopyOnImport(copy); }, []);
  // Book paths may have switched: the next open resolves them natively again.
  const handleLibraryLocationChanged = useCallback((): void => {
    void refreshShelfProjection().catch((error: unknown) => {
      setShelfError(uiText("libraryLocation.refreshFailed", { error: error instanceof Error ? error.message : String(error) }));
    });
  }, [refreshShelfProjection, setShelfError]);

  // ER-0042: the automatic import folder scans only from an idle shelf in the foreground.
  // A scan that adds nothing refreshes nothing; it is not a sync event either.
  const lastFolderWatchErrorRef = useRef<string | null>(null);
  useFolderWatchTriggers(
    view === "shelf" && libraryLoad.status === "ready" && !shelfBusy && nativeImport === null && !folderImport && !saveFailurePrompt
      && activeShelfSpace().policy.libraryServices,
    (outcome, manual) => {
      if (!activeShelfSpace().policy.libraryServices) return;
      if (outcome.kind === "error") {
        // The settings show the reason; the shelf says it once per reason.
        if (manual || lastFolderWatchErrorRef.current === outcome.message) return;
        lastFolderWatchErrorRef.current = outcome.message;
        setShelfNotice({ kind: "error", text: uiText("shelfSettings.watch.notice.error", { error: outcome.message }) });
        return;
      }
      if (outcome.kind !== "result") return;
      const { imported, failed } = outcome.result.counts;
      const { unreadableDirectories } = outcome.result;
      const issueKey = failed || unreadableDirectories ? `result:${failed}:${unreadableDirectories}` : null;
      const repeated = issueKey === lastFolderWatchErrorRef.current;
      lastFolderWatchErrorRef.current = issueKey;
      if (imported > 0) {
        void refreshShelfProjection().catch((error: unknown) => {
          setShelfError(uiText("shelfSettings.watch.refreshFailed", { error: error instanceof Error ? error.message : String(error) }));
        });
      } else if (manual || !issueKey || repeated) {
        return;
      }
      const details = [
        imported > 0 && uiPlural("shelfSettings.watch.notice", imported, { count: imported }),
        failed > 0 && uiPlural("shelfSettings.watch.failed", failed, { count: failed }),
        unreadableDirectories > 0 && uiPlural("shelfSettings.watch.unreadable", unreadableDirectories, { count: unreadableDirectories }),
      ].filter(Boolean);
      setShelfNotice({ kind: issueKey ? "warn" : "ok", text: details.join(uiText("notice.sep")) });
    },
  );

  const handleRevealSource = useCallback((entry: ShelfEntry): void => {
    void revealShelfSource(entry.contentHash ?? entry.id).then((status) => {
      if (status === "missing") setShelfNotice({ kind: "warn", text: uiText("shelf.card.reveal.missing") });
    }, (error: unknown) => {
      setShelfNotice({ kind: "error", text: uiText("shelf.card.reveal.failed", { error: error instanceof Error ? error.message : String(error) }) });
    });
  }, [setShelfNotice]);

  useLibraryActivation({
    libraryReader, organizationReader, progressRuntimeGateRef, refreshShelfProjection, setShelfNotice,
  });

  const {
    userFonts,
    fontBusy,
    systemFonts,
    systemFontsStatus,
    systemFontsError,
    handleImportFonts,
    handleImportFontPaths,
    handleDeleteFont,
    renderUserFonts,
    loadSystemFonts,
  } = useFontLibrary({ settings, setSettings, settingsActions, setShelfNotice });

  useEffect(() => {
    if (!fontSettingsOpen) setFontNativeDragActive(false);
  }, [fontSettingsOpen]);

  useShelfNoticeLifetime(shelfNotices);

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

  useBookmarkToastCleanup(bookmarkToastTimerRef);

  const showReaderNotice = useCallback((text: string, kind: "ok" | "warn" | "error" = "warn"): void => {
    setReaderNotice({ kind, text });
  }, []);

  const {
    batteryIndicatorEnabled,
    changeBatteryIndicatorEnabled,
    changeTapRegionPreferences,
    tapRegions,
    hideReaderSystemStatusBar,
    changeHideReaderSystemStatusBar,
    keepScreenOnWhileReading,
    changeKeepScreenOnWhileReading,
    volumeKeyTurn,
    volumeKeyReverse,
    changeVolumeKeyTurn,
    changeVolumeKeyReverse,
    volumeKeyGate,
  } = useReaderPlatformPreferences({
    runtime, view, viewRef, mobileChrome, theme: settings.theme, setShelfNotice, showReaderNotice,
  });

  const SourceReaderView = book?.sourceFormat === "comic-zip" ? ComicReaderView : ReaderView;

  // 打开书后渐进统计章节字数；同一本书切章不重建该任务。
  useEffect(() => {
    chapterCountJobRef.current?.cancel();
    chapterCountJobRef.current = null;
    const active = activeSessionRef.current;
    // 前台开章与首次恢复优先：恢复结算后再开始后台按需读取统计。
    if (view !== "reader" || !book || !server || !active || !restoreSettled) return;
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
      shouldYield: readerBusy,
      onCounts: (values) => {
        applyCountBatch(active.generation, values);
      },
      onCount: (index, value) => {
        applyCountBatch(active.generation, [[index, value]]);
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
  }, [view, book, server, bookKey, restoreSettled, applyCountBatch, applyCountError, readerBusy]);

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

  const { handleShelfDelete, handleShelfDeleteMany } = useShelfDeletion({
    shelfBusyRef, nativeImportRef, shelfEntriesRef, localCheckpointsRef,
    setShelfBusyMessage, setShelfBusy, setShelfEntries, setCurrentShelfId, setShelfError, setShelfNotice,
    refreshOrganization: organizationReader.refresh,
  });

  const handleIssues = useCallback((issues: string[]) => {
    // ResourceServer owns per-path status; raw unresolved URLs also include deferred fonts.
    if (issues.length > 0) setRuntimeIssues((prev) => [...prev, ...issues]);
  }, []);

  const refreshLogDiagnostics = useCallback(() => {
    const readerDiagnosis = readerRef.current?.diagnose() ?? uiText("log.diagnostics.unavailable");
    const lifecycleDiagnosis = lifecycleDiagnosticsRef.current.length > 0
      ? ["", "--- 匿名生命周期诊断 ---", ...lifecycleDiagnosticsRef.current].join("\n")
      : "\n--- 匿名生命周期诊断 ---\n（尚无记录）";
    const capturedAt = uiText("log.diagnostics.capturedAt", { time: new Date().toLocaleString() });
    setDiagText(`${capturedAt}\n${readerDiagnosis}${lifecycleDiagnosis}`);
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
      refreshLogDiagnostics();
      return openReaderPanel(current, "log");
    });
  }, [refreshLogDiagnostics]);

  const handleFootnoteClose = useCallback(() => {
    setForeground((current) =>
      current.kind === "transient" && current.transient === "footnote"
        ? closeReaderForeground()
        : current
    );
    overlayHoverRef.current = false;
    readerRef.current?.dismissFootnote();
  }, []);

  /**
   * 页号与锚点的同一次读数：分页模式由分页器给出（原生滑动途中取视觉屏，
   * 状态带 transient）；连续滚动回退到已发布状态 + 滚动锚点。chapterPath 为
   * null 表示读数未携带章节身份。
   */
  const readReaderPosition = useCallback((withText = false): {
    chapterPath: string | null;
    state: ChapterState;
    readingAnchor: ReturnType<ReaderHandle["getReadingAnchor"]>;
    anchorText: string | null;
  } => {
    const reader = readerRef.current;
    const snapshot = reader?.readPositionSnapshot({ withText }) ?? null;
    if (snapshot) return snapshot;
    return {
      chapterPath: null,
      state: chapterStateRef.current,
      readingAnchor: reader?.getReadingAnchor() ?? null,
      anchorText: withText ? reader?.getAnchorText() ?? null : null,
    };
  }, []);

  // ---- 目录/书内链接跳转 ----
  const {
    currentReaderPosition, handlePresentationChange, captureReaderHistory, commitReaderHistorySnapshot,
    handleFootnoteAnchor, handleTocNavigate, handleCommitSeek, handleScrubPreviewChange,
    handleContentFractionSettled, handleContentFractionCancelled, handleContentFractionFailed,
    handleUserProgressSample, handleSearchNavigate, handleInternalNavigate,
    handleHistoryBack, handleHistoryForward, followTocAfterSeek, dropTocFollowSeek,
  } = useReaderNavigation({
    readReaderPosition, readerRef, bookRef, spineIndexRef, lastStablePositionRef,
    navigationPendingRef, readerDisplayReadyRef, historyCaptureAllowedRef,
    latestPreciseRequestRef, preciseRequestRef, contentAxisRef, chapterStateRef,
    sidebarNavigationMemoryRef,
    scrubSessionRef, scrubRequestIdRef, pendingChapterSeekRef, tocFollowSeekRef,
    tocFollowGenerationRef, tocFollowRequest, setTocFollowRequest, activeHrefRef,
    scrubUiStateRef, dispatchScrub, acceptsScrubResult,
    book, spineIndex, view, settings, settingsActions, readerHistory, setReaderHistory,
    searchNavigationBusy, setSearchNavigationBusy, setPreciseTarget, setAnchor, setAnchorNonce,
    setSpineIndex, setInitialPage, setInitialAnchor, setInitialAlignment, setReaderNotice,
    showReaderNotice, closePanel, closeForeground, handleFootnoteClose,
    beginExplicitNavigation, releaseRestoreForExplicitNavigation, dispatchReaderSession,
    toPersistedReaderAnchor,
  });

  const {
    handleUserReadingPositionChange, onPageState, handleReaderDisplayReady,
    handleVisibleChapterChange, handleRequestChapter,
    handleReaderNavigationUnresolved, handleReaderRestoreResult, handlePreciseNavigationStatus,
  } = useReaderChapterCallbacks({
    dispatchRestoreGate, dispatchReaderSession, restoreGateRef, restoreResultMatches,
    setInitialRestoreTicket, setSearchNavigationBusy, setInitialAnchor, setInitialPage,
    setInitialAlignment, showReaderNotice, latestPreciseRequestRef, setPreciseTarget,
    setReturnPromptShown, chapterStateRef, setChapterState, pendingChapterSeekRef,
    dispatchScrub, scrubSessionRef, scrubUiStateRef, navigationPendingRef, contentAxisRef,
    bookRef, spineIndexRef, readerRef, lastStablePositionRef, activeSessionRef, readingModeRef,
    applyCount, dropTocFollowSeek, followTocAfterSeek, setSpineIndex, setAnchor, setStartAtEnd,
    closeImageOverlay, closeForeground, beginExplicitNavigation, toPersistedReaderAnchor,
  });

  // ---- 正文笔记 ----
  const { currentNotes, currentChapterNotes, notesForChapter, noteViewModels } = useNoteProjection(shelfEntries, currentShelfId, book, spineIndex);
  const { handleSaveNote, handleDeleteNote, handleEditNote } = useNoteActions({
    ...noteBusyState, currentShelfId, currentNotes, setShelfEntries, setRuntimeIssues,
    noteComposer, book, setForeground, shelfEntriesRef, openComposer,
  });

  const handleNoteNavigate = useCallback((note: ReaderNote): void => {
    if (!book || noteBusy) return;
    const target = spineIndexForEntryKey(book, note.chapterPath);
    if (target < 0 || target !== note.spineIndex) {
      setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.noteChapterGone")]);
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
      showReaderNotice(uiText("notice.reader.noteAnchorNotFound"), "warn");
      return;
    }
    captureReaderHistory(archiveHref(book.archiveReferences, note.chapterPath));
    beginExplicitNavigation();
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
  const { currentBookmarks, isCurrentPageBookmarked, sortedBookmarks } = useBookmarkProjection({
    currentShelfId, shelfEntries, chapterState, readerRef, spineIndex, book,
  });
  const handleToggleBookmarks = useBookmarkSidebarToggle({
    isSidebarOpen, sidebarSide, activeSidebarTab, handleSidebarClose, handleOpenBookmarks,
  });
  const { handleToggleBookmark } = useBookmarkActions({
    currentShelfId, readReaderPosition, currentBookmarks, spineIndex, book, readerRef,
    showBookmarkToast, setShelfEntries, setShelfError,
  });
  const {
    bookmarkCue, cueBookmarks, bookmarkPagesOpen, closeBookmarkPages, hintBookmarks,
    handleBookmarkButton, handleBookmarkCorner, addBookmark, removeBookmarks, undoBookmarkRemoval,
  } = useBookmarkRibbonActions({
    currentShelfId, readReaderPosition, currentBookmarks, spineIndex, book, readerRef,
    showBookmarkToast, setShelfEntries, setShelfError, legacyToggle: handleToggleBookmark,
  });
  // 书签列表逐条删除也可撤销；丝带在屏上时一样先收回。
  const handleDeleteBookmark = useCallback(
    (bookmarkId: string) => removeBookmarks([bookmarkId], { animate: true }),
    [removeBookmarks],
  );
  // 缩略书页只在双页且这一屏没有变化时显示；翻页、换章、收起工具栏都关掉。
  const bookmarkPagesScreen = bookmarkPagesOpen && view === "reader"
    ? readerRef.current?.screenBookmarks?.(currentBookmarks) ?? null
    : null;
  const bookmarkPagesKey = `${spineIndex}:${chapterState.status === "ready" ? chapterState.currentPage : -1}`;
  useEffect(() => {
    closeBookmarkPages();
  }, [bookmarkPagesKey, view, closeBookmarkPages]);

  // A17：角落点击的保护。
  // - 跳转/换章途中目标页还没显示：读不到这一屏的书签，会退回旧的切换、按加载中的位置增删。
  // - 从书签列表跳转后，落定到跳转光晕播完之前：连点多半是误触，会删掉刚跳到的书签。
  // 这两段时间角落点击一律吞掉（不增删、也不当普通点击）；跳转迟迟不落定时最多保护 8 秒。
  const bookmarkJumpRef = useRef<{ selectedAt: number; landedAt: number | null } | null>(null);
  useEffect(() => {
    const jump = bookmarkJumpRef.current;
    if (!jump || jump.landedAt !== null) return;
    if (chapterState.status === "ready" && !chapterState.transient && !navigationPendingRef.current &&
      readerDisplayReadyRef.current) {
      jump.landedAt = performance.now();
    }
  }, [chapterState, navigationPendingRef, readerDisplayReadyRef]);
  const handleBookmarkCornerTap = useCallback((side: "left" | "right"): boolean => {
    if (navigationPendingRef.current || !readerDisplayReadyRef.current) return true;
    const jump = bookmarkJumpRef.current;
    if (jump) {
      const now = performance.now();
      const guarded = now - jump.selectedAt < BOOKMARK_JUMP_GUARD_MAX_MS &&
        (jump.landedAt === null || now - jump.landedAt < BOOKMARK_JUMP_GUARD_AFTER_LANDING_MS);
      if (guarded) return true;
      bookmarkJumpRef.current = null;
    }
    return handleBookmarkCorner(side);
  }, [handleBookmarkCorner, navigationPendingRef, readerDisplayReadyRef]);

  const handleSelectBookmark = useCallback(
    (bookmarkId: string) => {
      setPreciseTarget(null);
      latestPreciseRequestRef.current = null;
      const bookmark = currentBookmarks.find((item) => item.id === bookmarkId);
      if (!bookmark || !book) return;
      bookmarkJumpRef.current = { selectedAt: performance.now(), landedAt: null };
      // A17：触摸界面的工具栏盖在丝带上；跳转的同时收起（走原有收起动画），让跳转光晕露出来。
      if (mobileChrome) {
        setMobileMoreOpen(false);
        setReaderToolsVisible(false);
      }
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
          // 本章直达当场落定（目标就在这一页时不会再有新的页状态）。
          if (bookmarkJumpRef.current) bookmarkJumpRef.current.landedAt = performance.now();
          setAnchor(undefined);
          commitReaderHistorySnapshot(snapshot);
          closeForeground();
          cueBookmarks("peek", [bookmark.id]);
          return;
        }
      }
      cueBookmarks("peek", [bookmark.id]);
      captureReaderHistory(spineItemHref(book, spineIndex) ?? "");
      beginExplicitNavigation();
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
      cueBookmarks,
      mobileChrome,
    ]
  );

  // ---- 外部链接：Tauri 用系统默认浏览器，浏览器开发模式开新标签页 ----
  const handleExternalLink = useCallback((rawUrl: string): void => {
    const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    if (!/^(https?|mailto|tel):/i.test(url)) return;
    if (isTauriEnv()) {
      void openUrl(url).catch((err: unknown) => {
        setRuntimeIssues((prev) => [...prev, uiText("appUi.issue.linkFailed", { error: String(err) })]);
      });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, []);

  // ---- 阅读进度保存 ----
  useEffect(() => {
    if (phase.phase !== "ready" || !book) return;
    // Portable shelf books now use the per-book local checkpoint plus v3
    // session path below; only temporary/non-shelf books keep this legacy
    // localStorage recovery record.
    if (activeProgressLeaseRef.current) return;
    if (
      readerDisplayReady &&
      !suppressShelfProgressRef.current &&
      !(restoreGateRef.current && !mayCommitRestoredProgress(restoreGateRef.current)) &&
      !navigationPendingRef.current &&
      chapterState.status === "ready" &&
      !chapterState.empty &&
      chapterState.transient !== true
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
  useReaderSettingsPersistence(settings, uiScale);
  // 界面文字大小（uiScale）写在根节点上：字号变量与图标都由它派生，弹层/portal 一并跟随（ER-0127）。
  useUiScaleRoot(uiScale);

  // 书架设置与阅读 Aa 共用的主题入口：仅主题变化走约 200ms 整屏淡入，更新回调内
  // 同步提交 React 外层、html/body 与全部在用正文宿主（见 ui/themeTransitionHost）。
  const changeTheme = themeTransition.changeTheme;
  const customThemeName = useCallback((n: number) => t("aa.customTheme.defaultName", { n }), [t]);
  const customThemes = useCustomThemes(settings.theme, changeTheme, customThemeName);

  // 同步主题至 html 与 body，保证全屏与全端窗口背景无死角对齐（过渡提交已先行同步，这里幂等）。
  // Layout effect: a user theme's variables must exist before the first paint that selects them.
  useLayoutEffect(() => {
    applyDocumentTheme(document, settings.theme);
  }, [settings.theme]);
  const appThemeAttributes = useMemo(() => documentThemeAttributes(settings.theme), [settings.theme]);

  // 恢复默认同时改几何：经同一控制器直接提交（取代未提交的主题请求），排版走原有事务。
  const resetDefaults = useCallback((): void => {
    commitThemeSettings(settingsActions.resetDefaults);
  }, [commitThemeSettings, settingsActions]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reposition on layout changes; storing the new footnote rect must not trigger this effect again.
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
        const bookFiles = files.filter((f) => supportedBookName(f.name));
        const fontFiles = files.filter((f) => isSupportedFontFileName(f.name));
        if (fontFiles.length > 0 && !fontSettingsOpen) {
          setShelfNotice({ kind: "error", text: uiText("notice.font.dropHere") });
        }
        if (files.length > 0 && bookFiles.length === 0 && fontFiles.length === 0) {
          setShelfNotice({ kind: "error", text: uiText("notice.drop.booksOnly") });
        }
        if (bookFiles.length > 0) {
          void handleImportSources(
            bookFiles.map((file) => ({ kind: "file" as const, file })),
            viewRef.current === "shelf" ? importContextRef.current : null,
          );
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
    let nativeDragHasBook = false;
    let nativeDragHasFont = false;
    let nativeDragHasOther = false;
    const isOverFontPanel = (position: { x: number; y: number }): boolean => {
      if (!fontSettingsOpen) return false;
      const panel = document.querySelector<HTMLElement>(".font-settings-panel");
      if (!panel) return false;
      return isPhysicalPointInsideRect(position, window.devicePixelRatio, panel.getBoundingClientRect());
    };
    /** Folder card under the point wins; otherwise the open folder; otherwise the shelf root. */
    const dropTargetAt = (position: { x: number; y: number }): { target: ImportFolderTarget | null; onCard: boolean } => {
      if (viewRef.current !== "shelf") return { target: null, onCard: false };
      const folderId = folderIdAtPhysicalPoint(position, window.devicePixelRatio);
      const name = folderId ? liveFolderName(organizationRef.current, folderId) : null;
      if (folderId && name !== null) return { target: { folderId, name }, onCard: true };
      return { target: importContextRef.current, onCard: false };
    };
    const clearNativeDragVisual = (): void => {
      setDragActive(false);
      setFontNativeDragActive(false);
      setDropFolderId(null);
    };
    const updateNativeDragVisual = (position: { x: number; y: number }): void => {
      const overFontPanel = isOverFontPanel(position);
      const active = !overFontPanel && (nativeDragHasBook || nativeDragHasFont || nativeDragHasOther);
      setFontNativeDragActive(overFontPanel);
      setDragActive(active);
      const { target, onCard } = active && nativeDragHasBook ? dropTargetAt(position) : { target: null, onCard: false };
      setDropFolderId(onCard && target ? target.folderId : null);
      setDropLabel(
        target ? uiText("appUi.drop.toFolder", { name: target.name })
          : nativeDragHasBook ? uiText("appUi.drop.books")
            : nativeDragHasOther ? uiText("appUi.drop.generic")
              : uiText("notice.font.dropHere"),
      );
    };
    /** A dropped non-book, non-font item: one folder opens directory import on it. */
    const openDroppedDirectory = async (paths: readonly string[]): Promise<void> => {
      const directories: string[] = [];
      for (const path of paths) {
        try {
          if ((await statFile(path)).isDirectory) directories.push(path);
        } catch {
          // Unreadable here: the native directory scan checks it and explains.
          directories.push(path);
        }
      }
      if (directories.length === 0 || !activeShelfSpace().policy.libraryServices) {
        // Directory import fills the library; another shelf takes books one by one.
        setShelfNotice({
          kind: "error",
          text: uiText(activeShelfSpace().policy.libraryServices ? "notice.drop.unsupported" : "notice.drop.booksOnly"),
        });
      } else if (directories.length > 1) {
        setShelfNotice({ kind: "warn", text: uiText("notice.drop.oneFolder") });
      } else {
        await handleOpenFolderImport({ kind: "path", path: directories[0] });
      }
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter") {
          const dropped = partitionDroppedPaths(p.paths);
          nativeDragHasBook = dropped.books.length > 0;
          nativeDragHasFont = dropped.fonts.length > 0;
          nativeDragHasOther = dropped.others.length > 0;
          updateNativeDragVisual(p.position);
        } else if (p.type === "over") {
          updateNativeDragVisual(p.position);
        } else if (p.type === "leave") {
          nativeDragHasBook = false;
          nativeDragHasFont = false;
          nativeDragHasOther = false;
          clearNativeDragVisual();
        } else if (p.type === "drop") {
          nativeDragHasBook = false;
          nativeDragHasFont = false;
          nativeDragHasOther = false;
          clearNativeDragVisual();
          // 字体面板优先：面板内的落点只走字体链路，拖入的图书不抢读书会话。
          const overFontPanel = isOverFontPanel(p.position);
          const dropped = partitionDroppedPaths(p.paths);
          if (overFontPanel) {
            void handleImportFontPaths(p.paths);
            if (dropped.books.length > 0) {
              setShelfNotice({ kind: "error", text: uiText("notice.font.dropUnsupported") });
            }
            return;
          }
          if (dropped.books.length > 0) {
            // Mixed with folders: only the book files are imported; a folder is dropped on its own.
            if (dropped.fonts.length > 0) {
              setShelfNotice({ kind: "error", text: uiText("notice.font.dropHere") });
            }
            void handleImportSources(
              dropped.books.map((path) => ({
                kind: "path" as const,
                path,
                name: path.split(/[\\/]/).pop() || "book.epub",
              })),
              dropTargetAt(p.position).target,
            );
          } else if (dropped.others.length > 0) {
            void openDroppedDirectory(dropped.others);
          } else if (dropped.fonts.length > 0) {
            setShelfNotice({ kind: "error", text: uiText("notice.font.dropHere") });
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
        setShelfNotice({ kind: "error", text: uiText("notice.font.dropUnavailable") });
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fontSettingsOpen, handleImportFontPaths, handleImportSources, handleOpenFolderImport]);

  // ---- 派生 ----
  const shelfDisplayEntries = useMemo(
    () => view === "shelf"
      ? projectShelfProgressReadiness(shelfEntries, readKnownChapterProgressKeys())
      : shelfEntries,
    [view, shelfEntries],
  );
  const ready = phase.phase === "ready" && book !== null && server !== null;
  // Chapter numbers shown to the reader count linear items only (no trailing nav).
  const spineLinear = useMemo(() => book?.spine.map((item) => item.linear) ?? [], [book]);
  const linearChapter = linearChapterNumber(spineLinear, spineIndex);
  // In-reader settings preview the open book's direction; the shelf copy stays left to right.
  const pageProgression = book ? effectivePageProgression(book.pageProgression, settings, book.fixedLayout) : "ltr";
  const readerTapRegions = useMemo(() => ({ ...tapRegions, progression: pageProgression }), [tapRegions, pageProgression]);
  // 开书/换章仍在加载：主题直接提交，加载完成后按最新主题（既有 desired/代次契约）。
  readerThemeBusyRef.current = view === "reader" && (!ready || !readerDisplayReady);
  // 阅读输入（含正文 iframe 内的按下/触摸/滚轮/按键）开始即中断主题装饰，不加输入锁。
  useReadingInputStart(view === "reader", themeTransition.interrupt);
  // 搜索与“更多”关闭后保留一个退场动画时长再卸载，与其他菜单同速。
  const searchPresence = useExitPresence(searchOpen);
  // PC 阅读：鼠标静止后隐藏指针；书架、面板/浮层与弹窗期间始终显示。
  useReaderCursorIdle(view === "reader" && !mobileChrome && foreground.kind === "none" &&
    !saveFailurePrompt && !progressChoice && imageRequest === null);
  const moreSheetPresence = useExitPresence(mobileChrome && view === "reader" && ready && mobileMoreOpen);
  const lanSavePresence = useExitPresence(lanSaveOpen && runtime.supportsLanTransfer);
  const readerLoadFeedback = resolveReaderLoadFeedback({
    visible: view === "reader" && ready,
    displayReady: readerDisplayReady,
    displayedOnce,
    chapter: chapterState,
  });
  // 首页显示后、过渡解除前先准备 Aa，再准备目录（挂载为关闭态，留到离开阅读器）。
  const openingPanels = useOpeningPanelPrep(
    view === "reader" && ready && displayedOnce && bookKey ? bookKey : null,
  );
  const prepareAaPanel = useCallback(() => openingPanels.prepared(bookKey, "aa"), [openingPanels.prepared, bookKey]);
  const openAaFonts = useCallback(() => showMenuSubview("fonts"), [showMenuSubview]);
  const openAaDisplay = useCallback(() => showMenuSubview("extras"), [showMenuSubview]);
  const aaDisplaySummary = useMemo(() => {
    const parts: string[] = [];
    if (textProjectionPreferences.mode === "simplified") parts.push(t("aa.display.summary.toSimplified"));
    else if (textProjectionPreferences.mode === "traditional") parts.push(t("aa.display.summary.toTraditional"));
    const rules = textProjectionPreferences.rules.filter((rule) => rule.enabled).length;
    if (rules > 0) parts.push(t("aa.display.summary.rules", { count: rules }));
    if (visualPreferences.enabled) parts.push(t("aa.display.summary.filter"));
    return parts.join(" · ");
  }, [textProjectionPreferences, visualPreferences.enabled, t]);
  const changeAaColumns = useCallback((columnsPerView: 1 | 2) => handlePresentationChange({ columnsPerView }), [handlePresentationChange]);
  const changeAaReadingMode = useCallback((readingMode: "paginated" | "scroll") => handlePresentationChange({ readingMode }), [handlePresentationChange]);
  const chooseBookFromAa = useCallback(() => {
    void handleChooseBooks();
    closeForeground();
  }, [handleChooseBooks, closeForeground]);
  // A11：多本书标签页。只挂一个阅读器：切标签 = 走现有“返回书架”保存并释放当前书，
  // 等会话清理 effect 提交后再走现有“从书架打开”。阅读层与分页器不感知标签。
  // 标签条只在电脑和平板横屏显示；手机和平板竖屏宽度不够，照旧只显示书名。
  const readerTabsVisible = useReaderTabsVisible(mobileChrome);
  const { readerTabs, setReaderTabs, tabSwitchOpening, setTabSwitchOpening } = useReaderTabsState();
  useEffect(() => {
    if (phase.phase === "loading") setTabSwitchOpening(null);
  }, [phase.phase]);
  // 标签条的“＋”（只开一本时也有）和“+N”面板也在阅读安静时画一次（电脑和安卓都画）。
  const readerTabsWarm = readerTabsVisible && view === "reader";
  // 安卓本次运行：Aa 与目录在首次开书过渡仍遮住时各画一次，其余面板在阅读安静时逐个画一次
  // （几乎不可见、不可交互），之后的首次打开不再承担 GPU 首绘。
  const androidRuntime = runtime.platform === "android";
  const panelWarmup = usePanelPaintWarmup(
    view === "reader" && ready && readerDisplayReady && openingPanels.aa && openingPanels.toc &&
      !openingPanels.pending && foreground.kind === "none" && !mobileMoreOpen && !assistantOpen,
    androidRuntime ? PANEL_WARM_VEIL_BATCHES : [],
    [
      ...(!androidRuntime ? [] : mobileChrome ? PANEL_WARM_IDLE_BATCHES_MOBILE : PANEL_WARM_IDLE_BATCHES),
      ...(readerTabsWarm ? PANEL_WARM_TAB_BATCHES : []),
    ],
    readerBusy,
  );
  useReadingInputStart(view === "reader", panelWarmup.interrupt);
  const warming = panelWarmup.warming;
  // 开书过渡覆盖“解析书籍”、首次“准备阅读位置”与有限的面板准备；之后的换章只用顶部细进度线。
  const readerOpeningVisible =
    phase.phase === "loading" ||
    tabSwitchOpening !== null ||
    (readerLoadFeedback?.kind === "loading" && !displayedOnce) ||
    openingPanels.pending ||
    panelWarmup.pending;
  const readerOpeningTitle = phase.phase === "loading"
    ? phase.title || phase.fileName
    : tabSwitchOpening?.title ?? book?.metadata.title ?? "";
  const readerOpeningCreator = phase.phase === "loading" ? phase.creator : tabSwitchOpening?.creator ?? book?.metadata.creator;
  const reading = chapterState.status === "ready" && !chapterState.empty;
  const currentPath = ready ? spineItemPath(book!, spineIndex) : undefined;
  const activeHref = currentPath
    ? archiveHref(book?.archiveReferences, currentPath, book?.sourceFormat === "comic-zip" && chapterState.status === "ready" ? `page-${(chapterState.leafRange?.first ?? 1) - 1}` : anchor ?? "")
    : undefined;
  activeHrefRef.current = activeHref;
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
      chapterFraction: book?.sourceFormat === "comic-zip" && chapterState.status === "ready" ? chapterState.totalScrollProgress : undefined,
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
  const { persistShelfProgress, persistChapterCountCache } = useShelfProgressCommit({
    view, currentShelfId, spineIndex, book, chapterState, chapterStateRef, settings,
    linearIndices, countSummary, readerDisplayReady, readReaderPosition,
    restoreGateRef, suppressShelfProgressRef, navigationPendingRef,
    setShelfEntries, showReaderNotice,
    activeSessionRef, chapterCountsRef, baselineProgressPctRef, lastCountProgressSignatureRef,
    persistShelfProgressRef, progressWriterRef, activeProgressLeaseRef, localCheckpointsRef,
  });

  const { handleShelfOpen, leaveReader } = useBookOpen({
    setBook, bookRef, setServer, setBookKey, activeSessionRef, sessionGenerationRef,
    chapterCountsRef, setChapterCountsState, chapterCountJobRef, baselineProgressPctRef,
    lastCountProgressSignatureRef, setContentAxis, contentAxisRef, setChapterState, setAnchor,
    setInitialAnchor, setInitialPage, setSpineIndex, setCurrentShelfId, setReaderHistory,
    setView, setPhase, setRuntimeIssues, setSearchQuery, setSearchNavigationBusy, setPreciseTarget,
    setNoteBusy, setDiagText, setForeground, setShelfBusy, setShelfBusyMessage, setShelfEntries,
    setShelfError, setShelfNotice, setProgressChoice, setLocalCheckpointConflict, setSaveFailurePrompt,
    shelfBusyRef, shelfEntriesRef, persistShelfProgressRef, noteBusyRef, latestPreciseRequestRef,
    preciseRequestRef, progressChoiceResolverRef, localCheckpointResolverRef, scrubSessionRef,
    tocFollowSeekRef, sidebarNavigationMemoryRef, lastStablePositionRef, activeProgressLeaseRef,
    localCheckpointsRef, firstSampleFailureRecordedRef, progressWriterRef, closeForeground,
    closeImageOverlay, dispatchReaderSession, startRestore, dispatchScrub, ensureProgressRuntimeReady,
    retainUnsavedSample, recordLifecycleDiagnostic, persistShelfProgress, persistChapterCountCache,
    reimportAndroidMissing, showReaderNotice, runtime, isTauriEnv, toPersistedReaderAnchor, bookKeyOf,
    firstLinear, clamp, legacySavedProgress, savedProgressFromPortableLocator, savedProgressFromShelfEntry,
    savedProgressFromVersion, mergeProgressProjection, portableProgressVersions, sameCheckpointPatchValue,
  });

  const handleBackToShelf = useCallback(() => leaveReader(false, true), [leaveReader]);

  const {
    readerTabsRef, setTabPick, switchReaderTab, closeReaderTabById,
    openFromShelf, shelfReaderTabs, readerTabStrip, takePendingOpen,
  } = useReaderTabActions({
    view, currentShelfId, libraryLoad, shelfEntries, readerTabsVisible, readerTabs, setReaderTabs,
    setTabSwitchOpening, shelfEntriesRef, shelfBusyRef, currentShelfIdRef, leaveReader, handleShelfOpen, warming,
  });

  // ---- ER-0044 书架切换：普通书架与隐私书架（以后的多书架走同一入口） ----
  /** The library's tabs while another shelf is open; restored when it closes. */
  const libraryReaderTabsRef = useRef<typeof readerTabs | null>(null);
  /** Search/sort/status the shelf had before opening a book; one per shelf space. */
  const [shelfSessionMemory, setShelfSessionMemory] = useState(createShelfSessionMemory);
  const shelfSpaces = useShelfSpaces({
    supported: runtime.supportsPrivateShelf,
    viewRef,
    leaveReader: (leaveUnsaved) => leaveReader(leaveUnsaved),
    resetShelfView: (entering) => {
      closeForeground();
      setTabPick(null);
      if (entering === "library") {
        setReaderTabs(libraryReaderTabsRef.current ?? parseReaderTabs(null));
        libraryReaderTabsRef.current = null;
      } else {
        libraryReaderTabsRef.current ??= readerTabsRef.current;
        setReaderTabs(parseReaderTabs(null));
      }
      setShelfEntries([]);
      setOrganization(emptyOrganization);
      setShelfScope({ type: "root" });
      setShelfSessionMemory(createShelfSessionMemory());
      setShelfSearchMode("metadata");
    },
    refreshShelf: refreshShelfProjection,
    setShelfNotice,
    shelfBusyRef,
    beforeBookMove: async ({ entry, hash }) => {
      const results = await progressWriterRef.current?.flushBooks([entry.id]) ?? [];
      const failed = results.find((result) => result.status === "failed");
      if (failed?.status === "failed") throw failed.error;
      if (localCheckpointsRef.current?.peek(hash)) throw new Error(uiText("shelfMain.move.pendingProgress"));
    },
    onBookMoved: ({ entry, hash, direction }) => {
      setReaderTabs((state) => closeReaderTab(state, entry.id).state);
      setCurrentShelfId((current) => (current === entry.id ? null : current));
      setShelfEntries((previous) => previous.filter((item) => item.id !== entry.id));
      // What this shelf kept in the browser for the book must not stay behind.
      localCheckpointsRef.current?.remove(hash);
      forgetShelfPlaceLabel(hash);
      forgetChapterCounts(hash);
      const encodingKey = `epub-reader:txt-encoding:${entry.id}`;
      try {
        const encoding = shelfSpaceStorage.getItem(encodingKey);
        shelfSpaceStorage.removeItem(encodingKey);
        // A manual TXT encoding is needed to read the book, so it follows it back to the library.
        if (encoding && direction === "toLibrary") localStorage.setItem(encodingKey, encoding);
      } catch {
        /* Browser storage is best effort. */
      }
    },
  });
  const libraryServices = shelfSpaces.space.policy.libraryServices;
  const shelfSpacesLeaveRef = useRef(shelfSpaces.leave);
  shelfSpacesLeaveRef.current = shelfSpaces.leave;

  const externalOpen = useExternalOpenFlow({
    leaveReader, handleShelfOpen, importExternalSource, libraryLoad, shelfBusy, nativeImport,
    saveFailurePrompt, view, shelfEntries, shelfBusyRef, nativeImportRef, saveFailurePromptRef,
    viewRef, shelfEntriesRef, activeSessionRef, shelfSpacesLeaveRef, runtime, isTauriEnv, setShelfNotice,
  });
  useEffect(() => {
    if (!readerTabsVisible || view !== "reader") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "Tab") {
        event.preventDefault();
        const next = cycleReaderTab(readerTabsRef.current, event.shiftKey ? -1 : 1);
        if (next) void switchReaderTab(next);
      } else if (event.key.toLowerCase() === "w" && !event.shiftKey) {
        const id = currentShelfIdRef.current;
        if (!id) return;
        event.preventDefault();
        closeReaderTabById(id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeReaderTabById, readerTabsVisible, switchReaderTab, view]);
  const resolveSaveFailurePrompt = useCallback((leaveUnsaved: boolean): void => {
    const prompt = saveFailurePrompt;
    if (!prompt) return;
    setSaveFailurePrompt(null);
    if (prompt.kind === "window") void windowCloseRef.current?.(leaveUnsaved);
    else void leaveReader(leaveUnsaved, true);
  }, [leaveReader, saveFailurePrompt]);
  const dismissSaveFailurePrompt = useCallback((): void => setSaveFailurePrompt(null), []);

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

  const {
    exitBackHint,
    handleShelfRootBack,
    clearExitBackHint,
  } = useShelfExitBack(view);

  const handleAndroidBack = useCallback((): void => {
    if (saveFailurePromptRef.current) {
      setSaveFailurePrompt(null);
      return;
    }
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
    if (folderImport) {
      // The panel closes itself unless an import is running.
      setFolderImportCloseSignal((value) => value + 1);
      return;
    }
    if (lanSaveOpen) {
      closeLanSavePanel();
      return;
    }
    if (lanSaveSession.active) {
      // A committing session may be hidden on purpose; Back must not exit the
      // app or fall through to the reader while its real result is pending.
      setLanSaveOpen(true);
      return;
    }
    if (saveFileExportSetup || saveFileJob.active) {
      void closeSaveFileUi();
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
      if (shelfBackHandlerRef.current?.()) {
        clearExitBackHint();
        return;
      }
      handleShelfRootBack();
    }
  }, [
    clearExitBackHint,
    closeImageOverlay,
    closeLanSavePanel,
    closeSaveFileUi,
    folderImport,
    handleBackToShelf,
    handleShelfRootBack,
    isSidebarOpen,
    lanSaveOpen,
    lanSaveSession.active,
    mobileMoreOpen,
    requestCloseCurrentSurface,
    responsive.imeBottom,
    saveFileExportSetup,
    saveFileJob.active,
    view,
  ]);

  useAndroidBack(
    runtime.usesAndroidBack && (
      view === "reader" ||
      view === "shelf" ||
      foreground.kind !== "none" ||
      imageRequest !== null ||
      shelfBackActive ||
      folderImport !== null ||
      saveFileActive ||
      lanSaveOpen ||
      lanSaveSession.active ||
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
    // 触摸阅读默认沉浸：开书只显示正文，轻点正文中部呼出工具。
    setReaderToolsVisible(!mobileChrome);
    setMobileMoreOpen(false);
  }, [currentShelfId, view]);

  useEffect(() => {
    if (!readerToolsVisible) setMobileMoreOpen(false);
  }, [readerToolsVisible]);

  useEffect(() => {
    if (foreground.kind !== "none" || imageRequest !== null) setMobileMoreOpen(false);
  }, [foreground.kind, imageRequest]);

  useNoteEditRelease({ noteComposer, noteComposerDirtyRef, activeNoteEditContextRef });

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
    clearRestore();
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
    tocFollowSeekRef.current = null;
    sidebarNavigationMemoryRef.current.tocFollow = undefined;
    dispatchScrub({ type: "reset", session: scrubSessionRef.current });
    setChapterState({ status: "loading" });
    setReaderHistory(emptyReaderNavigationHistory());
    overlayHoverRef.current = false;
    closeForeground();
    setSearchNavigationBusy(false);
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    dispatchReaderSession({ type: "leave" });
  }, [view]);

  // A11：上一个会话的清理 effect（同一次提交、声明在前）跑完后，才打开目标标签。
  useEffect(() => {
    if (view !== "shelf") return;
    const id = takePendingOpen();
    if (id) void handleShelfOpen(id).finally(() => setTabSwitchOpening(null));
  }, [handleShelfOpen, view]);

  useEffect(() => {
    if (chapterState.status !== "error") return;
    setSearchNavigationBusy(false);
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
  }, [chapterState.status]);

  // 切到后台时尽快冲刷；Tauri 关闭窗口时等待最后位置落盘后再销毁窗口。
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        persistShelfProgressRef.current(true);
        persistChapterCountCache();
        recordLifecycleDiagnostic("hidden", { stage: "visibility-hidden", result: "best-effort" });
        const lease = activeProgressLeaseRef.current;
        if (lease) {
          // Best effort once; freezing may leave the task to finish later.
          void progressWriterRef.current?.flush(lease).catch(() => {
            /* 返回前台后再由真实写入/检查报告，而非无限重试。 */
          });
        }
        return;
      }
      // visible: invalidate cached readiness, recover explicitly outside the
      // gate race, then perform one real read-only check.
      void (async () => {
        const gate = progressRuntimeGateRef.current;
        if (!gate) return;
        gate.invalidate();
        recordLifecycleDiagnostic("visible", { stage: "check-before", result: "begin" });
        try {
          const status = await ensureProgressRuntimeReady();
          recordLifecycleDiagnostic("visible", {
            stage: "check-after",
            result: "ready",
            repositoryGeneration: status.repositoryGeneration,
          });
          const lease = activeProgressLeaseRef.current;
          if (!lease) return;
          const store = getShelfStore();
          const currentGeneration = store.progressSessionRepositoryGeneration?.(lease);
          if (currentGeneration !== undefined && currentGeneration !== status.repositoryGeneration) {
            await store.rebindProgressSession?.(lease);
          }
        } catch (error) {
          recordLifecycleDiagnostic("visible", {
            stage: "check-after",
            result: "failed",
            errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
          });
          setReaderNotice({ kind: "warn", text: uiText("notice.service.unavailable", { error: String(error) }) });
        }
      })();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!runtime.hasDesktopWindowChrome) {
      return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    let unlisten: (() => void) | undefined;
    let closing = false;
    const appWindow = getCurrentWindow();
    const closeWindow = async (leaveUnsaved: boolean): Promise<void> => {
      if (closing) return;
      closing = true;
      persistShelfProgressRef.current(true);
      persistChapterCountCache();
      try {
        // Deliberate full flush at real window exit; report failed lanes.
        const writer = progressWriterRef.current;
        const results = await writer?.flushBooks() ?? [];
        const failures = results.filter((result) => result.status === "failed");
        if (failures.length > 0) {
          const first = failures[0];
          if (!leaveUnsaved && first.status === "failed") throw first.error;
          // Explicit "close anyway": hand failed lanes to local checkpoints
          // where possible; closing never waits on that succeeding.
          for (const failure of failures) releaseUnsavedLane(writer!, failure.lease, retainUnsavedSample(failure.lease));
          recordLifecycleDiagnostic("window_close", { stage: "save", result: "left-unsaved", count: failures.length });
        }
        await appWindow.destroy();
      } catch (error) {
        closing = false;
        setSaveFailurePrompt({ kind: "window", error: String(error) });
      }
    };
    windowCloseRef.current = closeWindow;
    void appWindow
      .onCloseRequested(async (event) => {
        // Every request stays intercepted until our save/choice path destroys
        // the window, including repeated requests during an in-flight save.
        event.preventDefault();
        if (closing) return;
        // A repeated close request while the choice is on screen keeps the
        // same choice instead of silently retrying or closing.
        if (saveFailurePromptRef.current?.kind === "window") return;
        await closeWindow(false);
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {
        /* 非桌面窗口或关闭监听不可用时，仍保留逐页写入与 visibility flush。 */
      });
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      windowCloseRef.current = null;
      unlisten?.();
    };
  }, []);

  // App update: background check (never while reading) and the full save an install waits for.
  useEffect(() => {
    const updatedTo = startAppUpdates({ isReading: () => viewRef.current === "reader" });
    if (updatedTo) setShelfNotice({ kind: "ok", text: uiText("about.updated", { version: updatedTo }) });
    registerAppUpdateSaveGate(async () => {
      persistShelfProgressRef.current(true);
      persistChapterCountCache();
      const results = await progressWriterRef.current?.flushBooks() ?? [];
      for (const result of results) if (result.status === "failed") throw result.error;
    });
    return () => registerAppUpdateSaveGate(null);
  }, []);

  /** 每个 spine 项在目录里的名字：插图页、拆开的章节文件沿用上一个目录项；封面等目录之前的为空串。 */
  const tocSpineLabels = useMemo(() => book ? tocLabelsBySpine(book) : [], [book]);
  const currentChapterLabel = ready ? book?.sourceFormat === "comic-zip" && chapterState.status === "ready"
    ? book.toc[(chapterState.leafRange?.first ?? 1) - 1]?.label ?? ""
    : tocSpineLabels[spineIndex] ?? "" : "";
  // The shelf's "continue" card shows this name for the saved position.
  useEffect(() => {
    if (ready) writeShelfPlaceLabel(activeSessionRef.current?.countCacheKey ?? null, spineIndex, currentChapterLabel);
  }, [ready, spineIndex, currentChapterLabel]);
  /** 跳转历史目标的位置名：本章为空串，其他章用目录名或“第 N 章”；无目标为 null。 */
  const historyPlaceLabel = (position: ReaderNavigationPosition | undefined): string | null => {
    if (!position || !book || !ready) return null;
    if (position.spineIndex === spineIndex) return "";
    return tocSpineLabels[position.spineIndex] ||
      t("footer.chapterN", { n: linearChapterNumber(spineLinear, position.spineIndex) ?? position.spineIndex + 1 });
  };

  const crossBookPanelResults = useLibrarySearchResults(librarySearchSnapshot, entryByContentHashRef, libraryIndexSignature);
  const { searchPanelResults, handleSearchViewChange, handleSearchCancel } = useReaderSearchPanel({
    ...readerSearchState, ...readerSearchRefs, setSearchView: readerSearchView.setSearchView,
  });
  const { handleStartLibraryIndex, handleCancelLibraryIndex, handleDeferLibraryIndex, handleRebuildTextIndex,
    handleClearTextIndex, handleShelfSearchModeChange, handleCorpusConcurrencyChange,
    handleLibrarySearchQueryChange } = useLibrarySearchActions({
      ...librarySearch, setShelfSearchMode, setSearchNavigationBusy,
    });
  const logItems: LogItem[] = [
    ...(book?.issues ?? []).map((i) => ({ kind: i.kind, source: i.source, message: i.message })),
    ...runtimeIssues.map((m) => ({ kind: "reader_error", source: "render", message: m })),
    ...resourceIssues.map((issue) => ({
      kind: "reader_error",
      source: "render",
      resolved: issue.recovered,
      message: uiText(issue.recovered ? "appUi.issue.resourceRecovered"
        : issue.kind === "missing" ? "appUi.issue.resourceAbsent" : "appUi.issue.resourceUnavailable", { path: issue.path })
        + (issue.error ? `\n${uiText("log.resourceErrorRecord", { error: issue.error })}` : ""),
    })),
  ];

  const {
    isFullscreen,
    fullscreenBusy,
    readerZenMode,
    changeReaderZenMode,
    toggleFullscreen,
  } = useFullscreenControls({ runtime, isTauriEnv, setRuntimeIssues });

  const isReaderPanelOpen = Boolean(
    menuOpen ||
    fontSettingsOpen ||
    tocOpen ||
    searchOpen ||
    notesOpen ||
    logOpen ||
    assistantOpen ||
    readingSettingsOpen ||
    noteComposer !== null
  );

  // 跳转返回 / 前进入口（与 Alt+← / Alt+→ 同一历史、同一就绪条件）。
  const historyBackPlace = view === "reader" ? historyPlaceLabel(readerHistory.back.at(-1)) : null;
  const historyForwardPlace = view === "reader" ? historyPlaceLabel(readerHistory.forward.at(-1)) : null;
  const goHistoryBack = (): void => {
    if (!readerDisplayReadyRef.current || navigationPendingRef.current) return;
    handleHistoryBack();
  };
  const goHistoryForward = (): void => {
    if (!readerDisplayReadyRef.current || navigationPendingRef.current) return;
    handleHistoryForward();
  };
  // 手机：跳转后自动出现，或随阅读工具一起出现；PC：跳转后自动出现，常驻入口在标题栏。
  const returnControlVisible =
    (historyBackPlace !== null || historyForwardPlace !== null) &&
    !isReaderPanelOpen && !isSidebarOpen && imageRequest === null &&
    (returnPromptShown || (mobileChrome && readerToolsVisible));

  // Android volume keys share the keyboard page-turn guards: panels, the
  // bookmark menu and the image viewer own input while they are open.
  const volumeKeyInputBlocked = isReaderPanelOpen || bookmarkMenuOpen || imageRequest !== null;
  useReaderShortcuts({
    runtime, view, viewRef, ready, book, pageProgression, spineIndex, searchOpen, tocOpen,
    menuOpen, bookmarkMenuOpen, noteComposer, isFullscreen, fullscreenBusy, readerHistory,
    readerDisplayReady, isReaderPanelOpen, imageRequest, navigationPendingRef,
    isSidebarOpen, volumeKeyInputBlocked, volumeKeyTurn, volumeKeyReverse, volumeKeyGate,
    setShelfNotice, showReaderNotice, readerRef, overlayHoverRef,
    closeForeground, handleHistoryBack, handleHistoryForward, handleBookmarkButton,
    undoBookmarkRemoval, handleToggleBookmarks, handleToggleSidebar, handleSidebarClose,
    requestCloseCurrentSurface, toggleFullscreen, openPanel, closePanel, handleTocNavigate,
  });

  const resolveProgressChoice = useCallback((stamp: Stamp | null): void => {
    const resolve = progressChoiceResolverRef.current;
    progressChoiceResolverRef.current = null;
    setProgressChoice(null);
    resolve?.(stamp);
  }, []);

  const resolveLocalCheckpointConflict = useCallback((choice: "local" | "synced" | null): void => {
    const resolve = localCheckpointResolverRef.current;
    localCheckpointResolverRef.current = null;
    setLocalCheckpointConflict(null);
    resolve?.(choice);
  }, []);

  return (
    <div
      data-drop-label={dragActive ? dropLabel : undefined}
      className={`app${dragActive ? " drag-active" : ""}${dragActive && dropFolderId ? " drag-to-folder" : ""}${isFullscreen ? " is-fullscreen" : ""}${isDockedSidebar ? ` has-docked-sidebar docked-side-${sidebarSide}` : ""}${isDockedSearch ? " has-docked-search" : ""}`}
      data-platform={runtime.platform}
      data-shell={runtime.shell}
      data-layout={responsive.layout}
      data-touch-ui={responsive.touchUi ? "true" : undefined}
      data-mobile-chrome={mobileChrome ? "true" : undefined}
      data-mobile-reader={mobileChrome && view === "reader" ? "true" : undefined}
      data-tools-visible={mobileChrome && view === "reader" ? String(readerToolsVisible) : undefined}
      data-theme={appThemeAttributes.theme}
      data-tone={appThemeAttributes.tone}
      style={{
        "--visual-viewport-height": `${responsive.visualViewportHeight}px`,
        "--visual-viewport-top": `${responsive.visualViewportOffsetTop}px`,
        "--ime-bottom": `${responsive.imeBottom}px`,
      } as CSSProperties}
    >
      <TitleBar
        view={view}
        title={view === "reader" ? (ready ? book!.metadata.title : (book?.metadata.title ?? "")) : `${t("appUi.appName")}${IS_AI_EDITION ? " AI" : ""}`}
        author={view === "reader" && ready ? book!.metadata.creator : undefined}
        chapterTitle={view === "reader" && ready ? currentChapterLabel : undefined}
        onBackToShelf={view === "reader" ? handleBackToShelf : undefined}
        readerTabs={view === "reader" ? readerTabStrip : undefined}
        onToggleSidebar={view === "reader" ? handleToggleSidebar : undefined}
        sidebarOpen={view === "reader" && isSidebarOpen}
        // 触摸设备（手机与平板）共用同一阅读顶栏，随 toolsVisible 一起显隐；
        // 平板不再叠加桌面工具栏。自带窗口外壳的桌面触屏仍保留窗口按键。
        mobileCompact={phoneChrome || (mobileChrome && !runtime.hasDesktopWindowChrome)}
        toolsVisible={readerToolsVisible}
        onToggleAppearance={view === "reader" ? toggleAppearancePanel : undefined}
        appearanceOpen={view === "reader" && menuOpen}
        onOpenSearch={
          view === "reader" && ready && !book!.fixedLayout
            ? toggleSearchPanel
            : undefined
        }
        searchOpen={view === "reader" && searchOpen}
        isBookmarked={view === "reader" && isCurrentPageBookmarked}
        onToggleBookmark={view === "reader" ? handleBookmarkButton : undefined}
        bookmarkSpread={view === "reader" && chapterState.status === "ready" && chapterState.mode !== "scroll" &&
          chapterState.effectiveColumns === 2}
        bookmarkPagesOpen={view === "reader" && bookmarkPagesOpen}
        zenMode={view === "reader" && !mobileChrome && readerZenMode}
        onToggleZenMode={view === "reader" && !mobileChrome ? () => changeReaderZenMode(!readerZenMode) : undefined}
        progressPct={view === "reader" && ready ? progressPct : undefined}
        chapterIndex={view === "reader" && ready && linearChapter !== null ? linearChapter - 1 : undefined}
        totalChapters={view === "reader" && ready ? linearChapterTotal(spineLinear) : undefined}
        isFullscreen={isFullscreen}
        fullscreenBusy={fullscreenBusy}
        onToggleFullscreen={view === "reader" ? toggleFullscreen : undefined}
        onHistoryBack={historyBackPlace !== null ? goHistoryBack : undefined}
        onHistoryForward={historyForwardPlace !== null ? goHistoryForward : undefined}
        historyBackLabel={historyBackPlace ?? undefined}
        historyForwardLabel={historyForwardPlace ?? undefined}
        onToggleAssistant={
          view === "reader" && IS_AI_EDITION && libraryServices
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
          aria-label={t("appUi.showTools")}
        >
          {t("appUi.showTools")}
        </button>
      )}
      {view === "reader" && ready && (
        <SidebarDrawer
          key={sidebarBookKey}
          navigationMemory={sidebarNavigationMemory}
          open={isSidebarOpen}
          side={sidebarSide}
          activeTab={activeSidebarTab}
          onTabChange={handleSidebarTabChange}
          mode={effectiveSidebarMode}
          onModeChange={handleSidebarModeChange}
          onClose={handleSidebarClose}
          compact={phoneChrome}
          warm={openingPanels.toc}
          onPrepared={() => openingPanels.prepared(bookKey, "toc")}
          paintWarm={warming("toc")}
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
          onEditNote={(viewNote) => void handleEditNote(viewNote.id)}
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
              key={shelfSpaces.token ?? "library"}
              shelfSwitch={runtime.supportsPrivateShelf ? {
                active: shelfSpaces.space.kind,
                spaces: ["private"],
                privateConfigured: shelfSpaces.privateConfigured,
                onSelect: (kind) => void shelfSpaces.select(kind),
                onLock: shelfSpaces.lock,
              } : undefined}
              libraryServices={libraryServices}
              compact={phoneChrome}
              entries={shelfDisplayEntries}
              organization={organization}
              scope={shelfScope}
              onScopeChange={setShelfScope}
              sessionMemory={shelfSessionMemory}
              onApplyOrganization={handleApplyOrganization}
              busy={shelfBusy}
              importActive={nativeImport !== null || folderImport !== null}
              onImportFolder={libraryServices ? () => void handleOpenFolderImport() : undefined}
              saveFileActive={saveFileActive}
              lanTransferActive={lanSaveSession.active}
              // Android keeps originals only for 导入书, so its one switch lives in settings.
              copyToLibrary={libraryServices && importEntryCopyChoiceSupported() ? libraryCopyChoice(librarySettings) : undefined}
              onCopyToLibraryChange={handleCopyToLibraryChange}
              onLibraryLocationChanged={handleLibraryLocationChanged}
              onOpenLanTransfer={runtime.supportsLanTransfer && libraryServices ? handleOpenLanSave : undefined}
              theme={settings.theme}
              onThemeChange={changeTheme}
              customThemes={customThemes}
              hideReaderSystemStatusBar={runtime.supportsReaderSystemStatusBar ? hideReaderSystemStatusBar : undefined}
              onHideReaderSystemStatusBarChange={changeHideReaderSystemStatusBar}
              keepScreenOnWhileReading={runtime.supportsReaderKeepScreenOn ? keepScreenOnWhileReading : undefined}
              onKeepScreenOnWhileReadingChange={changeKeepScreenOnWhileReading}
              volumeKeyTurn={runtime.supportsVolumeKeyTurn ? volumeKeyTurn : undefined}
              onVolumeKeyTurnChange={changeVolumeKeyTurn}
              volumeKeyReverse={runtime.supportsVolumeKeyTurn ? volumeKeyReverse : undefined}
              onVolumeKeyReverseChange={changeVolumeKeyReverse}
              batteryIndicatorEnabled={runtime.platform === "android" ? batteryIndicatorEnabled : undefined}
              onBatteryIndicatorChange={runtime.platform === "android" ? changeBatteryIndicatorEnabled : undefined}
              titlebarAutoHide={mobileChrome ? undefined : readerZenMode}
              onTitlebarAutoHideChange={changeReaderZenMode}
              preloadNextChapter={settings.preloadNextChapter === true}
              onPreloadNextChapterChange={settingsActions.setPreloadNextChapter}
              seamlessChapterTurn={settings.seamlessChapterTurn === true}
              onSeamlessChapterTurnChange={settingsActions.setSeamlessChapterTurn}
              uiScale={uiScale}
              onUiScaleChange={settingsActions.setUiScale}
              tapRegions={tapRegions}
              onTapRegionsChange={changeTapRegionPreferences}
              tapRegionsScrollMode={settings.readingMode === "scroll"}
              touchUi={mobileChrome}
              onOpenDiagnostics={libraryServices ? () => openPanel("log") : undefined}
              libraryState={shelfLibraryView(libraryLoad, shelfEntries.length > 0, organizationSettled)}
              onRetryLibraryLoad={retryLibraryLoad}
              onOpen={openFromShelf}
              readerTabs={shelfReaderTabs}
              onImport={() => void handleChooseBooks()}
              onImportIntoFolder={(target) => void handleChooseBooks(target)}
              onImportContextChange={handleImportContextChange}
              externalDropFolderId={dropFolderId}
              onDelete={handleShelfDelete}
              onDeleteMany={handleShelfDeleteMany}
              registerBackHandler={registerShelfBackHandler}
              onBackAvailabilityChange={reportShelfBackActive}
              onExportArchive={libraryServices ? handleExportArchive : undefined}
              onExportBooks={
                runtime.platform === "web" || !isTauriEnv() || !libraryServices
                  ? undefined
                  : (entries?: ShelfEntry[]) => void startBookSourceExport(entries)
              }
              onRevealSource={runtime.supportsRevealSource && libraryServices ? handleRevealSource : undefined}
              shelfMove={runtime.supportsPrivateShelf ? {
                direction: shelfSpaces.space.kind === "private" ? "toLibrary" : "toPrivate",
                onMove: (entry) => void shelfSpaces.requestMove(entry),
              } : undefined}
              onImportArchive={handleImportArchive}
              onImportLegacyArchive={
                runtime.platform === "web" || !isTauriEnv() || !libraryServices
                  ? undefined
                  : () => void handleLegacyImportArchive()
              }
              thumbnailProvider={shelfThumbnailProvider}
              searchMode={libraryServices ? shelfSearchMode : "metadata"}
              onSearchModeChange={libraryServices ? handleShelfSearchModeChange : undefined}
              bodySearch={!libraryServices ? undefined : {
                query: librarySearchSnapshot.query,
                onQueryChange: handleLibrarySearchQueryChange,
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
                  currentBookTitle: librarySearchSnapshot.indexProgress.titles.join(t("notice.listSep")) || undefined,
                },
                indexErrorMessage: librarySearchSnapshot.rebuildRequested
                  ? t("notice.index.rebuildWarning")
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
                onConcurrencyChange: handleCorpusConcurrencyChange,
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
            {(menuOpen || warming("display") || warming("fonts")) && (
              <PanelPaintWarmup active={!menuOpen}>
                {menuOpen && <div className="menu-backdrop" onClick={closeForeground} />}
                {(menuOpen ? displaySettingsOpen : warming("display")) ? (
                  <ReaderDisplaySettingsPopover
                    onBack={() => showMenuSubview("main")}
                  >
                    <TextProjectionPanel
                      preferences={textProjectionPreferences}
                      onChange={updateTextProjectionPreferences}
                    />
                    <ReaderVisualSettingsPanel
                      value={visualPreferences}
                      onChange={updateVisualPreferences}
                      compareOriginal={visualCompareOriginal}
                      onCompareOriginalChange={setVisualCompareOriginal}
                      colorAssistSlot={
                        <ColorAssistPanel
                          value={visualPreferences.colorAssist}
                          onChange={(colorAssist) => updateVisualPreferences({ ...visualPreferences, colorAssist })}
                        />
                      }
                    />
                  </ReaderDisplaySettingsPopover>
                ) : (menuOpen ? fontSettingsOpen : warming("fonts")) ? <FontSettingsPanel
                  source={settings.fontSource}
                  customFontId={settings.customFontId}
                  customFontName={settings.customFontName}
                  forceFontOverride={settings.forceFontOverride === true}
                  onForceFontOverrideChange={settingsActions.setForceFontOverride}
                  systemFonts={systemFonts}
                  userFonts={userFonts}
                  systemFontsStatus={systemFontsStatus}
                  systemFontsError={systemFontsError}
                  onLoadSystemFonts={() => void loadSystemFonts()}
                  busy={fontBusy}
                  onSelectSystem={settingsActions.selectSystemFont}
                  onSelectBook={settingsActions.selectBookFont}
                  onSelectImported={settingsActions.selectImportedFont}
                  onDelete={(id) => void handleDeleteFont(id)}
                  onImport={handleImportFonts}
                  nativeDragActive={fontNativeDragActive}
                  onClose={() => showMenuSubview("main")}
                /> : null}
              </PanelPaintWarmup>
            )}
            {((menuOpen && !displaySettingsOpen && !fontSettingsOpen) || openingPanels.aa) && (
              <AaPopover
                key={bookKey}
                open={menuOpen && !displaySettingsOpen && !fontSettingsOpen}
                suspended={menuOpen && (displaySettingsOpen || fontSettingsOpen)}
                onPrepared={prepareAaPanel}
                paintWarm={warming("aa-detailed") ? "detailed" : warming("aa") ? "quick" : undefined}
                phoneLayout={phoneChrome}
                fontSize={settings.fontSizePx}
                onFontSizeChange={settingsActions.setFontSize}
                onFontDec={settingsActions.decreaseFont}
                onFontInc={settingsActions.increaseFont}
                theme={settings.theme}
                onThemeChange={changeTheme}
                customThemes={customThemes}
                customFontName={settings.customFontName}
                onOpenFontSettings={openAaFonts}
                onOpenDisplaySettings={openAaDisplay}
                displaySummary={aaDisplaySummary}
                onLivePreviewChange={setTypographyPreview}
                layoutStamp={chapterState.status === "ready" ? chapterState : null}
                lineHeight={settings.lineHeight}
                onLineHeightChange={settingsActions.setLineHeight}
                onResetLineHeight={settingsActions.resetLineHeight}
                fontWeight={settings.fontWeight}
                onFontWeightChange={settingsActions.setFontWeight}
                letterSpacingPx={settings.letterSpacingPx}
                onLetterSpacingChange={settingsActions.setLetterSpacing}
                wordSpacingPx={settings.wordSpacingPx}
                onWordSpacingChange={settingsActions.setWordSpacing}
                gapPx={settings.gapPx}
                spreadGapMode={settings.spreadGapMode ?? "auto"}
                onGapPxChange={settingsActions.setGap}
                onSpreadGapModeChange={settingsActions.setSpreadGapMode}
                spreadArea={chapterState.status === "ready" ? chapterState.spreadArea : undefined}
                pageMargins={settings.pageMarginsPx}
                onPageMarginsChange={settingsActions.setPageMargins}
                columnsPerView={settings.columnsPerView === 2 ? 2 : 1}
                onColumnsChange={changeAaColumns}
                readingMode={settings.readingMode === "scroll" ? "scroll" : "paginated"}
                onReadingModeChange={changeAaReadingMode}
                effectiveColumns={chapterState.status === "ready" ? chapterState.effectiveColumns : undefined}
                onPresentationChange={handlePresentationChange}
                turnAnimation={normalizeTurnAnimation(settings.turnAnimation)}
                onTurnAnimationChange={settingsActions.setTurnAnimation}
                forceHorizontal={settings.forceHorizontal === true}
                onForceHorizontalChange={settingsActions.setForceHorizontal}
                txtIndent={settings.txtIndent === true}
                onTxtIndentChange={book?.sourceFormat === "txt" ? settingsActions.setTxtIndent : undefined}
                pageDirection={settings.pageDirection}
                onPageDirectionChange={settingsActions.setPageDirection}
                customCss={settings.customCss}
                onCustomCssChange={settingsActions.setCustomCss}
                onResetDefaults={resetDefaults}
                onToggleLog={handleToggleLog}
                issueCount={logItems.length}
                onOpenFile={chooseBookFromAa}
                onClose={closeForeground}
              />
            )}
            {ready ? (
              <>
                {(searchPresence.present || warming("search")) && (
                  <PanelPaintWarmup active={!searchPresence.present}>
                    <div className={`search-backdrop${!mobileChrome ? " is-docked" : ""}${searchPresence.closing ? " is-closing" : ""}`} onClick={() => closePanel("search")} />
                    <SearchPanel
                      closing={searchPresence.closing}
                      docked={!mobileChrome}
                      query={searchQuery}
                      onQueryChange={setSearchQuery}
                      searchView={searchView}
                      onSearchViewChange={!isIdentityTextProjection(readerTextProjectionPreferences) ? handleSearchViewChange : undefined}
                      results={searchPanelResults}
                      status={searchStatus}
                      processed={searchProgress.processed}
                      total={searchProgress.total}
                      truncated={searchResults.length > 100}
                      errorMessage={searchError}
                      navigationBusy={searchNavigationBusy}
                      onSelect={(panelResult) => {
                        const result = searchResults.find((candidate) =>
                          `${candidate.spineIndex}:${candidate.originalRange.start}:${candidate.originalRange.end}:${candidate.display?.range.start ?? -1}:${candidate.display?.range.end ?? -1}:${candidate.matchType}` === panelResult.id
                        );
                        if (result) handleSearchNavigate(result);
                      }}
                      onCancel={handleSearchCancel}
                      onClose={() => closePanel("search")}
                    />
                  </PanelPaintWarmup>
                )}
                {assistantOpen && LazyAiFoundationPanel && (
                  <>
                    <div className="ai-backdrop" onClick={() => closePanel("assistant")} aria-hidden="true" />
                    <Suspense fallback={<aside className="ai-foundation-panel" role="status">{t("appUi.aiLoading")}</aside>}>
                      <LazyAiFoundationPanel
                        snapshot={aiRuntimeSnapshot}
                        companion={book && currentShelfId ? {
                          book,
                          context: {
                            bookHash: contentHashByIdRef.current.get(currentShelfId) ?? currentShelfId,
                            title: book.metadata.title, creator: book.metadata.creator ?? "", spineIndex,
                          },
                          libraryBooks: shelfEntries.filter(entry => entry.available !== false && Boolean(entry.contentHash))
                            .map(entry => ({ hash: entry.contentHash!, title: entry.title, creator: entry.creator, spineIndex: entry.spineIndex })),
                          onNavigate: (evidence) => {
                            if (evidence.bookHash === (contentHashByIdRef.current.get(currentShelfId) ?? currentShelfId)) {
                              handleSearchNavigate(evidence.citation);
                            } else {
                              const entry = shelfEntries.find(candidate => candidate.contentHash === evidence.bookHash);
                              if (entry) void handleShelfOpen(entry.id, evidence.hit);
                            }
                          },
                        } : undefined}
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
                <SourceReaderView
                  key={bookKey}
                  ref={readerRef}
                  book={book!}
                  server={server!}
                  spineIndex={spineIndex}
                  anchor={anchor}
                  anchorNonce={anchorNonce}
                  settings={settings}
                  textProjectionPreferences={readerTextProjectionPreferences}
                  textProjection={compiledTextProjection}
                  visualPreferences={visualPreferences}
                  compareOriginal={visualCompareOriginal}
                  userFonts={renderUserFonts}
                  notes={currentChapterNotes}
                  notesForChapter={notesForChapter}
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
                  onRestoreResult={handleReaderRestoreResult}
                  onExternalLink={handleExternalLink}
                   onFootnote={(payload) => openTransient("footnote", payload)}
                  onFootnoteClose={handleFootnoteClose}
                  onImageActivation={handleImageActivation}
                  inputPaused={imageRequest !== null}
                  livePreview={typographyPreview && menuOpen}
                  onPlainTap={mobileChrome ? handleReaderPlainTap : undefined}
                  tapRegions={tapRegions}
                  bookmarks={currentBookmarks}
                  bookmarkCue={bookmarkCue}
                  onBookmarkCornerTap={mobileChrome ? handleBookmarkCornerTap : undefined}
                  initialAnchor={initialAnchor}
                  initialPage={initialPage}
                  initialAlignment={initialAlignment}
                  restoreTicket={initialRestoreTicket}
                  startAtEnd={startAtEnd}
                  preciseTarget={preciseTarget}
                  onPreciseNavigationStatus={handlePreciseNavigationStatus}
                  onContentFractionSettled={handleContentFractionSettled}
                  onContentFractionCancelled={handleContentFractionCancelled}
                  onContentFractionFailed={handleContentFractionFailed}
                  onUserProgressSample={handleUserProgressSample}
                />
                {readerLoadFeedback?.kind === "loading" && displayedOnce && (
                  <div className="reader-load-line" role="status" aria-live="polite">
                    <span className="reader-load-line-text">{readerLoadFeedback.text}</span>
                  </div>
                )}
                {readerLoadFeedback && readerLoadFeedback.kind !== "loading" && (
                  <div
                    className={`reader-load-feedback ${readerLoadFeedback.kind}`}
                    role={readerLoadFeedback.kind === "error" ? "alert" : "status"}
                    aria-live={readerLoadFeedback.kind === "error" ? "assertive" : "polite"}
                  >
                    <span className="reader-load-feedback-text">{readerLoadFeedback.text}</span>
                  </div>
                )}
                <ImageViewer
                  image={imageRequest}
                  onClose={closeImageOverlay}
                  visualPreferences={visualPreferences}
                  compareOriginal={visualCompareOriginal}
                  onCompareOriginalChange={setVisualCompareOriginal}
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
                      const fragment = book?.archiveReferences ? book.archiveReferences.resolve(image.chapterPath, href).anchor : href.slice(1);
                      if (readerRef.current?.navigateWithinCurrentChapter({ fragment })) {
                        commitReaderHistorySnapshot(snapshot);
                      }
                      return;
                    }
                    // ImageViewRequest keeps the original anchor href, which is
                    // relative to its chapter. Resolve it before App routing.
                    const { path: resolved, anchor } = resolveArchiveHref(book?.archiveReferences, image.chapterPath, href);
                    if (resolved) handleTocNavigate(archiveHref(book?.archiveReferences, resolved, anchor));
                  }}
                />
                {selectionContext && (
                  <ReaderContextMenu
                    selection={{
                      ...selectionContext,
                      text: selectionContext.selectedText,
                      originalText: selectionContext.originalSelectedText,
                    }}
                    position={{ x: selectionContext.rect.right + 6, y: selectionContext.rect.bottom + 6 }}
                    onCopy={(text) => {
                      void navigator.clipboard.writeText(text).catch((error) =>
                        setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.copyFailed", { error: String(error) })])
                      );
                      closeForeground();
                      readerRef.current?.clearTextSelection();
                    }}
                    onCopyOriginal={(text) => {
                      void navigator.clipboard.writeText(text).catch((error) =>
                        setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.copyOriginalFailed", { error: String(error) })])
                      );
                      closeForeground();
                      readerRef.current?.clearTextSelection();
                    }}
                    onAddNote={() => {
                      // 双页拼接屏上选的可能是另一章的半页：笔记按选中文字所在的章记。
                      const selectedIndex = book ? spineIndexForEntryKey(book, selectionContext.chapterPath) : -1;
                      openComposer({ mode: "create", selection: selectionContext, spineIndex: selectedIndex >= 0 ? selectedIndex : spineIndex });
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
                      selectedText={noteComposer.mode === "create"
                        ? (noteComposer.selection.originalSelectedText ?? noteComposer.selection.selectedText)
                        : noteComposer.note.selectedText}
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
                {phase.phase === "idle" && <div className="big">{t("appUi.preparingShelf")}</div>}
                {phase.phase === "loading" && <div>{t("appUi.openingFile", { name: phase.fileName })}</div>}
                {phase.phase === "error" && (
                  <>
                    <div className="big">{t("appUi.cannotOpen")}</div>
                    <div>{phase.message}</div>
                    <button onClick={() => void handleChooseBooks()}>{t("appUi.chooseAgain")}</button>
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
            onPin={mobileChrome ? () => readerRef.current?.pinFootnote() : undefined}
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
          linearSpine={spineLinear}
          chapterNamed={currentChapterLabel !== ""}
          rtl={pageProgression === "rtl"}
          bookProgressPct={progressPct}
          onSeekPage={(targetPage) => {
            readerRef.current?.setPage(targetPage);
          }}
          onSeekChapter={(targetSpineIndex) => {
            if (targetSpineIndex >= 0 && targetSpineIndex < book!.spine.length) {
              const href = spineItemHref(book!, targetSpineIndex);
              if (href) handleTocNavigate(href);
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
          statusAccessory={
            // 唯一电量订阅：工具栏仅用 CSS 隐藏仍挂载，必须传实际可见态以释放 receiver。
            <BatteryIndicator enabled={batteryIndicatorEnabled && (!mobileChrome || readerToolsVisible)} />
          }
        />
      )}
      {view === "reader" && ready && returnControlVisible && (
        <ReaderReturnControl
          back={historyBackPlace}
          forward={historyForwardPlace}
          onBack={goHistoryBack}
          onForward={goHistoryForward}
          placement={mobileChrome ? "phone" : "desktop"}
          raised={mobileChrome && readerToolsVisible}
        />
      )}
      {(moreSheetPresence.present || warming("more")) && (
        <PanelPaintWarmup active={!moreSheetPresence.present}>
          <div
            className={`mobile-more-backdrop${moreSheetPresence.closing ? " is-closing" : ""}`}
            onClick={() => setMobileMoreOpen(false)}
            aria-hidden="true"
          />
          <div className={`mobile-more-sheet${moreSheetPresence.closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={t("appUi.more.dialog")}>
            <div className="mobile-more-title">{t("appUi.more.title")}</div>
            {/* 书签/笔记在“目录”页签；诊断日志和关于在 书架 › 设置 › 关于。 */}
            <div className="mobile-more-list">
              {runtime.supportsReaderKeepScreenOn && (
                <SettingsSwitch
                  label={t("shelfMenu.keepScreenOn")}
                  checked={keepScreenOnWhileReading}
                  onChange={changeKeepScreenOnWhileReading}
                />
              )}
              {runtime.supportsReaderSystemStatusBar && (
                <SettingsSwitch
                  label={t("shelfMenu.statusBar.tip")}
                  checked={hideReaderSystemStatusBar}
                  onChange={changeHideReaderSystemStatusBar}
                />
              )}
              <button
                type="button"
                className="shelf-settings-row"
                onClick={() => {
                  // 先收起“更多”，阅读设置关闭后直接回到正文。
                  setMobileMoreOpen(false);
                  openPanel("reading");
                }}
              >
                <span className="shelf-settings-row-text">
                  <strong>{t("tapRegions.title")}</strong>
                  <small>{t("appUi.more.tapRegions.detail")}</small>
                </span>
                <ChevronRightIcon size={15} className="shelf-settings-row-chevron" />
              </button>
              {IS_AI_EDITION && libraryServices && (
                <button
                  type="button"
                  className="shelf-settings-row"
                  onClick={() => {
                    openPanel("assistant");
                    setMobileMoreOpen(false);
                  }}
                >
                  <span className="shelf-settings-row-text">
                    <strong>{t("appUi.more.ai")}</strong>
                  </span>
                  <ChevronRightIcon size={15} className="shelf-settings-row-chevron" />
                </button>
              )}
            </div>
          </div>
        </PanelPaintWarmup>
      )}
      {view === "reader" && (
        <PanelPaintWarmup active={warming("reading") && !readingSettingsOpen}>
          <ReaderReadingSettings
            textEncoding={book?.sourceFormat === "txt" ? book.textEncoding || "auto" : undefined}
            onTextEncodingChange={encoding => {
              if (!currentShelfId) return;
              try { shelfSpaceStorage.setItem(`epub-reader:txt-encoding:${currentShelfId}`, encoding); closePanel("reading"); void handleShelfOpen(currentShelfId, undefined, undefined, undefined, encoding); }
              catch (error) { showReaderNotice(String(error), "warn"); }
            }}
            open={readingSettingsOpen || warming("reading")}
            presentation={mobileChrome ? "page" : "dialog"}
            onClose={() => closePanel("reading")}
            tapRegions={readerTapRegions}
            onTapRegionsChange={changeTapRegionPreferences}
            tapRegionsScrollMode={settings.readingMode === "scroll"}
            keepScreenOnWhileReading={runtime.supportsReaderKeepScreenOn ? keepScreenOnWhileReading : undefined}
            onKeepScreenOnWhileReadingChange={changeKeepScreenOnWhileReading}
            volumeKeyTurn={runtime.supportsVolumeKeyTurn ? volumeKeyTurn : undefined}
            onVolumeKeyTurnChange={changeVolumeKeyTurn}
            volumeKeyReverse={runtime.supportsVolumeKeyTurn ? volumeKeyReverse : undefined}
            onVolumeKeyReverseChange={changeVolumeKeyReverse}
            hideReaderSystemStatusBar={runtime.supportsReaderSystemStatusBar ? hideReaderSystemStatusBar : undefined}
            onHideReaderSystemStatusBarChange={changeHideReaderSystemStatusBar}
            batteryIndicatorEnabled={runtime.platform === "android" ? batteryIndicatorEnabled : undefined}
            onBatteryIndicatorChange={runtime.platform === "android" ? changeBatteryIndicatorEnabled : undefined}
            titlebarAutoHide={mobileChrome ? undefined : readerZenMode}
            onTitlebarAutoHideChange={changeReaderZenMode}
            preloadNextChapter={settings.preloadNextChapter === true}
            preloadNextChapterDisabled={book?.fixedLayout === true}
            onPreloadNextChapterChange={settingsActions.setPreloadNextChapter}
            seamlessChapterTurn={settings.seamlessChapterTurn === true}
            onSeamlessChapterTurnChange={settingsActions.setSeamlessChapterTurn}
          />
        </PanelPaintWarmup>
      )}
      {logOpen && (
        <LogPanel
          items={logItems}
          diagText={diagText}
          onRefresh={refreshLogDiagnostics}
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
      {exitBackHint && (
        <div className="reader-bookmark-toast exit-back-hint" role="status" aria-live="polite">
          <span className="bookmark-toast-text">{t("appUi.exitHint")}</span>
        </div>
      )}
      {bookmarkToast && (
        <div
          key={bookmarkToast.id}
          className={`reader-bookmark-toast ${bookmarkToast.action}${bookmarkToast.closing ? " is-closing" : ""}${bookmarkToast.undo ? " has-undo" : ""}`}
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
          {bookmarkToast.undo && (
            <button type="button" className="bookmark-toast-undo" onClick={() => undoBookmarkRemoval()}>
              {t("notice.bookmark.undo")}
            </button>
          )}
        </div>
      )}
      {view === "reader" && warming("bookmark-pages") && (
        <PanelPaintWarmup active>
          <BookmarkPagesPopover warm screen={WARM_BOOKMARK_PAGES_SCREEN}
            onRemove={noopBookmarkPages} onAdd={noopBookmarkPages} onHint={noopBookmarkPages} onClose={noopBookmarkPages} />
        </PanelPaintWarmup>
      )}
      {bookmarkPagesScreen?.kind === "paged" && bookmarkPagesScreen.columns === 2 && (
        <BookmarkPagesPopover
          screen={bookmarkPagesScreen}
          onRemove={(ids) => removeBookmarks(ids, { animate: true })}
          onAdd={(lane) => { addBookmark(lane); }}
          onHint={hintBookmarks}
          onClose={closeBookmarkPages}
        />
      )}
      {saveFileExportSetup && (
        <SaveFileExportDialog
          selectedCount={saveFileExportSetup.selectedEntries.length}
          onCancel={() => setSaveFileExportSetup(null)}
          onConfirm={(scope, includeBooks) => void handleSaveFileExportConfirm(scope, includeBooks)}
        />
      )}
      {saveFileJob.state.kind === "prepared" && (
        <SaveFileImportPreview
          preview={saveFileJob.state.preview}
          sourceLabel={saveFileJob.state.sourceLabel}
          canceling={saveFileJob.state.canceling}
          onCancel={() => void closeSaveFileUi()}
          onConfirm={(applyPreferences) => void handleSaveFileImportConfirm(applyPreferences)}
        />
      )}
      <SaveFileProgressPanel state={saveFileJob.state} onCancel={() => void closeSaveFileUi()} />
      {lanSavePresence.present && (
        <LanSavePanel
          open
          closing={lanSavePresence.closing}
          session={lanSaveSession}
          selectedEntries={lanSaveSelection}
          isAndroid={runtime.platform === "android"}
          onClose={closeLanSavePanel}
        />
      )}
      {folderImport && (
        <FolderImportPanel
          port={folderImport.port}
          organization={folderImport.organization}
          directorySelectionSupported={folderImport.supported}
          closeSignal={folderImportCloseSignal}
          onSettled={handleFolderImportSettled}
          onClose={closeFolderImport}
          onUseFileImport={() => void handleChooseBooks()}
          autoScan={folderImport.autoScan}
          copyToLibrary={folderImportCopyChoice(librarySettings)}
          onCopyToLibraryChange={handleCopyToLibraryChange}
        />
      )}
      {nativeImport && (
        <NativeImportPanel
          phase={nativeImport.phase}
          completed={nativeImport.completed}
          total={nativeImport.total}
          fileNameSummary={nativeImport.fileNameSummary}
          cancelState={nativeImport.cancelState}
          canCancel={nativeImport.canCancel}
          collapsed={nativeImport.collapsed}
          onToggleCollapsed={handleToggleNativeImportCollapsed}
          onCancel={() => void handleCancelNativeImport()}
        />
      )}
      <ReaderOpening
        visible={readerOpeningVisible}
        title={readerOpeningTitle}
        creator={readerOpeningCreator}
        stage={phase.phase === "loading" ? t("notice.open.opening") : readerLoadFeedback?.text ?? t("notice.loading.position")}
      />
      {(shelfBusy || phase.phase === "loading") && nativeImport === null && !readerOpeningVisible && (
        <div className="app-busy" role="status" aria-live="polite" aria-busy="true">
          <div className="app-busy-spinner" />
          <div
            className="app-busy-text"
            title={shelfBusyMessage}
          >
            {shelfBusyMessage}
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".epub,.txt,.cbz,.zip,application/epub+zip,text/plain,application/zip"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) {
            handleFileInputSources(files.map((file) => ({ kind: "file" as const, file })));
          }
          e.target.value = "";
        }}
      />
      <div id="shelf-menu-portal-host" className="shelf-menu-portal-host" />
      {localCheckpointConflict && (
        <div className="shelf-confirm-backdrop" role="dialog" aria-modal="true" aria-label={t("appUi.checkpoint.dialog")}>
          <div className="shelf-confirm is-wide">
            <h3 className="shelf-confirm-title">{t("appUi.checkpoint.title")}</h3>
            <p className="shelf-confirm-body">
              {t("appUi.checkpoint.body", { title: localCheckpointConflict.title, synced: localCheckpointConflict.hasSynced ? t("appUi.checkpoint.syncedAvailable") : "" })}
            </p>
            <div className="shelf-confirm-choices">
              <button type="button" className="ui-btn" onClick={() => resolveLocalCheckpointConflict("local")}>
                {t("appUi.checkpoint.useLocal")}
              </button>
              {localCheckpointConflict.hasSynced && (
                <button type="button" className="ui-btn" onClick={() => resolveLocalCheckpointConflict("synced")}>
                  {t("appUi.checkpoint.useSynced")}
                </button>
              )}
            </div>
            <button type="button" className="ui-btn shelf-confirm-dismiss" onClick={() => resolveLocalCheckpointConflict(null)}>
              {t("appUi.cancel")}
            </button>
          </div>
        </div>
      )}
      {shelfSpaces.dialog && (
        <PrivateShelfDialog
          mode={shelfSpaces.dialog.mode}
          leftover={shelfSpaces.dialog.leftover}
          move={shelfSpaces.dialog.move && {
            title: shelfSpaces.dialog.move.entry.title || shelfSpaces.dialog.move.entry.fileName,
            run: (sessionId) => shelfSpaces.runMove(shelfSpaces.dialog!.move!, sessionId),
          }}
          native={privateShelfNative}
          // Clearing a forgotten password ends the move; the book stays where it is.
          onModeChange={(mode, leftover) => shelfSpaces.setDialog((current) => ({ mode, leftover, move: mode === "reset" ? undefined : current?.move }))}
          onUnlocked={shelfSpaces.openPrivate}
          onReset={shelfSpaces.onReset}
          onClose={() => shelfSpaces.setDialog(null)}
        />
      )}
      {progressChoice && (
        <div className="shelf-confirm-backdrop" role="dialog" aria-modal="true" aria-label={t("appUi.progressChoice.dialog")}>
          <div className="shelf-confirm is-wide">
            <h3 className="shelf-confirm-title">{t("appUi.progressChoice.title")}</h3>
            <p className="shelf-confirm-body">
              {uiPlural("appUi.progressChoice.body", progressChoice.candidates.length, { title: progressChoice.title, count: progressChoice.candidates.length })}
            </p>
            <ProgressSourceChoices
              candidates={progressChoice.candidates}
              onChoose={(candidate) => resolveProgressChoice(candidate.stamp)}
            />
            <button type="button" className="ui-btn shelf-confirm-dismiss" onClick={() => resolveProgressChoice(null)}>
              {t("appUi.cancel")}
            </button>
          </div>
        </div>
      )}
      {bookImportState.originalRetry && !saveFailurePrompt && (
        <OriginalImportRetryDialog
          reasons={bookImportState.originalRetry.reasons}
          onCopy={() => void retryOriginalAsCopy()}
          onClose={dismissOriginalRetry}
        />
      )}
      {externalOpen.failed && !saveFailurePrompt && (
        <ExternalOpenFailureDialog
          fileName={externalOpen.failed.fileName
            ?? (externalOpen.failed.source.kind === "path"
              ? externalOpen.failed.source.path.split(/[\\/]/).pop() || externalOpen.failed.source.path
              : displayNameFromContentUri(externalOpen.failed.source.uri))}
          onRetry={externalOpen.retry}
          onClose={externalOpen.dismiss}
        />
      )}
      {saveFailurePrompt && (
        <SaveFailureDialog
          prompt={saveFailurePrompt}
          onRetry={() => resolveSaveFailurePrompt(false)}
          onLeave={() => resolveSaveFailurePrompt(true)}
          onDismiss={dismissSaveFailurePrompt}
        />
      )}
    </div>
  );
}
