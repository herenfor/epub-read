import { FolderNameField } from "./FolderNameField";
import type { ShelfLibraryView } from "./libraryLoad";
import { validateFolderNameDraft, folderNameDraftError } from "./folderNameDraft";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MENU_CLOSE_MS, menuCloseMs, useExitPresence } from "./menuMotion";
import { uiMotionReduced } from "./motionPreference";
import { createPortal } from "react-dom";
import { getShelfMenuPortalHost, type ShelfMenuAnchorRect } from "./shelfMenuPlacement";
import { ShelfGestureTail, shelfLongPressKind, useShelfPress, type ShelfLongPress } from "./shelfPress";
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
  formatShelfTime,
  sortShelfEntries,
  type ShelfEntry,
  type ShelfSort,
} from "./shelf";
import {
  folderSelectionState,
  selectableBookIds,
  sortShelfFolders,
  toggleFolderSelection,
  type FolderSelectionState,
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
import {
  descriptorForEntry,
  isAbortError,
  legacyThumbnailProvider,
  loadThumbnailAsset,
  thumbnailTaskQueue,
  type ThumbnailProvider,
} from "./thumbnail";
import { hasReadPosition } from "./readEvidence";
import { isShelfProgressPending, shelfProgressLabel } from "./shelfProgressDisplay";
import { readCachedLinearMask } from "./chapterCountCache";
import { linearChapterNumber } from "../core/book";
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
import { uiPlural, uiText, useUiText } from "./localization/UiLanguageProvider";
import type { PlainMessageKey } from "./localization/core";

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

function shelfReadingStatus(entry: ShelfEntry): "reading" | "unread" | "finished" {
  if (entry.progressPct >= 100) return "finished";
  if (hasReadPosition(entry) && (entry.progressPct > 0 || isShelfProgressPending(entry))) return "reading";
  return "unread";
}

export interface ShelfViewProps {
  /** 移动端紧凑模式（由 App 根据 mobileChrome && compact 传入） */
  compact?: boolean;
  entries: ShelfEntry[];
  organization?: LibraryOrganization;
  scope?: ShelfScope;
  onScopeChange?(scope: ShelfScope): void;
  onApplyOrganization?(command: OrganizationCommand): Promise<void>;
  /** 全局忙（打开/删除等短操作），书架禁用交互防止重复操作 */
  busy: boolean;
  /** 原生书籍导入活动期间：只禁用冲突入口，不禁用阅读与收藏/文件夹操作。 */
  importActive?: boolean;
  /** 存档文件任务活动期间：只禁用重复的文件入口，不阻塞阅读和其他书架操作。 */
  saveFileActive?: boolean;
  /** LAN 会话活动期间禁用书架入口；一份会话结束并重新连接后再次开放。 */
  lanTransferActive?: boolean;
  /** 打开共享的设备互传面板，可携带当前批量选择用于“选中书籍”范围。 */
  onOpenLanTransfer?(selectedEntries?: ShelfEntry[]): void;
  theme: Theme;
  onThemeChange(theme: Theme): void;
  /** Android 阅读栏电量显示（本机偏好）；未提供时不显示该设置。 */
  batteryIndicatorEnabled?: boolean;
  onBatteryIndicatorChange?(enabled: boolean): void;
  hideReaderSystemStatusBar?: boolean;
  onHideReaderSystemStatusBarChange?(hidden: boolean): void;
  keepScreenOnWhileReading?: boolean;
  onKeepScreenOnWhileReadingChange?(enabled: boolean): void;
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
  /** `selectedEntries` is handled by App and resolved to 64-bit content hashes before any native job is created. */
  onExportArchive(selectedEntries?: ShelfEntry[]): void;
  /** SBE-U: save original EPUB files; no entries means the whole shelf. */
  onExportBooks?(selectedEntries?: ShelfEntry[]): void;
  /** Legacy v1/v2 JSON import stays secondary on native; Web can leave this undefined and use its existing entry. */
  onImportLegacyArchive?(): void;
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

interface ShelfSubmenuBackProps {
  registerSubmenuBackHandler?: (handler: (() => boolean) | null) => void;
  onSubmenuBackActiveChange?: (active: boolean) => void;
}

function useShelfSubmenuBack(
  open: boolean,
  close: () => void,
  props: ShelfSubmenuBackProps,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const handler = useCallback((): boolean => {
    closeRef.current();
    return true;
  }, []);
  useEffect(() => {
    if (!open) return;
    props.registerSubmenuBackHandler?.(handler);
    props.onSubmenuBackActiveChange?.(true);
    return () => {
      props.registerSubmenuBackHandler?.(null);
      props.onSubmenuBackActiveChange?.(false);
    };
  }, [handler, open, props.onSubmenuBackActiveChange, props.registerSubmenuBackHandler]);
}

/* =========================================================================
 * 现代轻量矢量 SVG 图标集（统一 20x20 视口，1.75px 线宽，双端一致设计语言）
 * ========================================================================= */

function BookLogoIcon() {
  return (
    <svg className="shelf-svg-icon shelf-logo-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.25 16.25 4.25 4.25" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <polyline points="7 8 12 3 17 8" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

/** 设备互传：电脑 + 手机，与互传面板、抽屉入口同一个图标。 */
function LanTransferIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="5" width="12" height="9" rx="1.5" />
      <path d="M5.5 18h6" />
      <rect x="16" y="8.5" width="5.5" height="11" rx="1.3" />
    </svg>
  );
}

function BookAddIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}

function FolderAddIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </svg>
  );
}

function CheckSquareIcon({ checked }: { checked: boolean }) {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" fill={checked ? "currentColor" : "none"} />
      <path d="m8 12.2 2.8 2.8L16.2 9.4" stroke={checked ? "var(--accent-foreground, #fff)" : "currentColor"} />
    </svg>
  );
}

interface ShelfImportButtonProps extends ShelfSubmenuBackProps {
  compact: boolean;
  disabled: boolean;
  /** Drag-and-drop works only with a mouse; hide the hint on touch. */
  showDropHint: boolean;
  /** Open folder the main action imports into; absent = shelf root. */
  targetName?: string;
  onImport(): void;
  onImportFolder?(): void;
}

/**
 * Shelf import entry. With directory import available it is a split button
 * (main action = 导入图书, caret = menu); on phones the whole 导入 button opens
 * the menu. The menu animates in/out with the shared popover motion.
 */
function ShelfImportButton(props: ShelfImportButtonProps) {
  const { t } = useUiText();
  const importTip = props.targetName === undefined
    ? t("shelf.import.tip")
    : t("shelf.import.toFolder.tip", { name: props.targetName });
  const [open, setOpen] = useState(false);
  const { present, closing } = useExitPresence(open);
  const wrapRef = useRef<HTMLDivElement>(null);

  useShelfSubmenuBack(open, () => setOpen(false), props);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  if (!props.onImportFolder) {
    return (
      <button
        className={`shelf-btn-primary${props.compact ? " shelf-mobile-import-btn" : ""}`}
        type="button"
        onClick={() => props.onImport()}
        disabled={props.disabled}
        title={importTip}
      >
        <PlusIcon />
        <span>{props.compact ? t("shelf.import.short") : t("shelf.import.books")}</span>
      </button>
    );
  }

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="shelf-import-split" ref={wrapRef}>
      {props.compact ? (
        <button
          className="shelf-btn-primary shelf-mobile-import-btn"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          disabled={props.disabled}
          title={t("shelf.import.menu.tip")}
        >
          <PlusIcon />
          <span>{t("shelf.import.short")}</span>
        </button>
      ) : (
        <>
          <button
            className="shelf-btn-primary shelf-import-main"
            type="button"
            onClick={() => props.onImport()}
            disabled={props.disabled}
            title={importTip}
          >
            <PlusIcon />
            <span>{t("shelf.import.books")}</span>
          </button>
          <button
            className="shelf-btn-primary shelf-import-caret"
            type="button"
            aria-label={t("shelf.import.more")}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            disabled={props.disabled}
          >
            <ChevronDownIcon />
          </button>
        </>
      )}
      {present && (
        <div className={`shelf-import-menu${closing ? " is-closing" : ""}`} role="menu" aria-label={t("shelf.import.menu")}>
          <button className="shelf-import-menu-item" type="button" role="menuitem" onClick={() => choose(props.onImport)}>
            <span className="shelf-import-menu-icon"><BookAddIcon /></span>
            <span className="shelf-import-menu-text">
              <strong>{t("shelf.import.books")}</strong>
              <small>{t("shelf.import.books.detail")}</small>
            </span>
          </button>
          <button className="shelf-import-menu-item" type="button" role="menuitem" onClick={() => choose(props.onImportFolder!)}>
            <span className="shelf-import-menu-icon"><FolderAddIcon /></span>
            <span className="shelf-import-menu-text">
              <strong>{t("shelf.import.folder")}</strong>
              <small>{t("shelf.import.folder.detail")}</small>
            </span>
          </button>
          {props.showDropHint && <p className="shelf-import-menu-hint">{t("shelf.import.dropHint")}</p>}
        </div>
      )}
    </div>
  );
}

function CheckListIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="4" height="4" rx="1" />
      <rect x="3" y="15" width="4" height="4" rx="1" />
      <line x1="11" y1="7" x2="21" y2="7" />
      <line x1="11" y1="17" x2="21" y2="17" />
    </svg>
  );
}

function DotsVerticalIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="1.25" fill="currentColor" />
      <circle cx="12" cy="6" r="1.25" fill="currentColor" />
      <circle cx="12" cy="18" r="1.25" fill="currentColor" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function StarIcon({ filled }: { filled?: boolean }) {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 14, height: 14 }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 14, height: 14 }}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 14, height: 14 }}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}


function BookOpenIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 14, height: 14 }}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

/* =========================================================================
 * 莫兰迪算法调色板与封面组件（高性能按需加载 + 高雅莫兰迪算法装帧）
 * ========================================================================= */

