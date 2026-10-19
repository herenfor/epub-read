import {
  createReaderStatusBarCoordinator,
  shouldHideReaderSystemStatusBar,
} from "./platform/readerSystemStatusBar";
import {
  readHideReaderSystemStatusBar,
  writeHideReaderSystemStatusBar,
  setReaderSystemStatusBarHidden,
  createStatusBarAppearanceCoordinator,
} from "./platform/androidReaderSystemStatusBar";
import {
  createReaderKeepScreenOnCoordinator,
  readReaderKeepScreenOn,
  shouldKeepReaderScreenOn,
  writeReaderKeepScreenOn,
} from "./platform/androidReaderKeepScreenOn";
import { resolveArchiveHref, archiveHref } from "./core/archiveReferences";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { loadBook, loadBookFromArchive, spineIndexForPath, spineIndexForEntryKey, spineItemPath, spineItemHref, disposeBook, nextLinearIndex, linearChapterNumber, linearChapterTotal } from "./core/book";
import type { Book } from "./core/types";
import type { ArchiveClient } from "./core/selectiveArchive";
import type { Stamp, Version } from "./core/portableState/portable-register-core";
import { compareStamp } from "./core/portableState/portable-register-core";
import { latestVersion, projectProgressVersion, versionForStamp } from "./core/portableState/projection";
import type { Locator, PortablePreferences, ProgressValue } from "./core/portableState/portable-state-types";
import { isExternalUrl, isFragmentOnly, splitHref } from "./core/paths";
import type { SearchResult } from "./core/search";
import type { ExactTextHit } from "./core/exactTextHits";
import type { SearchOccurrence } from "./core/searchOccurrence";
import { ResourceServer, type ResourceIssue } from "./render/resources";
import { sanitizePersistedTextAnchor } from "./render/textAnchor";
import { clearDocumentSelection, isSelectAllShortcut } from "./render/selectionGuard";
import { arrowKeyDirection, effectivePageProgression, normalizeTurnAnimation } from "./render/settings";
import type { ChapterState, MediaReadingAnchor, PreciseNavigationStatus, ReadingAnchor } from "./render/paginator";
import { useReaderSettings, useReaderSettingsPersistence } from "./ui/useReaderSettings";
import { sanitizeTextProjectionPreferences } from "./render/textProjection/preferences";
import type { ImageViewRequest } from "./render/imageActivation";
import { ImageViewer } from "./ui/ImageViewer";
import { TitleBar } from "./ui/TitleBar";
import {
  createNativeFullscreenController,
  type NativeFullscreenController,
  type NativeFullscreenPort,
} from "./ui/windowFullscreen";
import { getRuntimeCapabilities } from "./platform/runtimeCapabilities";
import { getAppBuildSession } from "./config/appBuildSession";
import {
  EMPTY_READER_TABS,
  READER_TABS_STORAGE_KEY,
  activeReaderTabs,
  closeReaderTab,
  cycleReaderTab,
  openReaderTab,
  parseReaderTabs,
  pruneReaderTabs,
  serializeReaderTabs,
} from "./ui/readerTabs";
import { checkThenRecoverProgressRuntime, planFreshProgressOpen } from "./ui/progressOpenOrder";
import { useAndroidBack } from "./platform/useAndroidBack";
import { moveAndroidTaskToBack } from "./platform/androidAppTask";
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
import { readBatteryIndicatorEnabled, writeBatteryIndicatorEnabled } from "./ui/batteryPreferences";
import { readTapRegionPreferences, writeTapRegionPreferences } from "./ui/tapRegionPreferences";
import type { ReaderTapPreferences } from "./ui/readerTapRegions";
import { useResponsiveEnvironment } from "./ui/responsiveEnvironment";
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
import type { ResolvedCrossBookSearchHit } from "./features/ai/indexing/indexStore";
import { ReaderContextMenu } from "./ui/ReaderContextMenu";
import { NoteComposer } from "./ui/NoteComposer";
import type { ReaderNote } from "./ui/notes";
import { hasOwnField, chapterLabelForIndex, useNoteEditRef, replaceNoteEditContext,
  useBookmarkToast, useBookmarkToastCleanup, useNoteBusyState, useNoteProjection, useNoteActions,
  useBookmarkProjection, useBookmarkSidebarToggle, useBookmarkActions, useBookmarkRibbonActions,
  useNoteEditRelease } from "./ui/useBookmarksAndNotes";
import { BookmarkPagesPopover, WARM_BOOKMARK_PAGES_SCREEN } from "./ui/BookmarkPagesPopover";
import { isEditableTarget } from "./ui/bookmarkRibbons";
import { createLazyFontController } from "./ui/fontRuntime";
import { currentUiLocale, uiPlural, uiText, useUiText } from "./ui/localization/UiLanguageProvider";
import { FootnotePop } from "./ui/FootnotePop";
import { LogPanel, type LogItem } from "./ui/LogPanel";
import { ReaderView, type ReaderHandle } from "./ui/ReaderView";
import { ShelfView } from "./ui/ShelfView";
import { ReaderReturnControl } from "./ui/ReaderReturnControl";
import { applyDocumentTheme, useThemeTransition } from "./ui/themeTransitionHost";
import { useReadingInputStart } from "./ui/readerPointerEdge";
import { shelfLibraryView } from "./ui/libraryLoad";
import {
  useShelfEntriesState, useShelfNoticeState, useShelfOrganizationState,
  useShelfContentHashes, useShelfLibrary, useShelfOrganizationActions,
  useShelfDeletion, useShelfNoticeLifetime,
} from "./ui/useShelfLibrary";
import { useBookImportState, useBookImport, useFolderImport, type ImportFolderTarget } from "./ui/useBookImport";
import { ReaderReadingSettings, SettingsSwitch } from "./ui/ReadingSettings";
import { ChevronRightIcon } from "./ui/readerIcons";
import { NativeImportPanel } from "./ui/NativeImportPanel";
import {
  FolderImportPanel,
} from "./ui/folderImport";
import { LanSavePanel } from "./ui/LanSavePanel";
import { useLanSaveSession } from "./ui/useLanSaveSession";
import { SaveFileExportDialog, SaveFileImportPreview, SaveFileProgressPanel } from "./ui/SaveFileDialogs";
import { importSkippedNotice } from "./ui/importSkippedText";
import { bookExportErrorNotice, bookExportFileName, bookExportResultNotice, bookExportTargetLabel } from "./ui/bookExportText";
import type { BookSourceExportError } from "./platform/bookExportNativeBridge";
import { SaveFailureDialog } from "./ui/SaveFailureDialog";
import { releaseUnsavedLane, type SaveFailurePrompt } from "./ui/saveFailureExit";
import { useSaveFileJob } from "./ui/useSaveFileJob";
import {
  readContentUriText,
  writeTextContentUri,
} from "./platform/androidNativeBridge";
import {
  saveFileErrorCode,
  saveFileErrorMessage,
  type SaveExportScope,
  type SaveFileCommitResult,
  type SaveFileLocation,
} from "./platform/saveFileNativeBridge";
import {
  activatePortableShelfState,
  LibraryDatabaseBlockedError,
  applyShelfProgressPatch,
  ensurePortableRepositoryReady,
  getShelfStore,
  markShelfEntryOpened,
  readPortablePreferencesSnapshot,
  readingAnchorFromShelfEntry,
  shelfThumbnailProvider,
  portableShelfStateActive,
  type PortableProgressSelection,
  type ShelfEntry,
  type ShelfProgressPatch,
} from "./ui/shelf";
import {
  sha256Hex,
} from "./ui/importBooks";
import { bookOpenErrorMessage, describeBookOpenFailure } from "./ui/bookOpenFailure";
import { ScopedProgressWriter } from "./ui/progressWriter";
import { ProgressRuntimeGate, type ProgressRuntimeStatus } from "./ui/portableState/progressRuntimeGate";
import { LocalProgressCheckpoints, type LocalProgressCheckpoint } from "./ui/localProgressCheckpoint";
import {
  openingBaselinePct,
  planCheckpointOpen,
  sameCheckpointValue,
  stageCheckpointSample,
  persistCheckpointSample,
  type CheckpointedSample,
} from "./ui/checkpointProgressRepair";
import { progressValueFromPatch } from "./ui/portableState/shelfStoreAdapter";
import { mayCommitRestoredProgress, type RestoreTicket } from "./ui/restoreCommitGate";
import { useReaderSession } from "./ui/useReaderSession";
import type { ProgressLease } from "./ui/portableState/ownedProgressSessions";
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
import { readCachedChapterCounts, readKnownChapterProgressKeys, writeChapterCountCache } from "./ui/chapterCountCache";
import { projectShelfProgressReadiness } from "./ui/shelfProgressDisplay";
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
  type SavedProgress,
} from "./ui/storage";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isPhysicalPointInsideRect, isSupportedFontFileName } from "./ui/fontDrop";
import { folderIdAtPhysicalPoint, partitionDroppedPaths } from "./ui/shelfDrop";
import { liveFolderName } from "./ui/importIntoFolder";
import { createFontImportController } from "./ui/fontImport";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, stat as statFile, writeTextFile } from "@tauri-apps/plugin-fs";
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

/** 书架根层“再滑一次退出”的提示/确认窗口。 */
const EXIT_BACK_WINDOW_MS = 2000;

const DIAGNOSTIC_ERROR_CODES = new Set([
  "invalid-data",
  "invalid-entity",
  "invalid-choice",
  "invalid-intent",
  "stale-basis",
  "stale-choice",
  "deleted-entity",
  "clock-exhausted",
  "storage-error",
  "progress-needs-choice",
  "progress-write-interrupted",
  "runtime-not-ready",
  "runtime-check-timeout",
  "runtime-check-interrupted",
  "shelf-record-missing",
]);

function diagnosticErrorCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && DIAGNOSTIC_ERROR_CODES.has(value) ? value : "unknown";
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

