import { Segmented } from "./controls/Segmented";
import type { ShelfLibraryView } from "./libraryLoad";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MENU_CLOSE_MS, menuCloseMs } from "./menuMotion";
import { createPortal } from "react-dom";
import { getShelfMenuPortalHost } from "./shelfMenuPlacement";
import { ShelfGestureTail, type ShelfLongPress } from "./shelfPress";
import {
  groupShelfActions,
  shelfBookActions,
  shelfFolderActions,
  shelfMenuPresentation,
  type ShelfAction,
  type ShelfActionId,
} from "./shelfActions";
import { ShelfActionMenu } from "./ShelfActionMenu";
import type { Theme } from "../render/settings";
import {
  createShelfFilterModel,
  sortShelfEntries,
  type ShelfEntry,
  type ShelfSort,
} from "./shelf";
import {
  folderSelectionState,
  selectableBookIds,
  sortShelfFolders,
  toggleFolderSelection,
} from "./shelfFolderSelection";
import {
  effectiveFolderId,
  emptyOrganization,
  generateFolderId,
  isFavorite,
  type LibraryOrganization,
  type OrganizationCommand,
  type ShelfScope,
} from "./libraryOrganization";
import { legacyThumbnailProvider, type ThumbnailProvider } from "./thumbnail";
import { shelfReadingStatus } from "./shelfProgressDisplay";
import type { CustomThemeControls } from "./useCustomThemes";
import { isShelfCardActionTarget } from "./shelfCardEventScope";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import type { ReaderTapPreferences } from "./readerTapRegions";
import type { ReaderTapRegionSettings } from "./readerTapRouting";
import { ShelfSettingsPage, type ShelfSettingsPageProps, type ShelfSettingsSection } from "./ShelfSettingsPage";
import { PanelPaintWarmup, usePanelPaintWarmup, type PanelWarmBatch } from "./panelPaintWarmup";
import {
  EMPTY_SHELF_FILTERS,
  ShelfFilterPanel,
  ShelfFilterSummary,
  shelfFilterCount,
  type ShelfFilters,
} from "./ShelfFilterPanel";
import { ShelfBodySearchDropdown, ShelfBodySearchPage } from "./ShelfBodySearch";
import {
  type SearchIndexProgress,
  type SearchIndexStatus,
  type SearchPanelResult,
  type SearchStatus,
} from "./SearchPanel";
import "./shelfZen.css";
import { ShelfFolderAddBooksDialog } from "./ShelfFolderAddBooksDialog";
import { useAppUpdateDot } from "./appUpdate/appUpdateStore";
import { useCloudSyncAttention } from "./cloudSync/cloudSyncStore";
import { CloudBookUploadLayer } from "./cloudSync/CloudBookUploadPanel";
import { useBatchDockFit } from "./batchDockFit";
import { cloudBookUploadBusy, closeCloudBookUpload, requestCloudBookUpload, useCloudBookUpload } from "./cloudSync/cloudBookUploadStore";
import { uiText, useUiText } from "./localization/UiLanguageProvider";
import type { PlainMessageKey } from "./localization/core";
import {
  BookLogoIcon,
  CheckListIcon,
  CheckSquareIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  DotsVerticalIcon,
  EditIcon,
  ExportIcon,
  CloudUploadIcon,
  FolderIcon,
  GridIcon,
  LanTransferIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  StarIcon,
  TrashIcon,
  shelfActionIcon,
} from "./shelfView/icons";
import { Cover, ShelfCard, ShelfFolderCard } from "./shelfView/cards";
import {
  sameShelfMenuTarget,
  type ShelfMenuOpener,
  type ShelfMenuSession,
  type ShelfMenuTarget,
} from "./shelfView/menuTarget";
export type { ShelfMenuOpener, ShelfMenuTarget } from "./shelfView/menuTarget";
import {
  ShelfAZRail,
  ShelfBrand,
  ShelfEmptyState,
  ShelfImportButton,
  ShelfSelect,
  ShelfTabPickBar,
  getInitialLetter,
  type ShelfSwitchProps,
} from "./shelfView/chrome";
import {
  ShelfCreateFolderDialog,
  ShelfDissolveDialog,
  ShelfFolderModal,
  ShelfMoveDialog,
  ShelfRenameDialog,
} from "./shelfView/dialogs";
import { useShelfSubmenuBack } from "./shelfView/submenuBack";
export type { ShelfSwitchProps } from "./shelfView/chrome";
import {
  ShelfFolderTableRow,
  ShelfTableRow,
  ShelfTableScroller,
  useShelfVirtualizer,
} from "./shelfView/geometry";
import { ShelfResumeStage } from "./shelfView/ShelfResumeStage";
export {
  measureShelfGridGeometry,
  measureShelfListGeometry,
  ShelfTableScroller,
} from "./shelfView/geometry";

export type { ShelfScope };
export type ShelfDensity = "comfortable" | "standard" | "compact";
export type ShelfSearchMode = "metadata" | "body";

/**
 * 文件夹/分类实体接口（预留扩展）。
 * 保持未来与单书统一的视图组织形式。
 */