const MORANDI_PALETTES = [
  { bg: "#4A5568", fg: "#F7FAFC", border: "rgba(247, 250, 252, 0.25)", accent: "rgba(247, 250, 252, 0.18)" }, // 灰青
  { bg: "#2D3748", fg: "#EDF2F7", border: "rgba(237, 242, 247, 0.25)", accent: "rgba(237, 242, 247, 0.18)" }, // 墨黛
  { bg: "#5C5248", fg: "#FDF6E2", border: "rgba(253, 246, 226, 0.25)", accent: "rgba(253, 246, 226, 0.18)" }, // 枯茶
  { bg: "#3D4F53", fg: "#E6F1F2", border: "rgba(230, 241, 242, 0.25)", accent: "rgba(230, 241, 242, 0.18)" }, // 苍绿
  { bg: "#5A4E5C", fg: "#F5EDF7", border: "rgba(245, 237, 247, 0.25)", accent: "rgba(245, 237, 247, 0.18)" }, // 暮紫
  { bg: "#4B5358", fg: "#EDF3F7", border: "rgba(237, 243, 247, 0.25)", accent: "rgba(237, 243, 247, 0.18)" }, // 暮蓝
  { bg: "#5A4944", fg: "#F9ECE8", border: "rgba(249, 236, 232, 0.25)", accent: "rgba(249, 236, 232, 0.18)" }, // 焦赭
  { bg: "#48524B", fg: "#EDF5EF", border: "rgba(237, 245, 239, 0.25)", accent: "rgba(237, 245, 239, 0.18)" }, // 艾绿
];

function shelfActionIcon(id: ShelfActionId): ReactNode {
  switch (id) {
    case "open": return <BookLogoIcon />;
    case "select": return <CheckListIcon />;
    case "favorite": return <StarIcon />;
    case "unfavorite": return <StarIcon filled />;
    case "exportBook": return <ExportIcon />;
    case "move":
    case "removeFromFolder":
    case "openFolder": return <FolderIcon />;
    case "renameFolder": return <EditIcon />;
    case "delete":
    case "dissolveFolder": return <TrashIcon />;
  }
}

/** The one presentation for an empty shelf, an empty scope and a list with no match. */
function ShelfEmptyState(props: { icon: ReactNode; title: string; hint: string; children?: ReactNode }) {
  return (
    <div className="shelf-empty">
      <div className="shelf-empty-icon" aria-hidden="true">
        {props.icon}
      </div>
      <div className="shelf-empty-title">{props.title}</div>
      <div className="shelf-empty-hint">{props.hint}</div>
      {props.children}
    </div>
  );
}