function parseLocalProgressCheckpoint(value: unknown): LocalProgressCheckpoint<ShelfProgressPatch> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("本机进度恢复记录格式无效");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.checkpointId !== "string" ||
    candidate.checkpointId.length === 0 ||
    typeof candidate.bookHash !== "string" ||
    candidate.bookHash.length === 0 ||
    !Object.prototype.hasOwnProperty.call(candidate, "shownStamp") ||
    !Object.prototype.hasOwnProperty.call(candidate, "patch")
  ) {
    throw new Error("本机进度恢复记录字段不完整");
  }
  const shown = candidate.shownStamp;
  let shownStamp: LocalProgressCheckpoint<ShelfProgressPatch>["shownStamp"] = null;
  if (shown !== null) {
    if (
      typeof shown !== "object" ||
      typeof (shown as { deviceId?: unknown }).deviceId !== "string" ||
      typeof (shown as { counter?: unknown }).counter !== "number" ||
      !Number.isSafeInteger((shown as { counter: number }).counter)
    ) {
      throw new Error("本机进度恢复记录的选择戳无效");
    }
    shownStamp = {
      deviceId: (shown as { deviceId: string }).deviceId,
      counter: (shown as { counter: number }).counter,
    };
  }
  const rawPatch = candidate.patch;
  if (typeof rawPatch !== "object" || rawPatch === null || Array.isArray(rawPatch)) {
    throw new Error("本机进度恢复记录的阅读位置无效");
  }
  const patch = rawPatch as Partial<ShelfProgressPatch>;
  if (
    typeof patch.lastReadAtMs !== "number" ||
    !Number.isSafeInteger(patch.lastReadAtMs) ||
    patch.lastReadAtMs < 0 ||
    typeof patch.spineIndex !== "number" ||
    !Number.isSafeInteger(patch.spineIndex) ||
    typeof patch.page !== "number" ||
    !Number.isSafeInteger(patch.page) ||
    typeof patch.progressPct !== "number" ||
    !Number.isFinite(patch.progressPct) ||
    (patch.anchorIndex !== null && typeof patch.anchorIndex !== "number") ||
    (patch.anchorRatio !== null && typeof patch.anchorRatio !== "number") ||
    (patch.anchorTextOffset !== null && typeof patch.anchorTextOffset !== "number") ||
    (patch.anchorTextSnippet !== null && typeof patch.anchorTextSnippet !== "string")
  ) {
    throw new Error("本机进度恢复记录的位置字段无效");
  }
  return {
    schemaVersion: 1,
    checkpointId: candidate.checkpointId,
    bookHash: candidate.bookHash,
    shownStamp,
    patch: patch as ShelfProgressPatch,
  };
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
  const [book, setBook] = useState<Book | null>(null);
  const [server, setServer] = useState<ResourceServer | null>(null);
  const resourceIssues = useSyncExternalStore(
    server?.subscribeResourceIssues ?? subscribeNoResourceIssues,
    server?.getResourceIssues ?? getNoResourceIssues,
    getNoResourceIssues,
  );
  const [bookKey, setBookKey] = useState("");
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
    structuralCounts: ChapterCountCollection;
  } | null>(null);
  const baselineProgressPctRef = useRef(0);
  const chapterCountJobRef = useRef<{ cancel(): void } | null>(null);
  const lastCountProgressSignatureRef = useRef<string | null>(null);
  /** 统一固定内容轴：全书结构统计完成后冻结，跨模式、跨字号保持映射稳定 */
  const [contentAxis, setContentAxis] = useState<ContentAxis | null>(null);
  const contentAxisRef = useRef<ContentAxis | null>(null);
  const scrubSessionRef = useRef(0);
  const scrubRequestIdRef = useRef(0);
  /**
   * 分页模式进度条跨章：先换章，目标章显示就绪后再按章内比例定位一次。
   * 一次性；就绪的不是目标章（期间又跳到别处）则丢弃。
   */
  const pendingChapterSeekRef = useRef<{
    target: { key: string; spineIndex: number; fraction: number };
    token: ScrubToken;
  } | null>(null);
  const [scrubUiState, setScrubUiState] = useState<ScrubUiState>(() => initialScrubUi(0));
  const scrubUiStateRef = useRef(scrubUiState);

  const dispatchScrub = useCallback((event: ScrubUiEvent) => {
    // Navigation may report synchronously before React renders a begin/reset.
    const next = reduceScrubUi(scrubUiStateRef.current, event);
    scrubUiStateRef.current = next;
    setScrubUiState(next);
  }, []);

  const acceptsScrubResult = useCallback((token: ScrubToken): boolean => {
    const state = scrubUiStateRef.current;
    return state.session === token.session &&
      state.pending?.session === token.session && state.pending.request === token.request;
  }, []);

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
  const [batteryIndicatorEnabled, setBatteryIndicatorEnabled] = useState(readBatteryIndicatorEnabled);
  const changeBatteryIndicatorEnabled = useCallback((enabled: boolean) => {
    setBatteryIndicatorEnabled(enabled);
    writeBatteryIndicatorEnabled(enabled);
  }, []);
  // 点击翻页区域：本机偏好，PC 与触屏各一份；Android 平板按触屏界面判定，不因宽屏算作 PC。
  const [tapRegionPreferences, setTapRegionPreferences] = useState(readTapRegionPreferences);
  const changeTapRegionPreferences = useCallback((next: ReaderTapPreferences) => {
    setTapRegionPreferences(next);
    writeTapRegionPreferences(next);
  }, []);
  const tapRegions = useMemo(() => ({
    device: mobileChrome ? "touch" as const : "pc" as const,
    preferences: tapRegionPreferences,
  }), [mobileChrome, tapRegionPreferences]);
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
  const [hideReaderSystemStatusBar, setHideReaderSystemStatusBar] = useState(readHideReaderSystemStatusBar);
  const [readerSystemBars] = useState(() => createReaderStatusBarCoordinator(setReaderSystemStatusBarHidden));
  const [statusBarAppearance] = useState(() => createStatusBarAppearanceCoordinator());
  const changeHideReaderSystemStatusBar = useCallback((hidden: boolean) => {
    try {
      writeHideReaderSystemStatusBar(hidden);
      setHideReaderSystemStatusBar(hidden);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.statusBar.saveFailed", { error: String(error) }) });
    }
  }, []);
  const [keepScreenOnWhileReading, setKeepScreenOnWhileReading] = useState(readReaderKeepScreenOn);
  const [readerScreenOn] = useState(() => createReaderKeepScreenOnCoordinator());
  const changeKeepScreenOnWhileReading = useCallback((enabled: boolean) => {
    try {
      writeReaderKeepScreenOn(enabled);
      setKeepScreenOnWhileReading(enabled);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.keepScreenOn.saveFailed", { error: String(error) }) });
    }
  }, []);

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
  // ---- 用户自定义字体 ----
  const [userFonts, setUserFonts] = useState<UserFont[]>([]);
  const [fontUrls, setFontUrls] = useState<Record<string, string>>({});
  const [fontBusy, setFontBusy] = useState(false);
  const [systemFonts, setSystemFonts] = useState<SystemFont[]>([]);
  const [userFontsLoaded, setUserFontsLoaded] = useState(false);
  const [systemFontsStatus, setSystemFontsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null);
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
  const fontRuntimeRef = useRef<ReturnType<typeof createLazyFontController> | null>(null);
  if (!fontRuntimeRef.current) {
    fontRuntimeRef.current = createLazyFontController((id) => getFontStore().readFont(id));
  }
  const { contentHashByIdRef, entryByContentHashRef } = useShelfContentHashes(shelfEntries);
  const libraryIndexSignature = shelfEntries
    .map((entry) => `${entry.id}:${entry.contentHash ?? ""}:${entry.available === false ? 0 : 1}`)
    .join("|");
  const progressWriterRef = useRef<ScopedProgressWriter<CheckpointedSample<ShelfProgressPatch>> | null>(null);
  if (!progressWriterRef.current) {
    // Exact-session lanes are registered per open; no book ID alone may flush
    // or retire another book's unsaved sample. Each lane owns a staged local
    // checkpoint ID captured before native IPC can start.
    progressWriterRef.current = new ScopedProgressWriter<CheckpointedSample<ShelfProgressPatch>>();
  }
  const activeProgressLeaseRef = useRef<ProgressLease | null>(null);
  const progressRuntimeGateRef = useRef<ProgressRuntimeGate | null>(null);
  if (!progressRuntimeGateRef.current) {
    progressRuntimeGateRef.current = new ProgressRuntimeGate(async () => {
      const store = getShelfStore();
      // Health checks stay read-only. Explicit first activation/recovery is
      // performed outside the 5s race by ensureProgressRuntimeReady.
      if (store.runtimeStatus) return store.runtimeStatus();
      return { repositoryGeneration: "legacy", repositoryReady: true };
    });
  }
  const ensureProgressRuntimeReady = useCallback(async () => {
    const status = await checkThenRecoverProgressRuntime(
      progressRuntimeGateRef.current!, ensurePortableRepositoryReady,
    );
    lastNativeRecordsReadRef.current = status.lastRecordsRead ?? null;
    if (status.repositoryGeneration) lastRepositoryGenerationRef.current = status.repositoryGeneration;
    return status;
  }, []);
  const localCheckpointsRef = useRef<LocalProgressCheckpoints<ShelfProgressPatch> | null>(null);
  if (!localCheckpointsRef.current) {
    localCheckpointsRef.current = new LocalProgressCheckpoints(
      window.localStorage,
      parseLocalProgressCheckpoint,
      () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : `progress-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
  }
  // Re-stage a lane's latest sample as the book's local recovery record before
  // the lane is dropped; throws (keeping the lane) when that is impossible.
  const retainUnsavedSample = useCallback((lease: ProgressLease) => (sample: CheckpointedSample<ShelfProgressPatch>): void => {
    const checkpoints = localCheckpointsRef.current;
    const store = getShelfStore();
    const bookHash = store.progressSessionBookHash?.(lease) ?? contentHashByIdRef.current.get(lease.bookId);
    if (!checkpoints || !bookHash) throw new Error("本机进度检查点不可用");
    stageCheckpointSample(checkpoints, bookHash, store.progressSessionChosenStamp?.(lease) ?? null, sample.patch);
  }, []);
  const lifecycleDiagnosticsRef = useRef<string[]>([]);
  const firstSampleFailureRecordedRef = useRef(false);
  const jsBootIdRef = useRef<string | null>(null);
  if (!jsBootIdRef.current) {
    jsBootIdRef.current = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : `js-boot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  const lastRepositoryGenerationRef = useRef<string>("unknown");
  const lastNativeRecordsReadRef = useRef<ProgressRuntimeStatus["lastRecordsRead"] | null>(null);
  const recordLifecycleDiagnostic = useCallback((
    event: string,
    detail: {
      readonly stage?: string;
      readonly result?: string;
      readonly candidate?: boolean;
      readonly repositoryGeneration?: string;
      readonly errorCode?: string;
      readonly backend?: string;
      readonly count?: number;
      readonly targetFound?: boolean;
    } = {},
  ): void => {
    if (!(getAppBuildSession()?.debug ?? import.meta.env.DEV)) return;
    const lease = activeProgressLeaseRef.current;
    const store = getShelfStore();
    const repositoryGeneration = detail.repositoryGeneration
      ?? (lease ? store.progressSessionRepositoryGeneration?.(lease) : undefined)
      ?? lastRepositoryGenerationRef.current;
    if (repositoryGeneration && repositoryGeneration !== "unknown") {
      lastRepositoryGenerationRef.current = repositoryGeneration;
    }
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      stage: detail.stage ?? null,
      result: detail.result ?? null,
      candidate: detail.candidate ?? false,
      errorCode: diagnosticErrorCode(detail.errorCode),
      repositoryGeneration,
      jsBoot: jsBootIdRef.current,
      backend: detail.backend ?? null,
      count: detail.count ?? null,
      targetFound: detail.targetFound ?? null,
      lastNativeRecordsRead: lastNativeRecordsReadRef.current,
      portableFacade: portableShelfStateActive(),
      jsSession: sessionGenerationRef.current,
      activeLease: Boolean(activeProgressLeaseRef.current),
      shelfCount: shelfEntriesRef.current.length,
    });
    const lines = lifecycleDiagnosticsRef.current;
    lines.push(line);
    if (lines.length > 20) lines.splice(0, lines.length - 20);
    if (event === "open_failed") {
      // Read only the cached native diagnostic, through the bounded health
      // gate. Do not delay the failed operation or read/migrate shelf data.
      void progressRuntimeGateRef.current?.check().then((status) => {
        lastNativeRecordsReadRef.current = status.lastRecordsRead ?? null;
        recordLifecycleDiagnostic("native_after_failure", {
          stage: detail.stage, result: "sampled",
          repositoryGeneration: status.repositoryGeneration,
        });
      }).catch(() => undefined);
    }
  }, []);
  /** 指针是否悬停在交互式浮层（脚注弹窗等）上：此时不响应翻页键/后续可扩展书签等 */
  const overlayHoverRef = useRef(false);
  const foregroundRef = useRef<ReaderForeground>({ kind: "none" });
  foregroundRef.current = foreground;

  const {
    menuOpen, fontSettingsOpen, displaySettingsOpen, tocOpen, bookmarkMenuOpen,
    searchOpen, notesOpen, logOpen, assistantOpen, readingSettingsOpen,
    selectionContext, footnote, noteComposer,
  } = readerForegroundSurfaces(foreground);

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
  const bookRef = useRef<Book | null>(book);
  bookRef.current = book;
  const serverRef = useRef<ResourceServer | null>(server);
  serverRef.current = server;
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
        structuralCounts: createChapterCountCollection(generation, b.spine.map((item) => item.linear)),
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
      activeSessionRef.current.structuralCounts = counts;
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
      setSpineIndex(start);
      setAnchor(undefined);
      setInitialPage(saved?.page ?? 0);
      setInitialAnchor(toPersistedReaderAnchor(saved?.anchor));
      // 没有正文/元素/媒体目标（新书、章首、旧页码、固定版式）：按正常开章结算。
      startRestore(generation, spineItemPath(b, start) ?? "", b.fixedLayout || !toPersistedReaderAnchor(saved?.anchor));
      lastStablePositionRef.current = {
        spineIndex: start,
        page: saved?.page ?? 0,
        anchor: toPersistedReaderAnchor(saved?.anchor),
      };
      dispatchReaderSession({ type: "open" });
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

  const { handleImportSources, handleFileInputSources, handleCancelNativeImport, handleToggleNativeImportCollapsed, reimportAndroidMissing, handleChooseBooks } = useBookImport({
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

  const chooseSaveFileDestination = useCallback(async (): Promise<SaveFileLocation | null> => {
    const defaultName = `epub-reader-${new Date().toISOString().slice(0, 10)}.epubsave`;
    if (runtime.platform === "android") {
      const selected = await saveFileDialog({
        title: uiText("notice.archive.exportTitle"),
        defaultPath: defaultName,
      });
      if (typeof selected !== "string" || selected.length === 0) return null;
      return { kind: "uri", uri: selected };
    }
    if (!isTauriEnv()) return null;
    const selected = await saveFileDialog({
      title: uiText("notice.archive.exportTitle"),
      defaultPath: defaultName,
      filters: [{ name: uiText("notice.archive.filter"), extensions: ["epubsave"] }],
    });
    if (typeof selected !== "string" || selected.length === 0) return null;
    return { kind: "path", path: selected };
  }, [runtime.platform]);

  const chooseSaveFileSource = useCallback(async (): Promise<{
    source: SaveFileLocation;
    label: string;
  } | null> => {
    if (runtime.platform === "android") {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: uiText("notice.archive.importTitle"),
      });
      const uri = Array.isArray(selected) ? selected[0] : selected;
      if (typeof uri !== "string" || uri.length === 0) return null;
      return { source: { kind: "uri", uri }, label: uri.split("/").pop() || uiText("notice.archive.androidDocument") };
    }
    if (!isTauriEnv()) return null;
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: uiText("notice.archive.importTitle"),
      filters: [{ name: uiText("notice.archive.filter"), extensions: ["epubsave"] }],
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (typeof path !== "string" || path.length === 0) return null;
    return { source: { kind: "path", path }, label: path.split(/[\\/]/).pop() || path };
  }, [runtime.platform]);

  const resolveNativeExportScope = useCallback(async (
    selectedEntries: ShelfEntry[],
    scopeChoice: "all" | "selected",
  ): Promise<{ scope: SaveExportScope; rangeLabel: string }> => {
    let scope: SaveExportScope;
    let rangeLabel: string;
    if (scopeChoice === "selected") {
      if (selectedEntries.length === 0) {
        const error = new Error("没有选中的书可导出") as Error & { code: string };
        error.code = "empty-selection";
        throw error;
      }
      const resolved: string[] = [];
      try {
        for (const entry of selectedEntries) resolved.push(await resolveContentHashForEntry(entry));
      } catch (error) {
        throw new Error(uiText("notice.archive.hashResolveFailed", { error: saveFileErrorMessage(error) }));
      }
      const bookHashes = [...new Set(resolved)];
      if (bookHashes.length === 0) {
        throw new Error(uiText("notice.archive.noContentHash"));
      }
      scope = { kind: "selected", bookHashes };
      rangeLabel = uiPlural("notice.archive.rangeSelected", bookHashes.length, { count: bookHashes.length });
    } else {
      scope = { kind: "all" };
      rangeLabel = uiText("notice.archive.rangeAll");
    }

    try {
      await activatePortableShelfState();
      persistShelfProgressRef.current(true);
      const laneIds = scopeChoice === "selected"
        ? selectedEntries.map((entry) => entry.id)
        : undefined;
      const results = await progressWriterRef.current?.flushBooks(laneIds) ?? [];
      const failed = results.find((result) => result.status === "failed");
      if (failed?.status === "failed") throw failed.error;
    } catch (error) {
      throw new Error(uiText("notice.archive.progressFlushFailed", { error: saveFileErrorMessage(error) }));
    }
    return { scope, rangeLabel };
  }, [resolveContentHashForEntry]);

  const startNativeExport = useCallback(async (
    selectedEntries: ShelfEntry[],
    scopeChoice: "all" | "selected",
    includeBooks: boolean,
  ): Promise<void> => {
    if (saveFileJob.active || saveFileLaunchRef.current || lanSaveActiveRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.busy") });
      return;
    }
    saveFileLaunchRef.current = true;
    try {
    let destination: SaveFileLocation | null = null;
    try {
      destination = await chooseSaveFileDestination();
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.savePickerFailed", { error: saveFileErrorMessage(error) }) });
      return;
    }
    if (!destination) return;

    let scope: SaveExportScope;
    let rangeLabel: string;
    try {
      const prepared = await resolveNativeExportScope(selectedEntries, scopeChoice);
      scope = prepared.scope;
      rangeLabel = prepared.rangeLabel;
    } catch (error) {
      const emptySelection = saveFileErrorCode(error) === "empty-selection";
      setShelfNotice({
        kind: emptySelection ? "warn" : "error",
        text: emptySelection ? uiText("notice.archive.emptySelection") : saveFileErrorMessage(error),
      });
      return;
    }

    try {
      const result = await saveFileJob.beginExport({ destination, scope, includeBooks });
      if (result.status === "cancelled") {
        setShelfNotice({ kind: "warn", text: uiText("notice.archive.exportCancelled") });
        return;
      }
      if (result.skippedBooks.length > 0) {
        const first = result.skippedBooks[0];
        setShelfNotice({
          kind: "warn",
          text: uiText("notice.archive.exportedSkipped", { range: rangeLabel, written: result.writtenBooks, skipped: result.skippedBooks.length, title: first.title, reason: first.reason }),
        });
      } else {
        setShelfNotice({
          kind: "ok",
          text: includeBooks ? uiText("notice.archive.exportedWithBooks", { range: rangeLabel, written: result.writtenBooks }) : uiText("notice.archive.exportedNoBooks", { range: rangeLabel }),
        });
      }
    } catch (error) {
      if (saveFileErrorCode(error) === "cancelled") {
        setShelfNotice({ kind: "warn", text: uiText("notice.archive.exportCancelled") });
        return;
      }
      setShelfNotice({ kind: "error", text: uiText("notice.archive.exportFailed", { error: saveFileErrorMessage(error) }) });
    }
    } finally {
      saveFileLaunchRef.current = false;
    }
  }, [chooseSaveFileDestination, resolveNativeExportScope, saveFileJob]);

  /** SBE-U: copy the shelf's original EPUB files out; one book saves as .epub, several or all as one .zip. */
  const startBookSourceExport = useCallback(async (selectedEntries?: ShelfEntry[]): Promise<void> => {
    if (saveFileJob.active || saveFileLaunchRef.current || lanSaveActiveRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.busy") });
      return;
    }
    if (selectedEntries && selectedEntries.length === 0) return;
    saveFileLaunchRef.current = true;
    try {
      let scope: SaveExportScope = { kind: "all" };
      let single: ShelfEntry | null = null;
      if (selectedEntries) {
        let hashes: string[];
        try {
          hashes = [...new Set(await Promise.all(selectedEntries.map((entry) => resolveContentHashForEntry(entry))))];
        } catch (error) {
          setShelfNotice({ kind: "error", text: uiText("bookExport.failed", { error: saveFileErrorMessage(error) }) });
          return;
        }
        scope = { kind: "selected", bookHashes: hashes };
        if (hashes.length === 1) single = selectedEntries[0];
      }
      const zip = single === null;
      const defaultPath = zip
        ? `epub-reader-books-${new Date().toISOString().slice(0, 10)}.zip`
        : bookExportFileName(single!.fileName, single!.title);
      let destination: SaveFileLocation | null = null;
      try {
        // Fail before ACTION_CREATE_DOCUMENT can create an external file.
        await activatePortableShelfState();
      } catch (error) {
        setShelfNotice(bookExportErrorNotice(error as BookSourceExportError));
        return;
      }
      try {
        const selected = await saveFileDialog({
          title: uiText("bookExport.dialogTitle"),
          defaultPath,
          filters: [zip
            ? { name: uiText("bookExport.filter.zip"), extensions: [runtime.platform === "android" ? "application/zip" : "zip"] }
            : { name: uiText("bookExport.filter.epub"), extensions: [runtime.platform === "android" ? "application/epub+zip" : "epub"] }],
        });
        if (typeof selected === "string" && selected.length > 0) {
          destination = runtime.platform === "android" ? { kind: "uri", uri: selected } : { kind: "path", path: selected };
        }
      } catch (error) {
        setShelfNotice({ kind: "error", text: uiText("notice.archive.savePickerFailed", { error: saveFileErrorMessage(error) }) });
        return;
      }
      if (!destination) return;
      try {
        // Android's pinned dialog plugin uses ACTION_CREATE_DOCUMENT; a Windows
        // save path may name an existing target and must never be cleaned as new.
        const result = await saveFileJob.beginBookExport({ destination, scope, destinationIsNew: runtime.platform === "android" });
        setShelfNotice(bookExportResultNotice(result, bookExportTargetLabel(destination)));
      } catch (error) {
        setShelfNotice(bookExportErrorNotice(error as BookSourceExportError));
      }
    } finally {
      saveFileLaunchRef.current = false;
    }
  }, [resolveContentHashForEntry, runtime.platform, saveFileJob]);

  const startNativeImport = useCallback(async (): Promise<void> => {
    if (saveFileJob.active || saveFileLaunchRef.current || lanSaveActiveRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.busy") });
      return;
    }
    saveFileLaunchRef.current = true;
    try {
    let selected: { source: SaveFileLocation; label: string } | null = null;
    try {
      selected = await chooseSaveFileSource();
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.openPickerFailed", { error: saveFileErrorMessage(error) }) });
      return;
    }
    if (!selected) return;
    try {
      await activatePortableShelfState();
      await saveFileJob.beginPrepare({ source: selected.source, sourceLabel: selected.label });
    } catch (error) {
      const code = saveFileErrorCode(error);
      if (code === "cancelled") {
        setShelfNotice({ kind: "warn", text: uiText("notice.archive.importCancelled") });
        return;
      }
      setShelfNotice({ kind: "error", text: uiText("notice.archive.prepareFailed", { error: saveFileErrorMessage(error) }) });
    }
    } finally {
      saveFileLaunchRef.current = false;
    }
  }, [chooseSaveFileSource, saveFileJob]);

  const prepareLanSaveSend = useCallback(async (
    scopeChoice: "all" | "selected",
    _includeBooks: boolean,
  ): Promise<SaveExportScope> => {
    if (saveFileJob.active || saveFileLaunchRef.current) {
      throw new Error("已有存档文件任务正在进行，请等待当前任务结束");
    }
    if (nativeImportRef.current) {
      throw new Error("正在导入书籍，暂不开始设备互传");
    }
    const prepared = await resolveNativeExportScope(lanSaveSelectionRef.current, scopeChoice);
    return prepared.scope;
  }, [resolveNativeExportScope, saveFileJob.active]);

  const applySaveFileCommitResult = useCallback(async (
    result: SaveFileCommitResult,
    applyPreferences: boolean,
  ): Promise<void> => {
    let refreshFailed = false;
    try {
      await refreshShelfProjection();
    } catch (error) {
      refreshFailed = true;
      setShelfError(uiText("notice.archive.committedRefreshFailed", { error: saveFileErrorMessage(error) }));
    }

    let preferencesFailed = false;
    let preferencesApplied = false;
    if (applyPreferences && result.appliedPreferences) {
      try {
        const preferences = await readPortablePreferencesSnapshot();
        preferencesApplied = applyPortablePreferences(preferences);
      } catch (error) {
        preferencesFailed = true;
        setShelfNotice({
          kind: "warn",
          text: uiText("notice.archive.preferencesReadFailed", { error: saveFileErrorMessage(error) }),
        });
      }
    }

    if (preferencesFailed) return;
    const conflictNote = result.progressConflictBooks.length > 0
      ? uiText("notice.sep") + uiText("notice.archive.conflicts", { count: result.progressConflictBooks.length })
      : "";
    const preferenceNote = applyPreferences && !result.appliedPreferences
      ? uiText("notice.sep") + uiText("notice.archive.preferencesNotApplied")
      : preferencesApplied
        ? uiText("notice.sep") + uiText("notice.archive.preferencesApplied")
        : "";
    const skippedNote = importSkippedNotice(result.skippedBookCount, result.skippedBooks);
    setShelfNotice({
      kind: skippedNote || refreshFailed || (applyPreferences && !result.appliedPreferences) ? "warn" : "ok",
      text: uiText("notice.archive.imported", { imported: result.importedBooks.length }) + (skippedNote ? uiText("notice.sep") + skippedNote : "") + conflictNote + preferenceNote + (refreshFailed ? uiText("notice.sep") + uiText("notice.shelf.refreshFailedShort") : ""),
    });
  }, [applyPortablePreferences, refreshShelfProjection]);

  const lanSaveSession = useLanSaveSession({
    prepareSend: prepareLanSaveSend,
    onImportCommitted: applySaveFileCommitResult,
  });
  lanSaveActiveRef.current = lanSaveSession.active;

  const handleSaveFileImportConfirm = useCallback(async (applyPreferences: boolean): Promise<void> => {
    if (saveFileJobStateRef.current.kind !== "prepared") return;
    try {
      const result = await saveFileJob.commit(applyPreferences);
      await applySaveFileCommitResult(result, applyPreferences);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.importFailed", { error: saveFileErrorMessage(error) }) });
    }
  }, [applySaveFileCommitResult, saveFileJob]);

  const handleOpenLanSave = useCallback((selectedEntries?: ShelfEntry[]): void => {
    if (lanSaveActiveRef.current) { setLanSaveOpen(true); return; }
    if (saveFileJobStateRef.current.kind !== "idle" || saveFileLaunchRef.current || nativeImportRef.current) return;
    const selection = selectedEntries ?? [];
    lanSaveSelectionRef.current = selection;
    setLanSaveSelection(selection);
    setLanSaveOpen(true);
  }, []);

  const closeLanSavePanel = useCallback((): void => {
    setLanSaveOpen(false);
    void lanSaveSession.close();
  }, [lanSaveSession]);

  const closeSaveFileUi = useCallback(async (): Promise<void> => {
    setSaveFileExportSetup(null);
    const current = saveFileJobStateRef.current;
    if (current.kind === "idle" || current.kind === "committing") return;
    try {
      await saveFileJob.cancelCurrent();
    } catch (error) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.cancelFailed", { error: saveFileErrorMessage(error) }) });
    }
  }, [saveFileJob]);

  const handleSaveFileExportConfirm = useCallback(async (
    scope: "all" | "selected",
    includeBooks: boolean,
  ): Promise<void> => {
    const setup = saveFileExportSetup;
    setSaveFileExportSetup(null);
    if (!setup) return;
    await startNativeExport(setup.selectedEntries, scope, includeBooks);
  }, [saveFileExportSetup, startNativeExport]);

  const handleLegacyExportArchive = useCallback(async () => {
    if (organizationBusyRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.savingOrganization") });
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
          title: uiText("notice.legacy.exportTitle"),
          defaultPath: `epub-reader-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: uiText("notice.archive.filter"), extensions: ["application/json", "json"] }],
        });
        if (!uri || Array.isArray(uri)) return;
        await writeTextContentUri(uri, text);
      } else if (isTauriEnv()) {
        const path = await saveFileDialog({
          title: uiText("notice.legacy.exportTitle"),
          defaultPath: `epub-reader-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: uiText("notice.archive.filter"), extensions: ["json"] }],
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
        text: uiText("notice.legacy.exported", { count: Object.keys(built.archive.records).length }),
      });
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.exportFailed", { error: String(error) }) });
    }
  }, [settings, uiScale]);

  const handleLegacyImportArchive = useCallback(async () => {
    if (shelfBusyRef.current || organizationBusyRef.current) return;
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.legacy.importBlocked") });
      return;
    }
    shelfBusyRef.current = true;
    organizationBusyRef.current = true;
    setShelfBusyMessage(uiText("notice.legacy.importing"));
    setShelfBusy(true);
    try {
      let text: string | null = null;
      if (runtime.platform === "android") {
        const selected = await openFileDialog({
          multiple: false,
          directory: false,
          title: uiText("notice.legacy.importTitle"),
        });
        const uri = Array.isArray(selected) ? selected[0] : selected;
        if (uri) {
          text = await readContentUriText(uri, 16 * 1024 * 1024);
        }
      } else if (isTauriEnv()) {
        const path = await openFileDialog({
          multiple: false,
          directory: false,
          title: uiText("notice.legacy.importTitle"),
          filters: [{ name: uiText("notice.archive.filter"), extensions: ["json"] }],
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
              setShelfNotice({ kind: "error", text: uiText("notice.legacy.tooLarge") });
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
      let skippedCount = 0;
      let skippedNote = "";
      try {
        const store = getShelfStore();
        const imported = await store.replacePortableRecords(
          archiveRecordsForBackend(incoming.archive),
          incoming.archive.organization,
        );
        const nextEntries = imported.entries;
        unavailableCount = nextEntries.filter((entry) => entry.available === false).length;
        skippedCount = Math.max(imported.skippedBookCount, imported.skippedBooks.length);
        skippedNote = importSkippedNotice(imported.skippedBookCount, imported.skippedBooks);
        setShelfEntries(nextEntries);
        setOrganization(await store.getOrganization());
      } catch (err) {
        throw new Error(`书籍记录与组织导入失败：${String(err)}`);
      }

      setShelfNotice({
        kind: unavailableCount > 0 || skippedNote ? "warn" : "ok",
        text: uiText("notice.legacy.imported", { count: Math.max(0, Object.keys(incoming.archive.records).length - skippedCount) }) + (skippedNote ? uiText("notice.sep") + skippedNote : "") + (unavailableCount > 0 ? uiText("notice.sep") + uiText("notice.legacy.relocate", { count: unavailableCount }) : "") + uiText("notice.sep") + uiText("notice.legacy.preferencesNotApplied"),
      });
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.importFailed", { error: String(error) }) });
    } finally {
      shelfBusyRef.current = false;
      organizationBusyRef.current = false;
      setShelfBusy(false);
    }
  }, [settings, uiScale]);

  const handleExportArchive = useCallback((selectedEntries?: ShelfEntry[]): void => {
    if (runtime.platform === "web" || !isTauriEnv()) {
      void handleLegacyExportArchive();
      return;
    }
    if (saveFileJob.active) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archiveFile.busy") });
      return;
    }
    setSaveFileExportSetup({ selectedEntries: selectedEntries ?? [] });
  }, [handleLegacyExportArchive, runtime.platform, saveFileJob.active]);

  const handleImportArchive = useCallback((): void => {
    if (runtime.platform === "web" || !isTauriEnv()) {
      void handleLegacyImportArchive();
      return;
    }
    void startNativeImport();
  }, [handleLegacyImportArchive, runtime.platform, startNativeImport]);

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
            text: error instanceof LibraryDatabaseBlockedError
              ? error.message
              : uiText("notice.portable.inactive", { error: String(error) }),
          });
        }
      }
      // Activation may change the repository instance behind the facade, so
      // the first real open must not reuse a pre-activation cached check.
      progressRuntimeGateRef.current?.invalidate();
      if (cancelled) return;
      void libraryReader.load();
      void organizationReader.load();
    })();

    return () => {
      cancelled = true;
      libraryReader.invalidate();
      organizationReader.invalidate();
    };
  }, [libraryReader, organizationReader]);

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
    settingsActions.selectImportedFont({ id, family: entry.family });
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
      setShelfNotice({ kind: "error", text: uiText("notice.font.busy") });
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
          ? uiText("notice.font.importedIgnored", { imported: result.imported, ignored: result.unsupported })
          : uiText("notice.font.ignoredOnly", { ignored: result.unsupported }),
      });
      return;
    }
    if (result.message) setShelfNotice({ kind: "ok", text: result.message });
  }, []);

  const handleImportFontPaths = useCallback(async (paths: string[]) => {
    const result = await fontImportRef.current!.importPaths(paths);
    if (result.kind === "busy") {
      setShelfNotice({ kind: "error", text: uiText("notice.font.busy") });
      return;
    }
    if (result.kind === "error") {
      setShelfNotice({ kind: "error", text: result.message });
      return;
    }
    const entry = result.entry;
    if (entry) {
      setUserFonts((prev) => [entry, ...prev.filter((f) => f.id !== entry.id)]);
      settingsActions.selectImportedFont(entry);
    }
    if (result.unsupported > 0) {
      setShelfNotice({
        kind: "error",
        text: result.imported > 0
          ? uiText("notice.font.importedIgnored", { imported: result.imported, ignored: result.unsupported })
          : uiText("notice.font.ignoredOnly", { ignored: result.unsupported }),
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
        setShelfNotice({ kind: "error", text: uiText("notice.font.deleteFailed", { error: String(e) }) });
      } finally {
        setFontBusy(false);
      }
    },
    [fontUrls, userFonts, settings.customFontId]
  );

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

  useEffect(() => {
    if (!runtime.supportsReaderSystemStatusBar) return;
    void readerSystemBars.requestHidden(shouldHideReaderSystemStatusBar({
      supported: true, readerActive: view === "reader", hideWhileReading: hideReaderSystemStatusBar,
    })).catch((error) => {
      const message = uiText("notice.statusBar.failed", { error: String(error) });
      if (view === "reader") showReaderNotice(message, "warn");
      else setShelfNotice({ kind: "warn", text: message });
    });
    // The app root owns the intent. Reader/menu cleanup must never submit a stale false.
  }, [view, hideReaderSystemStatusBar, runtime.supportsReaderSystemStatusBar, readerSystemBars, showReaderNotice]);

  useEffect(() => {
    if (!runtime.supportsReaderSystemStatusBar) return;
    void statusBarAppearance.requestTheme(settings.theme).catch((error) => {
      const message = uiText("notice.statusBar.failed", { error: String(error) });
      if (view === "reader") showReaderNotice(message, "warn");
      else setShelfNotice({ kind: "warn", text: message });
    });
  }, [settings.theme, view, runtime.supportsReaderSystemStatusBar, statusBarAppearance, showReaderNotice]);

  useEffect(() => {
    if (!runtime.supportsReaderKeepScreenOn) return;
    // Re-subscribed whenever route/preference change, so the listener never reads stale state.
    const submit = (force: boolean) => {
      void readerScreenOn.requestEnabled(shouldKeepReaderScreenOn({
        readerActive: view === "reader",
        keepWhileReading: keepScreenOnWhileReading,
        visible: document.visibilityState !== "hidden",
      }), force).catch((error) => {
        const message = uiText("notice.keepScreenOn.failed", { error: String(error) });
        if (view === "reader") showReaderNotice(message, "warn");
        else setShelfNotice({ kind: "warn", text: message });
      });
    };
    submit(false);
    // Native already clears the flag in the background; returning resubmits the current intent.
    const onVisibilityChange = () => submit(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [view, keepScreenOnWhileReading, runtime.supportsReaderKeepScreenOn, readerScreenOn, showReaderNotice]);
  useEffect(() => {
    if (!runtime.supportsReaderKeepScreenOn) return;
    // Root teardown goes through the same serializer; no second invoke chain.
    return () => { void readerScreenOn.requestEnabled(false).catch(() => {}); };
  }, [runtime.supportsReaderKeepScreenOn, readerScreenOn]);

  /** 语义锚点失败：解除显示门，但守住进度，直到读者真实移动后再写。 */
  const handleReaderNavigationUnresolved = useCallback((reported: boolean, ticket?: RestoreTicket | null): void => {
    if (ticket) {
      dispatchRestoreGate({ type: "resolved", ticket, located: false });
      dispatchRestoreGate({ type: "display-ready", ticket });
    }
    dispatchReaderSession({ type: "navigation-unresolved" });
    setSearchNavigationBusy(false);
    setInitialAnchor(null);
    setInitialPage(0);
    // The gate may remain unresolved until a real user commit; keep the
    // source ticket alive for that later callback. Explicit navigation
    // clears it separately via releaseRestoreForExplicitNavigation.
    if (!restoreGateRef.current) setInitialRestoreTicket(null);
    setInitialAlignment("context");
    if (!reported) showReaderNotice(uiText("notice.reader.positionNotFound"), "warn");
  }, [showReaderNotice, dispatchRestoreGate]);

  /** 分页视图的首次恢复结果；预加载与过期章节已在视图内/此处过滤。 */
  const handleReaderRestoreResult = useCallback((result: {
    chapterPath: string;
    located: boolean;
    ticket: RestoreTicket | null;
  }): void => {
    const ticket = result.ticket;
    if (!ticket || !restoreResultMatches(ticket, result.chapterPath)) return;
    const resolving = restoreGateRef.current?.phase === "resolving";
    dispatchRestoreGate({ type: "resolved", ticket, located: result.located });
    if (resolving && !result.located) {
      showReaderNotice(uiText("notice.reader.positionNotFoundKept"), "warn");
    }
  }, [dispatchRestoreGate, restoreResultMatches, showReaderNotice]);

  const handlePreciseNavigationStatus = useCallback((status: {
    requestId: number;
    status: PreciseNavigationStatus;
    exact: boolean;
  }): void => {
    if (latestPreciseRequestRef.current !== status.requestId) return;
    latestPreciseRequestRef.current = null;
    setPreciseTarget(null);
    if (status.status === "unresolved") {
      showReaderNotice(uiText("notice.reader.sourceNotFoundNote"), "warn");
    } else if (status.status === "located-reference") {
      showReaderNotice(uiText("notice.reader.paragraphOnly"), "warn");
    } else if (status.status === "unsupported-highlight") {
      showReaderNotice(uiText("notice.reader.noHighlight"), "warn");
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
      const cardEntry = shelfEntriesRef.current.find((e) => e.id === id);
      if (!cardEntry) return;
      // Acquire the single-operation guard before the first await, including
      // readiness recovery and any user position-choice dialog.
      shelfBusyRef.current = true;
      setShelfBusyMessage(uiText("notice.open.opening"));
      setShelfBusy(true);
      let preparationStage = "check";
      const store = getShelfStore();
      const writer = progressWriterRef.current!;
      try {
      // A real health response, not an event or cached promise, gates opening.
      // Check the first read too; recover only after an explicit not-ready result.
      try {
        await ensureProgressRuntimeReady();
      } catch (error) {
        recordLifecycleDiagnostic("open_failed", {
          stage: "check",
          result: "failed",
          errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
        });
        setShelfNotice({ kind: "error", text: bookOpenErrorMessage(error) });
        return;
      }
      persistShelfProgressRef.current(true);
      const previousLease = activeProgressLeaseRef.current;
      const targetLane = writer.current(id);
      const openPlan = await planFreshProgressOpen({
        flushTarget: async () => {
          preparationStage = "flush";
          return targetLane ? writer.flush(targetLane) : null;
        },
        readCurrent: async () => {
          preparationStage = "read-current";
          if (store.readProgressEntryForOpen) return store.readProgressEntryForOpen(id);
          const entries = await store.list();
          const entry = entries.find((item) => item.id === id);
          if (!entry) throw Object.assign(new Error("书架中没有这本书"), {
            code: "shelf-record-missing", recordsCount: entries.length, targetFound: false,
          });
          return entry;
        },
        choose: async (originalEntry) => {
          preparationStage = "choose";
          // B3: bind a specific progress version even when there is only one
          // candidate. The same selection is adopted against the repository read
          // before the EPUB is parsed.
          let chosenProgressVersion: Version<ProgressValue> | null = null;
          let progressSelection: PortableProgressSelection | null = null;
          let checkpointAckPending: LocalProgressCheckpoint<ShelfProgressPatch> | null = null;
          let checkpointPatchToRestore: LocalProgressCheckpoint<ShelfProgressPatch> | null = null;
          let explicitPositionChoice = false;
          const progressVersions = portableProgressVersions(originalEntry);
          const checkpointBookHash = originalEntry.contentHash ?? id;
          let checkpointForOpen: LocalProgressCheckpoint<ShelfProgressPatch> | null = null;
          try {
            checkpointForOpen = localCheckpointsRef.current?.peek(checkpointBookHash) ?? null;
          } catch (error) {
            setShelfNotice({ kind: "warn", text: uiText("notice.open.checkpointReadFailed", { error: String(error) }) });
          }
          if (checkpointForOpen) {
            const plan = planCheckpointOpen(checkpointForOpen, progressVersions, sameCheckpointPatchValue);
            if (plan.kind === "use-saved") {
              chosenProgressVersion = plan.version;
              progressSelection = { kind: "chosen", stamp: plan.version.stamp };
              checkpointAckPending = checkpointForOpen;
            } else if (plan.kind === "restore-local") {
              // The displayed basis remains valid, but the local sample still has
              // to be written through that basis before the checkpoint can be acked.
              checkpointPatchToRestore = plan.checkpoint;
              chosenProgressVersion = plan.basis;
              progressSelection = plan.basis
                ? { kind: "chosen", stamp: plan.basis.stamp }
                : { kind: "empty" };
            } else {
              const latest = latestVersion(progressVersions);
              const choice = await new Promise<"local" | "synced" | null>((resolve) => {
                localCheckpointResolverRef.current = resolve;
                setLocalCheckpointConflict({ title: originalEntry.title, hasSynced: progressVersions.length > 0 });
              });
              localCheckpointResolverRef.current = null;
              setLocalCheckpointConflict(null);
              if (!choice) return null;
              explicitPositionChoice = true;
              if (choice === "local") {
                checkpointPatchToRestore = checkpointForOpen;
                chosenProgressVersion = latest;
                progressSelection = latest
                  ? { kind: "chosen", stamp: latest.stamp }
                  : { kind: "empty" };
              } else {
                setShelfNotice({
                  kind: "warn",
                  text: uiText("notice.open.syncedPosition"),
                });
              }
            }
          }
          if (!progressSelection) {
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
              if (!selectedStamp) return null;
              chosenProgressVersion = versionForStamp(progressVersions, selectedStamp);
              if (!chosenProgressVersion) {
                setShelfNotice({ kind: "error", text: uiText("notice.open.versionGone") });
                return null;
              }
              explicitPositionChoice = true;
              progressSelection = { kind: "chosen", stamp: selectedStamp };
            } else if (progressVersions.length === 1) {
              chosenProgressVersion = progressVersions[0];
              progressSelection = { kind: "chosen", stamp: progressVersions[0].stamp };
            } else {
              progressSelection = { kind: "empty" };
            }
          }
          return { chosenProgressVersion, progressSelection, checkpointAckPending,
            checkpointPatchToRestore, explicitPositionChoice };
        },
      });
      if (!openPlan) return;
      const originalEntry = openPlan.entry;
      const { chosenProgressVersion, progressSelection, checkpointAckPending,
        checkpointPatchToRestore } = openPlan.decision;
      if (!progressSelection) return;
      shelfBusyRef.current = true;
      setShelfBusyMessage(uiText("notice.open.opening"));
      setShelfBusy(true);
      setShelfError(null);
      if (searchTarget) setSearchNavigationBusy(true);
      setPhase({
        phase: "loading",
        fileName: originalEntry.fileName,
        title: originalEntry.title,
        creator: originalEntry.creator,
      });
      let preciseRequestId: number | null = null;
      let unownedBook: Book | null = null;
      let unownedArchive: ArchiveClient | null = null;
      let candidateLease: ProgressLease | null = null;
      let candidateActivated = false;
      const targetSavedLease = openPlan.targetSave?.status === "saved" ? targetLane : null;
      const targetHandoffLease = openPlan.targetSave?.status === "failed" ? targetLane : null;
      let previousSavedLease: ProgressLease | null = null;
      let openStage: "check" | "flush" | "readSource" | "openArchive" | "begin" | "parse" | "publish" = "check";
      try {
        openStage = "flush";
        // A different paused book may be flushed opportunistically; failure
        // keeps its lane/lease/checkpoint and does not abort this open.
        if (previousLease && previousLease !== targetLane && previousLease.bookId !== id) {
          const saved = await writer!.flush(previousLease);
          if (saved.status === "saved") {
            previousSavedLease = previousLease;
          } else {
            setShelfNotice({
              kind: "warn",
              text: uiText("notice.open.previousUnsaved"),
            });
          }
        }
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
              title: uiText("notice.open.relocateTitle", { title: entry.title }),
              filters: [{ name: uiText("notice.picker.epubFilter"), extensions: ["epub"] }],
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
        const openArchive = runtime.platform === "android"
          ? store.openArchive?.bind(store)
          : undefined;
        const chosenProjection = chosenProgressVersion
          ? projectProgressVersion(chosenProgressVersion)
          : null;
        const initialSpineIndex = searchTarget
          ? searchTarget.spineIndex
          : (chosenProjection?.spineIndex ?? entry.spineIndex ?? 0);
        let b: Book;
        if (openArchive) {
          openStage = "openArchive";
          const archive = await openArchive(id).catch((error) => {
            if (describeBookOpenFailure(error).sourceUnavailable) {
              setShelfEntries((prev) =>
                prev.map((item) => (item.id === id ? { ...item, available: false } : item))
              );
            }
            throw error;
          });
          unownedArchive = archive;
          openStage = "begin";
          // B3: prepare, but do not publish, the selected progress candidate.
          candidateLease = store.prepareProgressSession
            ? await store.prepareProgressSession(id, progressSelection)
            : null;
          if (!candidateLease && store.beginProgressSession) {
            await store.beginProgressSession(id, progressSelection);
          }
          b = await loadBookFromArchive(archive, { initialSpineIndex });
          unownedArchive = null;
          openStage = "parse";
        } else {
          openStage = "readSource";
          let buf: Uint8Array;
          try {
            buf = await store.readBook(id);
          } catch (error) {
            if (describeBookOpenFailure(error).sourceUnavailable) {
              setShelfEntries((prev) =>
                prev.map((item) => (item.id === id ? { ...item, available: false } : item))
              );
            }
            throw error;
          }
          // Legacy browser shelf IDs may be UUIDs; index identity always comes from EPUB bytes.
          if (IS_AI_EDITION && !isTauriEnv() && !/^[a-f0-9]{64}$/.test(entry.contentHash ?? "")) {
            entry = await store.setContentHash(id, await sha256Hex(buf));
            setShelfEntries((prev) => prev.map((item) => item.id === id ? entry : item));
          }
          openStage = "begin";
          // B3: prepare, but do not publish, the selected progress candidate.
          candidateLease = store.prepareProgressSession
            ? await store.prepareProgressSession(id, progressSelection)
            : null;
          if (!candidateLease && store.beginProgressSession) {
            await store.beginProgressSession(id, progressSelection);
          }
          openStage = "parse";
          b = await loadBook(buf, { selective: true, initialSpineIndex });
        }
        // 在 openParsedBook 正式接管前，Book 仍由本函数负责释放；
        // 后面的空 spine / 进度解析 / 目标校验等任何失败路径都不能漏掉。
        unownedBook = b;
        if (b.spine.length === 0) {
          throw new Error("这本书没有可阅读的内容");
        }
        const srv = new ResourceServer(b);
        let saved: SavedProgress;
        if (searchTarget) {
          let targetIndex = searchTarget.spineIndex;
          if (spineItemPath(b, targetIndex) !== searchTarget.chapterPath) {
            targetIndex = spineIndexForEntryKey(b, searchTarget.chapterPath);
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
        } else if (checkpointPatchToRestore) {
          const patch = checkpointPatchToRestore.patch;
          const patchEntry = {
            ...entry,
            spineIndex: patch.spineIndex,
            page: patch.page,
            anchorIndex: patch.anchorIndex,
            anchorRatio: patch.anchorRatio,
            anchorTextOffset: patch.anchorTextOffset,
            anchorTextSnippet: patch.anchorTextSnippet,
            mediaAnchor: patch.mediaAnchor ?? null,
          } as ShelfEntry;
          const patchValue = progressValueFromPatch(patch);
          saved = patchValue
            ? savedProgressFromPortableLocator(b, patchValue.locator, legacySavedProgress(patchEntry))
            : legacySavedProgress(patchEntry);
        } else if (chosenProgressVersion) {
          saved = savedProgressFromVersion(b, chosenProgressVersion);
        } else {
          saved = savedProgressFromShelfEntry(b, entry);
        }
        openStage = "publish";
        // Takeover: the parsed candidate is now published and its exact lease
        // owns the writer lane. Old saved lanes are retired only now; failures
        // before this point leave the previous reader/session intact.
        if (candidateLease) {
          if (targetHandoffLease) {
            const checkpoints = localCheckpointsRef.current;
            if (!checkpoints) throw new Error("本机进度检查点不可用");
            const handoffHash = store.progressSessionBookHash?.(targetHandoffLease) ?? (entry.contentHash ?? id);
            const handoffStamp = store.progressSessionChosenStamp?.(targetHandoffLease) ?? null;
            writer!.handoffToCheckpoint(targetHandoffLease, (sample) => {
              // retain must durably stage before removing the old lane. Do not
              // acknowledge or clear the old checkpoint here.
              stageCheckpointSample(checkpoints, handoffHash, handoffStamp, sample.patch);
            });
            await store.closeProgressLease?.(targetHandoffLease);
            if (activeProgressLeaseRef.current === targetHandoffLease) {
              activeProgressLeaseRef.current = null;
            }
          }
          if (targetSavedLease) {
            writer!.retire(targetSavedLease);
            await store.closeProgressLease?.(targetSavedLease);
            if (activeProgressLeaseRef.current === targetSavedLease) {
              activeProgressLeaseRef.current = null;
            }
          }
          if (previousSavedLease) {
            writer!.retire(previousSavedLease);
            await store.closeProgressLease?.(previousSavedLease);
            if (activeProgressLeaseRef.current === previousSavedLease) {
              activeProgressLeaseRef.current = null;
            }
          }
          store.activateProgressSession?.(candidateLease);
          const sessionBookHash = store.progressSessionBookHash?.(candidateLease) ?? (entry.contentHash ?? id);
          const leaseForWriter = candidateLease;
          progressWriterRef.current?.register(leaseForWriter, async (sample) => {
            try {
              const checkpoints = localCheckpointsRef.current;
              if (!checkpoints) throw new Error("本机进度检查点不可用");
              const saved = await persistCheckpointSample(
                checkpoints,
                sessionBookHash,
                sample,
                async (patch) => {
                  const result = await store.updateProgressForSession?.(leaseForWriter, patch);
                  if (!result) throw new Error("当前后端不支持精确进度会话写入");
                  return result;
                },
              );
              setShelfEntries((prev) =>
                prev.map((item) => item.id === id ? mergeProgressProjection(item, saved.entry) : item)
              );
            } catch (error) {
              if (!firstSampleFailureRecordedRef.current) {
                firstSampleFailureRecordedRef.current = true;
                recordLifecycleDiagnostic("sample_failed", {
                  stage: "flush",
                  result: "failed",
                  candidate: true,
                  repositoryGeneration: store.progressSessionRepositoryGeneration?.(leaseForWriter),
                  errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
                });
              }
              throw error;
            }
          });
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
          openingBaselinePct(
            checkpointPatchToRestore?.patch ?? null,
            chosenProgressVersion ? projectProgressVersion(chosenProgressVersion).value?.progressPctHint : undefined,
            chosenProgressVersion !== null,
            entry.progressPct,
          ),
        );
        if (candidateLease) {
          activeProgressLeaseRef.current = candidateLease;
          candidateActivated = true;
          if (checkpointPatchToRestore) {
            // Explicit local conflict resolution: stage/write the retained local
            // position through the newly published exact session.
            const checkpoints = localCheckpointsRef.current;
            const restoreBookHash = store.progressSessionBookHash?.(candidateLease) ?? (entry.contentHash ?? id);
            if (checkpoints) {
              const shownStamp = store.progressSessionChosenStamp?.(candidateLease) ?? null;
              const sample = stageCheckpointSample(
                checkpoints,
                restoreBookHash,
                shownStamp,
                checkpointPatchToRestore.patch,
              );
              progressWriterRef.current?.enqueue(candidateLease, sample);
            }
          }
        }
        if (checkpointAckPending) {
          try {
            localCheckpointsRef.current?.acknowledge(checkpointAckPending.bookHash, checkpointAckPending.checkpointId);
          } catch {
            /* 保留记录，下一次打开继续核对。 */
          }
        }
        unownedBook = null;
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
        const failure = describeBookOpenFailure(e);
        recordLifecycleDiagnostic("open_failed", {
          stage: openStage,
          result: "failed",
          candidate: candidateLease !== null,
          repositoryGeneration: candidateLease
            ? store.progressSessionRepositoryGeneration?.(candidateLease)
            : undefined,
          errorCode: (e as { readonly code?: unknown } | null)?.code as string | undefined,
        });
        if (activeSessionRef.current && activeProgressLeaseRef.current) {
          // A failed second-open must not replace the still-valid old reader
          // with the loading/error body.
          setPhase({ phase: "ready" });
          showReaderNotice(uiText("notice.open.failed", { error: failure.message }), "error");
        } else {
          setShelfError(uiText("notice.open.failed", { error: failure.message }));
          setPhase({ phase: "error", message: failure.message });
        }
        setSearchNavigationBusy(false);
      } finally {
        // Close only the candidate acquired by this operation. This covers
        // throw, empty-spine return and cancel before publication.
        if (candidateLease && !candidateActivated) {
          try {
            progressWriterRef.current?.retire(candidateLease);
          } catch {
            /* Not registered yet, or no writer lane remains. */
          }
          await store.closeProgressLease?.(candidateLease).catch(() => undefined);
          if (activeProgressLeaseRef.current === candidateLease) {
            activeProgressLeaseRef.current = null;
          }
        }
        // 进度初始化可能在 loader 接管前失败，此时由开书入口关闭原生归档。
        unownedArchive?.close();
        // openParsedBook 返回后所有权已归 App 会话；若它在中途抛错但已写入
        // activeSessionRef，则不再抢占销毁，避免把正在阅读的 Book 释放掉。
        if (unownedBook && activeSessionRef.current?.book !== unownedBook) {
          disposeBook(unownedBook);
        }
      }
      } catch (error) {
        const detail = error as { code?: string; recordsCount?: number; targetFound?: boolean };
        recordLifecycleDiagnostic("open_failed", {
          stage: preparationStage, result: "failed", errorCode: detail?.code,
          count: detail?.recordsCount, targetFound: detail?.targetFound,
        });
        setShelfNotice({ kind: "error", text: uiText("notice.open.failed", { error: describeBookOpenFailure(error).message }) });
      } finally {
        shelfBusyRef.current = false;
        setShelfBusy(false);
      }
    },
    [openParsedBook, reimportAndroidMissing, recordLifecycleDiagnostic, showReaderNotice, ensureProgressRuntimeReady]
  );

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

  // ---- 章节状态回调 ----
  const handleUserReadingPositionChange = useCallback((ticket?: RestoreTicket | null) => {
    // 只有宿主实际用户位移才解除失败保护，重排和采样变化不能代替用户输入。
    dispatchReaderSession({ type: "user-position-committed" });
    setReturnPromptShown(false);
    if (ticket) {
      dispatchRestoreGate({ type: "user-position-committed", ticket });
      // A matching user commit normally clears the gate. If it did not match
      // (stale callback), keep whatever ticket the live gate still owns.
      if (!restoreGateRef.current) setInitialRestoreTicket(null);
    }
  }, [dispatchRestoreGate]);

  const onPageState = useCallback((s: ChapterState) => {
    chapterStateRef.current = s;
    setChapterState(s);
    if (s.status === "error") {
      const failedSeek = pendingChapterSeekRef.current;
      pendingChapterSeekRef.current = null;
      if (failedSeek) {
        dispatchScrub({ type: "failed", token: failedSeek.token });
        dispatchReaderSession({ type: "scrub-reader-aborted" });
      }
    }
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

  const handleReaderDisplayReady = useCallback((ticket?: RestoreTicket | null) => {
    // 连续视图失败走 onNavigationUnresolved；能走到 display-ready 即目标已提交。
    // 分页视图由 onRestoreResult 结算，display-ready 不能解除失败保护。
    if (ticket) {
      if (readingModeRef.current === "scroll" && !bookRef.current?.fixedLayout) {
        dispatchRestoreGate({ type: "resolved", ticket, located: true });
      }
      dispatchRestoreGate({ type: "display-ready", ticket });
    }
    dispatchReaderSession({ type: "display-ready" });
    setSearchNavigationBusy(false);
    setInitialAlignment("context");
    const pendingSeek = pendingChapterSeekRef.current;
    pendingChapterSeekRef.current = null;
    const scrubPending = scrubUiStateRef.current.pending;
    const matchingSeek = pendingSeek && pendingSeek.target.spineIndex === spineIndexRef.current &&
      pendingSeek.token.session === scrubPending?.session && pendingSeek.token.request === scrubPending?.request
      ? pendingSeek : null;
    if (pendingSeek && !matchingSeek) dispatchScrub({ type: "cancelled", token: pendingSeek.token });
    if (matchingSeek) {
      // setPage 同步发布页态，下面读到的就是定位后的状态。
      readerRef.current?.seekContentFraction?.(matchingSeek.target, matchingSeek.token);
    }
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
            dispatchScrub(matchingSeek
              ? { type: "settled", token: matchingSeek.token, actual: { ratio, atEnd } }
              : { type: "sample", session: scrubSessionRef.current, actual: { ratio, atEnd } });
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
    }
    // 恢复未放行（未结算/定位失败）时保留开书写入的原位置，历史返回不指向章首。
    const restoreBlocked = restoreGateRef.current !== null && !mayCommitRestoredProgress(restoreGateRef.current);
    if (
      !restoreBlocked &&
      active &&
      expectedPath &&
      state.status === "ready" &&
      !state.empty &&
      readingAnchor?.path === expectedPath &&
      Number.isSafeInteger(readingAnchor.totalChars) &&
      readingAnchor.totalChars >= 0
    ) {
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
    // apply this opening/history restore. Keep the source ticket when the
    // restore failed, so a later real user commit can still settle that gate.
    setInitialAnchor(null);
    if (!restoreGateRef.current) setInitialRestoreTicket(null);
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
      // 翻过章节边界也是用户自己往下读：收起跳转返回提示（跳转本身随后会重新显示它）。
      setReturnPromptShown(false);
      setPreciseTarget(null);
      latestPreciseRequestRef.current = null;
      beginExplicitNavigation();
      setSpineIndex(index);
      setAnchor(undefined);
      // 对象每次请求都新建：连续回翻多次时每次都能触发 atEnd 武装
      setStartAtEnd((prev) => ({ nonce: prev.nonce + 1, atEnd: opts?.atEnd === true }));
      closeForeground();
    },
    [closeForeground, closeImageOverlay]
  );

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
  /** 当前稳定阅读位置；同步 ref 避免 ready 更新尚未完成 React render 的竞态。 */
  const currentReaderPosition = useCallback((): ReaderHistoryPosition => {
    const { state, readingAnchor } = readReaderPosition();
    const currentBook = bookRef.current;
    let targetSpineIndex = spineIndex;
    if (readingAnchor?.path && currentBook) {
      const resolved = spineIndexForEntryKey(currentBook, readingAnchor.path);
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
  }, [spineIndex, readReaderPosition]);

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
      settingsActions.setPresentation(patch);
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
    dispatchReaderSession({ type: "history-captured" });
    setReaderHistory((prev) => recordReaderNavigation(prev, snapshot));
  }, [book, view, spineIndex, currentReaderPosition]);

  /** Commit a previously captured snapshot only after direct navigation succeeds. */
  const commitReaderHistorySnapshot = useCallback((snapshot: ReaderHistoryPosition): void => {
    setReaderHistory((prev) => commitDirectHistory(prev, snapshot, true));
    // Same-chapter navigation never enters the display gate. The paginator
    // settles synchronously, so the next explicit jump may be captured now.
    dispatchReaderSession({ type: "direct-settled" });
  }, [dispatchReaderSession]);

  /**
   * 弹注里的本章锚点：与其他书内跳转一样可以返回。只有确实换了页才记历史；
   * 很多书整段注释就是指回引用处的链接，点它常常还在同一页。
   */
  const handleFootnoteAnchor = useCallback((anchor: string) => {
    const snapshot = currentReaderPosition();
    if (readerRef.current?.navigateWithinCurrentChapter({ fragment: anchor })) {
      const landed = currentReaderPosition();
      if (landed.spineIndex !== snapshot.spineIndex || landed.page !== snapshot.page) commitReaderHistorySnapshot(snapshot);
    } else {
      readerRef.current?.jumpToAnchor(anchor);
    }
    handleFootnoteClose();
  }, [commitReaderHistorySnapshot, currentReaderPosition, handleFootnoteClose]);

  /** 只执行 href 跳转，不记录历史；UI 入口和 paginator 通知入口共用。 */
  const navigateReaderHref = useCallback((href: string): boolean => {
    if (!book) return false;
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    const idx = spineIndexForPath(book, href);
    const a = book.archiveReferences ? book.archiveReferences.resolve(book.opfPath, href).anchor : splitHref(href).anchor;
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
      beginExplicitNavigation();
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
  const handleTocNavigate = useCallback((href: string): boolean => {
    if (!book) return false;
    const target = spineIndexForPath(book, href);
    if (target < 0) return false;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: target,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const snapshot = currentReaderPosition();
      if (!navigateReaderHref(href)) return false;
      commitReaderHistorySnapshot(snapshot);
      return true;
    }
    captureReaderHistory(href);
    return navigateReaderHref(href);
  }, [book, captureReaderHistory, navigateReaderHref, spineIndex, currentReaderPosition, commitReaderHistorySnapshot]);

  const handleCommitSeek = useCallback((ratio: number) => {
    const r = Math.max(0, Math.min(1, ratio));
    const axis = contentAxisRef.current;
    scrubRequestIdRef.current += 1;
    const token: ScrubToken = {
      session: scrubSessionRef.current,
      request: scrubRequestIdRef.current,
    };
    dispatchReaderSession({ type: "begin-scrub" });
    releaseRestoreForExplicitNavigation();
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
          // Requested chapter index can change before its paginator is ready.
          // Keep a later fraction queued instead of applying it to the old document.
          if (target.spineIndex === spineIndexRef.current && readerDisplayReadyRef.current) {
            readerRef.current?.seekContentFraction?.(
              { key: target.key, spineIndex: target.spineIndex, fraction: target.fraction },
              token
            );
          } else {
            const currentBook = bookRef.current;
            const href = currentBook ? spineItemHref(currentBook, target.spineIndex) : undefined;
            if (href) {
              pendingChapterSeekRef.current = {
                target: { key: target.key, spineIndex: target.spineIndex, fraction: target.fraction },
                token,
              };
              if (handleTocNavigate(href)) return; // Settle only after the target chapter and page are ready.
            }
            pendingChapterSeekRef.current = null;
            dispatchScrub({ type: "failed", token });
            dispatchReaderSession({ type: "scrub-local-settled" });
            setReaderNotice({ kind: "warn", text: uiText("notice.reader.progressNotFound") });
            return;
          }
          dispatchScrub({
            type: "settled",
            token,
            actual: { ratio: r, atEnd: r >= 1 },
          });
          dispatchReaderSession({ type: "scrub-local-settled" });
          return;
        }
      }
      readerRef.current?.scrollToRatio?.(r);
      dispatchScrub({
        type: "settled",
        token,
        actual: { ratio: r, atEnd: r >= 1 },
      });
      dispatchReaderSession({ type: "scrub-local-settled" });
    }
  }, [settings.readingMode, handleTocNavigate, dispatchScrub, dispatchReaderSession, releaseRestoreForExplicitNavigation]);

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
    if (!acceptsScrubResult(token)) return;
    dispatchReaderSession({ type: "scrub-reader-settled" });
    const axis = contentAxisRef.current;
    const ratio = axis ? axis.ratioAt({ key: location.key, fraction: location.fraction }) : null;
    const actualRatio = ratio !== null ? ratio : (scrubUiStateRef.current.pending?.ratio ?? 0);
    dispatchScrub({
      type: "settled",
      token,
      actual: { ratio: actualRatio, atEnd: location.atEnd },
    });
  }, [acceptsScrubResult, dispatchScrub, dispatchReaderSession]);

  const handleContentFractionCancelled = useCallback((token: ScrubToken) => {
    if (!acceptsScrubResult(token)) return;
    dispatchReaderSession({ type: "scrub-reader-aborted" });
    dispatchScrub({ type: "cancelled", token });
  }, [acceptsScrubResult, dispatchScrub, dispatchReaderSession]);

  const handleContentFractionFailed = useCallback((token: ScrubToken) => {
    if (!acceptsScrubResult(token)) return;
    dispatchReaderSession({ type: "scrub-reader-aborted" });
    dispatchScrub({ type: "failed", token });
    setReaderNotice({ kind: "warn", text: uiText("notice.reader.progressNotFound") });
  }, [acceptsScrubResult, dispatchScrub, dispatchReaderSession]);

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
    const displayTarget = result.display
      ? {
          projectionVersion: result.display.projectionVersion,
          textHits: result.display.textHits,
          occurrence: result.display.occurrence,
        }
      : undefined;
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
          displayTarget,
          chapterPath: result.chapterPath,
        });
        if (status === "located" || status === "unsupported-highlight") {
          setAnchor(undefined);
          commitReaderHistorySnapshot(snapshot);
          if (status === "unsupported-highlight") {
            showReaderNotice(uiText("notice.reader.noHighlight"), "warn");
          }
          handleFootnoteClose();
          closeForeground();
          return;
        }
        showReaderNotice(uiText("notice.reader.sourceNotFound"), "warn");
        return;
      }
      const direct = readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: targetAnchor,
        fallbackPage: null,
      });
      if (direct) {
        setAnchor(undefined);
        commitReaderHistorySnapshot(snapshot);
        showReaderNotice(uiText("notice.reader.paragraphOnly"), "warn");
        handleFootnoteClose();
        closeForeground();
        return;
      }
      showReaderNotice(uiText("notice.reader.sourceNotFound"), "warn");
      return;
    }

    // 跨章先进入目标章节；精确范围/高亮在显示门内解析，失败不冒充命中。
    captureReaderHistory(archiveHref(book.archiveReferences, result.chapterPath));
    beginExplicitNavigation();
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
      displayTarget,
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
        dispatchReaderSession({ type: "direct-settled" });
        return;
      }
    }
    lastStablePositionRef.current = transition.target;
    beginExplicitNavigation();
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
        dispatchReaderSession({ type: "direct-settled" });
        return;
      }
    }
    lastStablePositionRef.current = transition.target;
    beginExplicitNavigation();
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

  // 书架设置与阅读 Aa 共用的主题入口：仅主题变化走约 200ms 整屏淡入，更新回调内
  // 同步提交 React 外层、html/body 与全部在用正文宿主（见 ui/themeTransitionHost）。
  const changeTheme = themeTransition.changeTheme;

  // 同步主题至 html 与 body，保证全屏与全端窗口背景无死角对齐（过渡提交已先行同步，这里幂等）
  useEffect(() => {
    applyDocumentTheme(document, settings.theme);
  }, [settings.theme]);

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
        const epubFiles = files.filter((f) => f.name.toLowerCase().endsWith(".epub"));
        const fontFiles = files.filter((f) => isSupportedFontFileName(f.name));
        if (fontFiles.length > 0 && !fontSettingsOpen) {
          setShelfNotice({ kind: "error", text: uiText("notice.font.dropHere") });
        }
        if (epubFiles.length > 0) {
          void handleImportSources(
            epubFiles.map((file) => ({ kind: "file" as const, file })),
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
    let nativeDragHasEpub = false;
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
      const active = !overFontPanel && (nativeDragHasEpub || nativeDragHasFont || nativeDragHasOther);
      setFontNativeDragActive(overFontPanel);
      setDragActive(active);
      const { target, onCard } = active && nativeDragHasEpub ? dropTargetAt(position) : { target: null, onCard: false };
      setDropFolderId(onCard && target ? target.folderId : null);
      setDropLabel(
        target ? uiText("appUi.drop.toFolder", { name: target.name })
          : nativeDragHasEpub ? uiText("appUi.drop.books")
            : nativeDragHasOther ? uiText("appUi.drop.folder")
              : uiText("appUi.drop.generic"),
      );
    };
    /** A dropped non-EPUB, non-font item: one folder opens directory import on it. */
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
      if (directories.length === 0) {
        setShelfNotice({ kind: "error", text: uiText("notice.drop.unsupported") });
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
          nativeDragHasEpub = dropped.epubs.length > 0;
          nativeDragHasFont = dropped.fonts.length > 0;
          nativeDragHasOther = dropped.others.length > 0;
          updateNativeDragVisual(p.position);
        } else if (p.type === "over") {
          updateNativeDragVisual(p.position);
        } else if (p.type === "leave") {
          nativeDragHasEpub = false;
          nativeDragHasFont = false;
          nativeDragHasOther = false;
          clearNativeDragVisual();
        } else if (p.type === "drop") {
          nativeDragHasEpub = false;
          nativeDragHasFont = false;
          nativeDragHasOther = false;
          clearNativeDragVisual();
          // 字体面板优先：面板内的落点只走字体链路，残留的 EPUB 不抢读书会话。
          const overFontPanel = isOverFontPanel(p.position);
          const dropped = partitionDroppedPaths(p.paths);
          if (overFontPanel) {
            void handleImportFontPaths(p.paths);
            if (dropped.epubs.length > 0) {
              setShelfNotice({ kind: "error", text: uiText("notice.font.dropUnsupported") });
            }
            return;
          }
          if (dropped.epubs.length > 0) {
            // Mixed with folders: only the EPUB files are imported; a folder is dropped on its own.
            if (dropped.fonts.length > 0) {
              setShelfNotice({ kind: "error", text: uiText("notice.font.dropHere") });
            }
            void handleImportSources(
              dropped.epubs.map((path) => ({
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
  const changeAaColumns = useCallback((columnsPerView: 1 | 2) => handlePresentationChange({ columnsPerView }), [handlePresentationChange]);
  const changeAaReadingMode = useCallback((readingMode: "paginated" | "scroll") => handlePresentationChange({ readingMode }), [handlePresentationChange]);
  const chooseBookFromAa = useCallback(() => {
    void handleChooseBooks();
    closeForeground();
  }, [handleChooseBooks, closeForeground]);
  // 安卓本次运行：Aa 与目录在首次开书过渡仍遮住时各画一次，其余面板在阅读安静时逐个画一次
  // （几乎不可见、不可交互），之后的首次打开不再承担 GPU 首绘。
  const androidRuntime = runtime.platform === "android";
  const panelWarmup = usePanelPaintWarmup(
    view === "reader" && ready && readerDisplayReady && openingPanels.aa && openingPanels.toc &&
      !openingPanels.pending && foreground.kind === "none" && !mobileMoreOpen && !assistantOpen,
    androidRuntime ? PANEL_WARM_VEIL_BATCHES : [],
    !androidRuntime ? [] : mobileChrome ? PANEL_WARM_IDLE_BATCHES_MOBILE : PANEL_WARM_IDLE_BATCHES,
    readerBusy,
  );
  useReadingInputStart(view === "reader", panelWarmup.interrupt);
  const warming = panelWarmup.warming;
  // 开书过渡覆盖“解析书籍”、首次“准备阅读位置”与有限的面板准备；之后的换章只用顶部细进度线。
  const readerOpeningVisible =
    phase.phase === "loading" ||
    (readerLoadFeedback?.kind === "loading" && !displayedOnce) ||
    openingPanels.pending ||
    panelWarmup.pending;
  const readerOpeningTitle = phase.phase === "loading"
    ? phase.title || phase.fileName
    : book?.metadata.title ?? "";
  const readerOpeningCreator = phase.phase === "loading" ? phase.creator : book?.metadata.creator;
  const reading = chapterState.status === "ready" && !chapterState.empty;
  const currentPath = ready ? spineItemPath(book!, spineIndex) : undefined;
  const activeHref = currentPath
    ? archiveHref(book?.archiveReferences, currentPath, anchor ?? "")
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
  /**
   * explicit=false 是随页态变化的自动保存：跳过原生滑动途中的 transient 预览。
   * 返回书架/切后台/关窗/导出/换书是显式保存：用同一次读数的视觉屏与锚点。
   */
  const persistShelfProgress = useCallback((explicit = false) => {
    // 自动与显式（返回书架/后台/关窗）入口同样受恢复门约束：未结算或失败的
    // 恢复不能用当前（可能是章首）位置覆盖原进度与本机检查点。
    if (restoreGateRef.current && !mayCommitRestoredProgress(restoreGateRef.current)) return;
    if (
      suppressShelfProgressRef.current ||
      navigationPendingRef.current ||
      !readerDisplayReady ||
      view !== "reader" ||
      !currentShelfId
    ) return;
    // 自动保存不会消费运动预览；先跳过，避免为了丢弃它而强制同步采样正文。
    // 显式退出/后台/书签仍读取同一次真实视觉位置。
    if (!explicit && chapterStateRef.current.status === "ready" && chapterStateRef.current.transient === true) return;
    const position = readReaderPosition();
    const state = position.state;
    if (state.status !== "ready") return;
    if (state.transient === true && !explicit) return;
    if (position.chapterPath !== null && book && position.chapterPath !== spineItemPath(book, spineIndex)) return;
    const a = position.readingAnchor;
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
    const lease = activeProgressLeaseRef.current;
    if (lease) {
      const store = getShelfStore();
      const bookHash = store.progressSessionBookHash?.(lease);
      const shownStamp = store.progressSessionChosenStamp?.(lease) ?? null;
      const checkpoints = localCheckpointsRef.current;
      if (bookHash && checkpoints) {
        try {
          // Stage the local recovery record before enqueueing any native IPC.
          const sample = stageCheckpointSample(checkpoints, bookHash, shownStamp, patch);
          progressWriterRef.current?.enqueue(lease, sample);
        } catch (error) {
          showReaderNotice(uiText("notice.progress.localWriteFailed"), "error");
        }
      }
    }
  // page/anchor 变化必须触发写入；不能只依赖取整后的 progressPct，
  // 否则长书连续数页保持同一百分比时会漏掉最新位置。
  }, [view, currentShelfId, spineIndex, readerDisplayReady, chapterState, showReaderNotice, readReaderPosition]);
  persistShelfProgressRef.current = persistShelfProgress;

  useEffect(() => {
    persistShelfProgress(false);
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
    writeChapterCountCache(active.countCacheKey, chapterCountsRef.current, active.structuralCounts);
  }, []);
  useEffect(() => {
    if (lastCountProgressSignatureRef.current === countProgressSignature) return;
    lastCountProgressSignatureRef.current = countProgressSignature;
    persistShelfProgressRef.current(false);
    if (countSummary.complete) persistChapterCountCache();
  }, [countProgressSignature, countSummary.complete, persistChapterCountCache]);

  const leaveReader = useCallback(async (leaveUnsaved: boolean): Promise<boolean> => {
    // 返回书架前先关浮层，再释放整本书的 ResourceServer。
    closeImageOverlay();
    persistShelfProgress(true);
    recordLifecycleDiagnostic("back_to_shelf", { stage: "save", result: leaveUnsaved ? "leave-unsaved" : "begin" });
    shelfBusyRef.current = true;
    setShelfBusyMessage(uiText("notice.progress.saving"));
    setShelfBusy(true);
    let outcome = "saved";
    try {
      const lease = activeProgressLeaseRef.current;
      if (lease) {
        const saved = await progressWriterRef.current?.flush(lease);
        if (saved?.status === "failed") {
          if (!leaveUnsaved) throw saved.error;
          // Explicit user choice after a failed save: never block leaving.
          // The sample moves to the local checkpoint; if even that cannot
          // run, the lane stays paused and a later open/close retries it.
          const writer = progressWriterRef.current!;
          if (releaseUnsavedLane(writer, lease, retainUnsavedSample(lease)) === "checkpoint") {
            await getShelfStore().closeProgressLease?.(lease).catch(() => undefined);
            activeProgressLeaseRef.current = null;
          }
          setShelfError(uiText("notice.progress.saveFailed", { error: String(saved.error) }));
          outcome = "left-unsaved";
        } else {
          progressWriterRef.current?.retire(lease);
          await getShelfStore().closeProgressLease?.(lease);
          activeProgressLeaseRef.current = null;
        }
      }
      persistChapterCountCache();
      recordLifecycleDiagnostic("back_to_shelf", { stage: "save", result: outcome });
    } catch (error) {
      recordLifecycleDiagnostic("back_to_shelf", {
        stage: "save",
        result: "failed",
        errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
      });
      setSaveFailurePrompt({ kind: "shelf", error: String(error) });
      shelfBusyRef.current = false;
      setShelfBusy(false);
      return false;
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
    return true;
  }, [persistShelfProgress, persistChapterCountCache, closeForeground, closeImageOverlay, retainUnsavedSample]);
  const handleBackToShelf = useCallback(() => leaveReader(false), [leaveReader]);

  // A11 V1：多本书标签页，只在非正式构建启用（浏览器开发模式、调试包和 optimized-dev
  // 测试包；后者 Rust profile 仍是 dev 但 debug 标志关闭），正式发布构建不渲染也不读写。
  // 只挂一个阅读器：切标签 = 走现有“返回书架”保存并释放当前书，等会话清理
  // effect 提交后再走现有“从书架打开”。阅读层与分页器不感知标签。
  const readerTabsEnabled = useMemo(() => {
    const session = getAppBuildSession();
    if (!session) return import.meta.env.DEV;
    return session.buildInfo ? session.buildInfo.profile !== "release" : session.debug;
  }, []);
  const [readerTabs, setReaderTabs] = useState(() => {
    if (!readerTabsEnabled) return EMPTY_READER_TABS;
    try {
      return parseReaderTabs(localStorage.getItem(READER_TABS_STORAGE_KEY));
    } catch {
      return EMPTY_READER_TABS;
    }
  });
  const readerTabsRef = useRef(readerTabs);
  readerTabsRef.current = readerTabs;
  const pendingTabOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!readerTabsEnabled) return;
    try {
      localStorage.setItem(READER_TABS_STORAGE_KEY, serializeReaderTabs(readerTabs));
    } catch {
      // 本机便利功能：写不进存储只影响重启后恢复标签。
    }
  }, [readerTabs, readerTabsEnabled]);
  useEffect(() => {
    if (!readerTabsEnabled || view !== "reader" || !currentShelfId) return;
    setReaderTabs((state) => openReaderTab(state, currentShelfId));
  }, [currentShelfId, readerTabsEnabled, view]);
  useEffect(() => {
    if (!readerTabsEnabled || libraryLoad.status !== "ready") return;
    const ids = new Set(shelfEntries.map((entry) => entry.id));
    setReaderTabs((state) => pruneReaderTabs(state, (id) => ids.has(id)));
  }, [libraryLoad.status, readerTabsEnabled, shelfEntries]);
  const switchReaderTab = useCallback(async (id: string | null): Promise<void> => {
    if (!readerTabsEnabled || id === currentShelfIdRef.current || shelfBusyRef.current) return;
    if (!(await leaveReader(false))) return;
    pendingTabOpenRef.current = id;
  }, [leaveReader, readerTabsEnabled]);
  const closeReaderTabById = useCallback((id: string): void => {
    if (!readerTabsEnabled || shelfBusyRef.current) return;
    const { state, next } = closeReaderTab(readerTabsRef.current, id);
    setReaderTabs(state);
    if (id === currentShelfIdRef.current) void switchReaderTab(next);
  }, [readerTabsEnabled, switchReaderTab]);
  const readerTabStrip = useMemo(() => {
    if (!readerTabsEnabled) return undefined;
    const titles = new Map(shelfEntries.map((entry) => [entry.id, entry.title] as const));
    return {
      tabs: activeReaderTabs(readerTabs).tabs
        .filter((id) => titles.has(id))
        .map((id) => ({ id, title: titles.get(id) || id })),
      activeId: currentShelfId,
      onSelect: (id: string) => void switchReaderTab(id),
      onClose: closeReaderTabById,
    };
  }, [closeReaderTabById, currentShelfId, readerTabs, readerTabsEnabled, shelfEntries, switchReaderTab]);
  useEffect(() => {
    if (!readerTabsEnabled || view !== "reader") return;
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
  }, [closeReaderTabById, readerTabsEnabled, switchReaderTab, view]);
  const resolveSaveFailurePrompt = useCallback((leaveUnsaved: boolean): void => {
    const prompt = saveFailurePrompt;
    if (!prompt) return;
    setSaveFailurePrompt(null);
    if (prompt.kind === "window") void windowCloseRef.current?.(leaveUnsaved);
    else void leaveReader(leaveUnsaved);
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

  // 书架根层返回两次退出：首次只提示，提示期内再次返回才退到后台。
  // 书架始终自己消费返回，避免 WebView 历史（iframe 导航）吃掉一次返回却没有任何反馈。
  const [exitBackHint, setExitBackHint] = useState(false);
  const exitBackArmedUntilRef = useRef(0);
  const exitBackHintTimerRef = useRef<number | null>(null);
  const clearExitBackHint = useCallback((): void => {
    exitBackArmedUntilRef.current = 0;
    if (exitBackHintTimerRef.current !== null) {
      window.clearTimeout(exitBackHintTimerRef.current);
      exitBackHintTimerRef.current = null;
    }
    setExitBackHint(false);
  }, []);
  const handleShelfRootBack = useCallback((): void => {
    if (Date.now() < exitBackArmedUntilRef.current) {
      clearExitBackHint();
      void moveAndroidTaskToBack().catch(() => undefined);
      return;
    }
    exitBackArmedUntilRef.current = Date.now() + EXIT_BACK_WINDOW_MS;
    if (exitBackHintTimerRef.current !== null) window.clearTimeout(exitBackHintTimerRef.current);
    setExitBackHint(true);
    exitBackHintTimerRef.current = window.setTimeout(clearExitBackHint, EXIT_BACK_WINDOW_MS);
  }, [clearExitBackHint]);
  useEffect(() => {
    if (view !== "shelf") clearExitBackHint();
  }, [view, clearExitBackHint]);
  useEffect(() => () => {
    if (exitBackHintTimerRef.current !== null) window.clearTimeout(exitBackHintTimerRef.current);
  }, []);

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
    const id = pendingTabOpenRef.current;
    pendingTabOpenRef.current = null;
    if (id) void handleShelfOpen(id);
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

  /** 章节在目录里的名字；没有目录项时为空串。 */
  const tocLabelForPath = (chapterPath: string): string => {
    if (!book) return "";
    const path = book.archiveReferences ? chapterPath : splitHref(chapterPath).path;
    const walk = (nodes: import("./core/types").TocNode[]): string => {
      for (const n of nodes) {
        if ((book.archiveReferences ? book.archiveReferences.resolve(book.opfPath, n.href).path : splitHref(n.href).path) === path && n.label) return n.label;
        const c = walk(n.children);
        if (c) return c;
      }
      return "";
    };
    return walk(book.toc);
  };
  const currentChapterLabel = ready && currentPath ? tocLabelForPath(currentPath) : "";
  /** 跳转历史目标的位置名：本章为空串，其他章用目录名或“第 N 章”；无目标为 null。 */
  const historyPlaceLabel = (position: ReaderNavigationPosition | undefined): string | null => {
    if (!position || !book || !ready) return null;
    if (position.spineIndex === spineIndex) return "";
    const path = spineItemPath(book, position.spineIndex);
    return (path && tocLabelForPath(path)) ||
      t("footer.chapterN", { n: linearChapterNumber(spineLinear, position.spineIndex) ?? position.spineIndex + 1 });
  };

  const renderUserFonts = useMemo(
    () =>
      userFonts
        .filter((f) => fontUrls[f.id])
        .map((f) => ({ family: f.family, url: fontUrls[f.id] })),
    [userFonts, fontUrls]
  );

  const crossBookPanelResults = useLibrarySearchResults(librarySearchSnapshot, entryByContentHashRef, libraryIndexSignature);
  const { searchPanelResults, handleSearchViewChange, handleSearchCancel } = useReaderSearchPanel({
    ...readerSearchState, ...readerSearchRefs, setSearchView: readerSearchView.setSearchView,
  });
  const { handleStartLibraryIndex, handleCancelLibraryIndex, handleDeferLibraryIndex, handleRebuildTextIndex,
    handleClearTextIndex, handleShelfSearchModeChange, handleCorpusConcurrencyChange,
    handleLibrarySearchQueryChange } = useLibrarySearchActions({
      ...librarySearch, setShelfSearchMode, setSearchNavigationBusy,
    });
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
    ...resourceIssues.map((issue) => ({
      kind: "reader_error",
      source: "render",
      resolved: issue.recovered,
      message: uiText(issue.recovered ? "appUi.issue.resourceRecovered"
        : issue.kind === "missing" ? "appUi.issue.resourceAbsent" : "appUi.issue.resourceUnavailable", { path: issue.path })
        + (issue.error ? `\n${uiText("log.resourceErrorRecord", { error: issue.error })}` : ""),
    })),
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
      setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.fullscreenFailed", { error: String(err) })]);
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
          setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.windowFullscreenFailed", { error: String(err) })]);
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

  // 保存快捷键所需最新状态 ref，避免闭包捕获旧状态或频繁解绑事件
  const latestShortcutStateRef = useRef({
    view,
    ready,
    book,
    pageProgression,
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
    pageProgression,
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

      // 4. Ctrl + B：书签按钮（双页弹出缩略书页，其他模式放 / 取）
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        if (st.view === "reader") {
          handleBookmarkButton();
        }
        return;
      }

      // 4b. Ctrl + Z：撤销刚删除的书签；焦点在输入框时让给输入框
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "z" || e.key === "Z")) {
        if (st.view === "reader" && !isEditableTarget(e.target) && undoBookmarkRemoval()) {
          e.preventDefault();
          return;
        }
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
          } else if (st.book) {
            // Same neighbour as page turns: skip linear="no" items such as a trailing nav.
            const prev = nextLinearIndex(st.book, st.spineIndex, -1);
            const href = prev >= 0 ? spineItemHref(st.book, prev) : undefined;
            if (href) handleTocNavigate(href);
          }
        }
        return;
      }
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending) {
          if (st.readerHistory.forward.length > 0) {
            handleHistoryForward();
          } else if (st.book) {
            const next = nextLinearIndex(st.book, st.spineIndex, 1);
            const href = next >= 0 ? spineItemHref(st.book, next) : undefined;
            if (href) handleTocNavigate(href);
          }
        }
        return;
      }

      // 7. [ 与 ] 键：快速跳转上一章 / 下一章
      if (e.key === "[" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending && st.book) {
          const prev = nextLinearIndex(st.book, st.spineIndex, -1);
          const href = prev >= 0 ? spineItemHref(st.book, prev) : undefined;
          if (href) handleTocNavigate(href);
        }
        return;
      }
      if (e.key === "]" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending && st.book) {
          const next = nextLinearIndex(st.book, st.spineIndex, 1);
          const href = next >= 0 ? spineItemHref(st.book, next) : undefined;
          if (href) handleTocNavigate(href);
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
      // 面板、浮层抽屉或书签菜单打开时，键盘归最上层：方向键和翻页键不在背后翻页。
      // 停靠的侧栏不算前景，照常翻页。
      if (st.isReaderPanelOpen || st.bookmarkMenuOpen) return;
      const keyDir = e.key === "ArrowRight" || e.key === "PageDown" || e.key === " " ? 1
        : e.key === "ArrowLeft" || e.key === "PageUp" ? -1 : 0;
      if (keyDir !== 0) {
        e.preventDefault();
        if (arrowKeyDirection(keyDir, e.key, st.pageProgression) === 1) readerRef.current?.nextPage();
        else readerRef.current?.prevPage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    closeForeground,
    fullscreenBusy,
    handleHistoryBack,
    handleHistoryForward,
    handleBookmarkButton,
    undoBookmarkRemoval,
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
        title={view === "reader" ? (ready ? book!.metadata.title : (book?.metadata.title ?? "")) : t("appUi.appName")}
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
        bookmarksOpen={view === "reader" && isSidebarOpen && activeSidebarTab === "bookmarks"}
        onOpenBookmarks={view === "reader" ? handleToggleBookmarks : undefined}
        zenMode={view === "reader" && !mobileChrome && readerZenMode}
        onToggleZenMode={view === "reader" ? toggleZenMode : undefined}
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
              compact={phoneChrome}
              entries={shelfDisplayEntries}
              organization={organization}
              scope={shelfScope}
              onScopeChange={setShelfScope}
              onApplyOrganization={handleApplyOrganization}
              busy={shelfBusy}
              importActive={nativeImport !== null || folderImport !== null}
              onImportFolder={() => void handleOpenFolderImport()}
              saveFileActive={saveFileActive}
              lanTransferActive={lanSaveSession.active}
              onOpenLanTransfer={runtime.supportsLanTransfer ? handleOpenLanSave : undefined}
              theme={settings.theme}
              onThemeChange={changeTheme}
              hideReaderSystemStatusBar={runtime.supportsReaderSystemStatusBar ? hideReaderSystemStatusBar : undefined}
              onHideReaderSystemStatusBarChange={changeHideReaderSystemStatusBar}
              keepScreenOnWhileReading={runtime.supportsReaderKeepScreenOn ? keepScreenOnWhileReading : undefined}
              onKeepScreenOnWhileReadingChange={changeKeepScreenOnWhileReading}
              batteryIndicatorEnabled={runtime.platform === "android" ? batteryIndicatorEnabled : undefined}
              onBatteryIndicatorChange={runtime.platform === "android" ? changeBatteryIndicatorEnabled : undefined}
              tapRegions={tapRegions}
              onTapRegionsChange={changeTapRegionPreferences}
              tapRegionsScrollMode={settings.readingMode === "scroll"}
              touchUi={mobileChrome}
              onOpenDiagnostics={() => openPanel("log")}
              libraryState={shelfLibraryView(libraryLoad, shelfEntries.length > 0, organizationSettled)}
              onRetryLibraryLoad={retryLibraryLoad}
              onOpen={handleShelfOpen}
              onImport={() => void handleChooseBooks()}
              onImportIntoFolder={(target) => void handleChooseBooks(target)}
              onImportContextChange={handleImportContextChange}
              externalDropFolderId={dropFolderId}
              onDelete={handleShelfDelete}
              onDeleteMany={handleShelfDeleteMany}
              registerBackHandler={registerShelfBackHandler}
              onBackAvailabilityChange={reportShelfBackActive}
              onExportArchive={handleExportArchive}
              onExportBooks={
                runtime.platform === "web" || !isTauriEnv()
                  ? undefined
                  : (entries?: ShelfEntry[]) => void startBookSourceExport(entries)
              }
              onImportArchive={handleImportArchive}
              onImportLegacyArchive={
                runtime.platform === "web" || !isTauriEnv()
                  ? undefined
                  : () => void handleLegacyImportArchive()
              }
              thumbnailProvider={shelfThumbnailProvider}
              searchMode={shelfSearchMode}
              onSearchModeChange={handleShelfSearchModeChange}
              bodySearch={{
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
                customFontName={settings.customFontName}
                onOpenFontSettings={openAaFonts}
                onOpenDisplaySettings={openAaDisplay}
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
                uiScale={uiScale}
                onUiScaleChange={settingsActions.setUiScale}
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
                pageDirection={settings.pageDirection}
                onPageDirectionChange={settingsActions.setPageDirection}
                preloadNextChapter={settings.preloadNextChapter === true}
                preloadNextChapterDisabled={book?.fixedLayout === true}
                onPreloadNextChapterChange={settingsActions.setPreloadNextChapter}
                seamlessChapterTurn={settings.seamlessChapterTurn === true}
                onSeamlessChapterTurnChange={settingsActions.setSeamlessChapterTurn}
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
              {IS_AI_EDITION && (
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
            open={readingSettingsOpen || warming("reading")}
            presentation={mobileChrome ? "page" : "dialog"}
            onClose={() => closePanel("reading")}
            tapRegions={readerTapRegions}
            onTapRegionsChange={changeTapRegionPreferences}
            tapRegionsScrollMode={settings.readingMode === "scroll"}
            keepScreenOnWhileReading={runtime.supportsReaderKeepScreenOn ? keepScreenOnWhileReading : undefined}
            onKeepScreenOnWhileReadingChange={changeKeepScreenOnWhileReading}
            hideReaderSystemStatusBar={runtime.supportsReaderSystemStatusBar ? hideReaderSystemStatusBar : undefined}
            onHideReaderSystemStatusBarChange={changeHideReaderSystemStatusBar}
            batteryIndicatorEnabled={runtime.platform === "android" ? batteryIndicatorEnabled : undefined}
            onBatteryIndicatorChange={runtime.platform === "android" ? changeBatteryIndicatorEnabled : undefined}
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
        />
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
        accept=".epub,application/epub+zip"
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("appUi.checkpoint.dialog")}
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
              background: "var(--surface, #fff)",
              color: "var(--text, #222)",
              borderRadius: 12,
              padding: 20,
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.3)",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>{t("appUi.checkpoint.title")}</h3>
            <p style={{ margin: "0 0 14px", fontSize: 14, lineHeight: 1.5 }}>
              {t("appUi.checkpoint.body", { title: localCheckpointConflict.title, synced: localCheckpointConflict.hasSynced ? t("appUi.checkpoint.syncedAvailable") : "" })}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                onClick={() => resolveLocalCheckpointConflict("local")}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  border: "1px solid var(--border, #d0d0d0)",
                  borderRadius: 8,
                  background: "var(--surface, #fff)",
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                {t("appUi.checkpoint.useLocal")}
              </button>
              {localCheckpointConflict.hasSynced && (
                <button
                  type="button"
                  onClick={() => resolveLocalCheckpointConflict("synced")}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid var(--border, #d0d0d0)",
                    borderRadius: 8,
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {t("appUi.checkpoint.useSynced")}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => resolveLocalCheckpointConflict(null)}
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
              {t("appUi.cancel")}
            </button>
          </div>
        </div>
      )}
      {progressChoice && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("appUi.progressChoice.dialog")}
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
            <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>{t("appUi.progressChoice.title")}</h3>
            <p style={{ margin: "0 0 14px", fontSize: 14, lineHeight: 1.5 }}>
              {uiPlural("appUi.progressChoice.body", progressChoice.candidates.length, { title: progressChoice.title, count: progressChoice.candidates.length })}
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
                      : t("appUi.chapterN", { n: linearChapterNumber(spineLinear, candidate.spineIndex) ?? candidate.spineIndex + 1 })}
                  </strong>
                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                    {candidate.progressPct}% · {new Date(candidate.updatedAtMs).toLocaleString(currentUiLocale())}
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
              {t("appUi.cancel")}
            </button>
          </div>
        </div>
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