export interface ShelfFolder {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  bookIds: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ShelfBodySearchProps {
  query: string;
  onQueryChange(query: string): void;
  results: SearchPanelResult[];
  status: SearchStatus;
  processed: number;
  total: number;
  truncated?: boolean;
  errorMessage?: string;
  onSelect(result: SearchPanelResult): void;
  onCancel?(): void;
  navigationBusy?: boolean;
  statusMessage?: string;
  indexStatus?: SearchIndexStatus;
  indexProgress?: SearchIndexProgress;
  onStartIndex?(): void;
  onDeferIndex?(): void;
  onCancelIndex?(): void;
  indexErrorMessage?: string;
  onRebuildIndex?(): void;
  onClearIndex?(): void;
  /** Reserved for the shared index controller's automatic/manual scheduler. */
  concurrencyMode?: "automatic" | "manual";
  concurrency?: number;
  detectedCores?: number;
  recommendedConcurrency?: number;
  onConcurrencyChange?(mode: "automatic" | "manual", value?: number): void;
}

export type ShelfViewMode = "grid" | "list";
export type ShelfStatusTab = "all" | "reading" | "unread" | "finished" | "favorites";

/**
 * What the shelf was showing when it unmounted for the reader. The owner keeps
 * one per shelf space for the app session and replaces it when the space
 * changes; ShelfView reads it on mount and writes it back without re-rendering
 * the owner on every keystroke.
 */
export interface ShelfSessionMemory {
  query: string;
  sort: ShelfSort;
  statusTab: ShelfStatusTab;
}

export function createShelfSessionMemory(): ShelfSessionMemory {
  return { query: "", sort: "recent", statusTab: "all" };
}

export interface ShelfViewProps {
  /** 移动端紧凑模式（由 App 根据 mobileChrome && compact 传入） */
  compact?: boolean;
  entries: ShelfEntry[];
  organization?: LibraryOrganization;
  scope?: ShelfScope;
  onScopeChange?(scope: ShelfScope): void;
  /** Keeps search, root sort and status tab across reader round trips (see ShelfSessionMemory). */
  sessionMemory?: ShelfSessionMemory;
  onApplyOrganization?(command: OrganizationCommand): Promise<void>;
  /** 全局忙（打开/删除等短操作），书架禁用交互防止重复操作 */
  busy: boolean;
  /** 原生书籍导入活动期间：只禁用冲突入口，不禁用阅读与收藏/文件夹操作。 */
  importActive?: boolean;
  /** 存档文件任务活动期间：只禁用重复的文件入口，不阻塞阅读和其他书架操作。 */
  saveFileActive?: boolean;
  /** LAN 会话活动期间禁用书架入口；一份会话结束并重新连接后再次开放。 */
  lanTransferActive?: boolean;
  /** A34 (Windows): copy imports into the library; shown as a checkbox in the import menu. */
  copyToLibrary?: boolean;
  onCopyToLibraryChange?(copy: boolean): void;
  /** A34 P2: the library location changed (or a change ended); re-read the shelf. */
  onLibraryLocationChanged?(): void;
  /** 打开共享的设备互传面板，可携带当前批量选择用于“选中书籍”范围。 */
  onOpenLanTransfer?(selectedEntries?: ShelfEntry[]): void;
  theme: Theme;
  onThemeChange(theme: Theme): void;
  customThemes?: CustomThemeControls;
  /** Android 阅读栏电量显示（本机偏好）；未提供时不显示该设置。 */
  batteryIndicatorEnabled?: boolean;
  onBatteryIndicatorChange?(enabled: boolean): void;
  titlebarAutoHide?: boolean;
  onTitlebarAutoHideChange?(enabled: boolean): void;
  preloadNextChapter?: boolean;
  onPreloadNextChapterChange?(enabled: boolean): void;
  seamlessChapterTurn?: boolean;
  onSeamlessChapterTurnChange?(enabled: boolean): void;
  uiScale?: number;
  onUiScaleChange?(scale: number): void;
  hideReaderSystemStatusBar?: boolean;
  onHideReaderSystemStatusBarChange?(hidden: boolean): void;
  keepScreenOnWhileReading?: boolean;
  onKeepScreenOnWhileReadingChange?(enabled: boolean): void;
  volumeKeyTurn?: boolean;
  onVolumeKeyTurnChange?(enabled: boolean): void;
  volumeKeyReverse?: boolean;
  onVolumeKeyReverseChange?(reverse: boolean): void;
  /** 点击翻页区域（本机偏好，编辑当前设备类别那一份）；未提供时不显示入口。 */
  tapRegions?: ReaderTapRegionSettings;
  onTapRegionsChange?(next: ReaderTapPreferences): void;
  /** 阅读器处于滚动模式：点击翻页设置只在分页模式生效。 */
  tapRegionsScrollMode?: boolean;
  /** 触屏界面（手机和平板）：设置为全屏页，筛选为底部面板。 */
  touchUi?: boolean;
  /** 设置 › 关于 › 诊断日志；未提供时不显示。 */
  onOpenDiagnostics?(): void;
  /** The library read itself (App owns it): loading and failure replace the empty-shelf invitation. */
  libraryState?: ShelfLibraryView;
  onRetryLibraryLoad?(): void;
  onOpen(id: string): void;
  /**
   * A11: present where reader tabs show. Books open in a new tab from the menu,
   * with Ctrl+click or a middle click; `pick` is the “choose a book for a new
   * tab” step started from the reader's + panel.
   */
  readerTabs?: {
    openIds: ReadonlySet<string>;
    full: boolean;
    max: number;
    onOpenInNewTab(id: string): void;
    pick: { count: number; returnTitle: string | null; onCancel(): void } | null;
  };
  onImport(): void;
  /** Import chosen EPUBs into an open shelf folder; absent imports to the shelf root. */
  onImportIntoFolder?(target: { folderId: string; name: string }): void;
  /** Open folder (sheet first, then folder view) that a window drop files into; null = shelf root. */
  onImportContextChange?(target: { folderId: string; name: string } | null): void;
  /** Folder under an OS file drag (Windows), highlighted like a book drag. */
  externalDropFolderId?: string | null;
  /** Directory import entry; absent hides it. */
  onImportFolder?(): void;
  onImportArchive(): void;
  /**
   * `selectedEntries` is handled by App and resolved to 64-bit content hashes
   * before any native job is created. Absent on a shelf without library services.
   */
  onExportArchive?(selectedEntries?: ShelfEntry[]): void;
  /** The title switcher between the library and other shelves; absent shows a plain title. */
  shelfSwitch?: ShelfSwitchProps;
  /**
   * False on a shelf that keeps to itself (the private shelf): settings drop
   * data, sync, library location, the import folder, the index and diagnostics.
   */
  libraryServices?: boolean;
  /** SBE-U: save original EPUB files; no entries means the whole shelf. */
  onExportBooks?(selectedEntries?: ShelfEntry[]): void;
  /** Windows: show the book's file in File Explorer; absent hides the action. */
  onRevealSource?(entry: ShelfEntry): void;
  /** ER-0151: Windows/Android library shelf uploads original files to the connected cloud drive. */
  cloudUpload?: boolean;
  /** ER-0045: move one book into or out of the private shelf; absent hides the action. */
  shelfMove?: { direction: "toPrivate" | "toLibrary"; onMove(entry: ShelfEntry): void };
  /** Legacy v1/v2 JSON import stays secondary on native; Web can leave this undefined and use its existing entry. */
  onImportLegacyArchive?(): void;
  /** ER-0138: single-book KOReader progress import; absent hides the row. */
  onImportKoreader?(): void;
  onDelete(id: string): void;
  /** 批量删除（选中多本时由确认弹窗调用） */
  onDeleteMany(ids: string[]): void;
  /** Optional native cache/source-cover bridge; browser compatibility uses ShelfStore. */
  thumbnailProvider?: ThumbnailProvider;
  /** Optional shared library-body search projection; absent keeps the metadata-only shelf. */
  searchMode?: ShelfSearchMode;
  onSearchModeChange?(mode: ShelfSearchMode): void;
  bodySearch?: ShelfBodySearchProps;
  /** 预留接口：文件夹列表扩展 */
  folders?: ShelfFolder[];
  /** 预留接口：当前浏览文件夹 ID（null 为根目录） */
  currentFolderId?: string | null;
  /** 预留接口：打开文件夹回调 */
  onOpenFolder?(folderId: string): void;
  /** 预留接口：批量移动书籍至目标文件夹 */
  onMoveToFolder?(entryIds: string[], targetFolderId: string | null): void;
  /** Android Back 根协调：书架注册当前前台层退出器；返回 false 表示无层可退。 */
  registerBackHandler?(handler: (() => boolean) | null): void;
  /** 书架是否存在可被 Back 消费的前景层，供 App 决定是否接管系统 Back。 */
  onBackAvailabilityChange?(active: boolean): void;
}

/* =========================================================================
 * 主书架视图
 * ========================================================================= */


/** 拖书时距可视区上下边缘多少 CSS px 开始自动滚动，及每帧最大滚动量。 */
const SHELF_DRAG_AUTOSCROLL_ZONE_PX = 72;
const SHELF_DRAG_AUTOSCROLL_MAX_PX = 14;

/** 书架三档密度的显示名与快捷按钮循环顺序（舒适 → 标准 → 紧凑 → 舒适）。 */
const SHELF_DENSITY_LABEL: Record<ShelfDensity, PlainMessageKey> = {
  comfortable: "shelfMain.density.comfortable",
  standard: "shelfMain.density.standard",
  compact: "shelfMain.density.compact",
};

const NEXT_SHELF_DENSITY: Record<ShelfDensity, ShelfDensity> = {
  comfortable: "standard",
  standard: "compact",
  compact: "comfortable",
};

/** Drawn back to back right after the shelf's first paint (no idle wait). */
const SETTINGS_WARM_BATCHES: readonly PanelWarmBatch[] = [["shelf-settings"], ["shelf-settings-pages"]];

const SHELF_SORTS: readonly ShelfSort[] = ["recent", "added", "title", "progress"];
const FOLDER_SORT_STORAGE_KEY = "epub_shelf_folder_sort";
const FOLDER_PREFIX_EXPANDED_STORAGE_KEY = "epub_shelf_folders_expanded";

export function ShelfView(props: ShelfViewProps) {
  const { t, tn } = useUiText();
  const organization = props.organization ?? emptyOrganization();
  const [internalScope, setInternalScope] = useState<ShelfScope>(props.scope ?? { type: "root" });
  const scope = props.scope ?? internalScope;
  const setScope = useCallback(
    (s: ShelfScope) => {
      if (props.onScopeChange) props.onScopeChange(s);
      else setInternalScope(s);
      setSelectedIds(new Set());
    },
    [props.onScopeChange]
  );

  const sessionMemory = props.sessionMemory;
  const [query, setQuery] = useState(() => sessionMemory?.query ?? "");
  const [shelfSort, setShelfSort] = useState<ShelfSort>(() => sessionMemory?.sort ?? "recent");
  // 文件夹内（弹窗与全页文件夹）共用一个本机排序；未选过时跟随书架排序，改它不重排根层。
  const [folderSortChoice, setFolderSortChoice] = useState<ShelfSort | null>(() => {
    try {
      const stored = localStorage.getItem(FOLDER_SORT_STORAGE_KEY);
      return SHELF_SORTS.includes(stored as ShelfSort) ? stored as ShelfSort : null;
    } catch {
      return null;
    }
  });
  const folderSort = folderSortChoice ?? shelfSort;
  const chooseFolderSort = useCallback((next: ShelfSort): void => {
    setFolderSortChoice(next);
    try {
      localStorage.setItem(FOLDER_SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);
  const sort = scope.type === "folder" ? folderSort : shelfSort;
  const setSort = scope.type === "folder" ? chooseFolderSort : setShelfSort;
  const [density, setDensityState] = useState<ShelfDensity>(() => {
    try {
      const stored = localStorage.getItem("epub_shelf_density");
      return stored === "comfortable" || stored === "compact" ? stored : "standard";
    } catch {
      return "standard";
    }
  });
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    try {
      return (localStorage.getItem("epub_shelf_view_mode") as "grid" | "list") || "grid";
    } catch {
      return "grid";
    }
  });
  const [statusTab, setStatusTab] = useState<ShelfStatusTab>(() => sessionMemory?.statusTab ?? "all");
  useEffect(() => {
    if (!sessionMemory) return;
    sessionMemory.query = query;
    sessionMemory.sort = shelfSort;
    sessionMemory.statusTab = statusTab;
  }, [sessionMemory, query, shelfSort, statusTab]);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const folderDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!folderMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!folderDropdownRef.current?.contains(e.target as Node)) {
        setFolderMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFolderMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [folderMenuOpen]);

  const quickInputRef = useRef<HTMLInputElement | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Two frames after mount the shelf has painted; warm-ups start only then.
  const [shelfPainted, setShelfPainted] = useState(false);
  useEffect(() => {
    const frames = typeof window.requestAnimationFrame === "function";
    const schedule = frames
      ? window.requestAnimationFrame
      : ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    const cancel = frames ? window.cancelAnimationFrame : window.clearTimeout;
    let second = 0;
    const first = schedule(() => { second = schedule(() => setShelfPainted(true)); });
    return () => { cancel(first); cancel(second); };
  }, []);
  // The gear carries both the update dot and a sync failure that needs the user.
  const appUpdateDot = useAppUpdateDot();
  const syncAttention = useCloudSyncAttention();
  const updateDot = appUpdateDot || syncAttention;
  const settingsLabel = [t("shelfSettings.title"), ...(appUpdateDot ? [t("about.update.dot")] : []),
    ...(syncAttention ? [t("cloudSync.attention")] : [])].join(" · ");
  const [settingsSection, setSettingsSection] = useState<ShelfSettingsSection | undefined>(undefined);
  const [filterOpen, setFilterOpen] = useState(false);
  const [bodySearchOpen, setBodySearchOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const [filters, setFilters] = useState<ShelfFilters>(EMPTY_SHELF_FILTERS);
  const [selectionMode, setSelectionMode] = useState(false);
  // ER-0151: the upload panel (not its collapsed card) takes back presses; a running job disables new uploads.
  const cloudUpload = useCloudBookUpload();
  const cloudUploadOpen = Boolean(props.cloudUpload) && cloudUpload.panel.kind !== "closed" && !cloudUpload.collapsed;
  const cloudUploadRunning = cloudBookUploadBusy(cloudUpload);
  const [dockClosing, setDockClosing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[] | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [dissolveFolderTarget, setDissolveFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveDialogTargetIds, setMoveDialogTargetIds] = useState<string[] | null>(null);
  const [deleteTargetsClosing, setDeleteTargetsClosing] = useState(false);
  const [toastLetter, setToastLetter] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const pendingLetterTargetRef = useRef<{ targetIndex: number; targetId: string | null } | null>(null);
  const shelfViewRef = useRef<HTMLDivElement | null>(null);
  const [submenuBackActive, setSubmenuBackActive] = useState(false);
  const submenuBackHandlerRef = useRef<(() => boolean) | null>(null);

  const registerSubmenuBackHandler = useCallback((handler: (() => boolean) | null): void => {
    submenuBackHandlerRef.current = handler;
  }, []);

  const reportSubmenuBackActive = useCallback((active: boolean): void => {
    setSubmenuBackActive(active);
  }, []);

  const isCompactMobile = !!props.compact;
  // ER-0158: the desktop dock steps down (no count, then compact buttons) instead of running off a narrow window.
  const batchDockRef = useRef<HTMLDivElement | null>(null);
  const batchDockKey = [
    t("shelfMain.dock.hint"),
    selectedIds.size,
    Boolean(props.onExportArchive),
    Boolean(props.onExportBooks),
    Boolean(getRuntimeCapabilities().supportsLanTransfer && props.onOpenLanTransfer),
    Boolean(props.cloudUpload),
  ].join("|");
  useBatchDockFit(batchDockRef, (selectionMode || dockClosing) && !isCompactMobile, batchDockKey);
  const [coarsePointer] = useState(() => {
    try {
      return window.matchMedia?.("(pointer: coarse)").matches === true;
    } catch {
      return false;
    }
  });
  // 无悬停能力的设备从一开始就按触屏处理悬停样式；之后跟随实际输入切换。
  const [initialShelfInput] = useState<"touch" | undefined>(() => {
    try {
      return window.matchMedia?.("(hover: none)").matches === true ? "touch" : undefined;
    } catch {
      return undefined;
    }
  });
  // Without a library state (tests, older hosts) the list is taken as already read.
  const library: ShelfLibraryView = props.libraryState ?? { kind: "ready", refreshError: null };
  const emptyShelfHint = getRuntimeCapabilities().platform === "android"
    ? t("shelfMain.empty.hint.android")
    : t("shelfMain.empty.hint.desktop");
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const categoryDropdownRef = useRef<HTMLDivElement | null>(null);
  // 默认展开；沿用本机选择，避免开书后返回时因书架重建而重置。
  const [folderPrefixExpanded, setFolderPrefixExpanded] = useState(() => {
    try {
      return localStorage.getItem(FOLDER_PREFIX_EXPANDED_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const toggleFolderPrefix = () => {
    const next = !folderPrefixExpanded;
    setFolderPrefixExpanded(next);
    try {
      localStorage.setItem(FOLDER_PREFIX_EXPANDED_STORAGE_KEY, String(next));
    } catch {}
  };

  const [folderActiveMoreOpen, setFolderActiveMoreOpen] = useState(false);
  const folderActiveMoreRef = useRef<HTMLDivElement | null>(null);

  useShelfSubmenuBack(categoryMenuOpen, () => setCategoryMenuOpen(false), {
    registerSubmenuBackHandler,
    onSubmenuBackActiveChange: reportSubmenuBackActive,
  });

  useShelfSubmenuBack(folderMenuOpen, () => setFolderMenuOpen(false), {
    registerSubmenuBackHandler,
    onSubmenuBackActiveChange: reportSubmenuBackActive,
  });

  useShelfSubmenuBack(folderActiveMoreOpen, () => setFolderActiveMoreOpen(false), {
    registerSubmenuBackHandler,
    onSubmenuBackActiveChange: reportSubmenuBackActive,
  });


  useEffect(() => {
    if (!categoryMenuOpen) return;
    const onDown = (e: MouseEvent | PointerEvent) => {
      if (!categoryDropdownRef.current?.contains(e.target as Node)) {
        setCategoryMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCategoryMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [categoryMenuOpen]);

  useEffect(() => {
    if (!folderActiveMoreOpen) return;
    const onDown = (e: MouseEvent | PointerEvent) => {
      if (!folderActiveMoreRef.current?.contains(e.target as Node)) {
        setFolderActiveMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFolderActiveMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [folderActiveMoreOpen]);

  const handleTouchLongPressSelect = useCallback((id: string): void => {
    setSelectedIds(new Set([id]));
    setDockClosing(false);
    setSelectionMode(true);
  }, []);

  // ---- 书架唯一的操作菜单：三点、右键、触屏长按文件夹都由这里接管 ----
  const [menu, setMenu] = useState<ShelfMenuSession | null>(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const [menuPending, setMenuPending] = useState<{ token: number; action: ShelfActionId } | null>(null);
  const [menuError, setMenuError] = useState<{ token: number; text: string } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const menuTokenRef = useRef(0);
  const menuCloseTimerRef = useRef<number | null>(null);
  const menuPendingRef = useRef(menuPending);
  menuPendingRef.current = menuPending;

  const clearMenuCloseTimer = useCallback((): void => {
    if (menuCloseTimerRef.current === null) return;
    window.clearTimeout(menuCloseTimerRef.current);
    menuCloseTimerRef.current = null;
  }, []);

  /** Closes the current menu; a menu opened meanwhile is never unmounted by this timer. */
  const closeMenu = useCallback((options?: { restoreFocus?: boolean; immediate?: boolean }): void => {
    const current = menuRef.current;
    if (!current) return;
    if (options?.restoreFocus !== false && current.trigger?.isConnected) {
      current.trigger.focus({ preventScroll: true });
    }
    if (options?.immediate) {
      clearMenuCloseTimer();
      menuRef.current = null;
      setMenu(null);
      setMenuClosing(false);
      return;
    }
    if (menuCloseTimerRef.current !== null) return;
    setMenuClosing(true);
    const token = current.token;
    menuCloseTimerRef.current = window.setTimeout(() => {
      menuCloseTimerRef.current = null;
      if (menuRef.current?.token !== token) return;
      menuRef.current = null;
      setMenu(null);
      setMenuClosing(false);
    }, menuCloseMs());
  }, [clearMenuCloseTimer]);

  const requestMenu = useCallback((target: ShelfMenuTarget, opener: ShelfMenuOpener): void => {
    const current = menuRef.current;
    if (opener.toggle && current && menuCloseTimerRef.current === null && sameShelfMenuTarget(current.target, target)) {
      closeMenu();
      return;
    }
    // 新菜单直接接管：关闭中的旧菜单立即让位，它的定时器不会再卸载新菜单。
    clearMenuCloseTimer();
    const rect = opener.point
      ? { left: opener.point.x, right: opener.point.x, top: opener.point.y, bottom: opener.point.y }
      : opener.trigger?.getBoundingClientRect() ?? { left: 0, right: 0, top: 0, bottom: 0 };
    const session: ShelfMenuSession = {
      token: ++menuTokenRef.current,
      target,
      presentation: shelfMenuPresentation(opener.pointerType, coarsePointer),
      anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      trigger: opener.trigger,
      focusFirstItem: opener.keyboard,
    };
    menuRef.current = session;
    setMenu(session);
    setMenuClosing(false);
    setMenuError(null);
  }, [clearMenuCloseTimer, closeMenu, coarsePointer]);

  const dismissMenu = useCallback((): void => closeMenu(), [closeMenu]);

  useEffect(() => clearMenuCloseTimer, [clearMenuCloseTimer]);

  const deleteCloseTimerRef = useRef<number | null>(null);
  const handleCancelDelete = useCallback(() => {
    if (deleteCloseTimerRef.current !== null) return;
    setDeleteTargetsClosing(true);
    deleteCloseTimerRef.current = window.setTimeout(() => {
      deleteCloseTimerRef.current = null;
      setDeleteTargetIds(null);
      setDeleteTargetsClosing(false);
    }, MENU_CLOSE_MS);
  }, []);

  /** A new confirmation takes over a closing one instead of being cleared by its timer. */
  const requestDelete = useCallback((ids: string[]): void => {
    if (ids.length === 0) return;
    if (deleteCloseTimerRef.current !== null) {
      window.clearTimeout(deleteCloseTimerRef.current);
      deleteCloseTimerRef.current = null;
    }
    setDeleteTargetsClosing(false);
    setDeleteTargetIds(ids);
  }, []);

  // 全局快捷键：按 / 键聚焦快速书名过滤框，按 Esc 退出批量选择模式
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag !== "input" && tag !== "textarea" && tag !== "select" && !target?.isContentEditable) {
          e.preventDefault();
          quickInputRef.current?.focus();
          quickInputRef.current?.select();
        }
      }
      if (e.key === "Escape" && selectionMode) {
        exitSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectionMode]);

  const setDensity = useCallback((next: ShelfDensity) => {
    setDensityState(next);
    try {
      localStorage.setItem("epub_shelf_density", next);
    } catch {}
  }, []);

  const handleViewModeChange = useCallback((mode: "grid" | "list") => {
    setViewMode(mode);
    try {
      localStorage.setItem("epub_shelf_view_mode", mode);
    } catch {}
  }, []);

  // 文件夹弹窗状态（手机拟物居中展开弹窗）
  const [activeFolderModal, setActiveFolderModal] = useState<{
    folderId: string;
    originRect?: DOMRect;
  } | null>(null);
  const [folderModalClosing, setFolderModalClosing] = useState(false);
  const folderModalClosingRef = useRef(false);
  const activeFolderModalRef = useRef(activeFolderModal);
  activeFolderModalRef.current = activeFolderModal;
  const folderModalRef = useRef<HTMLDivElement>(null);
  const isDraggingFromFolderModalRef = useRef(false);
  const draggedFromFolderIdRef = useRef<string | null>(null);

  // 拖拽整理状态（类似手机端长按书本拖动整理）
  const [draggedEntry, setDraggedEntry] = useState<ShelfEntry | null>(null);
  const [dragCoord, setDragCoord] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<
    | { type: "folder"; id: string }
    | { type: "book"; id: string }
    | null
  >(null);
  const [pendingMergeIds, setPendingMergeIds] = useState<string[] | null>(null);

  const draggedEntryRef = useRef<ShelfEntry | null>(null);
  draggedEntryRef.current = draggedEntry;

  const dropTargetRef = useRef<typeof dropTarget>(null);
  dropTargetRef.current = dropTarget;

  const entriesRef = useRef(props.entries);
  entriesRef.current = props.entries;

  // 弹层与菜单只按稳定 id 指向书：每次渲染从当前真实资料取对象，书不在了就安全关闭。
  const entriesById = useMemo(() => new Map(props.entries.map((entry) => [entry.id, entry])), [props.entries]);
  const entriesByIdRef = useRef(entriesById);
  entriesByIdRef.current = entriesById;
  const resolveEntries = useCallback((ids: string[] | null): ShelfEntry[] | null => {
    if (!ids) return null;
    const found = ids.flatMap((id) => entriesById.get(id) ?? []);
    return found.length > 0 ? found : null;
  }, [entriesById]);
  const deleteTargets = useMemo(() => resolveEntries(deleteTargetIds), [resolveEntries, deleteTargetIds]);
  const moveDialogTargets = useMemo(() => resolveEntries(moveDialogTargetIds), [resolveEntries, moveDialogTargetIds]);
  const pendingMergeBooks = useMemo(() => resolveEntries(pendingMergeIds), [resolveEntries, pendingMergeIds]);
  useEffect(() => {
    if (deleteTargetIds && !deleteTargets) setDeleteTargetIds(null);
    if (moveDialogTargetIds && !moveDialogTargets) setMoveDialogTargetIds(null);
    if (pendingMergeIds && (pendingMergeBooks?.length ?? 0) < pendingMergeIds.length) {
      // 合并的一本已离开书架：放弃这次合并，不对旧对象建文件夹。
      setPendingMergeIds(null);
      setCreateFolderOpen(false);
    }
  }, [deleteTargetIds, deleteTargets, moveDialogTargetIds, moveDialogTargets, pendingMergeIds, pendingMergeBooks]);

  /** Swallows only the click dispatched with the pointerup that ended a drag. */
  const dragJustEndedRef = useRef(false);
  const markDragEnded = useCallback((): void => {
    dragJustEndedRef.current = true;
    window.setTimeout(() => { dragJustEndedRef.current = false; }, 0);
  }, []);

  /** The click ending a gesture whose long press acted reaches no card, even if books moved under the finger. */
  const [gestureTail] = useState(() => new ShelfGestureTail());
  const armGestureTail = useCallback((): void => gestureTail.arm(), [gestureTail]);

  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const activeFolders = useMemo(() => {
    return Object.entries(organization.folders)
      .filter(([_, folder]) => !folder.deleted)
      .map(([id, folder]) => ({
        id,
        name: folder.name.value,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
  }, [organization.folders]);

  // 自愈：如果当前文件夹 scope 已被解散或不存在，自动切回根目录
  useEffect(() => {
    if (scope.type === "folder" && !activeFolders.some((f) => f.id === scope.folderId)) {
      setScope({ type: "root" });
    }
  }, [scope, activeFolders, setScope]);

  const currentFolder =
    scope.type === "folder" ? activeFolders.find((f) => f.id === scope.folderId) : undefined;

  // Imports started inside a folder file their books there; the open sheet wins over the folder view.
  const modalFolder = activeFolderModal ? activeFolders.find((f) => f.id === activeFolderModal.folderId) : undefined;
  const importContextId = (modalFolder ?? currentFolder)?.id;
  const importContextName = (modalFolder ?? currentFolder)?.name;
  const { onImport, onImportIntoFolder, onImportContextChange } = props;
  useEffect(() => {
    if (!onImportContextChange) return;
    onImportContextChange(importContextId !== undefined && importContextName !== undefined
      ? { folderId: importContextId, name: importContextName }
      : null);
    return () => onImportContextChange(null);
  }, [importContextId, importContextName, onImportContextChange]);
  const importInto = useCallback((folder: { id: string; name: string } | undefined): void => {
    if (folder && onImportIntoFolder) onImportIntoFolder({ folderId: folder.id, name: folder.name });
    else onImport();
  }, [onImport, onImportIntoFolder]);
  const importHere = useCallback((): void => importInto(currentFolder), [currentFolder, importInto]);
  const importTargetName = currentFolder && props.onImportIntoFolder ? currentFolder.name : undefined;
  const onOpenLanTransfer = props.onOpenLanTransfer;
  const openLanTransferFromImport = useMemo(
    () => getRuntimeCapabilities().supportsLanTransfer && onOpenLanTransfer ? () => onOpenLanTransfer() : undefined,
    [onOpenLanTransfer],
  );
  // Same rule as the 设置 → 数据与备份 row: a running transfer can always be reopened.
  const lanTransferImportDisabled = !props.lanTransferActive && Boolean(props.saveFileActive);
  const [addBooksFolder, setAddBooksFolder] = useState<{ id: string; name: string } | null>(null);

  const { folderBooksMap, unclassifiedBooks, favoriteBooks } = useMemo(() => {
    const folderMap = new Map<string, ShelfEntry[]>();
    for (const f of activeFolders) {
      folderMap.set(f.id, []);
    }
    const unclassified: ShelfEntry[] = [];
    const favorites: ShelfEntry[] = [];

    for (const entry of props.entries) {
      const hash = entry.contentHash ?? entry.id;
      const fId = effectiveFolderId(organization, hash);
      if (fId && folderMap.has(fId)) {
        folderMap.get(fId)!.push(entry);
      } else {
        unclassified.push(entry);
      }

      if (isFavorite(organization, hash)) {
        favorites.push(entry);
      }
    }
    // Books inside a folder follow the shelf sort too; the first one represents the folder.
    for (const [id, books] of folderMap) folderMap.set(id, sortShelfEntries(books, shelfSort));
    return { folderBooksMap: folderMap, unclassifiedBooks: unclassified, favoriteBooks: favorites };
  }, [organization, props.entries, activeFolders, shelfSort]);

  const bookExportDisabled = Boolean(props.busy || props.saveFileActive || props.lanTransferActive);
  const handleExportFolderBooks = useCallback((folderId: string): void => {
    const books = folderBooksMap.get(folderId) ?? [];
    if (books.length > 0) props.onExportBooks?.(books);
  }, [folderBooksMap, props.onExportBooks]);

  // Level 3 状态分流计数
  const { allCount, readingCount, unreadCount, finishedCount, favoriteCount } = useMemo(() => {
    const source = scope.type === "folder" ? (folderBooksMap.get(scope.folderId) ?? []) : props.entries;
    let read = 0;
    let unread = 0;
    let finished = 0;
    let fav = 0;
    for (const entry of source) {
      const hash = entry.contentHash ?? entry.id;
      if (isFavorite(organization, hash)) fav++;
      const status = shelfReadingStatus(entry);
      if (status === "finished") {
        finished++;
      } else if (status === "reading") {
        read++;
      } else {
        unread++;
      }
    }
    return {
      allCount: source.length,
      readingCount: read,
      unreadCount: unread,
      finishedCount: finished,
      favoriteCount: fav,
    };
  }, [scope, folderBooksMap, props.entries, organization]);

  const categoryLabels = useMemo<Record<ShelfStatusTab, string>>(() => ({
    all: t("shelfMain.category.all"),
    reading: t("shelfMain.category.reading"),
    unread: t("shelfMain.category.unread"),
    finished: t("shelfMain.category.finished"),
    favorites: t("shelfMain.category.favorites"),
  }), [t]);

  const categoryCounts = useMemo<Record<ShelfStatusTab, number>>(() => ({
    all: allCount,
    reading: readingCount,
    unread: unreadCount,
    finished: finishedCount,
    favorites: favoriteCount,
  }), [allCount, readingCount, unreadCount, finishedCount, favoriteCount]);

  const searching = query.trim() !== "";
  const scopedCandidateBooks = useMemo(() => {
    switch (scope.type) {
      case "root":
        // By folder: the root lists unfiled books, but a search covers the books inside folders too.
        return searching ? props.entries : unclassifiedBooks;
      case "all":
        return props.entries;
      case "favorites":
        return favoriteBooks;
      case "folder":
        return folderBooksMap.get(scope.folderId) ?? [];
    }
  }, [scope, searching, unclassifiedBooks, props.entries, favoriteBooks, folderBooksMap]);

  // 结合 Level 3 状态胶囊的分流筛选
  const statusFilteredBooks = useMemo(() => {
    const base = scope.type === "folder" ? (folderBooksMap.get(scope.folderId) ?? []) : props.entries;
    switch (statusTab) {
      case "reading":
        return base.filter((e) => shelfReadingStatus(e) === "reading");
      case "unread":
        return base.filter((e) => shelfReadingStatus(e) === "unread");
      case "finished":
        return base.filter((e) => shelfReadingStatus(e) === "finished");
      case "favorites":
        return scope.type === "folder"
          ? base.filter((e) => isFavorite(organization, e.contentHash ?? e.id))
          : favoriteBooks;
      case "all":
      default:
        return scopedCandidateBooks;
    }
  }, [statusTab, scope.type, folderBooksMap, scopedCandidateBooks, props.entries, organization, favoriteBooks]);

  const filterModel = useMemo(
    () =>
      createShelfFilterModel(statusFilteredBooks, {
        authors: [...filters.authors],
        titles: [...filters.titles],
        timeSegments: [...filters.saved],
        languages: [...filters.languages],
        query,
      }),
    [statusFilteredBooks, query, filters]
  );

  const visible = useMemo(
    () => sortShelfEntries(filterModel.entries, sort),
    [filterModel.entries, sort]
  );

  /** Status tab or drawer facets narrow the list (the query is reported separately). */
  const narrowedByFilters = statusTab !== "all" || filters.authors.size + filters.titles.size
    + filters.saved.size + filters.languages.size > 0;
  const clearShelfFilters = (): void => {
    setStatusTab("all");
    setFilters({ authors: new Set(), titles: new Set(), saved: new Set(), languages: new Set() });
  };

  const visibleFolders = useMemo(() => {
    if (scope.type !== "root") return [];
    if (statusTab !== "all") return [];
    const q = query.trim().toLowerCase();
    const matched = q ? activeFolders.filter((f) => f.name.toLowerCase().includes(q)) : activeFolders;
    return sortShelfFolders(matched, folderBooksMap, shelfSort);
  }, [scope, statusTab, activeFolders, query, folderBooksMap, shelfSort]);

  const virtualizer = useShelfVirtualizer(
    shelfViewRef,
    visible.length,
    viewMode,
    density,
    // 收起的文件夹卡片不占位：按实际画出的张数重测书籍区起点。
    isCompactMobile && viewMode === "grid" && !folderPrefixExpanded ? 0 : visibleFolders.length,
    40,
    `${scope.type === "folder" ? scope.folderId : "root"}|${statusTab}|${query}`
  );

  const renderedBooks = useMemo(() => {
    if (!virtualizer.isVirtual) return visible;
    return visible.slice(virtualizer.startIndex, virtualizer.endIndex);
  }, [visible, virtualizer]);

  const letterFirstIndexMap = useMemo(() => {
    if (sort !== "title") return new Map<string, number>();
    const map = new Map<string, number>();
    for (let i = 0; i < visible.length; i++) {
      const letter = getInitialLetter(visible[i].title);
      if (!map.has(letter)) {
        map.set(letter, i);
      }
    }
    return map;
  }, [visible, sort]);

  const scrollShelfToOffset = useCallback((top: number): void => {
    const container = shelfViewRef.current;
    if (!container) return;
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top, behavior: "smooth" });
    } else {
      container.scrollTop = top;
    }
  }, []);

  const handleSelectLetter = useCallback(
    (letter: string, targetIndex: number) => {
      setToastLetter(letter);
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        setToastLetter(null);
        toastTimerRef.current = null;
      }, 350);

      const geometry = virtualizer.gridGeometry;
      if (!geometry) {
        // 几何未测量时延后到测量完成，不退回另一套列宽估算。
        pendingLetterTargetRef.current = {
          targetIndex,
          targetId: visible[targetIndex]?.id ?? null,
        };
        return;
      }
      scrollShelfToOffset(
        geometry.contentTop + Math.floor(targetIndex / geometry.columns) * geometry.rowStep
      );
    },
    [scrollShelfToOffset, virtualizer.gridGeometry, visible]
  );

  useEffect(() => {
    const pending = pendingLetterTargetRef.current;
    if (!pending || !virtualizer.gridGeometry) return;
    const targetIndex = pending.targetId
      ? visible.findIndex((entry) => entry.id === pending.targetId)
      : pending.targetIndex;
    pendingLetterTargetRef.current = null;
    if (targetIndex < 0) return;
    const geometry = virtualizer.gridGeometry;
    scrollShelfToOffset(
      geometry.contentTop + Math.floor(targetIndex / geometry.columns) * geometry.rowStep
    );
  }, [scrollShelfToOffset, viewMode, virtualizer.gridGeometry, visible]);

  const thumbnailProvider = props.thumbnailProvider ?? legacyThumbnailProvider;

  // Visible books plus whole visible folders (a folder selects all its books, whatever the book filters).
  const selectableIds = useMemo(
    () => selectableBookIds(visible, visibleFolders.map((folder) => folderBooksMap.get(folder.id) ?? [])),
    [visible, visibleFolders, folderBooksMap],
  );

  // 当可选范围变化（筛选/scope/文件夹成员）时，自动清理已不可选的书
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visibleIds = selectableIds;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectableIds]);

  const toggleSelected = useCallback((id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleFolderSelected = useCallback((folderId: string): void => {
    const books = folderBooksMap.get(folderId) ?? [];
    setSelectedIds((prev) => toggleFolderSelection(books, prev));
  }, [folderBooksMap]);

  const enterSelection = (): void => {
    setSelectedIds(new Set());
    setDockClosing(false);
    setSelectionMode(true);
  };

  const noneSelected = selectedIds.size === 0;
  const exitSelection = useCallback((): void => {
    setDockClosing(true);
    window.setTimeout(() => {
      setSelectionMode(false);
      setDockClosing(false);
      setSelectedIds(new Set());
    }, menuCloseMs());
  }, []);

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    menuButtonRef.current?.focus();
  }, []);
  const openSettings = useCallback((section?: ShelfSettingsSection): void => {
    setBodySearchOpen(false);
    setFilterOpen(false);
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const closeFilter = useCallback((): void => {
    setFilterOpen(false);
    filterButtonRef.current?.focus();
  }, []);
  const closeBodySearch = useCallback((): void => setBodySearchOpen(false), []);
  // 正文搜索只在书架搜索框里：PC 在框下展开结果，手机进入全屏搜索页，离开时回到书名作者。
  const bodySearch = props.onSearchModeChange ? props.bodySearch : undefined;
  const searchMode = bodySearch ? props.searchMode ?? "metadata" : "metadata";
  const onSearchModeChange = props.onSearchModeChange;
  const changeSearchMode = useCallback((mode: ShelfSearchMode): void => {
    if (mode === "body") {
      setQuery("");
      setBodySearchOpen(true);
    } else {
      setBodySearchOpen(false);
    }
    onSearchModeChange?.(mode);
  }, [onSearchModeChange]);
  const leaveBodySearch = useCallback((): void => {
    setBodySearchOpen(false);
    if (isCompactMobile) onSearchModeChange?.("metadata");
  }, [isCompactMobile, onSearchModeChange]);
  const filterCount = shelfFilterCount(filters);

  /** Resolves false on failure; App has already reported it through the shelf notice. */
  const applyFavorite = useCallback(
    async (targets: ShelfEntry[], value: boolean): Promise<boolean> => {
      const hashes = targets.map((e) => e.contentHash ?? e.id);
      if (hashes.length === 0 || !props.onApplyOrganization) return false;
      try {
        await props.onApplyOrganization({ type: "setFavorite", contentHashes: hashes, value });
        return true;
      } catch {
        return false;
      }
    },
    [props.onApplyOrganization]
  );

  const handleToggleFavorite = useCallback(
    (entry: ShelfEntry): void => {
      void applyFavorite([entry], !isFavorite(organization, entry.contentHash ?? entry.id));
    },
    [applyFavorite, organization]
  );

  const handleBatchFavorite = useCallback(
    async (value: boolean): Promise<void> => {
      const targets = props.entries.filter((e) => selectedIds.has(e.id));
      // 失败时保留选择，方便直接重试。
      if (await applyFavorite(targets, value)) exitSelection();
    },
    [applyFavorite, selectedIds, props.entries]
  );

  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const handleOpenFolderModal = useCallback((folderId: string, element?: HTMLElement | null) => {
    folderModalClosingRef.current = false;
    setFolderModalClosing(false);
    const rect = element ? element.getBoundingClientRect() : undefined;
    setActiveFolderModal({ folderId, originRect: rect });
  }, []);

  const handleCloseFolderModal = useCallback(() => {
    if (folderModalClosingRef.current) return;
    folderModalClosingRef.current = true;
    setFolderModalClosing(true);
    window.setTimeout(() => {
      setActiveFolderModal(null);
      folderModalClosingRef.current = false;
      setFolderModalClosing(false);
    }, MENU_CLOSE_MS);
  }, []);

  const handleRootBack = useCallback((): boolean => {
    // 原书上传面板在设置之上：返回先收起它（任务进行中只收起，不取消）。
    if (cloudUploadOpen) {
      closeCloudBookUpload();
      return true;
    }
    // 操作菜单总在最上层（包括文件夹弹窗之上），先关它。
    if (menuRef.current && menuCloseTimerRef.current === null) {
      closeMenu();
      return true;
    }
    if (submenuBackHandlerRef.current?.()) return true;
    if (deleteTargets) {
      handleCancelDelete();
      return true;
    }
    if (createFolderOpen) {
      setCreateFolderOpen(false);
      setPendingMergeIds(null);
      return true;
    }
    if (pendingMergeBooks) {
      setPendingMergeIds(null);
      return true;
    }
    if (moveDialogTargets) {
      setMoveDialogTargetIds(null);
      return true;
    }
    if (renameFolderTarget) {
      setRenameFolderTarget(null);
      return true;
    }
    if (dissolveFolderTarget) {
      setDissolveFolderTarget(null);
      return true;
    }
    if (activeFolderModal) {
      handleCloseFolderModal();
      return true;
    }
    if (settingsOpen) {
      closeSettings();
      return true;
    }
    if (filterOpen) {
      closeFilter();
      return true;
    }
    if (bodySearchOpen) {
      leaveBodySearch();
      return true;
    }
    if (folderMenuOpen) {
      setFolderMenuOpen(false);
      return true;
    }
    if (selectionMode) {
      exitSelection();
      return true;
    }
    if (scope.type === "folder") {
      setScope({ type: "root" });
      return true;
    }
    return false;
  }, [
    activeFolderModal,
    cloudUploadOpen,
    closeMenu,
    closeSettings,
    closeFilter,
    filterOpen,
    bodySearchOpen,
    leaveBodySearch,
    createFolderOpen,
    deleteTargets,
    dissolveFolderTarget,
    settingsOpen,
    exitSelection,
    folderMenuOpen,
    handleCancelDelete,
    handleCloseFolderModal,
    moveDialogTargets,
    pendingMergeBooks,
    renameFolderTarget,
    scope.type,
    selectionMode,
    setScope,
  ]);

  const shelfBackHandlerRef = useRef(handleRootBack);
  shelfBackHandlerRef.current = handleRootBack;
  const shelfBackActive = Boolean(
    cloudUploadOpen ||
    (menu && !menuClosing) ||
    deleteTargets ||
    pendingMergeBooks ||
    moveDialogTargets ||
    createFolderOpen ||
    renameFolderTarget ||
    dissolveFolderTarget ||
    activeFolderModal ||
    settingsOpen ||
    filterOpen ||
    bodySearchOpen ||
    folderMenuOpen ||
    selectionMode ||
    submenuBackActive ||
    scope.type === "folder"
  );

  useEffect(() => {
    props.registerBackHandler?.(() => shelfBackHandlerRef.current());
    return () => props.registerBackHandler?.(null);
  }, [props.registerBackHandler]);

  useEffect(() => {
    props.onBackAvailabilityChange?.(shelfBackActive);
    return () => props.onBackAvailabilityChange?.(false);
  }, [props.onBackAvailabilityChange, shelfBackActive]);

  // 触摸拖书只在多选状态或文件夹弹窗内由长按发起：此时挂一个非被动 touchmove，拖动中阻止页面滚动，
  // 否则浏览器接管为平移并发 pointercancel 中断拖动。必须在 touchstart 前就已注册，
  // 合成器才会等主线程决定；未拖动时不拦截，上下滚动照常。
  const touchDragPossible = selectionMode || activeFolderModal !== null;
  useEffect(() => {
    if (!touchDragPossible) return;
    const blockScrollWhileDragging = (e: TouchEvent): void => {
      if (draggedEntryRef.current && e.cancelable) e.preventDefault();
    };
    window.addEventListener("touchmove", blockScrollWhileDragging, { passive: false });
    return () => window.removeEventListener("touchmove", blockScrollWhileDragging);
  }, [touchDragPossible]);

  const handleDragStart = useCallback(
    (entry: ShelfEntry, point: { x: number; y: number }): void => {
      // 先同步 ref：长按触发后的第一帧 touchmove 可能早于重渲染。
      draggedEntryRef.current = entry;
      setDraggedEntry(entry);
      setDragCoord(point);
      setDropTarget(null);
    },
    []
  );

  const handleFolderBookDragStart = useCallback(
    (entry: ShelfEntry, pt: { x: number; y: number }) => {
      if (!activeFolderModalRef.current) return;
      isDraggingFromFolderModalRef.current = true;
      draggedFromFolderIdRef.current = activeFolderModalRef.current.folderId;
      handleDragStart(entry, pt);
    },
    [handleDragStart]
  );

  useEffect(() => {
    if (!draggedEntry) return;

    const handleWindowPointerMove = (e: MouseEvent | PointerEvent): void => {
      setDragCoord({ x: e.clientX, y: e.clientY });

      // 1. 如果是从文件夹弹窗中长按拖拽出来的书籍，检测是否移出了弹窗容器之外
      if (
        isDraggingFromFolderModalRef.current &&
        folderModalRef.current &&
        !folderModalClosingRef.current
      ) {
        const modalRect = folderModalRef.current.getBoundingClientRect();
        const padding = 8;
        const isOutside =
          e.clientX < modalRect.left - padding ||
          e.clientX > modalRect.right + padding ||
          e.clientY < modalRect.top - padding ||
          e.clientY > modalRect.bottom + padding;

        if (isOutside) {
          isDraggingFromFolderModalRef.current = false;
          handleCloseFolderModal();
        }
      }

      lastDragPoint = { x: e.clientX, y: e.clientY };
      resolveDropTargetAt(e.clientX, e.clientY);
    };

    // 指针不动但列表自动滚动时也要重新命中，所以落点判定独立成函数。
    function resolveDropTargetAt(x: number, y: number): void {
      const elem = document.elementFromPoint(x, y);
      const targetCard = elem?.closest<HTMLElement>("[data-shelf-target]");
      if (!targetCard) {
        setDropTarget(null);
        return;
      }

      const targetType = targetCard.dataset.shelfTarget;
      if (targetType === "folder") {
        const folderId = targetCard.dataset.folderId;
        if (folderId) {
          setDropTarget({ type: "folder", id: folderId });
        }
      } else if (targetType === "book") {
        const bookId = targetCard.dataset.bookId;
        // 如果当前仍在文件夹弹窗内，或者在文件夹页面视图下，不允许书籍合并成新文件夹（单层限制）
        const inFolderScope = scopeRef.current.type === "folder" || isDraggingFromFolderModalRef.current;
        if (
          bookId &&
          bookId !== draggedEntryRef.current?.id &&
          !inFolderScope
        ) {
          setDropTarget({ type: "book", id: bookId });
        } else {
          setDropTarget(null);
        }
      } else {
        setDropTarget(null);
      }
    }

    // 拖到书架可视区上下边缘时自动滚动（底部让出多选操作栏、顶部让出文件夹落点条）。
    let lastDragPoint: { x: number; y: number } | null = null;
    let autoScrollFrame = 0;
    const autoScrollStep = (): void => {
      autoScrollFrame = window.requestAnimationFrame(autoScrollStep);
      const scroller = shelfViewRef.current;
      const point = lastDragPoint;
      if (!scroller || !point) return;
      if (document.elementFromPoint(point.x, point.y)?.closest(".shelf-drag-folder-strip")) return;
      const rect = scroller.getBoundingClientRect();
      const strip = document.querySelector(".shelf-drag-folder-strip")?.getBoundingClientRect();
      // 吸顶的书架顶栏会盖住滚动区顶部，上边缘从顶栏/落点条下沿算起。
      const head = scroller.querySelector(".shelf-head")?.getBoundingClientRect();
      const top = Math.max(rect.top, head ? head.bottom : rect.top, strip ? strip.bottom : rect.top);
      const dock = document.querySelector(".shelf-floating-batch-dock")?.getBoundingClientRect();
      const bottom = Math.min(rect.bottom, dock ? dock.top : rect.bottom);
      const zone = SHELF_DRAG_AUTOSCROLL_ZONE_PX;
      let delta = 0;
      if (point.y < top + zone) delta = -((top + zone - point.y) / zone);
      else if (point.y > bottom - zone) delta = (point.y - (bottom - zone)) / zone;
      if (delta === 0) return;
      const before = scroller.scrollTop;
      // 越靠边越快；每帧至少 2px，避免刚进入边缘区时亚像素步长被取整吞掉。
      const speed = Math.max(2, Math.min(1, Math.abs(delta)) * SHELF_DRAG_AUTOSCROLL_MAX_PX);
      scroller.scrollTop = before + Math.sign(delta) * speed;
      if (scroller.scrollTop !== before) resolveDropTargetAt(point.x, point.y);
    };
    // 无 rAF 的环境（测试 DOM）不做自动滚动，拖放本身不受影响。
    const canAutoScroll = typeof window.requestAnimationFrame === "function";
    if (canAutoScroll) autoScrollFrame = window.requestAnimationFrame(autoScrollStep);

    const handleWindowPointerUp = async (): Promise<void> => {
      // pointerup 与兼容 mouseup 只结算一次。
      const dragged = draggedEntryRef.current;
      draggedEntryRef.current = null;
      const currentTarget = dropTargetRef.current;
      const fromFolderId = draggedFromFolderIdRef.current;
      const wasInsideModal = isDraggingFromFolderModalRef.current;

      // 重置弹窗拖拽状态
      isDraggingFromFolderModalRef.current = false;
      draggedFromFolderIdRef.current = null;

      if (dragged) markDragEnded();

      setDraggedEntry(null);
      setDragCoord(null);
      setDropTarget(null);

      // 以松手时书架里的真实条目为准；拖动中被删除/替换的书不再执行整理。
      const currentDragged = dragged ? entriesByIdRef.current.get(dragged.id) : undefined;
      if (!currentDragged) return;

      if (currentTarget) {
        if (currentTarget.type === "folder") {
          // 如果拖回自身所在的文件夹，则无需操作
          if (currentTarget.id !== fromFolderId) {
            const hash = currentDragged.contentHash ?? currentDragged.id;
            await props.onApplyOrganization?.({
              type: "moveBooks",
              folderId: currentTarget.id,
              contentHashes: [hash],
            }).catch(() => { /* App 已用书架提示报告失败 */ });
          }
        } else if (currentTarget.type === "book") {
          const otherBook = entriesRef.current.find((b) => b.id === currentTarget.id);
          if (otherBook && otherBook.id !== currentDragged.id) {
            setPendingMergeIds([currentDragged.id, otherBook.id]);
            setCreateFolderOpen(true);
          }
        }
      } else if (fromFolderId && !wasInsideModal) {
        // 从文件夹弹窗拖出到外部半透明空白处松手：移出文件夹，回到根目录（未归类）
        const hash = currentDragged.contentHash ?? currentDragged.id;
        await props.onApplyOrganization?.({
          type: "moveBooks",
          folderId: null,
          contentHashes: [hash],
        }).catch(() => { /* App 已用书架提示报告失败 */ });
      }
    };

    const handleWindowPointerCancel = (): void => {
      if (draggedEntryRef.current) markDragEnded();
      draggedEntryRef.current = null;
      isDraggingFromFolderModalRef.current = false;
      draggedFromFolderIdRef.current = null;
      setDraggedEntry(null);
      setDragCoord(null);
      setDropTarget(null);
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: true });
    window.addEventListener("mousemove", handleWindowPointerMove, { passive: true });
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("mouseup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    // 切后台/失焦：撤销拖动，不在回来时按旧落点执行整理。
    const handleHidden = (): void => {
      if (document.visibilityState === "hidden") handleWindowPointerCancel();
    };
    window.addEventListener("blur", handleWindowPointerCancel);
    document.addEventListener("visibilitychange", handleHidden);

    return () => {
      window.removeEventListener("blur", handleWindowPointerCancel);
      document.removeEventListener("visibilitychange", handleHidden);
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("mousemove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("mouseup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
      if (canAutoScroll) window.cancelAnimationFrame(autoScrollFrame);
    };
  }, [draggedEntry, handleCloseFolderModal, markDragEnded, props.onApplyOrganization]);

  // 拖动的书在拖动中离开书架（同步/删除）：直接撤销拖动。
  useEffect(() => {
    if (draggedEntry && !entriesById.has(draggedEntry.id)) {
      draggedEntryRef.current = null;
      isDraggingFromFolderModalRef.current = false;
      draggedFromFolderIdRef.current = null;
      setDraggedEntry(null);
      setDragCoord(null);
      setDropTarget(null);
    }
  }, [draggedEntry, entriesById]);

  // 拖动进行中，以及结束拖动的那一次 pointerup 所带的合成点击，不交给卡片；弹窗区域正常响应。
  // 只按手势吞掉这一次，不设时间窗，松手后的新点击立即可用。
  useEffect(() => {
    const handleDocumentPointerDown = (): void => gestureTail.pointerDown();
    const handleDocumentPointerUp = (): void => gestureTail.pointerUp();
    const handleDocumentClickCapture = (e: MouseEvent): void => {
      if (gestureTail.takeClick(e.detail)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.(
          ".shelf-confirm-backdrop, .shelf-confirm, dialog, [role='dialog'], .shelf-menu-portal-host, .shelf-card-actions-wrap, .shelf-folder-modal"
        )
      ) {
        return;
      }
      if (draggedEntryRef.current || dragJustEndedRef.current) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };
    // Document capture still runs before React's root listeners.
    document.addEventListener("pointerdown", handleDocumentPointerDown, { capture: true });
    document.addEventListener("pointerup", handleDocumentPointerUp, { capture: true });
    document.addEventListener("pointercancel", handleDocumentPointerUp, { capture: true });
    document.addEventListener("click", handleDocumentClickCapture, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown, { capture: true });
      document.removeEventListener("pointerup", handleDocumentPointerUp, { capture: true });
      document.removeEventListener("pointercancel", handleDocumentPointerUp, { capture: true });
      document.removeEventListener("click", handleDocumentClickCapture, { capture: true });
    };
  }, [gestureTail]);

  const handleCreateFolder = useCallback(
    async (name: string): Promise<string> => {
      const folderId = generateFolderId();
      await props.onApplyOrganization?.({
        type: "createFolder",
        folderId,
        name,
      });
      if (pendingMergeBooks && pendingMergeBooks.length > 0) {
        const hashes = pendingMergeBooks.map((b) => b.contentHash ?? b.id);
        await props.onApplyOrganization?.({
          type: "moveBooks",
          folderId,
          contentHashes: hashes,
        });
        setPendingMergeIds(null);
      }
      setCreateFolderOpen(false);
      return folderId;
    },
    [pendingMergeBooks, props.onApplyOrganization]
  );

  const handleRenameFolder = useCallback(
    async (folderId: string, name: string): Promise<void> => {
      await props.onApplyOrganization?.({
        type: "renameFolder",
        folderId,
        name,
      });
      setRenameFolderTarget(null);
    },
    [props.onApplyOrganization]
  );

  const handleDissolveFolder = useCallback(
    async (folderId: string): Promise<void> => {
      await props.onApplyOrganization?.({
        type: "deleteFolder",
        folderId,
      });
      setDissolveFolderTarget(null);
      if (activeFolderModal?.folderId === folderId) {
        handleCloseFolderModal();
      }
      if (scope.type === "folder" && scope.folderId === folderId) {
        setScope({ type: "root" });
      }
    },
    [activeFolderModal?.folderId, handleCloseFolderModal, props.onApplyOrganization, scope, setScope]
  );

  const handleRemoveFromFolder = useCallback(
    async (entry: ShelfEntry): Promise<void> => {
      if (props.busy) return;
      await props.onApplyOrganization?.({
        type: "moveBooks",
        contentHashes: [entry.contentHash ?? entry.id],
        folderId: null,
      });
    },
    [props.busy, props.onApplyOrganization]
  );

  const handleMoveConfirm = useCallback(
    async (targetFolderId: string | null): Promise<void> => {
      if (!moveDialogTargets || moveDialogTargets.length === 0) return;
      const hashes = moveDialogTargets.map((e) => e.contentHash ?? e.id);
      await props.onApplyOrganization?.({
        type: "moveBooks",
        contentHashes: hashes,
        folderId: targetFolderId,
      });
      setMoveDialogTargetIds(null);
      if (selectionMode) exitSelection();
    },
    [moveDialogTargets, props.onApplyOrganization, selectionMode]
  );

  const moveDialogFolderOptions = useMemo(() => {
    return activeFolders.map((f) => ({
      id: f.id,
      name: f.name,
      count: (folderBooksMap.get(f.id) ?? []).length,
    }));
  }, [activeFolders, folderBooksMap]);

  const canOrganize = Boolean(props.onApplyOrganization);

  const handleBookLongPress = useCallback(
    (entry: ShelfEntry, kind: ShelfLongPress, point: { x: number; y: number }): void => {
      armGestureTail();
      if (kind === "select") handleTouchLongPressSelect(entry.id);
      else if (kind === "drag") handleDragStart(entry, point);
    },
    [armGestureTail, handleDragStart, handleTouchLongPressSelect]
  );

  const handleFolderModalLongPress = useCallback(
    (entry: ShelfEntry, kind: ShelfLongPress, point: { x: number; y: number }): void => {
      armGestureTail();
      if (kind === "drag") handleFolderBookDragStart(entry, point);
    },
    [armGestureTail, handleFolderBookDragStart]
  );

  // 菜单目标消失（同步、删除、解散）或其所在的文件夹弹窗已关：立即安全关闭，不对旧对象执行迟到动作。
  const menuTargetGone = menu !== null && (
    menu.target.kind === "book"
      ? !entriesById.has(menu.target.id) || (menu.target.surface === "folderModal" && activeFolderModal === null)
      : !activeFolders.some((folder) => folder.id === menu.target.id)
  );
  useEffect(() => {
    if (menuTargetGone) closeMenu({ immediate: true, restoreFocus: false });
  }, [closeMenu, menuTargetGone]);

  // 底部面板是模态：锁住书架滚动，关闭/卸载时只恢复自己改过的值。
  const sheetLocked = menu?.presentation === "sheet" && !menuClosing;
  useEffect(() => {
    const scroller = shelfViewRef.current;
    if (!sheetLocked || !scroller) return;
    const previous = scroller.style.overflow;
    scroller.style.overflow = "hidden";
    return () => { scroller.style.overflow = previous; };
  }, [sheetLocked]);

  const runMenuAction = useCallback((action: ShelfActionId): void => {
    const session = menuRef.current;
    if (!session || menuCloseTimerRef.current !== null) return;
    const { target, token } = session;
    if (target.kind === "folder") {
      const folder = activeFolders.find((f) => f.id === target.id);
      if (!folder) {
        closeMenu({ immediate: true, restoreFocus: false });
        return;
      }
      closeMenu({ restoreFocus: action !== "openFolder" });
      if (action === "openFolder") handleOpenFolderModal(folder.id, session.trigger?.closest<HTMLElement>(".shelf-folder-card") ?? null);
      else if (action === "renameFolder") setRenameFolderTarget({ id: folder.id, name: folder.name });
      else if (action === "dissolveFolder") setDissolveFolderTarget({ id: folder.id, name: folder.name });
      else if (action === "exportBook") handleExportFolderBooks(folder.id);
      return;
    }
    const entry = entriesByIdRef.current.get(target.id);
    if (!entry) {
      closeMenu({ immediate: true, restoreFocus: false });
      return;
    }
    switch (action) {
      case "open":
        closeMenu({ restoreFocus: false });
        props.onOpen(entry.id);
        return;
      case "openInNewTab":
        closeMenu({ restoreFocus: false });
        props.readerTabs?.onOpenInNewTab(entry.id);
        return;
      case "select":
        closeMenu({ restoreFocus: false });
        handleTouchLongPressSelect(entry.id);
        return;
      case "favorite":
      case "unfavorite":
        closeMenu();
        void applyFavorite([entry], action === "favorite");
        return;
      case "move":
        closeMenu({ restoreFocus: false });
        setMoveDialogTargetIds([entry.id]);
        return;
      case "delete":
        closeMenu({ restoreFocus: false });
        requestDelete([entry.id]);
        return;
      case "exportBook":
        closeMenu({ restoreFocus: false });
        props.onExportBooks?.([entry]);
        return;
      case "uploadToCloud":
        closeMenu({ restoreFocus: false });
        requestCloudBookUpload([entry.contentHash ?? entry.id]);
        return;
      case "revealSource":
        closeMenu();
        props.onRevealSource?.(entry);
        return;
      case "moveToPrivate":
      case "moveToLibrary":
        closeMenu({ restoreFocus: false });
        props.shelfMove?.onMove(entry);
        return;
      case "removeFromFolder": {
        // 同一次菜单内在途时不重复提交；仍可正常返回/关闭。
        if (menuPendingRef.current?.token === token) return;
        const pending = { token, action };
        menuPendingRef.current = pending;
        setMenuPending(pending);
        setMenuError(null);
        void handleRemoveFromFolder(entry).then(() => {
          if (menuRef.current?.token === token) closeMenu();
        }, (error: unknown) => {
          // 结果只回写到发起它的那一次菜单；菜单已换书或已关时由 App 的书架提示报告。
          if (menuRef.current?.token === token) {
            setMenuError({ token, text: uiText("shelf.card.removeFailed", { error: String(error) }) });
          }
        }).finally(() => {
          if (menuPendingRef.current === pending) menuPendingRef.current = null;
          setMenuPending((current) => (current === pending ? null : current));
        });
        return;
      }
    }
  }, [activeFolders, applyFavorite, closeMenu, handleExportFolderBooks, handleOpenFolderModal, handleRemoveFromFolder, handleTouchLongPressSelect, props.onOpen, props.onExportBooks, props.onRevealSource, props.shelfMove, requestDelete]);

  const menuView = useMemo(() => {
    if (!menu || menuTargetGone) return null;
    const pendingAction = menuPending?.token === menu.token ? menuPending.action : null;
    const toItems = (actions: ShelfAction[]) => groupShelfActions(actions).map(({ group, actions: list }) => ({
      group,
      items: list.map((action) => ({
        id: action.id,
        label: t(pendingAction === action.id && action.pendingLabel ? action.pendingLabel : action.label),
        icon: shelfActionIcon(action.id),
        disabled: action.disabled,
        pending: pendingAction === action.id,
      })),
    }));
    if (menu.target.kind === "folder") {
      const folderId = menu.target.id;
      const folder = activeFolders.find((f) => f.id === folderId);
      if (!folder) return null;
      const count = (folderBooksMap.get(folder.id) ?? []).length;
      return {
        label: t("shelfFolder.options", { name: folder.name }),
        header: menu.presentation === "sheet"
          ? <div className="shelf-action-head">
              <span className="shelf-action-head-icon" aria-hidden="true"><FolderIcon /></span>
              <span className="shelf-action-head-text">
                <span className="shelf-action-head-title">{folder.name}</span>
                <span className="shelf-action-head-sub">{tn("shelfFolder.bookCount", count, { count })}</span>
              </span>
            </div>
          : folder.name,
        groups: toItems(shelfFolderActions({
          canOpen: menu.target.surface !== "folderModal",
          canExport: Boolean(props.onExportBooks),
          exportDisabled: bookExportDisabled || count === 0,
        })),
      };
    }
    const entry = entriesById.get(menu.target.id);
    if (!entry) return null;
    const hash = entry.contentHash ?? entry.id;
    const actions = shelfBookActions({
      favorite: isFavorite(organization, hash),
      inFolder: effectiveFolderId(organization, hash) !== null,
      busy: props.busy,
      deleteDisabled: Boolean(props.importActive),
      canSelect: menu.target.surface !== "folderModal" && !selectionMode,
      canFavorite: canOrganize,
      canMove: canOrganize,
      canRemoveFromFolder: canOrganize,
      canExport: Boolean(props.onExportBooks),
      exportDisabled: Boolean(props.saveFileActive || props.lanTransferActive),
      cloudUpload: props.cloudUpload ? { disabled: cloudUploadRunning } : undefined,
      canReveal: Boolean(props.onRevealSource),
      revealDisabled: entry.available === false,
      // The move rebinds the original file, so it waits for the file and for imports.
      shelfMove: props.shelfMove
        ? { direction: props.shelfMove.direction, disabled: entry.available === false || Boolean(props.importActive) }
        : undefined,
      tabs: props.readerTabs ? { open: props.readerTabs.openIds.has(entry.id), full: props.readerTabs.full } : undefined,
    });
    return {
      label: t("shelf.card.more", { title: entry.title }),
      header: menu.presentation === "sheet"
        ? <div className="shelf-action-head">
            <span className="shelf-action-head-cover" aria-hidden="true"><Cover entry={entry} provider={thumbnailProvider} /></span>
            <span className="shelf-action-head-text">
              <span className="shelf-action-head-title">{entry.title}</span>
              <span className="shelf-action-head-sub">{entry.creator || t("shelf.unknownAuthor")}</span>
            </span>
          </div>
        : entry.title,
      groups: toItems(actions),
    };
  }, [activeFolders, bookExportDisabled, canOrganize, cloudUploadRunning, entriesById, folderBooksMap, menu, menuPending, menuTargetGone, organization, props.busy, props.cloudUpload, props.importActive, props.onExportBooks, props.onRevealSource, props.readerTabs, props.saveFileActive, props.lanTransferActive, props.shelfMove, selectionMode, t, thumbnailProvider, tn]);

  const openMenuKey = menu && !menuClosing
    ? (menu.target.kind === "book"
      ? `${menu.target.surface}:${menu.target.id}`
      : `${menu.target.surface === "folderModal" ? "folderModalHead" : "folder"}:${menu.target.id}`)
    : null;

  /** Hover styling follows the input actually used, so a tap on a hybrid device never leaves a lifted card. */
  const noteShelfInput = useCallback((pointerType: string): void => {
    const view = shelfViewRef.current;
    const input = pointerType === "touch" ? "touch" : "pointer";
    if (view && view.dataset.input !== input) view.dataset.input = input;
  }, []);

  const searchScopeSwitch = (
    <Segmented label={t("shelfSettings.search.scope")} value={searchMode} variant="compact" className="shelf-search-scope"
      disabled={props.busy}
      options={[
        { value: "metadata", label: isCompactMobile ? t("shelfSettings.search.scope.titleShort") : t("shelfMenu.searchMode.metadata") },
        { value: "body", label: t("shelfMenu.searchMode.body") },
      ]}
      onChange={changeSearchMode} />
  );
  const filterButton = (
    <button
      ref={filterButtonRef}
      className={`shelf-filter-btn${isCompactMobile ? " is-icon" : ""}${filterCount > 0 ? " is-active" : ""}`}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={filterOpen}
      aria-label={filterCount > 0 ? t("shelfSettings.filter.button.count", { count: filterCount }) : t("shelfSettings.filter.button")}
      title={t("shelfSettings.filter.button")}
      disabled={props.busy}
      onClick={() => {
        setBodySearchOpen(false);
        setFilterOpen((open) => !open);
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
      {!isCompactMobile && <span>{t("shelfSettings.filter.button")}</span>}
      {filterCount > 0 && <span className="shelf-filter-badge" aria-hidden="true">{filterCount}</span>}
    </button>
  );

  const settingsPageProps = {
    presentation: props.touchUi || isCompactMobile ? "page" : "dialog",
    initialSection: settingsSection,
    busy: Boolean(props.busy),
    bookCount: props.entries.length,
    theme: props.theme,
    onThemeChange: props.onThemeChange,
    customThemes: props.customThemes,
    hideReaderSystemStatusBar: props.hideReaderSystemStatusBar,
    onHideReaderSystemStatusBarChange: props.onHideReaderSystemStatusBarChange,
    keepScreenOnWhileReading: props.keepScreenOnWhileReading,
    onKeepScreenOnWhileReadingChange: props.onKeepScreenOnWhileReadingChange,
    volumeKeyTurn: props.volumeKeyTurn,
    onVolumeKeyTurnChange: props.onVolumeKeyTurnChange,
    volumeKeyReverse: props.volumeKeyReverse,
    onVolumeKeyReverseChange: props.onVolumeKeyReverseChange,
    batteryIndicatorEnabled: props.batteryIndicatorEnabled,
    onBatteryIndicatorChange: props.onBatteryIndicatorChange,
    titlebarAutoHide: props.titlebarAutoHide,
    onTitlebarAutoHideChange: props.onTitlebarAutoHideChange,
    preloadNextChapter: props.preloadNextChapter,
    onPreloadNextChapterChange: props.onPreloadNextChapterChange,
    seamlessChapterTurn: props.seamlessChapterTurn,
    onSeamlessChapterTurnChange: props.onSeamlessChapterTurnChange,
    uiScale: props.uiScale,
    onUiScaleChange: props.onUiScaleChange,
    tapRegions: props.tapRegions,
    onTapRegionsChange: props.onTapRegionsChange,
    tapRegionsScrollMode: props.tapRegionsScrollMode,
    importArchiveDisabled: props.importActive,
    importActive: props.importActive,
    saveFileActive: props.saveFileActive,
    lanTransferActive: props.lanTransferActive,
    onOpenLanTransfer: props.onOpenLanTransfer ? () => props.onOpenLanTransfer!() : undefined,
    onImportArchive: props.onImportArchive,
    onExportArchive: () => props.onExportArchive?.(),
    libraryServices: props.libraryServices !== false,
    onExportAllBooks: props.onExportBooks ? () => props.onExportBooks!() : undefined,
    onImportLegacyArchive: props.onImportLegacyArchive,
    onImportKoreader: props.onImportKoreader,
    onLibraryLocationChanged: props.onLibraryLocationChanged,
    bodySearch,
    onOpenDiagnostics: props.onOpenDiagnostics ? () => {
      closeSettings();
      props.onOpenDiagnostics!();
    } : undefined,
  } satisfies Omit<ShelfSettingsPageProps, "open" | "onClose">;
  // 安卓本次运行：书架第一次画完就把设置页（首页、再各分类页）几乎不可见地各画一次，
  // 首次打开设置或进入分类时只播动画，不再承担 GPU 首绘。打开设置时让路，关掉后补完。
  const settingsWarmup = usePanelPaintWarmup(
    shelfPainted && getRuntimeCapabilities().platform === "android" && !settingsOpen && !props.busy,
    SETTINGS_WARM_BATCHES,
    [],
  );
  const settingsWarm = settingsWarmup.warming("shelf-settings-pages") ? "pages"
    : settingsWarmup.warming("shelf-settings") ? "home" : undefined;
  /**
   * A11: the book a Ctrl+click or middle click opens in a new tab. null leaves
   * the click alone; "" swallows it (the tab limit is reached).
   */
  const newTabTarget = (target: EventTarget | null): string | null => {
    const tabs = props.readerTabs;
    if (!tabs || selectionMode || props.busy || typeof Element === "undefined" || !(target instanceof Element)) return null;
    const card = target.closest<HTMLElement>('[data-shelf-target="book"][data-book-id]');
    const id = card?.dataset.bookId;
    if (!card || !id || isShelfCardActionTarget(target, card)) return null;
    return tabs.full && !tabs.openIds.has(id) ? "" : id;
  };
  const tabPick = props.readerTabs?.pick ?? null;

  return (
    <div
      ref={shelfViewRef}
      className={`shelf-view density-${density}${tabPick ? " is-tab-pick" : ""}${selectionMode ? " selection-mode" : ""} view-${viewMode}${props.busy ? " busy" : ""}${props.importActive ? " import-active" : ""}`}
      aria-busy={props.busy || props.importActive}
      data-input={initialShelfInput}
      onPointerDownCapture={(e) => noteShelfInput(e.pointerType)}
      onPointerMove={(e) => { if (e.pointerType === "mouse") noteShelfInput("mouse"); }}
      onClickCapture={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const id = newTabTarget(e.target);
        if (id === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (id) props.readerTabs!.onOpenInNewTab(id);
      }}
      onMouseDown={(e) => {
        // 中键点书：不进入系统的自动滚动。
        if (e.button === 1 && newTabTarget(e.target) !== null) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        const id = newTabTarget(e.target);
        if (id === null) return;
        e.preventDefault();
        if (id) props.readerTabs!.onOpenInNewTab(id);
      }}
    >
      {/* 现代极简顶部操作栏 (Level 1) */}
      <header className="shelf-head shelf-head-zen">
        {selectionMode ? (
          /* 多选管理模式状态栏 */
          <div className="shelf-selection-bar">
            <div className="shelf-selection-left">
              {/* 手机：取消在左上，批量动作统一放底部操作栏（与平板/桌面同一底坞）。 */}
              <button className="shelf-selection-exit" type="button" onClick={exitSelection}>
                {t("shelfMain.selection.cancel")}
              </button>
              <span className="shelf-selection-title">{tn("shelfMain.selection.count", selectedIds.size, { count: selectedIds.size })}</span>
              <button
                className="shelf-selection-toggle-all"
                type="button"
                aria-pressed={selectedIds.size === selectableIds.size && selectableIds.size > 0}
                disabled={props.busy || selectableIds.size === 0}
                onClick={() => {
                  if (selectedIds.size === selectableIds.size) setSelectedIds(new Set());
                  else setSelectedIds(new Set(selectableIds));
                }}
              >
                <CheckSquareIcon checked={selectedIds.size === selectableIds.size && selectableIds.size > 0} />
                <span>{selectedIds.size === selectableIds.size && selectableIds.size > 0 ? t("shelfMain.selection.clearAll") : t("shelfMain.selection.none")}</span>
              </button>
            </div>
          </div>
        ) : isCompactMobile ? (
          <div className="shelf-normal-bar-mobile-wrap">
            <div className="shelf-normal-bar-mobile">
              {/* Level 1 左侧：应用 LOGO；总数已在“全部 N”筛选上显示，不再重复 */}
              <ShelfBrand switcher={props.shelfSwitch} disabled={Boolean(props.busy || props.importActive || props.saveFileActive || props.lanTransferActive)}
                registerSubmenuBackHandler={registerSubmenuBackHandler} onSubmenuBackActiveChange={reportSubmenuBackActive} />

              {/* Level 1 右侧：导入图书主按钮、设置/更多 */}
              <div className="shelf-actions-zone-zen shelf-actions-zone-mobile">
                <ShelfImportButton
                  compact
                  disabled={Boolean(props.busy || props.importActive)}
                  showDropHint={false}
                  targetName={importTargetName}
                  onImport={importHere}
                  onImportFolder={props.onImportFolder}
                  onOpenLanTransfer={openLanTransferFromImport}
                  lanTransferDisabled={lanTransferImportDisabled}
                  copyToLibrary={props.copyToLibrary}
                  onCopyToLibraryChange={props.onCopyToLibraryChange}
                  registerSubmenuBackHandler={registerSubmenuBackHandler}
                  onSubmenuBackActiveChange={reportSubmenuBackActive}
                />

                <button
                  className="shelf-icon-btn-zen shelf-mobile-more-btn"
                  ref={menuButtonRef}
                  type="button"
                  aria-label={settingsLabel}
                  aria-expanded={settingsOpen}
                  aria-haspopup="dialog"
                  onClick={() => openSettings()}
                  disabled={props.busy}
                  title={t("shelfSettings.title")}
                >
                  <SettingsIcon />
                  {updateDot && <span className="app-update-dot" aria-hidden="true" />}
                </button>
              </div>
            </div>

            {/* Level 1 独立搜索行：完整输入框，无快捷键提示，48px清除按钮 */}
            <div className="shelf-search-row">
              <div className="shelf-quick-filter-box shelf-quick-filter-box-mobile">
                <span className="shelf-quick-filter-icon" aria-hidden="true">
                  <SearchIcon />
                </span>
                <input
                  ref={quickInputRef}
                  className="shelf-quick-filter-input"
                  type="search"
                  placeholder={t("shelfMain.search.mobile")}
                  value={query}
                  disabled={props.busy}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t("shelfMain.search.mobile")}
                />
                {query && (
                  <button
                    className="shelf-quick-filter-clear shelf-mobile-search-clear"
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label={t("shelfMain.search.clear")}
                    title={t("shelfMain.search.clear.tip")}
                  >
                    <CloseIcon />
                  </button>
                )}
                {bodySearch && searchScopeSwitch}
              </div>
              {filterButton}
            </div>
          </div>
        ) : (
          /* 常态操作栏：Level 1 全局顶栏极净化 */
          <div className="shelf-normal-bar shelf-normal-bar-zen">
            {/* Level 1 左侧：应用 LOGO；总数已在“全部 N”筛选上显示，不再重复 */}
            <ShelfBrand switcher={props.shelfSwitch} disabled={Boolean(props.busy || props.importActive || props.saveFileActive || props.lanTransferActive)}
              registerSubmenuBackHandler={registerSubmenuBackHandler} onSubmenuBackActiveChange={reportSubmenuBackActive} />

            {/* Level 1 中间：书架搜索框，范围切换“书名作者 | 正文”；正文结果在框下展开 */}
            <div className="shelf-quick-filter-anchor" ref={searchBoxRef}>
              <div className={`shelf-quick-filter-box${searchMode === "body" ? " is-body" : ""}`}>
                <span className="shelf-quick-filter-icon" aria-hidden="true">
                  <SearchIcon />
                </span>
                {searchMode === "body" && bodySearch ? (
                  <input
                    ref={quickInputRef}
                    className="shelf-quick-filter-input"
                    type="search"
                    placeholder={t("search.placeholder.all")}
                    value={bodySearch.query}
                    disabled={props.busy || bodySearch.indexStatus === "checking" || bodySearch.indexStatus === "indexing" || bodySearch.indexStatus === "cancelling"}
                    onFocus={() => setBodySearchOpen(true)}
                    onChange={(e) => {
                      bodySearch.onQueryChange(e.target.value);
                      setBodySearchOpen(true);
                    }}
                    aria-label={t("search.placeholder.all")}
                  />
                ) : (
                  <input
                    ref={quickInputRef}
                    className="shelf-quick-filter-input"
                    type="search"
                    placeholder={t("shelfMain.search.quick")}
                    value={query}
                    disabled={props.busy}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label={t("shelfMain.search.quick.label")}
                  />
                )}
                {searchMode === "metadata" && query && (
                  <button
                    className="shelf-quick-filter-clear"
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label={t("shelfMain.search.clear")}
                    title={t("shelfMain.search.clear.tip")}
                  >
                    <CloseIcon />
                  </button>
                )}
                {bodySearch && searchScopeSwitch}
              </div>
              {bodySearch && (
                <ShelfBodySearchDropdown
                  open={searchMode === "body" && bodySearchOpen}
                  body={bodySearch}
                  anchor={searchBoxRef.current}
                  onClose={closeBodySearch}
                  onManageIndex={() => openSettings("storage")}
                />
              )}
            </div>

            {/* Level 1 右侧：导入图书主按钮、视图切换 [⊞/☰]、设置 */}
            <div className="shelf-actions-zone-zen">
              <ShelfImportButton
                compact={false}
                disabled={Boolean(props.busy || props.importActive)}
                showDropHint={!coarsePointer}
                targetName={importTargetName}
                onImport={importHere}
                onImportFolder={props.onImportFolder ? () => {
                  if (!props.saveFileActive && !props.lanTransferActive) props.onImportFolder!();
                } : undefined}
                onOpenLanTransfer={openLanTransferFromImport}
                lanTransferDisabled={lanTransferImportDisabled}
                copyToLibrary={props.copyToLibrary}
                onCopyToLibraryChange={props.onCopyToLibraryChange}
                registerSubmenuBackHandler={registerSubmenuBackHandler}
                onSubmenuBackActiveChange={reportSubmenuBackActive}
              />

              {/* 视图切换 [⊞/☰] */}
              <div className="shelf-view-toggle-group" role="group" aria-label={t("shelfMain.viewToggle")}>
                <button
                  className={`shelf-view-toggle-btn${viewMode === "grid" ? " active" : ""}`}
                  type="button"
                  onClick={() => handleViewModeChange("grid")}
                  title={t("shelfMain.view.grid")}
                  aria-label={t("shelfMain.view.grid")}
                  aria-pressed={viewMode === "grid"}
                >
                  <GridIcon />
                </button>
                <button
                  className={`shelf-view-toggle-btn${viewMode === "list" ? " active" : ""}`}
                  type="button"
                  onClick={() => handleViewModeChange("list")}
                  title={t("shelfMain.view.list")}
                  aria-label={t("shelfMain.view.list")}
                  aria-pressed={viewMode === "list"}
                >
                  <ListIcon />
                </button>
              </div>

              {/* 批量管理切换 */}
              <button
                className="shelf-manage-toggle-btn"
                type="button"
                onClick={enterSelection}
                disabled={props.busy || props.entries.length === 0}
                title={t("shelfMain.batch.enter.tip")}
                data-testid="shelf-batch-select-btn"
              >
                <CheckListIcon />
                <span>{t("shelfMain.batch.enter")}</span>
              </button>

              {filterButton}

              {/* 设置按钮 */}
              <button
                className="shelf-icon-btn-zen"
                ref={menuButtonRef}
                type="button"
                aria-label={settingsLabel}
                aria-expanded={settingsOpen}
                aria-haspopup="dialog"
                onClick={() => openSettings()}
                disabled={props.busy}
                title={t("shelfSettings.title")}
              >
                <SettingsIcon />
                {updateDot && <span className="app-update-dot" aria-hidden="true" />}
              </button>
            </div>
          </div>
        )}
      </header>
      {tabPick && props.readerTabs && (
        <ShelfTabPickBar pick={tabPick} max={props.readerTabs.max} openIds={props.readerTabs.openIds} />
      )}

      {/* 设置页：PC 对话框，触屏全屏页 */}
      <ShelfSettingsPage {...settingsPageProps} open={settingsOpen} registerSubmenuBackHandler={registerSubmenuBackHandler} onClose={closeSettings} />
      {props.cloudUpload && <CloudBookUploadLayer onOpenSync={() => openSettings("sync")} />}
      {settingsWarm && <PanelPaintWarmup active>
        <ShelfSettingsPage {...settingsPageProps} initialSection={undefined} open warm={settingsWarm} onClose={closeSettings} />
      </PanelPaintWarmup>}

      {/* 筛选与排序：PC 浮层，手机底部面板（手机上兼管排序、视图、密度） */}
      <ShelfFilterPanel
        open={filterOpen}
        presentation={isCompactMobile ? "sheet" : "popover"}
        anchor={filterButtonRef.current}
        filters={filters}
        facets={filterModel.facets}
        matchingCount={filterModel.entries.length}
        onFiltersChange={setFilters}
        onClose={closeFilter}
        sort={sort}
        onSortChange={setSort}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        density={density}
        onDensityChange={setDensity}
      />

      {bodySearch && isCompactMobile && (
        <ShelfBodySearchPage
          open={searchMode === "body" && bodySearchOpen}
          body={bodySearch}
          busy={props.busy}
          onClose={leaveBodySearch}
          onManageIndex={() => openSettings("storage")}
        />
      )}

      {/* Level 2: 紧凑型“正在阅读”续读控制台 */}
      <ShelfResumeStage
        compact={isCompactMobile}
        entries={props.entries}
        provider={thumbnailProvider}
        busy={props.busy}
        onOpen={props.onOpen}
        registerSubmenuBackHandler={registerSubmenuBackHandler}
        onSubmenuBackActiveChange={reportSubmenuBackActive}
      />

      {/* Level 3: 状态与分类胶囊轨 */}
      <nav className="shelf-nav-rail" aria-label={t("shelfMain.nav")}>
        <div className="shelf-nav-rail-left">
          {/* 状态分流胶囊组（手机端合并为单个分类选择下拉，桌面保留平铺胶囊） */}
          {isCompactMobile ? (
            <div className="shelf-category-select-wrap" ref={categoryDropdownRef}>
              <button
                className="shelf-category-dropdown-btn"
                type="button"
                onClick={() => setCategoryMenuOpen(!categoryMenuOpen)}
                aria-expanded={categoryMenuOpen}
                title={t("shelfMain.category.choose")}
              >
                <span>{t("shelfMain.category.withCount", { label: categoryLabels[statusTab], count: categoryCounts[statusTab] })}</span>
                <ChevronDownIcon />
              </button>
              {categoryMenuOpen && (
                <div className="shelf-category-popover-menu" role="menu">
                  {(["all", "reading", "unread", "finished", "favorites"] as ShelfStatusTab[]).map((tab) => (
                    <button
                      key={tab}
                      className={`shelf-category-menu-item${statusTab === tab ? " selected" : ""}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setStatusTab(tab);
                        setCategoryMenuOpen(false);
                      }}
                    >
                      {tab === "favorites" ? <StarIcon filled={statusTab === "favorites"} /> : null}
                      <span>{categoryLabels[tab]}</span>
                      <span className="shelf-capsule-count">{categoryCounts[tab]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="shelf-capsule-tabs" role="tablist" aria-label={t("shelfMain.category.tabs")}>
              <button
                className={`shelf-capsule-tab${statusTab === "all" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "all"}
                onClick={() => setStatusTab("all")}
              >
                <span>{categoryLabels.all}</span>
                <span className="shelf-capsule-count">{allCount}</span>
              </button>
              <button
                className={`shelf-capsule-tab${statusTab === "reading" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "reading"}
                onClick={() => setStatusTab("reading")}
              >
                <span>{categoryLabels.reading}</span>
                <span className="shelf-capsule-count">{readingCount}</span>
              </button>
              <button
                className={`shelf-capsule-tab${statusTab === "unread" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "unread"}
                onClick={() => setStatusTab("unread")}
              >
                <span>{categoryLabels.unread}</span>
                <span className="shelf-capsule-count">{unreadCount}</span>
              </button>
              <button
                className={`shelf-capsule-tab${statusTab === "finished" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "finished"}
                onClick={() => setStatusTab("finished")}
              >
                <span>{categoryLabels.finished}</span>
                <span className="shelf-capsule-count">{finishedCount}</span>
              </button>
              <button
                className={`shelf-capsule-tab${statusTab === "favorites" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "favorites"}
                onClick={() => setStatusTab("favorites")}
              >
                <StarIcon filled={statusTab === "favorites"} />
                <span>{categoryLabels.favorites}</span>
                <span className="shelf-capsule-count">{favoriteCount}</span>
              </button>
            </div>
          )}

          {/* 集中式文件夹选择下拉 */}
          <div className="shelf-folder-dropdown-wrap" ref={folderDropdownRef}>
            <button
              className={`shelf-folder-dropdown-btn${scope.type === "folder" ? " active" : ""}`}
              type="button"
              onClick={() => setFolderMenuOpen(!folderMenuOpen)}
              aria-expanded={folderMenuOpen}
              title={t("shelfMain.folders.choose")}
            >
              <FolderIcon />
              <span className="shelf-folder-dropdown-label" title={currentFolder?.name}>
                {scope.type === "folder"
                  ? currentFolder?.name ?? t("shelfMain.folders.fallback")
                  : scope.type === "all"
                    ? t("shelfMain.folders.flat")
                    : t("shelfMain.folders.byFolder")}
              </span>
              <ChevronDownIcon />
            </button>
            {folderMenuOpen && (
              <div className="shelf-folder-popover-menu">
                {/* 两种书架排法：默认的按文件夹在上，不分文件夹的平铺在下。 */}
                <button
                  className={`shelf-folder-menu-item shelf-folder-menu-mode${scope.type === "root" ? " selected" : ""}`}
                  type="button"
                  onClick={() => {
                    setScope({ type: "root" });
                    setFolderMenuOpen(false);
                  }}
                >
                  <span className="shelf-folder-menu-mode-text">
                    <span>{t("shelfMain.folders.byFolder")}</span>
                    <small>{t("shelfMain.folders.byFolder.detail")}</small>
                  </span>
                </button>
                <button
                  className={`shelf-folder-menu-item shelf-folder-menu-mode${scope.type === "all" ? " selected" : ""}`}
                  type="button"
                  onClick={() => {
                    setScope({ type: "all" });
                    setFolderMenuOpen(false);
                  }}
                >
                  <span className="shelf-folder-menu-mode-text">
                    <span>{t("shelfMain.folders.flat")}</span>
                    <small>{t("shelfMain.folders.flat.detail")}</small>
                  </span>
                  <span className="shelf-capsule-count">{props.entries.length}</span>
                </button>
                <div className="shelf-folder-menu-divider" />
                {activeFolders.length > 0 && (
                  <div className="shelf-folder-menu-caption">{t("shelfMain.folders.open")}</div>
                )}
                {activeFolders.map((f) => {
                  const count = (folderBooksMap.get(f.id) ?? []).length;
                  const isCurrent = scope.type === "folder" && scope.folderId === f.id;
                  return (
                    <button
                      key={f.id}
                      className={`shelf-folder-menu-item${isCurrent ? " selected" : ""}`}
                      type="button"
                      onClick={() => {
                        setScope({ type: "folder", folderId: f.id });
                        setFolderMenuOpen(false);
                      }}
                    >
                      <span>{f.name}</span>
                      <span className="shelf-capsule-count">{count}</span>
                    </button>
                  );
                })}
                <div className="shelf-folder-menu-divider" />
                <button
                  className="shelf-folder-menu-new-btn"
                  type="button"
                  onClick={() => {
                    setFolderMenuOpen(false);
                    setCreateFolderOpen(true);
                  }}
                >
                  <PlusIcon />
                  <span>{t("shelfMain.folders.new")}</span>
                </button>
              </div>
            )}
          </div>

          {/* 手机根层网格：文件夹卡片的展开/收起放在筛选行最右，不再单占一行。 */}
          {isCompactMobile && scope.type === "root" && viewMode === "grid" && visibleFolders.length > 0 && (
            <button
              className={`shelf-folder-toggle-btn${folderPrefixExpanded ? " expanded" : ""}`}
              type="button"
              onClick={toggleFolderPrefix}
              aria-expanded={folderPrefixExpanded}
              title={t(folderPrefixExpanded ? "shelfMain.folders.collapse.tip" : "shelfMain.folders.expand.tip")}
              aria-label={t(folderPrefixExpanded ? "shelfMain.folders.collapse.tip" : "shelfMain.folders.expand.tip")}
            >
              <span>{t("shelfMain.folders.summary", { count: visibleFolders.length })}</span>
              {folderPrefixExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </button>
          )}

          {/* 当处于特定文件夹时，显示专属状态与退出/管理操作 */}
          {scope.type === "folder" && (
            <div className="shelf-folder-active-bar">
              <button
                className="shelf-folder-active-exit"
                type="button"
                onClick={() => setScope({ type: "root" })}
                title={t("shelfMain.folder.exit")}
                aria-label={t("shelfMain.folder.exit")}
              >
                <CloseIcon />
              </button>
              <div className="shelf-folder-active-info">
                <span className="shelf-folder-active-name" title={currentFolder?.name}>{t("shelfMain.folder.name", { name: currentFolder?.name ?? t("shelfMain.folders.fallback") })}</span>
                <span className="shelf-folder-active-count">
                  {tn("shelfMain.folder.bookCount", (folderBooksMap.get(scope.folderId) ?? []).length, { count: (folderBooksMap.get(scope.folderId) ?? []).length })}
                </span>
              </div>
              {currentFolder && (
                isCompactMobile ? (
                  <div className="shelf-folder-active-more-wrap" ref={folderActiveMoreRef}>
                    <button
                      className="shelf-folder-action-btn shelf-folder-more-btn"
                      type="button"
                      onClick={() => setFolderActiveMoreOpen(!folderActiveMoreOpen)}
                      aria-expanded={folderActiveMoreOpen}
                      title={t("shelfMain.folder.actions")}
                    >
                      <DotsVerticalIcon />
                    </button>
                    {folderActiveMoreOpen && (
                      <div className="shelf-folder-active-menu">
                        {canOrganize && (
                          <button
                            className="shelf-folder-menu-item"
                            type="button"
                            disabled={props.busy}
                            onClick={() => {
                              setFolderActiveMoreOpen(false);
                              setAddBooksFolder(currentFolder);
                            }}
                          >
                            <CheckListIcon />
                            <span>{t("shelfFolder.addBooks.open")}</span>
                          </button>
                        )}
                        {props.onExportBooks && (
                          <button
                            className="shelf-folder-menu-item"
                            type="button"
                            disabled={bookExportDisabled || (folderBooksMap.get(currentFolder.id) ?? []).length === 0}
                            onClick={() => {
                              setFolderActiveMoreOpen(false);
                              handleExportFolderBooks(currentFolder.id);
                            }}
                          >
                            <ExportIcon />
                            <span>{t("bookExport.action")}</span>
                          </button>
                        )}
                        <button
                          className="shelf-folder-menu-item"
                          type="button"
                          onClick={() => {
                            setFolderActiveMoreOpen(false);
                            setRenameFolderTarget(currentFolder);
                          }}
                        >
                          <EditIcon />
                          <span>{t("shelfMain.folder.rename")}</span>
                        </button>
                        <button
                          className="shelf-folder-menu-item danger"
                          type="button"
                          onClick={() => {
                            setFolderActiveMoreOpen(false);
                            setDissolveFolderTarget(currentFolder);
                          }}
                        >
                          <TrashIcon />
                          <span>{t("shelfMain.folder.dissolve")}</span>
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {canOrganize && (
                      <button
                        className="shelf-folder-action-btn"
                        type="button"
                        disabled={props.busy}
                        onClick={() => setAddBooksFolder(currentFolder)}
                        title={t("shelfFolder.addBooks.open.tip")}
                      >
                        <CheckListIcon />
                        <span>{t("shelfFolder.addBooks.open")}</span>
                      </button>
                    )}
                    {props.onExportBooks && (
                      <button
                        className="shelf-folder-action-btn"
                        type="button"
                        disabled={bookExportDisabled || (folderBooksMap.get(currentFolder.id) ?? []).length === 0}
                        onClick={() => handleExportFolderBooks(currentFolder.id)}
                        title={t("bookExport.action")}
                      >
                        <ExportIcon />
                        <span>{t("bookExport.action")}</span>
                      </button>
                    )}
                    <button
                      className="shelf-folder-action-btn"
                      type="button"
                      onClick={() => setRenameFolderTarget(currentFolder)}
                      title={t("shelfMain.folder.rename.tip")}
                    >
                      <EditIcon />
                      <span>{t("shelfMain.folder.rename")}</span>
                    </button>
                    <button
                      className="shelf-folder-action-btn danger"
                      type="button"
                      onClick={() => setDissolveFolderTarget(currentFolder)}
                      title={t("shelfMain.folder.dissolve.tip")}
                    >
                      <TrashIcon />
                      <span>{t("shelfMain.folder.dissolve")}</span>
                    </button>
                  </>
                )
              )}
            </div>
          )}
        </div>

        {/* 右侧排序与密度轨（移动端紧凑模式由设置抽屉统一承接，外部不重复显示） */}
        {!isCompactMobile && (
          <div className="shelf-nav-rail-right">
            <div className="shelf-sort-select-container" style={{ position: "relative" }}>
              <ShelfSelect
                registerSubmenuBackHandler={registerSubmenuBackHandler}
                onSubmenuBackActiveChange={reportSubmenuBackActive}
                value={sort}
                busy={props.busy}
                title={scope.type === "folder" ? t("shelfFolder.modal.sort") : t("shelfMain.sort")}
                options={[
                  { value: "recent", label: t("shelfMain.sort.recent") },
                  { value: "added", label: t("shelfMain.sort.added") },
                  { value: "title", label: t("shelfMain.sort.title") },
                  { value: "progress", label: t("shelfMain.sort.progress") },
                ]}
                onChange={(val) => setSort(val as ShelfSort)}
              />
              <select
                className="shelf-sort-select-zen"
                value={sort}
                disabled={props.busy}
                onChange={(e) => setSort(e.target.value as ShelfSort)}
                aria-label={t("shelfMain.sort")}
                style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 0, height: 0 }}
                tabIndex={-1}
                aria-hidden="true"
              >
                <option value="recent">{t("shelfMain.sort.recent")}</option>
                <option value="added">{t("shelfMain.sort.added")}</option>
                <option value="title">{t("shelfMain.sort.title")}</option>
                <option value="progress">{t("shelfMain.sort.progress")}</option>
              </select>
            </div>

            <button
              className="shelf-icon-btn-zen shelf-density-btn"
              type="button"
              onClick={() => setDensity(NEXT_SHELF_DENSITY[density])}
              title={t("shelfMain.density.tip", { current: t(SHELF_DENSITY_LABEL[density]), next: t(SHELF_DENSITY_LABEL[NEXT_SHELF_DENSITY[density]]) })}
            >
              {t(SHELF_DENSITY_LABEL[density])}
            </button>
          </div>
        )}
      </nav>

      {/* 生效的筛选：每个维度一个可删除的摘要标签，不逐个列出选中的值 */}
      <ShelfFilterSummary filters={filters} facets={filterModel.facets} compact={isCompactMobile} onFiltersChange={setFilters} />

      {/* 书库刷新失败：已知的卡片和文件夹照常显示，只多一条可重试的提示 */}
      {library.kind === "ready" && library.refreshError && (
        <div className="shelf-library-banner" role="alert">
          <span className="shelf-library-banner-text">{t("notice.shelf.refreshFailed", { error: library.refreshError })}</span>
          {props.onRetryLibraryLoad && (
            <button type="button" className="shelf-selection-cancel" onClick={props.onRetryLibraryLoad}>
              {t("shelfMain.library.retry")}
            </button>
          )}
        </div>
      )}

      {/* 书架内容区 */}
      {library.kind === "loading" ? (
        <div className="shelf-empty shelf-library-state" role="status" aria-live="polite">
          <div className="shelf-empty-title">{t("shelfMain.library.loading")}</div>
        </div>
      ) : library.kind === "failed" ? (
        <ShelfEmptyState icon={<BookLogoIcon />} title={t("shelfMain.library.failed")} hint={library.error}>
          {props.onRetryLibraryLoad && (
            <button className="shelf-empty-btn" type="button" onClick={props.onRetryLibraryLoad}>
              <span>{t("shelfMain.library.retry")}</span>
            </button>
          )}
        </ShelfEmptyState>
      ) : props.entries.length === 0 && (activeFolders.length === 0 || scope.type === "all") ? (
        <ShelfEmptyState icon={<BookLogoIcon />} title={t("shelfMain.empty.title")} hint={emptyShelfHint}>
          <button className="shelf-empty-btn" onClick={props.onImport} disabled={props.busy || props.importActive}>
            <PlusIcon />
            <span>{t("shelfMain.empty.import")}</span>
          </button>
        </ShelfEmptyState>
      ) : scope.type === "favorites" && favoriteBooks.length === 0 ? (
        <ShelfEmptyState icon={<StarIcon />} title={t("shelfMain.favorites.empty")} hint={t("shelfMain.favorites.hint")}>
          <button className="shelf-empty-btn" onClick={() => setScope({ type: "all" })} disabled={props.busy}>
            <BookLogoIcon />
            <span>{t("shelfMain.favorites.viewAll")}</span>
          </button>
        </ShelfEmptyState>
      ) : scope.type === "folder" && (folderBooksMap.get(scope.folderId) ?? []).length === 0 ? (
        <ShelfEmptyState icon={<FolderIcon />} title={t("shelfMain.folder.empty")} hint={t("shelfMain.folder.emptyHint")}>
<div className="shelf-empty-actions">
              {currentFolder && props.onImportIntoFolder && (
              <button className="shelf-empty-btn" type="button" onClick={importHere} disabled={props.busy || props.importActive}>
                <PlusIcon />
                <span>{t("shelfFolder.importHere")}</span>
              </button>
            )}
            {currentFolder && canOrganize && (
              <button className="shelf-empty-btn" type="button" onClick={() => setAddBooksFolder(currentFolder)} disabled={props.busy}>
                <CheckListIcon />
                <span>{t("shelfFolder.addBooks.open")}</span>
              </button>
            )}
            <button className="shelf-empty-btn" onClick={() => setScope({ type: "root" })} disabled={props.busy}>
              <BookLogoIcon />
              <span>{t("shelfMain.folder.back")}</span>
            </button>
          </div>
        </ShelfEmptyState>
      ) : visible.length === 0 && visibleFolders.length === 0 ? (
        // Nothing matches: name the cause and offer the way back for each active narrowing.
        <ShelfEmptyState
          icon={<SearchIcon />}
          title={query.trim() ? t("shelfMain.search.none") : t("shelfMain.filter.none")}
          hint={query.trim() ? t("shelfMain.search.noneHint") : t("shelfMain.filter.noneHint")}
        >
          {(query || narrowedByFilters) && (
            <div className="shelf-empty-actions">
              {query && (
                <button className="shelf-selection-cancel" type="button" onClick={() => setQuery("")}>
                  {t("shelfMain.search.clearQuery")}
                </button>
              )}
              {narrowedByFilters && (
                <button className="shelf-selection-cancel" type="button" onClick={clearShelfFilters}>
                  {t("shelfMain.filter.clear")}
                </button>
              )}
            </div>
          )}
        </ShelfEmptyState>
      ) : viewMode === "list" ? (
        <ShelfTableScroller>
          <table className="shelf-table">
            <thead>
              <tr>
                <th style={{ width: 44, textAlign: "center" }}>
                  {selectionMode ? t("shelfMain.table.select") : "#"}
                </th>
                <th className="shelf-table-cover-col">{t("shelfMain.table.cover")}</th>
                <th
                  className={`sortable${sort === "title" ? " active" : ""}`}
                  onClick={() => setSort("title")}
                  title={t("shelfMain.table.title.tip")}
                >
                  {t("shelfMain.table.title")} {sort === "title" ? "▾" : ""}
                </th>
                <th style={{ width: "16%" }}>{t("shelfMain.table.author")}</th>
                <th
                  className={`sortable${sort === "progress" ? " active" : ""}`}
                  style={{ width: 140 }}
                  onClick={() => setSort("progress")}
                  title={t("shelfMain.table.progress.tip")}
                >
                  {t("shelfMain.table.progress")} {sort === "progress" ? "▾" : ""}
                </th>
                <th style={{ width: 90 }}>{t("shelfMain.table.size")}</th>
                <th
                  className={`sortable${sort === "recent" ? " active" : ""}`}
                  style={{ width: 120 }}
                  onClick={() => setSort("recent")}
                  title={t("shelfMain.table.time.tip")}
                >
                  {t("shelfMain.table.time")} {sort === "recent" ? "▾" : ""}
                </th>
                <th className="shelf-table-action-th">{t("shelfMain.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {scope.type === "root" &&
                visibleFolders.map((folder) => (
                  <ShelfFolderTableRow
                    key={folder.id}
                    id={folder.id}
                    name={folder.name}
                    books={folderBooksMap.get(folder.id) ?? []}
                    provider={thumbnailProvider}
                    selectionMode={selectionMode}
                    selectionState={folderSelectionState(folderBooksMap.get(folder.id) ?? [], selectedIds)}
                    isDropTarget={props.externalDropFolderId === folder.id}
                    onOpen={handleOpenFolderModal}
                    onToggleSelected={toggleFolderSelected}
                  />
                ))}
              {/* 书籍区起点（列表几何的 contentTop），兼作虚拟化的前置占位。
                  占位行只放一个不跨列的空格子：窄屏用 CSS 隐去次要列，手机表格又是固定布局，
                  colSpan=8 会凭空撑出被隐去的列，与书名列平分余宽。 */}
              <tr className="shelf-table-book-start" style={{ height: `${virtualizer.topPadding}px` }} aria-hidden="true">
                <td style={{ padding: 0, border: "none" }} />
              </tr>
              {renderedBooks.map((entry, idx) => {
                const actualIndex = virtualizer.isVirtual ? virtualizer.startIndex + idx : idx;
                const hash = entry.contentHash ?? entry.id;
                return (
                  <ShelfTableRow
                    key={entry.id}
                    entry={entry}
                    index={actualIndex}
                    provider={thumbnailProvider}
                    selected={selectedIds.has(entry.id)}
                    selectionMode={selectionMode}
                    isFavorite={isFavorite(organization, hash)}
                    menuOpen={openMenuKey === `list:${entry.id}`}
                    onOpen={props.onOpen}
                    onToggleSelected={toggleSelected}
                    onToggleFavorite={handleToggleFavorite}
                    onRequestMenu={requestMenu}
                    onLongPress={handleBookLongPress}
                  />
                );
              })}
              {virtualizer.bottomPadding > 0 && (
                <tr style={{ height: `${virtualizer.bottomPadding}px` }} aria-hidden="true">
                  <td style={{ padding: 0, border: "none" }} />
                </tr>
              )}
            </tbody>
          </table>
        </ShelfTableScroller>
      ) : (
        <>
          {scope.type === "root" && visibleFolders.length > 0 && (!isCompactMobile || folderPrefixExpanded) && (
            <div className="shelf-folder-prefix">
              <div className="shelf-grid shelf-folder-grid">
                {visibleFolders.map((folder) => (
                  <ShelfFolderCard
                    key={folder.id}
                    id={folder.id}
                    name={folder.name}
                    books={folderBooksMap.get(folder.id) ?? []}
                    provider={thumbnailProvider}
                    selectionMode={selectionMode}
                    selectionState={selectionMode ? folderSelectionState(folderBooksMap.get(folder.id) ?? [], selectedIds) : undefined}
                    onToggleSelected={toggleFolderSelected}
                    isDropTarget={(dropTarget?.type === "folder" && dropTarget.id === folder.id) || props.externalDropFolderId === folder.id}
                    menuOpen={openMenuKey === `folder:${folder.id}`}
                    onOpen={handleOpenFolderModal}
                    onRequestMenu={canOrganize ? requestMenu : undefined}
                  />
                ))}
              </div>
            </div>
          )}
          <div
            className="shelf-book-prefix"
            style={{
              paddingTop: virtualizer.topPadding > 0 ? `${virtualizer.topPadding}px` : undefined,
              paddingBottom: virtualizer.bottomPadding > 0 ? `${virtualizer.bottomPadding}px` : undefined,
            }}
          >
            <div className="shelf-grid shelf-book-grid">
              {renderedBooks.map((entry) => (
                <ShelfCard
                  key={entry.id}
                  entry={entry}
                  surface="book"
                  selected={selectedIds.has(entry.id)}
                  selectionMode={selectionMode}
                  provider={thumbnailProvider}
                  isFavorite={isFavorite(organization, entry.contentHash ?? entry.id)}
                  isDragging={draggedEntry?.id === entry.id}
                  isDropTargetBook={dropTarget?.type === "book" && dropTarget.id === entry.id}
                  draggedEntry={draggedEntry}
                  menuOpen={openMenuKey === `grid:${entry.id}`}
                  canSelect
                  canDrag={canOrganize}
                  onOpen={props.onOpen}
                  onToggleSelected={toggleSelected}
                  onToggleFavorite={canOrganize ? handleToggleFavorite : undefined}
                  onRequestMenu={requestMenu}
                  onLongPress={handleBookLongPress}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* 新建文件夹弹层 */}
      {createFolderOpen && (
        <ShelfCreateFolderDialog
          existingNames={activeFolders.map((f) => f.name)}
          busy={props.busy}
          subtitle={
            pendingMergeBooks && pendingMergeBooks.length >= 2
              ? t("shelfMain.merge", { first: pendingMergeBooks[0].title, second: pendingMergeBooks[1].title })
              : undefined
          }
          onCancel={() => {
            setCreateFolderOpen(false);
            setPendingMergeIds(null);
          }}
          onCreate={async (name) => {
            await handleCreateFolder(name);
          }}
        />
      )}

      {/* 重命名文件夹弹层 */}
      {renameFolderTarget && (
        <ShelfRenameDialog
          folderId={renameFolderTarget.id}
          currentName={renameFolderTarget.name}
          existingNames={activeFolders.map((f) => f.name)}
          busy={props.busy}
          onCancel={() => setRenameFolderTarget(null)}
          onRename={handleRenameFolder}
        />
      )}

      {/* 解散文件夹弹层 */}
      {dissolveFolderTarget && (
        <ShelfDissolveDialog
          folderId={dissolveFolderTarget.id}
          folderName={dissolveFolderTarget.name}
          busy={props.busy}
          onCancel={() => setDissolveFolderTarget(null)}
          onDissolve={handleDissolveFolder}
        />
      )}

      {/* 移至文件夹选择器弹层 */}
      {moveDialogTargets && (
        <ShelfMoveDialog
          targets={moveDialogTargets}
          currentFolderId={
            moveDialogTargets.length > 0
              ? (() => {
                  const firstFolder = effectiveFolderId(
                    organization,
                    moveDialogTargets[0].contentHash ?? moveDialogTargets[0].id
                  );
                  const allSame = moveDialogTargets.every(
                    (t) =>
                      effectiveFolderId(organization, t.contentHash ?? t.id) === firstFolder
                  );
                  return allSame ? firstFolder : null;
                })()
              : null
          }
          folders={moveDialogFolderOptions}
          busy={props.busy}
          onCancel={() => setMoveDialogTargetIds(null)}
          onMove={handleMoveConfirm}
          onCreateFolder={handleCreateFolder}
        />
      )}

      {/* 手机拟物居中文件夹弹窗 */}
      {activeFolderModal && (() => {
        const folder = activeFolders.find((f) => f.id === activeFolderModal.folderId);
        if (!folder) return null;
        const books = sortShelfEntries(folderBooksMap.get(folder.id) ?? [], folderSort);
        return (
          <ShelfFolderModal
            compact={isCompactMobile}
            folder={folder}
            books={books}
            sort={folderSort}
            sortDisabled={props.busy}
            onSortChange={chooseFolderSort}
            registerSubmenuBackHandler={registerSubmenuBackHandler}
            onSubmenuBackActiveChange={reportSubmenuBackActive}
            provider={thumbnailProvider}
            originRect={activeFolderModal.originRect}
            closing={folderModalClosing}
            draggedEntry={draggedEntry}
            organization={organization}
            modalRef={folderModalRef}
            menuBookId={openMenuKey?.startsWith("folderModal:") ? openMenuKey.slice("folderModal:".length) : null}
            folderMenuOpen={openMenuKey === `folderModalHead:${activeFolderModal.folderId}`}
            onClose={handleCloseFolderModal}
            onOpenBook={props.onOpen}
            onRename={(fId, fName) => setRenameFolderTarget({ id: fId, name: fName })}
            onDissolve={(fId, fName) => setDissolveFolderTarget({ id: fId, name: fName })}
            onExportBooks={props.onExportBooks ? () => handleExportFolderBooks(folder.id) : undefined}
            exportDisabled={bookExportDisabled}
            onImportBooks={props.onImportIntoFolder ? () => importInto(folder) : undefined}
            onAddBooks={canOrganize ? () => setAddBooksFolder(folder) : undefined}
            addDisabled={Boolean(props.busy || props.importActive)}
            onToggleFavorite={handleToggleFavorite}
            onRequestMenu={requestMenu}
            onLongPress={handleFolderModalLongPress}
          />
        );
      })()}

      {addBooksFolder && activeFolders.some((f) => f.id === addBooksFolder.id) && (
        <ShelfFolderAddBooksDialog
          folder={addBooksFolder}
          entries={props.entries}
          organization={organization}
          busy={Boolean(props.busy)}
          onCancel={() => setAddBooksFolder(null)}
          onAdd={async (entryIds) => {
            await props.onApplyOrganization?.({ type: "moveBooks", contentHashes: entryIds, folderId: addBooksFolder.id });
            setAddBooksFolder(null);
          }}
        />
      )}

      {/* 删除确认弹层 */}
      {deleteTargets && (
        <div
          className={`shelf-confirm-backdrop${deleteTargetsClosing ? " is-closing" : ""}`}
          onClick={handleCancelDelete}
        >
          <div
            className="shelf-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shelf-confirm-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div id="shelf-confirm-dialog-title" className="shelf-confirm-title">
              {deleteTargets.length > 1
                ? tn("shelfMain.delete.many", deleteTargets.length, { count: deleteTargets.length })
                : t("shelfMain.delete.one")}
            </div>
            <div className="shelf-confirm-name">
              {deleteTargets.length > 1
                ? deleteTargets
                    .slice(0, 3)
                    .map((target) => target.title)
                    .join(t("shelfMain.delete.separator")) + (deleteTargets.length > 3 ? "…" : "")
                : deleteTargets[0].title}
            </div>
            <div className="shelf-confirm-hint">
              {t(deleteTargets.every((target) => target.originalLocation) ? "shelfMain.delete.hintOriginal" : "shelfMain.delete.hint")}
            </div>
            <div className="shelf-confirm-actions">
              <button className="shelf-selection-cancel" type="button" onClick={handleCancelDelete}>
                {t("shelfMain.delete.cancel")}
              </button>
              <button
                className="shelf-selection-delete"
                type="button"
                disabled={props.busy || props.importActive}
                onClick={() => {
                  const ids = deleteTargets.map((target) => target.id);
                  setDeleteTargetIds(null);
                  if (selectionMode) {
                    if (ids.length > 1) props.onDeleteMany(ids);
                    else props.onDelete(ids[0]);
                    exitSelection();
                  } else {
                    props.onDelete(ids[0]);
                  }
                }}
              >
                {t("shelfMain.delete.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 拖拽悬停至文件夹时的高斯模糊背景层（手机文件夹拟物全景模糊） */}
      {dropTarget?.type === "folder" && (
        <div className="shelf-folder-drop-backdrop" aria-hidden="true" />
      )}

      {/* 拖拽跟随时显示的半透明微缩封面浮层 */}
      {/* 触摸拖书时顶部浮出文件夹落点条：手机网格不铺文件夹卡、平板滚动后文件夹也可能不在屏内，
          两端都能直接拖进已有文件夹；不改变下方布局。 */}
      {draggedEntry && coarsePointer && scope.type === "root" && !draggedFromFolderIdRef.current && activeFolders.length > 0 && (
        <div className="shelf-drag-folder-strip" role="list" aria-label={t("shelfMain.drag.strip")}>
          <span className="shelf-drag-folder-strip-label">{t("shelfMain.drag.stripLabel")}</span>
          <div className="shelf-drag-folder-strip-items">
            {activeFolders.map((folder) => (
              <div
                key={folder.id}
                role="listitem"
                className={`shelf-drag-folder-chip${dropTarget?.type === "folder" && dropTarget.id === folder.id ? " is-over" : ""}`}
                data-shelf-target="folder"
                data-folder-id={folder.id}
              >
                <FolderIcon />
                <span>{folder.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {draggedEntry && dragCoord && (
        <div
          className={`shelf-drag-ghost${dropTarget?.type === "folder" ? " is-over-folder" : ""}`}
          style={{
            left: `${dragCoord.x}px`,
            top: `${dragCoord.y}px`,
          }}
          aria-hidden="true"
        >
          <div className="shelf-drag-ghost-cover">
            <Cover entry={draggedEntry} provider={thumbnailProvider} />
          </div>
          <div className="shelf-drag-ghost-badge">
            {draggedEntry.title}
          </div>
        </div>
      )}

      {/* 底部悬浮批量操作底坞 (Floating Batch Bar) */}
      {(selectionMode || dockClosing) && (
        <div ref={batchDockRef} className={`shelf-floating-batch-dock${dockClosing ? " is-closing" : ""}`} role="toolbar" aria-label={t("shelfMain.dock")}>
          <div className="shelf-floating-batch-info">
            <span className="shelf-floating-batch-badge">{selectedIds.size}</span>
            <span>{selectedIds.size > 0 ? tn("shelfMain.dock.selected", selectedIds.size, { count: selectedIds.size }) : t("shelfMain.dock.hint")}</span>
          </div>
          <div className="shelf-floating-batch-actions">
            {/* 动作常驻、未选时置灰：首次勾选时底栏不跳动。 */}
            <button
              className="shelf-batch-action-btn"
              type="button"
              disabled={noneSelected || props.busy}
              onClick={() => void handleBatchFavorite(true)}
              title={t("shelfMain.dock.favorite.tip")}
            >
              <StarIcon filled />
              <span>{t("shelfMain.dock.favorite")}</span>
            </button>
            <button
              className="shelf-batch-action-btn"
              type="button"
              disabled={noneSelected || props.busy}
              onClick={() => void handleBatchFavorite(false)}
              title={t("shelfMain.dock.unfavorite")}
            >
              <StarIcon />
              <span>{t("shelfMain.dock.unfavorite")}</span>
            </button>
            <button
              className="shelf-batch-action-btn"
              type="button"
              disabled={noneSelected || props.busy}
              onClick={() => {
                const targets = props.entries.filter((e) => selectedIds.has(e.id));
                if (targets.length > 0) setMoveDialogTargetIds(targets.map((entry) => entry.id));
              }}
              title={t("shelfMain.dock.move")}
            >
              <FolderIcon />
              <span>{t("shelfMain.dock.move")}</span>
            </button>
            {(props.onExportArchive || props.onExportBooks || props.cloudUpload || (getRuntimeCapabilities().supportsLanTransfer && props.onOpenLanTransfer)) && <span className="shelf-batch-divider" aria-hidden="true" />}
            {props.onExportArchive && (
              <button
                className="shelf-batch-action-btn"
                type="button"
                disabled={noneSelected || props.busy || props.saveFileActive || props.lanTransferActive}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (targets.length > 0) props.onExportArchive!(targets);
                }}
                title={t("shelfMain.dock.export.tip")}
              >
                <ExportIcon />
                <span>{t("shelfMain.dock.export")}</span>
              </button>
            )}
            {props.onExportBooks && (
              <button
                className="shelf-batch-action-btn"
                type="button"
                disabled={noneSelected || props.busy || props.saveFileActive || props.lanTransferActive}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (targets.length > 0) props.onExportBooks!(targets);
                }}
                title={t("bookExport.action.tip")}
              >
                <ExportIcon />
                <span>{t("bookExport.action")}</span>
              </button>
            )}
            {getRuntimeCapabilities().supportsLanTransfer && props.onOpenLanTransfer && (
              <button
                className="shelf-batch-action-btn"
                type="button"
                disabled={!props.lanTransferActive && (noneSelected || props.busy || props.importActive || props.saveFileActive)}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (props.lanTransferActive || targets.length > 0) props.onOpenLanTransfer!(targets);
                }}
                title={t("shelfMain.dock.send.tip")}
              >
                <LanTransferIcon />
                <span>{t("shelfMain.dock.send")}</span>
              </button>
            )}
            {props.cloudUpload && (
              <button
                className="shelf-batch-action-btn"
                type="button"
                disabled={noneSelected || props.busy || cloudUploadRunning}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (targets.length > 0) requestCloudBookUpload(targets.map((entry) => entry.contentHash ?? entry.id));
                }}
                title={t("cloudSync.upload.dock.tip")}
              >
                <CloudUploadIcon />
                <span>{t("cloudSync.upload.dock")}</span>
              </button>
            )}
            <span className="shelf-batch-divider" aria-hidden="true" />
            <button
              className="shelf-batch-action-btn danger"
              type="button"
              disabled={noneSelected || props.busy || props.importActive}
              onClick={() => {
                const targets = props.entries.filter((e) => selectedIds.has(e.id));
                if (targets.length > 0) requestDelete(targets.map((entry) => entry.id));
              }}
              title={t("shelfMain.dock.delete.tip")}
            >
              <TrashIcon />
              <span>{t("shelfMain.dock.delete")}</span>
            </button>
            <button
              className="shelf-batch-action-btn cancel"
              type="button"
              onClick={exitSelection}
              title={t("shelfMain.dock.exit.tip")}
            >
              <CloseIcon />
              <span>{t("shelfMain.dock.exit")}</span>
            </button>
          </div>
        </div>
      )}

      {/* 书架唯一的操作菜单：触屏底部面板 / PC 锚定浮层，同一份动作描述 */}
      {menu && menuView && typeof document !== "undefined" && createPortal(
        <ShelfActionMenu
          key={menu.token}
          presentation={menu.presentation}
          closing={menuClosing}
          label={menuView.label}
          header={menuView.header}
          groups={menuView.groups}
          error={menuError?.token === menu.token ? menuError.text : null}
          anchor={menu.anchor}
          focusFirstItem={menu.focusFirstItem}
          onAction={runMenuAction}
          onDismiss={dismissMenu}
        />,
        getShelfMenuPortalHost(shelfViewRef.current),
      )}

      {/* 首字母快速索引轨与吐司 (A-Z Fast Index Rail) */}
      {sort === "title" && visible.length > 5 && (
        <ShelfAZRail
          letterIndexMap={letterFirstIndexMap}
          onSelectLetter={handleSelectLetter}
        />
      )}
      {toastLetter && (
        <div className="shelf-az-toast" aria-live="polite">
          {toastLetter}
        </div>
      )}
    </div>
  );
}