function getMorandiPalette(title: string, id: string) {
  let hash = 0;
  const str = id + title;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % MORANDI_PALETTES.length;
  const initial = title.trim().charAt(0) || uiText("shelf.cover.initialFallback");
  return { ...MORANDI_PALETTES[idx], initial };
}

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const Cover = memo(function Cover({
  entry,
  provider,
}: {
  entry: ShelfEntry;
  provider: ThumbnailProvider;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const loadedFor = useRef<string>("");
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([item]) => {
        if (!item?.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { root: null, rootMargin: "100% 0px", threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport || entry.available === false) return;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    loadedFor.current = entry.id;
    setUrl(null);
    void thumbnailTaskQueue
      .enqueue(
        (signal) => loadThumbnailAsset(provider, descriptorForEntry(entry), signal),
        controller.signal
      )
      .then((asset) => {
        if (controller.signal.aborted || !asset || asset.bytes.byteLength === 0) return;
        const nextUrl = URL.createObjectURL(
          new Blob([asset.bytes.slice().buffer as ArrayBuffer], {
            type: asset.mime || entry.coverMime || "image/jpeg",
          })
        );
        if (controller.signal.aborted) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        objectUrl = nextUrl;
        setUrl(nextUrl);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          /* 封面读取失败按无封面处理 */
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry.id, entry.contentHash, entry.coverMime, entry.thumbnailMime, entry.available, nearViewport, provider]);

  if (!url || loadedFor.current !== entry.id) {
    const palette = getMorandiPalette(entry.title, entry.id);
    return (
      <div
        ref={nodeRef}
        className="shelf-cover fallback morandi-cover"
        style={{ backgroundColor: palette.bg, color: palette.fg }}
        aria-hidden="true"
      >
        <div className="morandi-spine-shadow" />
        <div className="morandi-inner-frame" style={{ borderColor: palette.border }}>
          <span className="morandi-watermark fallback-mark" style={{ color: palette.accent }}>
            {palette.initial}
          </span>
          <span className="morandi-title fallback-title">{entry.title}</span>
          {entry.creator && <span className="morandi-creator">{entry.creator}</span>}
        </div>
      </div>
    );
  }
  return <img className="shelf-cover" src={url} alt={entry.title} loading="lazy" draggable={false} />;
});

function formatRelativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return uiText("shelf.time.justNow");
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.floor(diff / (60 * 1000));
    return uiPlural("shelf.time.minutesAgo", minutes, { count: minutes });
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return uiPlural("shelf.time.hoursAgo", hours, { count: hours });
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(ms);
  if (
    target.getDate() === yesterday.getDate() &&
    target.getMonth() === yesterday.getMonth() &&
    target.getFullYear() === yesterday.getFullYear()
  ) {
    return uiText("shelf.time.yesterday");
  }
  return formatShelfTime(ms);
}

/* =========================================================================
 * 续读控制台组件（横向紧凑控制台、3D 书脊阴影、精确锚点与一键开书）
 * ========================================================================= */

interface ShelfResumeStageProps extends ShelfSubmenuBackProps {
  entries: ShelfEntry[];
  provider: ThumbnailProvider;
  busy?: boolean;
  compact?: boolean;
  onOpen(id: string): void;
}

const ShelfResumeStage = memo(function ShelfResumeStage({
  entries,
  provider,
  busy,
  compact,
  onOpen,
  registerSubmenuBackHandler,
  onSubmenuBackActiveChange,
}: ShelfResumeStageProps) {
  const { t } = useUiText();
  const readingBooks = useMemo(() => {
    return entries
      .filter(
        (e) =>
          hasReadPosition(e) &&
          (e.progressPct ?? 0) < 100 &&
          e.lastReadAtMs > 0
      )
      .sort((a, b) => b.lastReadAtMs - a.lastReadAtMs)
      .slice(0, 10);
  }, [entries]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreDropdownRef = useRef<HTMLDivElement>(null);

  useShelfSubmenuBack(moreOpen, () => setMoreOpen(false), {
    registerSubmenuBackHandler,
    onSubmenuBackActiveChange,
  });

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!moreDropdownRef.current?.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMoreOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem("epub_shelf_resume_collapsed");
      if (stored !== null) {
        return stored === "true";
      }
      return !!compact;
    } catch {
      return !!compact;
    }
  });

  const stageRef = useRef<HTMLDivElement>(null);
  /** Height before a toggle; the layout effect animates from it to the new natural height. */
  const heightBeforeToggleRef = useRef<number | null>(null);
  const settleAnimationRef = useRef<(() => void) | null>(null);

  const toggleCollapse = useCallback(() => {
    const stage = stageRef.current;
    if (stage) {
      // Mid-animation toggles continue from the height currently on screen.
      heightBeforeToggleRef.current = stage.getBoundingClientRect().height;
      settleAnimationRef.current?.();
    }
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("epub_shelf_resume_collapsed", String(next));
      } catch {}
      return next;
    });
  }, []);

  // Real height morph: pin the old height, then transition to the new natural
  // height. The outgoing pane overlays and is clipped as the card shrinks or
  // grows; panes only cross-fade. Height-only, one element, ~280ms.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const from = heightBeforeToggleRef.current;
    heightBeforeToggleRef.current = null;
    if (!stage || from === null || uiMotionReduced()) return;
    const to = stage.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    stage.classList.add("is-animating");
    stage.style.height = `${from}px`;
    void stage.offsetHeight;
    stage.style.height = `${to}px`;
    let timer = 0;
    const settle = () => {
      window.clearTimeout(timer);
      stage.removeEventListener("transitionend", onEnd);
      stage.classList.remove("is-animating");
      stage.style.height = "";
      settleAnimationRef.current = null;
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === stage && event.propertyName === "height") settle();
    };
    stage.addEventListener("transitionend", onEnd);
    timer = window.setTimeout(settle, 450);
    settleAnimationRef.current = settle;
    return settle;
  }, [collapsed]);

  const activeBook = useMemo(() => {
    if (readingBooks.length === 0) return null;
    if (selectedId) {
      const found = readingBooks.find((b) => b.id === selectedId);
      if (found) return found;
    }
    return readingBooks[0];
  }, [readingBooks, selectedId]);
  const activeKey = activeBook ? activeBook.contentHash ?? activeBook.id : null;
  const linearMask = useMemo(() => readCachedLinearMask(activeKey), [activeKey]);

  useEffect(() => {
    if (!activeBook) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (!target || target === document.body || target.classList.contains("shelf-view")) {
          e.preventDefault();
          onOpen(activeBook.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeBook, onOpen]);

  if (!activeBook) return null;

  const barWidth = isShelfProgressPending(activeBook)
    ? "0%"
    : `${Math.max(2, Math.min(100, activeBook.progressPct ?? 0))}%`;
  const spineIndex = activeBook.spineIndex ?? 0;
  // Same numbering as the reader footer; books never opened since this cache existed keep the raw position.
  const chapterNumber = (linearMask ? linearChapterNumber(linearMask, spineIndex) : null) ?? spineIndex + 1;
  const chapterLabel = t("shelf.resume.chapter", { n: chapterNumber, progress: shelfProgressLabel(activeBook) });

  // Both states stay mounted; the stage animates its grid rows between them so
  // expanding/collapsing is one short height + cross-fade, not a remount jump.
  return (
    <div ref={stageRef} className={`shelf-resume-stage${collapsed ? " is-collapsed" : " is-expanded"}`}>
      <div className="shelf-resume-pane shelf-resume-pane-compact" aria-hidden={!collapsed}>
        <div className="shelf-resume-collapsed">
          <button
            className="shelf-resume-compact-open"
            type="button"
            tabIndex={collapsed ? 0 : -1}
            onClick={() => onOpen(activeBook.id)}
            title={t("shelf.resume.open", { title: activeBook.title })}
          >
            <span className="shelf-resume-mini-cover" aria-hidden="true">
              <Cover entry={activeBook} provider={provider} />
            </span>
            <span className="shelf-resume-compact-text">
              <span className="shelf-resume-compact-title">{activeBook.title}</span>
              <span className="shelf-resume-compact-meta">
                <span>{chapterLabel}</span>
                <span className="shelf-resume-mini-track" aria-hidden="true">
                  <span style={{ width: barWidth }} />
                </span>
              </span>
            </span>
          </button>
          <div className="shelf-resume-collapsed-right">
            <button
              className="shelf-resume-continue"
              type="button"
              tabIndex={collapsed ? 0 : -1}
              onClick={() => onOpen(activeBook.id)}
              disabled={busy}
            >
              <span>{t("shelf.resume.continue")}</span>
              <ArrowRightIcon />
            </button>
            <button
              className="shelf-resume-toggle-btn"
              type="button"
              tabIndex={collapsed ? 0 : -1}
              onClick={toggleCollapse}
              title={t("shelf.resume.expand.tip")}
              aria-label={t("shelf.resume.expand")}
              aria-expanded={false}
            >
              <ChevronDownIcon />
            </button>
          </div>
        </div>
      </div>

      <div className="shelf-resume-pane shelf-resume-pane-full" aria-hidden={collapsed}>
        <div className="shelf-resume-expanded">
          <div className="shelf-resume-main">
            <button
              className="shelf-resume-cover-box"
              type="button"
              tabIndex={collapsed ? -1 : 0}
              onClick={() => onOpen(activeBook.id)}
              title={t("shelf.resume.open", { title: activeBook.title })}
            >
              <Cover entry={activeBook} provider={provider} />
            </button>
            <div className="shelf-resume-info">
              <div className="shelf-resume-meta-row">
                <span className="shelf-resume-tag">
                  <BookOpenIcon />
                  <span>{t("shelf.resume.reading")}</span>
                </span>
                <span className="shelf-resume-time">
                  {formatRelativeTime(activeBook.lastReadAtMs)}
                </span>
              </div>
              <button
                className="shelf-resume-title"
                type="button"
                tabIndex={collapsed ? -1 : 0}
                onClick={() => onOpen(activeBook.id)}
                title={activeBook.title}
              >
                {activeBook.title}
              </button>
              <div className="shelf-resume-author">{activeBook.creator || t("shelf.unknownAuthor")}</div>
              <div className="shelf-resume-anchor-row">
                <div className="shelf-resume-anchor-text">{t("shelf.resume.lastAt", { place: chapterLabel })}</div>
                <div className="shelf-resume-progress-track">
                  <div className="shelf-resume-progress-bar" style={{ width: barWidth }} />
                </div>
              </div>
            </div>
          </div>
          <div className="shelf-resume-actions">
            {readingBooks.length > 1 && (
              <div className="shelf-more-reading-dropdown" ref={moreDropdownRef}>
                <button
                  className="shelf-more-reading-btn"
                  type="button"
                  tabIndex={collapsed ? -1 : 0}
                  onClick={() => setMoreOpen(!moreOpen)}
                  aria-expanded={moreOpen}
                  title={t("shelf.resume.more.tip")}
                >
                  <span>{t("shelf.resume.more", { count: readingBooks.length })}</span>
                  <ChevronDownIcon />
                </button>
                {moreOpen && (
                  <div className="shelf-more-reading-popover">
                    {readingBooks.map((b) => (
                      <div
                        key={b.id}
                        className={`shelf-more-reading-item${b.id === activeBook.id ? " active" : ""}`}
                        onClick={() => {
                          setSelectedId(b.id);
                          setMoreOpen(false);
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="shelf-more-reading-item-title">{b.title}</div>
                          <div className="shelf-more-reading-item-meta">
                            {shelfProgressLabel(b)} · {formatRelativeTime(b.lastReadAtMs)}
                          </div>
                        </div>
                        <button
                          className="shelf-more-reading-open"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(b.id);
                            setMoreOpen(false);
                          }}
                        >
                          {t("shelf.resume.openBook")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              className="shelf-btn-resume"
              type="button"
              tabIndex={collapsed ? -1 : 0}
              onClick={() => onOpen(activeBook.id)}
              disabled={busy}
              title={t("shelf.resume.continueReading.tip")}
            >
              <span>{t("shelf.resume.continueReading")}</span>
              <ArrowRightIcon />
              {!compact && <span className="shelf-resume-key-hint">Enter</span>}
            </button>
            <button
              className="shelf-resume-toggle-btn"
              type="button"
              tabIndex={collapsed ? -1 : 0}
              onClick={toggleCollapse}
              title={t("shelf.resume.collapse.tip")}
              aria-label={t("shelf.resume.collapse")}
              aria-expanded={true}
            >
              <ChevronUpIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

/* =========================================================================
 * 书籍卡片组件（现代极简排版、内嵌进度条、触控安全区）
 * ========================================================================= */

/** Which shelf object a menu is for; identity is the stable id, never a captured entry object. */
export type ShelfMenuTarget =
  | { kind: "book"; id: string; surface: "grid" | "list" | "folderModal" }
  | { kind: "folder"; id: string };

/** How a card asked for its menu. */
export interface ShelfMenuOpener {
  trigger: HTMLElement | null;
  /** Right-click position; absent anchors at the trigger. */
  point?: { x: number; y: number };
  pointerType: string;
  keyboard: boolean;
  /** The three-dot of an already open menu closes it instead of reopening. */
  toggle: boolean;
}

interface ShelfMenuSession {
  /** Every opening gets a new token; async results only land on the menu that started them. */
  token: number;
  target: ShelfMenuTarget;
  presentation: "sheet" | "popover";
  anchor: ShelfMenuAnchorRect;
  trigger: HTMLElement | null;
  focusFirstItem: boolean;
}

function sameShelfMenuTarget(a: ShelfMenuTarget, b: ShelfMenuTarget): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind !== "book" || b.kind !== "book" || a.surface === b.surface;
}

function buttonMenuOpener(event: React.MouseEvent<HTMLElement>, pressedWith: string): ShelfMenuOpener {
  const keyboard = event.detail === 0;
  const pointerType = keyboard ? "" : ((event.nativeEvent as Partial<PointerEvent>).pointerType || pressedWith);
  return { trigger: event.currentTarget, pointerType, keyboard, toggle: true };
}

function contextMenuOpener(event: React.MouseEvent<HTMLElement>, trigger: HTMLElement | null): ShelfMenuOpener {
  // Touch long press never gets here (the press recognizer owns it). A right button is the mouse;
  // the context-menu key / Shift+F10 arrives without it and anchors at the card's own button.
  const keyboard = event.button !== 2;
  const pointerType = keyboard ? "" : ((event.nativeEvent as Partial<PointerEvent>).pointerType || "mouse");
  return {
    trigger,
    point: keyboard ? undefined : { x: event.clientX, y: event.clientY },
    pointerType,
    keyboard,
    toggle: false,
  };
}

interface ShelfCardProps {
  entry: ShelfEntry;
  /** Folder-dialog books have no selection mode; their long press drags them out. */
  surface: "book" | "folderModalBook";
  selected: boolean;
  selectionMode: boolean;
  provider: ThumbnailProvider;
  isFavorite?: boolean;
  isDragging?: boolean;
  isDropTargetBook?: boolean;
  draggedEntry?: ShelfEntry | null;
  menuOpen?: boolean;
  canSelect?: boolean;
  canDrag?: boolean;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onToggleFavorite?(entry: ShelfEntry): void;
  onRequestMenu?(target: ShelfMenuTarget, opener: ShelfMenuOpener): void;
  onLongPress?(entry: ShelfEntry, kind: ShelfLongPress, point: { x: number; y: number }): void;
}

const ShelfCard = memo(function ShelfCard(props: ShelfCardProps) {
  const { t } = useUiText();
  const { entry } = props;
  const moreRef = useRef<HTMLButtonElement>(null);
  const morePressedWith = useRef("");

  const last = entry.lastReadAtMs > 0 ? entry.lastReadAtMs : entry.addedAtMs;
  const recent = Date.now() - last < 1000 * 60 * 60 * 24 * 7;
  // Badge and status line follow the same judgement as the status filters.
  const status = shelfReadingStatus(entry);

  const press = useShelfPress({
    longPressKind: (pointerType) => shelfLongPressKind(props.surface, pointerType, props.selectionMode, {
      select: props.canSelect, drag: props.canDrag,
    }),
    onLongPress: (kind, point) => props.onLongPress?.(entry, kind, point),
  });

  const activate = (): void => {
    if (props.selectionMode) props.onToggleSelected(entry.id);
    else props.onOpen(entry.id);
  };

  const requestMenu = (opener: ShelfMenuOpener): void => {
    if (props.selectionMode) return;
    props.onRequestMenu?.({ kind: "book", id: entry.id, surface: props.surface === "folderModalBook" ? "folderModal" : "grid" }, opener);
  };

  return (
    <div
      className={`shelf-card${props.selected ? " selected" : ""}${entry.available === false ? " unavailable" : ""}${props.isDragging ? " is-dragging" : ""}${props.isDropTargetBook ? " drag-over-book" : ""}${props.menuOpen ? " menu-open" : ""}`}
      role="button"
      tabIndex={0}
      data-shelf-target="book"
      data-book-id={entry.id}
      {...press.handlers}
      onClick={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (press.swallowClick(e)) return;
        activate();
      }}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        if (press.swallowTouchContextMenu(e)) return;
        e.preventDefault();
        // 多选状态的长按留给拖动，不弹系统/卡片菜单。
        requestMenu(contextMenuOpener(e, moreRef.current ?? e.currentTarget));
      }}
      onKeyDown={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      title={`${entry.title}${entry.creator ? ` · ${entry.creator}` : ""}`}
    >
      <div className="shelf-cover-box">
        <Cover entry={entry} provider={props.provider} />

        {/* 模拟创建文件夹的交互预览态 */}
        {props.isDropTargetBook && (
          <div className="shelf-card-folder-sim-overlay" aria-hidden="true">
            <div className="shelf-folder-sim-pill">
              <FolderIcon />
              <span>{t("shelf.card.dropToCreateFolder")}</span>
            </div>
            <div className="shelf-folder-sim-mosaic">
              <div className="shelf-folder-sim-thumb primary">
                <Cover entry={entry} provider={props.provider} />
              </div>
              {props.draggedEntry && (
                <div className="shelf-folder-sim-thumb incoming">
                  <Cover entry={props.draggedEntry} provider={props.provider} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* 单卡片星标按钮 */}
        {!props.selectionMode && props.onToggleFavorite && (
          <button
            className={`shelf-card-star-btn${props.isFavorite ? " active" : ""}`}
            type="button"
            title={props.isFavorite ? t("shelf.card.unfavorite") : t("shelf.card.favorite")}
            aria-label={props.isFavorite ? t("shelf.card.unfavoriteBook", { title: entry.title }) : t("shelf.card.favoriteBook", { title: entry.title })}
            aria-pressed={props.isFavorite}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleFavorite?.(entry);
            }}
          >
            <StarIcon filled={props.isFavorite} />
          </button>
        )}

        {/* 多选模式勾选框 */}
        {props.selectionMode && (
          <div className={`shelf-card-checkbox${props.selected ? " checked" : ""}`} aria-hidden="true">
            {props.selected && <CheckIcon />}
          </div>
        )}

        {/* 状态徽标（极简胶囊，不破坏封面比例） */}
        <div className="shelf-card-badges" aria-hidden="true">
          {entry.available === false ? (
            <span className="shelf-badge missing">{getRuntimeCapabilities().platform === "android" ? t("shelf.card.reimport") : t("shelf.card.sourceMissing")}</span>
          ) : (
            <>
              {entry.isNew && !props.selectionMode && <span className="shelf-badge new">{t("shelf.card.new")}</span>}
              {recent && status === "reading" && !entry.isNew && !props.selectionMode && (
                <span className="shelf-badge reading">{t("shelf.card.reading")}</span>
              )}
            </>
          )}
        </div>

        {/* 贴合封面底边的纤细微光进度条 */}
        {entry.progressPct > 0 && (
          <div className="shelf-card-progress-bar" title={t("shelf.card.progress", { percent: entry.progressPct })}>
            <div
              className="shelf-card-progress-fill"
              style={{ width: `${Math.min(100, entry.progressPct)}%` }}
            />
          </div>
        )}

        {/* 三点按钮只请求书架唯一的操作菜单；按钮自身的按压不进入卡片手势。 */}
        {!props.selectionMode && props.onRequestMenu && (
          <div className="shelf-card-actions-wrap">
            <button
              ref={moreRef}
              className={`shelf-card-more-btn${props.menuOpen ? " active" : ""}`}
              type="button"
              title={t("shelf.card.more.tip")}
              aria-label={t("shelf.card.more", { title: entry.title })}
              aria-haspopup="menu"
              aria-expanded={props.menuOpen === true}
              onPointerDown={(e) => { morePressedWith.current = e.pointerType; }}
              onClick={(e) => {
                e.stopPropagation();
                requestMenu(buttonMenuOpener(e, morePressedWith.current));
              }}
            >
              <DotsVerticalIcon />
            </button>
          </div>
        )}
      </div>

      {/* 底部标题与元数据 */}
      <div className="shelf-card-info">
        <div className="shelf-card-title">{entry.title}</div>
        <div className="shelf-card-meta">
          <span className="shelf-card-creator" title={entry.creator || t("shelf.unknownAuthor")}>
            {entry.creator || t("shelf.unknownAuthor")}
          </span>
          <span className="shelf-card-subline">
            {status !== "unread" ? (
              <span className="shelf-read-stat">{shelfProgressLabel(entry, t("shelf.card.readSuffix"))}</span>
            ) : (
              <span className="shelf-read-stat unread">{t("shelf.card.unread")}</span>
            )}
            <span className="shelf-dot" aria-hidden="true">·</span>
            <span className="shelf-time">{formatShelfTime(last) || t("shelf.time.justNow")}</span>
          </span>
        </div>
      </div>
    </div>
  );
});

/* =========================================================================
 * 文件夹卡片组件（4图马赛克拼图、弹层菜单、触控安全区）
 * ========================================================================= */

interface ShelfFolderCardProps {
  id: string;
  name: string;
  books: ShelfEntry[];
  provider: ThumbnailProvider;
  selectionMode: boolean;
  /** Batch selection: derived from the selected books (see shelfFolderSelection). */
  selectionState?: FolderSelectionState;
  onToggleSelected?(id: string): void;
  isDropTarget?: boolean;
  menuOpen?: boolean;
  onOpen(id: string, element?: HTMLElement | null): void;
  onRequestMenu?(target: ShelfMenuTarget, opener: ShelfMenuOpener): void;
}

const ShelfFolderCard = memo(function ShelfFolderCard(props: ShelfFolderCardProps) {
  const { t, tn } = useUiText();
  const cardRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const morePressedWith = useRef("");

  const requestMenu = (opener: ShelfMenuOpener): void => {
    if (props.selectionMode) return;
    props.onRequestMenu?.({ kind: "folder", id: props.id }, opener);
  };

  // 触屏长按文件夹直接给出操作面板（原先依赖系统 contextmenu，会和点击抢同一手势）。
  const press = useShelfPress({
    longPressKind: (pointerType) => shelfLongPressKind("folder", pointerType, props.selectionMode, { menu: Boolean(props.onRequestMenu) }),
    onLongPress: (kind) => {
      if (kind === "menu") requestMenu({ trigger: moreRef.current ?? cardRef.current, pointerType: "touch", keyboard: false, toggle: false });
    },
  });

  const selectable = props.selectionState !== undefined && props.selectionState !== "empty";
  const handleCardClick = (): void => {
    if (!props.selectionMode) props.onOpen(props.id, cardRef.current);
    else if (selectable) props.onToggleSelected?.(props.id);
  };

  const sampleBooks = props.books.slice(0, 9);
  const checked = props.selectionState === "all";
  const mixed = props.selectionState === "mixed";

  return (
    <div
      ref={cardRef}
      className={`shelf-card shelf-folder-card${props.isDropTarget ? " is-drop-target" : ""}${props.menuOpen ? " menu-open" : ""}${props.selectionMode && checked ? " selected" : ""}`}
      role={props.selectionMode ? "checkbox" : "button"}
      aria-checked={props.selectionMode ? (mixed ? "mixed" : checked) : undefined}
      aria-disabled={props.selectionMode && !selectable ? true : undefined}
      aria-label={props.selectionMode ? t("shelfFolder.select", { name: props.name }) : undefined}
      tabIndex={0}
      data-shelf-target="folder"
      data-folder-id={props.id}
      {...press.handlers}
      onClick={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (press.swallowClick(e)) return;
        handleCardClick();
      }}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        if (press.swallowTouchContextMenu(e)) return;
        e.preventDefault();
        requestMenu(contextMenuOpener(e, moreRef.current ?? e.currentTarget));
      }}
      onKeyDown={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      title={props.selectionMode && !selectable
        ? t("shelfFolder.select.empty")
        : tn("shelfFolder.card.tip", props.books.length, { name: props.name, count: props.books.length })}
    >
      <div className="shelf-cover-box shelf-folder-cover-box">
        {props.selectionMode && (
          <div className={`shelf-card-checkbox${checked ? " checked" : ""}${mixed ? " mixed" : ""}${selectable ? "" : " disabled"}`} aria-hidden="true">
            {checked && <CheckIcon />}
            {mixed && <span className="shelf-card-checkbox-dash" />}
          </div>
        )}
        {props.isDropTarget && (
          <div className="shelf-folder-drop-overlay" aria-hidden="true">
            <div className="shelf-folder-drop-badge">
              <PlusIcon />
              <span>{t("shelfFolder.card.drop")}</span>
            </div>
          </div>
        )}
        {sampleBooks.length === 0 ? (
          <div className="shelf-folder-empty-cover" aria-hidden="true">
            <FolderIcon />
          </div>
        ) : (
          <div className="shelf-folder-mosaic shelf-folder-mosaic-3x3">
            {sampleBooks.map((b) => (
              <div key={b.id} className="shelf-folder-mosaic-cell">
                <Cover entry={b} provider={props.provider} />
              </div>
            ))}
          </div>
        )}

        {!props.selectionMode && props.onRequestMenu && (
          <div className="shelf-card-actions-wrap">
            <button
              ref={moreRef}
              className={`shelf-card-more-btn${props.menuOpen ? " active" : ""}`}
              type="button"
              title={t("shelfFolder.options.tip")}
              aria-label={t("shelfFolder.options", { name: props.name })}
              aria-haspopup="menu"
              aria-expanded={props.menuOpen === true}
              onPointerDown={(e) => { morePressedWith.current = e.pointerType; }}
              onClick={(e) => {
                e.stopPropagation();
                requestMenu(buttonMenuOpener(e, morePressedWith.current));
              }}
            >
              <DotsVerticalIcon />
            </button>
          </div>
        )}
      </div>

      <div className="shelf-card-info">
        <div className="shelf-card-title">{props.name}</div>
        <div className="shelf-card-meta">
          <span className="shelf-card-creator">{tn("shelfFolder.bookCount", props.books.length, { count: props.books.length })}</span>
        </div>
      </div>
    </div>
  );
});

/* =========================================================================
 * 文件夹管理弹窗（新建、重命名、解散、移动选择器）
 * ========================================================================= */

interface ShelfCreateFolderDialogProps {
  existingNames: string[];
  busy: boolean;
  subtitle?: string;
  onCancel(): void;
  onCreate(name: string): Promise<void>;
}

function ShelfCreateFolderDialog(props: ShelfCreateFolderDialogProps) {
  const { t } = useUiText();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const draft = validateFolderNameDraft(name, props.existingNames);
    if (!draft.ok) {
      setError(folderNameDraftError(draft.code));
      return;
    }
    try {
      await props.onCreate(draft.name);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="shelf-confirm-title">{t("shelfFolder.create.title")}</div>
          {props.subtitle && (
            <div style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0 10px" }}>
              {props.subtitle}
            </div>
          )}
          <div style={{ margin: "14px 0" }}>
            <FolderNameField
              inputRef={inputRef}
              value={name}
              disabled={props.busy}
              placeholder={t("shelfFolder.name.placeholder")}
              error={error}
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
            />
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
              {t("shelfFolder.cancel")}
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy}>
              {props.busy ? t("shelfFolder.creating") : t("shelfFolder.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ShelfRenameDialogProps {
  folderId: string;
  currentName: string;
  existingNames: string[];
  busy: boolean;
  onCancel(): void;
  onRename(folderId: string, newName: string): Promise<void>;
}

function ShelfRenameDialog(props: ShelfRenameDialogProps) {
  const { t } = useUiText();
  const [name, setName] = useState(props.currentName);
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const draft = validateFolderNameDraft(name, props.existingNames, props.currentName);
    if (!draft.ok) {
      setError(folderNameDraftError(draft.code));
      return;
    }
    if (draft.unchanged) {
      handleCancel();
      return;
    }
    try {
      await props.onRename(props.folderId, draft.name);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="shelf-confirm-title">{t("shelfFolder.rename.title")}</div>
          <div style={{ margin: "14px 0" }}>
            <FolderNameField
              inputRef={inputRef}
              value={name}
              disabled={props.busy}
              placeholder={t("shelfFolder.name.placeholder")}
              error={error}
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
            />
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
              {t("shelfFolder.cancel")}
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy}>
              {props.busy ? t("shelfFolder.saving") : t("shelfFolder.confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ShelfDissolveDialogProps {
  folderId: string;
  folderName: string;
  busy: boolean;
  onCancel(): void;
  onDissolve(folderId: string): Promise<void>;
}

function ShelfDissolveDialog(props: ShelfDissolveDialogProps) {
  const { t } = useUiText();
  const [isClosing, setIsClosing] = useState(false);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="shelf-confirm-title">{t("shelfFolder.dissolve.title", { name: props.folderName })}</div>
        <div className="shelf-confirm-hint">{t("shelfFolder.dissolve.hint")}</div>
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
            {t("shelfFolder.cancel")}
          </button>
          <button
            className="shelf-selection-delete"
            type="button"
            disabled={props.busy}
            onClick={() => void props.onDissolve(props.folderId)}
          >
            {props.busy ? t("shelfFolder.dissolving") : t("shelfFolder.dissolve")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ShelfMoveDialogProps {
  targets: ShelfEntry[];
  currentFolderId: string | null;
  folders: Array<{ id: string; name: string; count: number }>;
  busy: boolean;
  onCancel(): void;
  onMove(targetFolderId: string | null): Promise<void>;
  onCreateFolder(name: string): Promise<string>;
}

function ShelfMoveDialog(props: ShelfMoveDialogProps) {
  const { t, tn } = useUiText();
  const [isClosing, setIsClosing] = useState(false);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  const initialFolderId = useMemo(() => {
    if (props.currentFolderId === null) {
      return props.folders.length > 0 ? props.folders[0].id : null;
    } else {
      return null;
    }
  }, [props.currentFolderId, props.folders]);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(initialFolderId);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleCreateInline = async (): Promise<void> => {
    const draft = validateFolderNameDraft(newName, props.folders.map((folder) => folder.name));
    if (!draft.ok) {
      setError(folderNameDraftError(draft.code));
      return;
    }
    try {
      const createdId = await props.onCreateFolder(draft.name);
      setSelectedFolderId(createdId);
      setCreating(false);
      setNewName("");
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleConfirmMove = async (): Promise<void> => {
    try {
      await props.onMove(selectedFolderId);
    } catch (err) {
      setError(String(err));
    }
  };

  const targetTitle =
    props.targets.length === 1
      ? t("shelfFolder.move.oneBook", { title: props.targets[0].title })
      : tn("shelfFolder.move.books", props.targets.length, { count: props.targets.length });

  const isRootCurrent = props.currentFolderId === null;
  const isSelectedSame = selectedFolderId === props.currentFolderId;

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm shelf-move-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="shelf-confirm-title">{t("shelfFolder.move.title", { target: targetTitle })}</div>
        <div className="shelf-move-list" role="radiogroup">
          <label
            className={`shelf-move-item${selectedFolderId === null ? " selected" : ""}${isRootCurrent ? " disabled is-current" : ""}`}
            title={isRootCurrent ? t("shelfFolder.move.current") : undefined}
          >
            <input
              type="radio"
              name="shelf-move-target"
              disabled={isRootCurrent}
              checked={selectedFolderId === null && !isRootCurrent}
              onChange={() => {
                if (!isRootCurrent) setSelectedFolderId(null);
              }}
            />
            <span className="shelf-move-item-name">{t("shelfFolder.move.root")}</span>
            {isRootCurrent && <span className="shelf-move-current-badge">{t("shelfFolder.move.currentBadge")}</span>}
          </label>
          {props.folders.map((f) => {
            const isFolderCurrent = props.currentFolderId === f.id;
            return (
              <label
                key={f.id}
                className={`shelf-move-item${selectedFolderId === f.id ? " selected" : ""}${isFolderCurrent ? " disabled is-current" : ""}`}
                title={isFolderCurrent ? t("shelfFolder.move.current") : undefined}
              >
                <input
                  type="radio"
                  name="shelf-move-target"
                  disabled={isFolderCurrent}
                  checked={selectedFolderId === f.id && !isFolderCurrent}
                  onChange={() => {
                    if (!isFolderCurrent) setSelectedFolderId(f.id);
                  }}
                />
                <span className="shelf-move-item-icon"><FolderIcon /></span>
                <span className="shelf-move-item-name" title={f.name}>{f.name}</span>
                <span className="shelf-move-item-count">{tn("shelfFolder.move.count", f.count, { count: f.count })}</span>
                {isFolderCurrent && <span className="shelf-move-current-badge">{t("shelfFolder.move.currentBadge")}</span>}
              </label>
            );
          })}
        </div>

        {creating ? (
          <div className="shelf-move-create-box">
            <FolderNameField
              value={newName}
              disabled={props.busy}
              placeholder={t("shelfFolder.move.newPlaceholder")}
              error={error}
              onChange={(value) => {
                setNewName(value);
                setError(null);
              }}
            />
            <div className="shelf-move-create-actions">
              <button
                className="shelf-selection-cancel"
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setError(null);
                }}
              >
                {t("shelfFolder.cancel")}
              </button>
              <button
                className="shelf-confirm-primary"
                type="button"
                disabled={props.busy}
                onClick={() => void handleCreateInline()}
              >
                {t("shelfFolder.move.createAndSelect")}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="shelf-move-new-btn"
            type="button"
            onClick={() => setCreating(true)}
            disabled={props.busy}
          >
            <PlusIcon />
            <span>{t("shelfFolder.move.new")}</span>
          </button>
        )}

        {error && !creating && <div className="shelf-dialog-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
            {t("shelfFolder.cancel")}
          </button>
          <button
            className="shelf-confirm-primary"
            type="button"
            disabled={props.busy || isSelectedSame || (selectedFolderId === null && isRootCurrent)}
            onClick={() => void handleConfirmMove()}
          >
            {props.busy ? t("shelfFolder.moving") : t("shelfFolder.move.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
 * 手机拟物居中文件夹弹窗组件（Folder Modal）
 * ========================================================================= */

interface ShelfFolderModalProps {
  folder: { id: string; name: string };
  books: ShelfEntry[];
  provider: ThumbnailProvider;
  originRect?: DOMRect;
  closing: boolean;
  draggedEntry: ShelfEntry | null;
  organization: LibraryOrganization;
  /** Book whose action menu is open, for the trigger's expanded state. */
  menuBookId: string | null;
  onClose(): void;
  onOpenBook(id: string): void;
  onRename(folderId: string, currentName: string): void;
  onDissolve(folderId: string, folderName: string): void;
  onExportBooks?(): void;
  exportDisabled: boolean;
  /** Import new EPUBs into this folder; absent hides it. */
  onImportBooks?(): void;
  /** Pick books already in the library; absent hides it. */
  onAddBooks?(): void;
  addDisabled: boolean;
  onToggleFavorite(entry: ShelfEntry): void;
  onRequestMenu(target: ShelfMenuTarget, opener: ShelfMenuOpener): void;
  onLongPress(entry: ShelfEntry, kind: ShelfLongPress, point: { x: number; y: number }): void;
  compact?: boolean;
  modalRef: React.RefObject<HTMLDivElement>;
}

const noopToggle = (): void => {};

const ShelfFolderModal = memo(function ShelfFolderModal(props: ShelfFolderModalProps) {
  const { t, tn } = useUiText();
  const { folder, books, closing, modalRef } = props;
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      // An action menu above the dialog consumes its own Escape first.
      if (e.key === "Escape" && !e.defaultPrevented) {
        closeRef.current();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <div
      className={`shelf-folder-modal-backdrop${closing ? " closing" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div
        className="shelf-folder-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("shelfFolder.modal", { name: folder.name })}
      >
        <div className="shelf-folder-modal-head">
          <div className="shelf-folder-modal-title-box">
            <FolderIcon />
            <span className="shelf-folder-modal-title" title={folder.name}>{folder.name}</span>
            <span className="shelf-folder-modal-count">{tn("shelfFolder.modal.count", books.length, { count: books.length })}</span>
          </div>
          <div className="shelf-folder-modal-actions">
            {props.onExportBooks && (
              <button
                className="shelf-folder-modal-action-btn"
                type="button"
                title={t("bookExport.action")}
                aria-label={t("bookExport.action")}
                disabled={props.exportDisabled || books.length === 0}
                onClick={props.onExportBooks}
              >
                <ExportIcon />
              </button>
            )}
            <button
              className="shelf-folder-modal-action-btn"
              type="button"
              title={t("shelfFolder.modal.rename")}
              aria-label={t("shelfFolder.modal.rename")}
              onClick={() => props.onRename(folder.id, folder.name)}
            >
              <EditIcon />
            </button>
            <button
              className="shelf-folder-modal-action-btn danger"
              type="button"
              title={t("shelfFolder.dissolve")}
              aria-label={t("shelfFolder.dissolve")}
              onClick={() => props.onDissolve(folder.id, folder.name)}
            >
              <TrashIcon />
            </button>
            <button
              className="shelf-folder-modal-action-btn"
              type="button"
              title={t("shelfFolder.modal.close.tip")}
              aria-label={t("shelfFolder.modal.close")}
              onClick={props.onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="shelf-folder-modal-body">
          {books.length === 0 ? (
            <div className="shelf-folder-modal-empty">
              {props.compact
                ? t("shelfFolder.modal.empty.touch")
                : t("shelfFolder.modal.empty.pointer")}
            </div>
          ) : (
            // 与书架共用 .shelf-grid：列数随排布密度，触屏卡片按钮也走同一套样式。
            <div className="shelf-grid shelf-folder-modal-grid">
              {books.map((entry) => (
                <ShelfCard
                  key={entry.id}
                  entry={entry}
                  surface="folderModalBook"
                  selected={false}
                  selectionMode={false}
                  provider={props.provider}
                  isFavorite={isFavorite(props.organization, entry.contentHash ?? entry.id)}
                  isDragging={props.draggedEntry?.id === entry.id}
                  isDropTargetBook={false}
                  draggedEntry={props.draggedEntry}
                  menuOpen={props.menuBookId === entry.id}
                  canDrag
                  onOpen={props.onOpenBook}
                  onToggleSelected={noopToggle}
                  onToggleFavorite={props.onToggleFavorite}
                  onRequestMenu={props.onRequestMenu}
                  onLongPress={props.onLongPress}
                />
              ))}
            </div>
          )}
        </div>
        {(props.onImportBooks || props.onAddBooks) && (
          <div className="shelf-folder-modal-foot">
            {props.onImportBooks && (
              <button
                className="shelf-folder-modal-foot-btn"
                type="button"
                disabled={props.addDisabled}
                title={t("shelfFolder.importHere.tip")}
                onClick={props.onImportBooks}
              >
                <PlusIcon />
                <span>{t("shelfFolder.importHere")}</span>
              </button>
            )}
            {props.onAddBooks && (
              <button
                className="shelf-folder-modal-foot-btn"
                type="button"
                disabled={props.addDisabled}
                title={t("shelfFolder.addBooks.open.tip")}
                onClick={props.onAddBooks}
              >
                <CheckListIcon />
                <span>{t("shelfFolder.addBooks.open")}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/* =========================================================================
 * 极简下拉选择组件
 * ========================================================================= */

interface ShelfSelectOption {
  value: string;
  label: string;
}

function ShelfSelect(props: ShelfSubmenuBackProps & {
  value: string;
  options: ShelfSelectOption[];
  onChange(value: string): void;
  title?: string;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  const closeDropdown = useCallback(() => {
    if (!open || closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      timerRef.current = null;
    }, MENU_CLOSE_MS);
  }, [open, closing]);

  useShelfSubmenuBack(open, closeDropdown, props);

  const toggleDropdown = useCallback(() => {
    if (closing) return;
    if (open) {
      closeDropdown();
    } else {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setClosing(false);
      setOpen(true);
    }
  }, [open, closing, closeDropdown]);

  useEffect(() => {
    if (!open || closing) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeDropdown();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeDropdown();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closing, closeDropdown]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const current = props.options.find((o) => o.value === props.value) ?? props.options[0];

  return (
    <div className="shelf-select-wrap" ref={ref}>
      <button
        className={`shelf-select-btn${open && !closing ? " open" : ""}`}
        title={props.title}
        disabled={props.busy}
        aria-expanded={open && !closing}
        onClick={toggleDropdown}
      >
        <span>{current.label}</span>
        <span className="shelf-select-arrow" aria-hidden="true" />
      </button>
      {(open || closing) && (
        <div className={`shelf-select-pop${closing ? " closing" : ""}`} role="listbox">
          {props.options.map((o) => (
            <button
              key={o.value}
              className={`shelf-select-option${o.value === props.value ? " selected" : ""}`}
              role="option"
              aria-selected={o.value === props.value}
              onClick={() => {
                props.onChange(o.value);
                closeDropdown();
              }}
            >
              <span>{o.label}</span>
              {o.value === props.value ? (
                <span className="shelf-select-check">
                  <CheckIcon />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* =========================================================================
 * 首字母快速索引轨与拼音边界算法 (A-Z Fast Index Rail)
 * ========================================================================= */

const AZ_LETTERS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
  "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T",
  "U", "V", "W", "X", "Y", "Z", "#"
];

const PINYIN_BOUNDS = [
  { letter: "A", char: "阿" },
  { letter: "B", char: "八" },
  { letter: "C", char: "嚓" },
  { letter: "D", char: "哒" },
  { letter: "E", char: "妸" },
  { letter: "F", char: "发" },
  { letter: "G", char: "旮" },
  { letter: "H", char: "哈" },
  { letter: "J", char: "击" },
  { letter: "K", char: "咔" },
  { letter: "L", char: "垃" },
  { letter: "M", char: "妈" },
  { letter: "N", char: "拿" },
  { letter: "O", char: "噢" },
  { letter: "P", char: "妑" },
  { letter: "Q", char: "七" },
  { letter: "R", char: "呥" },
  { letter: "S", char: "仨" },
  { letter: "T", char: "他" },
  { letter: "W", char: "穵" },
  { letter: "X", char: "夕" },
  { letter: "Y", char: "丫" },
  { letter: "Z", char: "帀" },
];

function getInitialLetter(str: string): string {
  if (!str) return "#";
  const ch = str.trim().charAt(0);
  if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  if (/[\u4e00-\u9fa5]/.test(ch)) {
    for (let i = PINYIN_BOUNDS.length - 1; i >= 0; i--) {
      if (ch.localeCompare(PINYIN_BOUNDS[i].char, "zh-Hans-CN") >= 0) {
        return PINYIN_BOUNDS[i].letter;
      }
    }
  }
  return "#";
}

interface ShelfAZRailProps {
  letterIndexMap: Map<string, number>;
  onSelectLetter(letter: string, targetIndex: number): void;
}

const ShelfAZRail = memo(function ShelfAZRail({ letterIndexMap, onSelectLetter }: ShelfAZRailProps) {
  const { t } = useUiText();
  return (
    <div className="shelf-az-rail" aria-label={t("shelfMenu.azRail")}>
      {AZ_LETTERS.map((letter) => {
        const hasBooks = letterIndexMap.has(letter);
        return (
          <button
            key={letter}
            className={`shelf-az-letter${!hasBooks ? " disabled" : ""}`}
            type="button"
            disabled={!hasBooks}
            onClick={() => {
              const idx = letterIndexMap.get(letter);
              if (idx !== undefined) {
                onSelectLetter(letter, idx);
              }
            }}
            title={hasBooks ? t("shelfMenu.azRail.jump", { letter }) : undefined}
          >
            {letter}
          </button>
        );
      })}
    </div>
  );
});

interface ShelfGridGeometry {
  columns: number;
  /** 书籍行步长，已还原到书架布局 CSS px。 */
  rowStep: number;
  /** 书籍占位容器在滚动内容中的稳定起点，不含自身虚拟 topPadding。 */
  contentTop: number;
}

function sameShelfGridGeometry(a: ShelfGridGeometry, b: ShelfGridGeometry): boolean {
  return a.columns === b.columns &&
    Math.abs(a.rowStep - b.rowStep) < 1 &&
    Math.abs(a.contentTop - b.contentTop) < 1;
}

function readShelfComputedStyle(container: HTMLElement, element: Element): CSSStyleDeclaration | null {
  const view = container.ownerDocument?.defaultView;
  if (view && typeof view.getComputedStyle === "function") return view.getComputedStyle(element);
  if (typeof getComputedStyle === "function") return getComputedStyle(element);
  return null;
}

/** 只使用书架自身已有的有效 zoom；rect 屏幕差值除以它后参与布局坐标计算。 */
function readShelfLayoutZoom(container: HTMLElement): number {
  const style = readShelfComputedStyle(container, container);
  const value = style ? Number.parseFloat(style.zoom) : 1;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** 读取书籍 grid 的真实列数/行步长，以及书籍占位容器的稳定内容起点。 */
export function measureShelfGridGeometry(container: HTMLElement): ShelfGridGeometry | null {
  const anchor = container.querySelector<HTMLElement>(".shelf-book-prefix");
  if (!anchor) return null;
  const grid = anchor.querySelector<HTMLElement>(".shelf-book-grid");
  if (!grid) return null;
  const cards = grid.querySelectorAll<HTMLElement>(".shelf-card");
  const first = cards[0];
  if (!first) return null;
  const zoom = readShelfLayoutZoom(container);
  const firstRect = first.getBoundingClientRect();
  const firstHeight = firstRect.height / zoom;
  if (!Number.isFinite(firstHeight) || firstHeight <= 0) return null;
  const computed = readShelfComputedStyle(container, grid);
  const tracks = (computed?.gridTemplateColumns ?? "").split(/\s+/).filter(Boolean);
  const columns = Math.max(1, tracks.length || 1);
  const nextRow = cards[columns];
  const rowStep = nextRow
    ? (nextRow.getBoundingClientRect().top - firstRect.top) / zoom
    : firstHeight + (Number.parseFloat(computed?.rowGap || computed?.gap || "") || 0);
  const containerRect = container.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const contentTop = container.scrollTop + (anchorRect.top - containerRect.top) / zoom;
  return {
    columns,
    rowStep: Math.max(1, Math.round(rowStep)),
    contentTop: Math.max(0, Math.round(contentTop)),
  };
}

/**
 * 列表视图的同一份几何（单列）：书行步长取实际相邻两行（含封面、内边距、密度和
 * 缩放），起点取书籍区起点行的顶边——它在文件夹行与表头之后，且不含自身的
 * 虚拟 topPadding 高度，所以虚拟化后重测不会累计偏移。
 */
export function measureShelfListGeometry(container: HTMLElement): ShelfGridGeometry | null {
  const start = container.querySelector<HTMLElement>(".shelf-table-book-start");
  if (!start) return null;
  const rows = container.querySelectorAll<HTMLElement>("tr.shelf-table-row[data-shelf-target=\"book\"]");
  const first = rows[0];
  if (!first) return null;
  const zoom = readShelfLayoutZoom(container);
  const firstRect = first.getBoundingClientRect();
  const rowStep = rows[1]
    ? (rows[1].getBoundingClientRect().top - firstRect.top) / zoom
    : firstRect.height / zoom;
  if (!Number.isFinite(rowStep) || rowStep <= 0) return null;
  const containerRect = container.getBoundingClientRect();
  const contentTop = container.scrollTop + (start.getBoundingClientRect().top - containerRect.top) / zoom;
  return {
    columns: 1,
    // Rows are often fractional (60.5px); rounding would drift by half a pixel a row.
    rowStep: Math.max(1, rowStep),
    contentTop: Math.max(0, Math.round(contentTop)),
  };
}

/* =========================================================================
 * 60fps 轻量虚拟滚动 Hook (支持网格与列表双模式，智能阈值按需激活)
 * ========================================================================= */

interface VirtualizerResult {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
  isVirtual: boolean;
}

function useShelfVirtualizer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  totalCount: number,
  viewMode: "grid" | "list",
  density: ShelfDensity,
  folderCount = 0,
  threshold = 40
): VirtualizerResult & { gridGeometry: ShelfGridGeometry | null } {
  const [scrollState, setScrollState] = useState({ scrollTop: 0, viewportHeight: 800 });
  const [gridGeometry, setGridGeometry] = useState<ShelfGridGeometry | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setGridGeometry(null);
      return;
    }
    const measureGeometry = viewMode === "grid" ? measureShelfGridGeometry : measureShelfListGeometry;
    let frame: number | null = null;
    const measure = () => {
      if (frame !== null) return;
      const schedule = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame
        : ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
      frame = schedule(() => {
        frame = null;
        const next = measureGeometry(container);
        setGridGeometry((previous) => (
          next && previous && sameShelfGridGeometry(previous, next) ? previous : next
        ));
      });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    const anchor = container.querySelector<HTMLElement>(viewMode === "grid" ? ".shelf-book-prefix" : ".shelf-table-view");
    if (anchor) observer?.observe(anchor);
    const grid = container.querySelector<HTMLElement>(viewMode === "grid" ? ".shelf-book-grid" : ".shelf-table");
    if (grid) observer?.observe(grid);
    const scaleOwner = container.closest(".app");
    const styleObserver = typeof MutationObserver !== "undefined" && scaleOwner
      ? new MutationObserver(measure)
      : null;
    styleObserver?.observe(scaleOwner as Element, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure, { passive: true });
    return () => {
      if (frame !== null) {
        if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
        else window.clearTimeout(frame);
      }
      observer?.disconnect();
      styleObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [containerRef, density, folderCount, viewMode, totalCount]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || totalCount < threshold) return;

    let rafId: number | null = null;
    const updateMetrics = () => {
      setScrollState({
        scrollTop: container.scrollTop,
        viewportHeight: container.clientHeight || 800,
      });
    };

    updateMetrics();

    const onScroll = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        updateMetrics();
      });
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateMetrics, { passive: true });

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateMetrics);
    };
  }, [containerRef, totalCount, threshold]);

  return useMemo(() => {
    const geometry = gridGeometry;
    if (totalCount < threshold) {
      return {
        startIndex: 0,
        endIndex: totalCount,
        topPadding: 0,
        bottomPadding: 0,
        isVirtual: false,
        gridGeometry: geometry,
      };
    }

    // 几何未测量前保留一个测量窗口；不退回旧密度/列宽估算。
    if (!geometry) {
      return {
        startIndex: 0,
        endIndex: Math.min(totalCount, Math.max(threshold, 1)),
        topPadding: 0,
        bottomPadding: 0,
        isVirtual: totalCount >= threshold,
        gridGeometry: null,
      };
    }

    const { scrollTop, viewportHeight } = scrollState;
    const relativeTop = Math.max(0, scrollTop - geometry.contentTop);
    // 列表一行一本，多留几行；网格按行留两行。
    const overscan = geometry.columns === 1 ? 5 : 2;
    const totalRows = Math.ceil(totalCount / geometry.columns);
    const firstRow = Math.max(0, Math.floor(relativeTop / geometry.rowStep) - overscan);
    const endRow = Math.min(totalRows, Math.ceil((relativeTop + viewportHeight) / geometry.rowStep) + overscan);
    const startIndex = firstRow * geometry.columns;
    const endIndex = Math.min(totalCount, endRow * geometry.columns);

    return {
      startIndex,
      endIndex,
      topPadding: firstRow * geometry.rowStep,
      bottomPadding: Math.max(0, (totalRows - endRow) * geometry.rowStep),
      isVirtual: true,
      gridGeometry: geometry,
    };
  }, [totalCount, threshold, scrollState, gridGeometry]);
}

/* =========================================================================
 * 列表模式单行组件 (ShelfTableRow)
 * ========================================================================= */

interface ShelfTableRowProps {
  entry: ShelfEntry;
  index: number;
  provider: ThumbnailProvider;
  selected: boolean;
  selectionMode: boolean;
  isFavorite: boolean;
  menuOpen?: boolean;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onToggleFavorite(entry: ShelfEntry): void;
  onRequestMenu?(target: ShelfMenuTarget, opener: ShelfMenuOpener): void;
  onLongPress?(entry: ShelfEntry, kind: ShelfLongPress, point: { x: number; y: number }): void;
}

const ShelfTableRow = memo(function ShelfTableRow({
  entry,
  index,
  provider,
  selected,
  selectionMode,
  isFavorite,
  menuOpen,
  onOpen,
  onToggleSelected,
  onToggleFavorite,
  onRequestMenu,
  onLongPress,
}: ShelfTableRowProps) {
  const { t } = useUiText();
  const moreRef = useRef<HTMLButtonElement>(null);
  const morePressedWith = useRef("");

  const press = useShelfPress({
    longPressKind: (pointerType) => shelfLongPressKind("row", pointerType, selectionMode, { select: Boolean(onLongPress) }),
    onLongPress: (kind, point) => onLongPress?.(entry, kind, point),
  });

  // 列表的三点在多选状态下仍可用（保持原行为）；右键只在普通状态打开。
  const requestMenu = (opener: ShelfMenuOpener): void => {
    onRequestMenu?.({ kind: "book", id: entry.id, surface: "list" }, opener);
  };

  return (
    <tr
      className={`shelf-table-row${selected ? " selected" : ""}${menuOpen ? " menu-open" : ""}`}
      data-shelf-target="book"
      data-book-id={entry.id}
      {...press.handlers}
      onClick={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (press.swallowClick(e)) return;
        if (selectionMode) onToggleSelected(entry.id);
        else onOpen(entry.id);
      }}
      onContextMenu={(e) => {
        if (press.swallowTouchContextMenu(e)) return;
        if (selectionMode || !onRequestMenu) return;
        e.preventDefault();
        requestMenu(contextMenuOpener(e, moreRef.current ?? e.currentTarget));
      }}
    >
      <td style={{ textAlign: "center", width: 44 }}>
        {selectionMode ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelected(entry.id)}
            aria-label={t("shelf.table.select", { title: entry.title })}
          />
        ) : (
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{index + 1}</span>
        )}
      </td>
      <td style={{ width: 48 }}>
        <div className="shelf-table-thumb-box">
          <Cover entry={entry} provider={provider} />
        </div>
      </td>
      <td>
        <div className="shelf-table-title-cell">
          <span className="shelf-table-title" title={entry.title}>{entry.title}</span>
          {entry.isNew && !selectionMode && (
            <span className="shelf-badge new" style={{ position: "static", marginLeft: 6 }}>
              {t("shelf.card.new")}
            </span>
          )}
        </div>
      </td>
      <td style={{ color: "var(--muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {entry.creator || t("shelf.unknownAuthor")}
      </td>
      <td>
        <div className="shelf-table-progress-wrap">
          <div className="shelf-table-progress-track">
            <div
              className="shelf-table-progress-bar"
              style={{ width: `${Math.min(100, entry.progressPct ?? 0)}%` }}
            />
          </div>
          <span className="shelf-table-progress-text">{shelfProgressLabel(entry)}</span>
        </div>
      </td>
      <td style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
        {formatFileSize(entry.fileSize)}
      </td>
      <td style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
        {formatRelativeTime(entry.lastReadAtMs) || formatShelfTime(entry.addedAtMs) || t("shelf.time.justNow")}
      </td>
      <td className="shelf-table-action-cell" style={{ whiteSpace: "nowrap" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <button
            className={`shelf-card-star-btn${isFavorite ? " active" : ""}`}
            style={{ position: "static", opacity: 1, display: "inline-flex" }}
            type="button"
            title={isFavorite ? t("shelf.card.unfavorite") : t("shelf.card.favorite")}
            aria-label={isFavorite ? t("shelf.card.unfavoriteBook", { title: entry.title }) : t("shelf.card.favoriteBook", { title: entry.title })}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(entry);
            }}
          >
            <StarIcon filled={isFavorite} />
          </button>
          {onRequestMenu && (
            <div className="shelf-card-actions-wrap" style={{ position: "relative", opacity: 1 }}>
              <button
                ref={moreRef}
                className={`shelf-card-more-btn${menuOpen ? " active" : ""}`}
                style={{ position: "static", opacity: 1 }}
                type="button"
                title={t("shelf.card.more.tip")}
                aria-label={t("shelf.table.more", { title: entry.title })}
                aria-haspopup="menu"
                aria-expanded={menuOpen === true}
                onPointerDown={(e) => { morePressedWith.current = e.pointerType; }}
                onClick={(e) => {
                  e.stopPropagation();
                  requestMenu(buttonMenuOpener(e, morePressedWith.current));
                }}
              >
                <DotsVerticalIcon />
              </button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
});

/**
 * 列表模式文件夹行：文件夹名与总书数之外，作者/进度/大小/时间显示当前排序下的
 * 首本书，并明确标注“首本”，不当作整个文件夹的统计。批选时整行切换选择。
 */
const ShelfFolderTableRow = memo(function ShelfFolderTableRow(props: {
  id: string;
  name: string;
  books: ShelfEntry[];
  provider: ThumbnailProvider;
  selectionMode: boolean;
  selectionState: FolderSelectionState;
  isDropTarget?: boolean;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
}) {
  const { t, tn } = useUiText();
  const checkboxRef = useRef<HTMLInputElement>(null);
  const first = props.books[0] as ShelfEntry | undefined;
  const selectable = props.selectionState !== "empty";
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = props.selectionState === "mixed";
  }, [props.selectionState, props.selectionMode]);
  const activate = (): void => {
    if (!props.selectionMode) props.onOpen(props.id);
    else if (selectable) props.onToggleSelected(props.id);
  };
  return (
    <tr
      className={`shelf-table-row folder-row${props.selectionMode && props.selectionState === "all" ? " selected" : ""}${props.isDropTarget ? " is-drop-target" : ""}`}
      data-shelf-target="folder"
      data-folder-id={props.id}
      title={props.selectionMode && !selectable ? t("shelfFolder.select.empty") : undefined}
      onClick={activate}
    >
      <td style={{ textAlign: "center" }}>
        {props.selectionMode ? (
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={props.selectionState === "all"}
            disabled={!selectable}
            onClick={(e) => e.stopPropagation()}
            onChange={() => props.onToggleSelected(props.id)}
            aria-label={t("shelfFolder.select", { name: props.name })}
          />
        ) : (
          <FolderIcon />
        )}
      </td>
      <td>
        {first ? (
          <div className="shelf-table-thumb-box shelf-table-folder-thumb">
            <Cover entry={first} provider={props.provider} />
            <span className="shelf-table-folder-badge" aria-hidden="true"><FolderIcon /></span>
          </div>
        ) : (
          <div className="shelf-table-thumb-box shelf-table-folder-thumb is-empty">
            <FolderIcon />
          </div>
        )}
      </td>
      <td>
        <div className="shelf-table-title-cell">
          <span className="shelf-table-title" style={{ fontWeight: 700 }} title={props.name}>
            {props.name}
          </span>
          <span className="shelf-capsule-count">
            {tn("shelfMain.table.folderCount", props.books.length, { count: props.books.length })}
          </span>
        </div>
        {first && (
          <div className="shelf-table-folder-first" title={first.title}>
            {t("shelfMain.table.folderFirst", { title: first.title })}
          </div>
        )}
      </td>
      {first ? (
        <>
          <td style={{ color: "var(--muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {first.creator || t("shelf.unknownAuthor")}
          </td>
          <td>
            <div className="shelf-table-progress-wrap">
              <div className="shelf-table-progress-track">
                <div className="shelf-table-progress-bar" style={{ width: `${Math.min(100, first.progressPct ?? 0)}%` }} />
              </div>
              <span className="shelf-table-progress-text">{shelfProgressLabel(first)}</span>
            </div>
          </td>
          <td style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
            {formatFileSize(first.fileSize)}
          </td>
          <td style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
            {formatRelativeTime(first.lastReadAtMs) || formatShelfTime(first.addedAtMs) || t("shelf.time.justNow")}
          </td>
        </>
      ) : (
        <>
          <td style={{ color: "var(--muted)" }}>{t("shelfMain.table.folder")}</td>
          <td style={{ color: "var(--muted)" }}>--</td>
          <td style={{ color: "var(--muted)" }}>--</td>
          <td style={{ color: "var(--muted)" }}>--</td>
        </>
      )}
      <td className="shelf-table-action-cell">
        {!props.selectionMode && (
          <button
            className="shelf-card-more-btn"
            style={{ position: "static", opacity: 1 }}
            type="button"
            title={t("shelfMain.table.openFolder")}
            onClick={(e) => {
              e.stopPropagation();
              props.onOpen(props.id);
            }}
          >
            <ArrowRightIcon />
          </button>
        )}
      </td>
    </tr>
  );
});

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

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ShelfSort>("recent");
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
  const [statusTab, setStatusTab] = useState<"all" | "reading" | "unread" | "finished" | "favorites">("all");
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
  const updateDot = useAppUpdateDot();
  const [settingsSection, setSettingsSection] = useState<ShelfSettingsSection | undefined>(undefined);
  const [filterOpen, setFilterOpen] = useState(false);
  const [bodySearchOpen, setBodySearchOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const [filters, setFilters] = useState<ShelfFilters>(EMPTY_SHELF_FILTERS);
  const [selectionMode, setSelectionMode] = useState(false);
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
  // 手机网格根层默认展开文件夹卡片；收起后摘要栏仍在，可随时再展开。
  const [folderPrefixExpanded, setFolderPrefixExpanded] = useState(true);

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
    for (const [id, books] of folderMap) folderMap.set(id, sortShelfEntries(books, sort));
    return { folderBooksMap: folderMap, unclassifiedBooks: unclassified, favoriteBooks: favorites };
  }, [organization, props.entries, activeFolders, sort]);

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

  const scopedCandidateBooks = useMemo(() => {
    switch (scope.type) {
      case "root":
        return unclassifiedBooks;
      case "all":
        return props.entries;
      case "favorites":
        return favoriteBooks;
      case "folder":
        return folderBooksMap.get(scope.folderId) ?? [];
    }
  }, [scope, unclassifiedBooks, props.entries, favoriteBooks, folderBooksMap]);

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
    return sortShelfFolders(matched, folderBooksMap, sort);
  }, [scope, statusTab, activeFolders, query, folderBooksMap, sort]);

  const virtualizer = useShelfVirtualizer(
    shelfViewRef,
    visible.length,
    viewMode,
    density,
    // 收起的文件夹卡片不占位：按实际画出的张数重测书籍区起点。
    isCompactMobile && viewMode === "grid" && !folderPrefixExpanded ? 0 : visibleFolders.length,
    40
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
    }, 150);
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
  }, [activeFolders, applyFavorite, closeMenu, handleExportFolderBooks, handleOpenFolderModal, handleRemoveFromFolder, handleTouchLongPressSelect, props.onOpen, props.onExportBooks, requestDelete]);

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
  }, [activeFolders, bookExportDisabled, canOrganize, entriesById, folderBooksMap, menu, menuPending, menuTargetGone, organization, props.busy, props.importActive, props.onExportBooks, props.saveFileActive, props.lanTransferActive, selectionMode, t, thumbnailProvider, tn]);

  const openMenuKey = menu && !menuClosing
    ? (menu.target.kind === "book" ? `${menu.target.surface}:${menu.target.id}` : `folder:${menu.target.id}`)
    : null;

  /** Hover styling follows the input actually used, so a tap on a hybrid device never leaves a lifted card. */
  const noteShelfInput = useCallback((pointerType: string): void => {
    const view = shelfViewRef.current;
    const input = pointerType === "touch" ? "touch" : "pointer";
    if (view && view.dataset.input !== input) view.dataset.input = input;
  }, []);

  const searchScopeSwitch = (
    <div className="shelf-search-scope" role="group" aria-label={t("shelfSettings.search.scope")}>
      <button type="button" aria-pressed={searchMode === "metadata"} className={searchMode === "metadata" ? "active" : ""}
        disabled={props.busy} onClick={() => changeSearchMode("metadata")}>
        {isCompactMobile ? t("shelfSettings.search.scope.titleShort") : t("shelfMenu.searchMode.metadata")}
      </button>
      <button type="button" aria-pressed={searchMode === "body"} className={searchMode === "body" ? "active" : ""}
        disabled={props.busy} onClick={() => changeSearchMode("body")}>{t("shelfMenu.searchMode.body")}</button>
    </div>
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
    hideReaderSystemStatusBar: props.hideReaderSystemStatusBar,
    onHideReaderSystemStatusBarChange: props.onHideReaderSystemStatusBarChange,
    keepScreenOnWhileReading: props.keepScreenOnWhileReading,
    onKeepScreenOnWhileReadingChange: props.onKeepScreenOnWhileReadingChange,
    batteryIndicatorEnabled: props.batteryIndicatorEnabled,
    onBatteryIndicatorChange: props.onBatteryIndicatorChange,
    tapRegions: props.tapRegions,
    onTapRegionsChange: props.onTapRegionsChange,
    tapRegionsScrollMode: props.tapRegionsScrollMode,
    importArchiveDisabled: props.importActive,
    importActive: props.importActive,
    saveFileActive: props.saveFileActive,
    lanTransferActive: props.lanTransferActive,
    onOpenLanTransfer: props.onOpenLanTransfer ? () => props.onOpenLanTransfer!() : undefined,
    onImportArchive: props.onImportArchive,
    onExportArchive: () => props.onExportArchive(),
    onExportAllBooks: props.onExportBooks ? () => props.onExportBooks!() : undefined,
    onImportLegacyArchive: props.onImportLegacyArchive,
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
  return (
    <div
      ref={shelfViewRef}
      className={`shelf-view density-${density}${selectionMode ? " selection-mode" : ""} view-${viewMode}${props.busy ? " busy" : ""}${props.importActive ? " import-active" : ""}`}
      aria-busy={props.busy || props.importActive}
      data-input={initialShelfInput}
      onPointerDownCapture={(e) => noteShelfInput(e.pointerType)}
      onPointerMove={(e) => { if (e.pointerType === "mouse") noteShelfInput("mouse"); }}
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
              <div className="shelf-brand-zone-zen">
                <div className="shelf-logo-badge" aria-hidden="true">
                  <BookLogoIcon />
                </div>
                <span className="shelf-brand-title">{t("shelfMain.brand")}</span>
              </div>

              {/* Level 1 右侧：导入图书主按钮、设置/更多 */}
              <div className="shelf-actions-zone-zen shelf-actions-zone-mobile">
                <ShelfImportButton
                  compact
                  disabled={Boolean(props.busy || props.importActive)}
                  showDropHint={false}
                  targetName={importTargetName}
                  onImport={importHere}
                  onImportFolder={props.onImportFolder}
                  registerSubmenuBackHandler={registerSubmenuBackHandler}
                  onSubmenuBackActiveChange={reportSubmenuBackActive}
                />

                <button
                  className="shelf-icon-btn-zen shelf-mobile-more-btn"
                  ref={menuButtonRef}
                  type="button"
                  aria-label={updateDot ? `${t("shelfSettings.title")} · ${t("about.update.dot")}` : t("shelfSettings.title")}
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
            <div className="shelf-brand-zone-zen">
              <div className="shelf-logo-badge" aria-hidden="true">
                <BookLogoIcon />
              </div>
              <span className="shelf-brand-title">{t("shelfMain.brand")}</span>
            </div>

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
                aria-label={updateDot ? `${t("shelfSettings.title")} · ${t("about.update.dot")}` : t("shelfSettings.title")}
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

      {/* 设置页：PC 对话框，触屏全屏页 */}
      <ShelfSettingsPage {...settingsPageProps} open={settingsOpen} registerSubmenuBackHandler={registerSubmenuBackHandler} onClose={closeSettings} />
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
                title={t("shelfMain.sort")}
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
              className="shelf-icon-btn-zen"
              type="button"
              onClick={() => setDensity(NEXT_SHELF_DENSITY[density])}
              title={t("shelfMain.density.tip", { current: t(SHELF_DENSITY_LABEL[density]), next: t(SHELF_DENSITY_LABEL[NEXT_SHELF_DENSITY[density]]) })}
              style={{ width: "auto", padding: "0 12px", fontSize: "13px" }}
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
        <div className="shelf-table-view">
          <table className="shelf-table">
            <thead>
              <tr>
                <th style={{ width: 44, textAlign: "center" }}>
                  {selectionMode ? t("shelfMain.table.select") : "#"}
                </th>
                <th style={{ width: 48 }}>{t("shelfMain.table.cover")}</th>
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
                <th className="shelf-table-action-th" style={{ width: 104 }}>{t("shelfMain.table.actions")}</th>
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
        </div>
      ) : (
        <>
          {scope.type === "root" && visibleFolders.length > 0 && (
            <div className="shelf-folder-prefix">
              {isCompactMobile && (
                <div className={`shelf-folder-summary-rail${folderPrefixExpanded ? " expanded" : ""}`}>
                  <div className="shelf-folder-summary-info">
                    <FolderIcon />
                    <span>{t("shelfMain.folders.summary", { count: visibleFolders.length })}</span>
                  </div>
                  <button
                    className="shelf-folder-summary-toggle-btn"
                    type="button"
                    onClick={() => setFolderPrefixExpanded((prev) => !prev)}
                    aria-expanded={folderPrefixExpanded}
                    title={t(folderPrefixExpanded ? "shelfMain.folders.collapse.tip" : "shelfMain.folders.expand.tip")}
                    aria-label={t(folderPrefixExpanded ? "shelfMain.folders.collapse.tip" : "shelfMain.folders.expand.tip")}
                  >
                    <span>{t(folderPrefixExpanded ? "shelfMain.folders.collapse" : "shelfMain.folders.expand")}</span>
                    {folderPrefixExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                  </button>
                </div>
              )}
              {(!isCompactMobile || folderPrefixExpanded) && (
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
              )}
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
        const books = folderBooksMap.get(folder.id) ?? [];
        return (
          <ShelfFolderModal
            compact={isCompactMobile}
            folder={folder}
            books={books}
            provider={thumbnailProvider}
            originRect={activeFolderModal.originRect}
            closing={folderModalClosing}
            draggedEntry={draggedEntry}
            organization={organization}
            modalRef={folderModalRef}
            menuBookId={openMenuKey?.startsWith("folderModal:") ? openMenuKey.slice("folderModal:".length) : null}
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
              {t("shelfMain.delete.hint")}
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
        <div className={`shelf-floating-batch-dock${dockClosing ? " is-closing" : ""}`} role="toolbar" aria-label={t("shelfMain.dock")}>
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
            <span className="shelf-batch-divider" aria-hidden="true" />
            <button
              className="shelf-batch-action-btn"
              type="button"
              disabled={noneSelected || props.busy || props.saveFileActive || props.lanTransferActive}
              onClick={() => {
                const targets = props.entries.filter((e) => selectedIds.has(e.id));
                if (targets.length > 0) props.onExportArchive(targets);
              }}
              title={t("shelfMain.dock.export.tip")}
            >
              <ExportIcon />
              <span>{t("shelfMain.dock.export")}</span>
            </button>
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
