import { FolderNameField } from "./FolderNameField";
import { validateFolderNameDraft, folderNameDraftError } from "./folderNameDraft";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MENU_CLOSE_MS, useExitPresence } from "./menuMotion";
import { uiMotionReduced, useUiMotion, type UiMotion } from "./motionPreference";
import { useUiLanguageChoice } from "./localization/useUiLanguageChoice";
import type { UiLanguagePreference } from "./localization/core";
import { createPortal } from "react-dom";
import { getShelfMenuPortalHost, useShelfMenuPopover } from "./shelfMenuPlacement";
import type { Theme } from "../render/settings";
import {
  createShelfFilterModel,
  formatShelfTime,
  sortShelfEntries,
  type ShelfFilterFacets,
  type ShelfEntry,
  type ShelfSort,
  type ShelfTimeSegment,
} from "./shelf";
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
import { isShelfCardActionTarget } from "./shelfCardEventScope";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { AboutInfo } from "./AboutInfo";
import { CacheStoragePanel } from "./CacheStoragePanel";
import {
  getSearchStatusLabel,
  SearchIndexCard,
  SearchResultList,
  type SearchIndexProgress,
  type SearchIndexStatus,
  type SearchPanelResult,
  type SearchStatus,
} from "./SearchPanel";
import "./shelfZen.css";

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
  onOpen(id: string): void;
  onImport(): void;
  /** Directory import entry; absent hides it. */
  onImportFolder?(): void;
  onImportArchive(): void;
  /** `selectedEntries` is handled by App and resolved to 64-bit content hashes before any native job is created. */
  onExportArchive(selectedEntries?: ShelfEntry[]): void;
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

function ImportArchiveIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <polyline points="7 10 12 15 17 10" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

function StorageIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/** One row of a grouped drawer list: tinted icon, title, one-line detail, chevron. */
function ShelfDrawerRow(props: {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled?: boolean;
  tone?: "accent" | "neutral";
  onClick(): void;
}) {
  return (
    <button
      className={`shelf-drawer-row${props.tone === "neutral" ? " is-neutral" : ""}`}
      type="button"
      disabled={props.disabled}
      onClick={(event) => {
        // Pickers and panels take focus away; drop it so the row is not left highlighted.
        event.currentTarget.blur();
        props.onClick();
      }}
    >
      <span className="shelf-drawer-row-icon">{props.icon}</span>
      <span className="shelf-drawer-row-text">
        <strong>{props.title}</strong>
        <small>{props.detail}</small>
      </span>
      <span className="shelf-drawer-row-chevron"><ChevronRightIcon /></span>
    </button>
  );
}

interface ShelfImportButtonProps extends ShelfSubmenuBackProps {
  compact: boolean;
  disabled: boolean;
  /** Drag-and-drop works only with a mouse; hide the hint on touch. */
  showDropHint: boolean;
  onImport(): void;
  onImportFolder?(): void;
}

/**
 * Shelf import entry. With directory import available it is a split button
 * (main action = 导入图书, caret = menu); on phones the whole 导入 button opens
 * the menu. The menu animates in/out with the shared popover motion.
 */
function ShelfImportButton(props: ShelfImportButtonProps) {
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
        onClick={props.onImport}
        disabled={props.disabled}
        title="导入 EPUB 图书到书架"
      >
        <PlusIcon />
        <span>{props.compact ? "导入" : "导入图书"}</span>
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
          title="导入图书或文件夹"
        >
          <PlusIcon />
          <span>导入</span>
        </button>
      ) : (
        <>
          <button
            className="shelf-btn-primary shelf-import-main"
            type="button"
            onClick={props.onImport}
            disabled={props.disabled}
            title="导入 EPUB 图书到书架"
          >
            <PlusIcon />
            <span>导入图书</span>
          </button>
          <button
            className="shelf-btn-primary shelf-import-caret"
            type="button"
            aria-label="更多导入方式"
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
        <div className={`shelf-import-menu${closing ? " is-closing" : ""}`} role="menu" aria-label="导入方式">
          <button className="shelf-import-menu-item" type="button" role="menuitem" onClick={() => choose(props.onImport)}>
            <span className="shelf-import-menu-icon"><BookAddIcon /></span>
            <span className="shelf-import-menu-text">
              <strong>导入图书</strong>
              <small>选择一本或多本 EPUB</small>
            </span>
          </button>
          <button className="shelf-import-menu-item" type="button" role="menuitem" onClick={() => choose(props.onImportFolder!)}>
            <span className="shelf-import-menu-icon"><FolderAddIcon /></span>
            <span className="shelf-import-menu-text">
              <strong>导入文件夹</strong>
              <small>按目录自动整理到书架文件夹</small>
            </span>
          </button>
          {props.showDropHint && <p className="shelf-import-menu-hint">也可以把 EPUB 文件直接拖到书架上</p>}
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

function getMorandiPalette(title: string, id: string) {
  let hash = 0;
  const str = id + title;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % MORANDI_PALETTES.length;
  const initial = title.trim().charAt(0) || "书";
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
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(ms);
  if (
    target.getDate() === yesterday.getDate() &&
    target.getMonth() === yesterday.getMonth() &&
    target.getFullYear() === yesterday.getFullYear()
  ) {
    return "昨天";
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
  const chapterLabel = `第 ${(activeBook.spineIndex ?? 0) + 1} 章 · ${shelfProgressLabel(activeBook)}`;

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
            title={`打开《${activeBook.title}》`}
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
              <span>继续</span>
              <ArrowRightIcon />
            </button>
            <button
              className="shelf-resume-toggle-btn"
              type="button"
              tabIndex={collapsed ? 0 : -1}
              onClick={toggleCollapse}
              title="展开 (显示封面与详细进度)"
              aria-label="展开正在阅读"
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
              title={`打开《${activeBook.title}》`}
            >
              <Cover entry={activeBook} provider={provider} />
            </button>
            <div className="shelf-resume-info">
              <div className="shelf-resume-meta-row">
                <span className="shelf-resume-tag">
                  <BookOpenIcon />
                  <span>正在阅读</span>
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
              <div className="shelf-resume-author">{activeBook.creator || "未知作者"}</div>
              <div className="shelf-resume-anchor-row">
                <div className="shelf-resume-anchor-text">上次读到：{chapterLabel}</div>
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
                  title="查看最近在读书籍（最多10本）"
                >
                  <span>更多在读 ({readingBooks.length})</span>
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
                          开书
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
              title="继续阅读当前书籍 (按 Space 或 Enter 一键开书)"
            >
              <span>继续阅读</span>
              <ArrowRightIcon />
              {!compact && <span className="shelf-resume-key-hint">Enter</span>}
            </button>
            <button
              className="shelf-resume-toggle-btn"
              type="button"
              tabIndex={collapsed ? -1 : 0}
              onClick={toggleCollapse}
              title="收起 (折叠为单行)"
              aria-label="收起正在阅读"
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

interface ShelfCardProps extends ShelfSubmenuBackProps {
  entry: ShelfEntry;
  selected: boolean;
  selectionMode: boolean;
  provider: ThumbnailProvider;
  isFavorite?: boolean;
  isDragging?: boolean;
  isDropTargetBook?: boolean;
  /** 全局忙（打开/删除中）：禁用卡片内会写数据的操作 */
  busy?: boolean;
  /** 原生导入活动期间：仅禁用删除等冲突入口，不影响打开阅读/收藏/文件夹。 */
  deleteDisabled?: boolean;
  draggedEntry?: ShelfEntry | null;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onDeleteRequest(entry: ShelfEntry): void;
  onMoveToFolder?(entry: ShelfEntry): void;
  onRemoveFromFolder?(entry: ShelfEntry): Promise<void>;
  onToggleFavorite?(entry: ShelfEntry): void;
  onDragStart?(entry: ShelfEntry, point: { x: number; y: number }): void;
  onLongPressSelect?(id: string): void;
}

const ShelfCard = memo(function ShelfCard(props: ShelfCardProps) {
  const { entry } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const {
    menuClosing,
    menuCoords,
    triggerRef,
    menuPanelRef,
    closeMenu,
  } = useShelfMenuPopover(menuOpen, setMenuOpen);

  useShelfSubmenuBack(menuOpen, closeMenu, props);

  const last = entry.lastReadAtMs > 0 ? entry.lastReadAtMs : entry.addedAtMs;
  const recent = Date.now() - last < 1000 * 60 * 60 * 24 * 7;
  const read = hasReadPosition(entry);

  const longPressTimerRef = useRef<number | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const didLongPressRef = useRef(false);
  const suppressClickUntilRef = useRef(0);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    startPosRef.current = null;
    isDraggingRef.current = false;
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // 触摸：普通状态长按进入多选；多选状态再长按才拖动书本（移入文件夹/合并新文件夹），
    // 手指先移动则仍是上下滚动。鼠标沿用长按即拖动，多选状态不拖。
    const touch = e.pointerType === "touch";
    if (props.selectionMode && !(touch && props.onDragStart)) return;
    const target = e.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest(".shelf-card-pop-menu") ||
      target.closest(".shelf-card-actions-wrap") ||
      target.closest(".shelf-card-star-btn")
    ) {
      didLongPressRef.current = false;
      return;
    }

    const touchLongPressSelect = touch && !props.selectionMode && Boolean(props.onLongPressSelect);
    if (!touchLongPressSelect && !props.onDragStart) return;

    startPosRef.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = false;
    didLongPressRef.current = false;

    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = window.setTimeout(() => {
      didLongPressRef.current = true;
      suppressClickUntilRef.current = Date.now() + 2000;
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try {
          navigator.vibrate(40);
        } catch {
          // ignore
        }
      }
      if (touchLongPressSelect) {
        props.onLongPressSelect?.(entry.id);
        return;
      }
      isDraggingRef.current = true;
      props.onDragStart?.(entry, { x: e.clientX, y: e.clientY });
    }, 500);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!startPosRef.current || isDraggingRef.current) return;
    const dx = e.clientX - startPosRef.current.x;
    const dy = e.clientY - startPosRef.current.y;
    if (Math.hypot(dx, dy) > 8) {
      cancelLongPress();
    }
  };

  const handlePointerUp = (): void => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (didLongPressRef.current) {
      suppressClickUntilRef.current = Math.max(suppressClickUntilRef.current, Date.now() + 600);
      window.setTimeout(() => {
        didLongPressRef.current = false;
      }, 350);
    }
    startPosRef.current = null;
  };

  const handlePointerCancel = (): void => {
    cancelLongPress();
  };

  useEffect(() => () => cancelLongPress(), [cancelLongPress]);


  const handleClickCapture = (e: React.MouseEvent): void => {
    if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
    if (didLongPressRef.current || Date.now() < suppressClickUntilRef.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleCardClick = (e?: React.MouseEvent): void => {
    if (e && isShelfCardActionTarget(e.target, e.currentTarget)) return;
    if (didLongPressRef.current || Date.now() < suppressClickUntilRef.current) {
      didLongPressRef.current = false;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (props.selectionMode) {
      props.onToggleSelected(entry.id);
    } else {
      props.onOpen(entry.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    // 多选状态的长按留给拖动，不弹系统/卡片菜单。
    if (props.selectionMode) return;
    setMenuOpen(true);
  };

  const handleRemoveFromFolder = async (): Promise<void> => {
    if (!props.onRemoveFromFolder || removePending) return;
    setRemovePending(true);
    setRemoveError(null);
    try {
      await props.onRemoveFromFolder(entry);
      setMenuOpen(false);
    } catch (err) {
      setRemoveError(String(err));
    } finally {
      setRemovePending(false);
    }
  };

  return (
    <div
      className={`shelf-card${props.selected ? " selected" : ""}${entry.available === false ? " unavailable" : ""}${props.isDragging ? " is-dragging" : ""}${props.isDropTargetBook ? " drag-over-book" : ""}`}
      role="button"
      tabIndex={0}
      data-shelf-target="book"
      data-book-id={entry.id}
      onClick={handleCardClick}
      onClickCapture={handleClickCapture}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        if (isShelfCardActionTarget(e.target, e.currentTarget)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
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
              <span>松手新建文件夹</span>
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
            title={props.isFavorite ? "取消收藏" : "加入收藏"}
            aria-label={props.isFavorite ? `取消收藏：${entry.title}` : `加入收藏：${entry.title}`}
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
            <span className="shelf-badge missing">{getRuntimeCapabilities().platform === "android" ? "需重新导入" : "源文件缺失"}</span>
          ) : (
            <>
              {entry.isNew && !props.selectionMode && <span className="shelf-badge new">新</span>}
              {recent && read && !entry.isNew && !props.selectionMode && (
                <span className="shelf-badge reading">在读</span>
              )}
            </>
          )}
        </div>

        {/* 贴合封面底边的纤细微光进度条 */}
        {entry.progressPct > 0 && (
          <div className="shelf-card-progress-bar" title={`阅读进度 ${entry.progressPct}%`}>
            <div
              className="shelf-card-progress-fill"
              style={{ width: `${Math.min(100, entry.progressPct)}%` }}
            />
          </div>
        )}

        {/* 卡片独立操作菜单按钮（悬浮/聚焦可见，替代生硬的直接删除按钮） */}
        {!props.selectionMode && (
          <div className="shelf-card-actions-wrap">
            <button
              ref={triggerRef}
              className={`shelf-card-more-btn${menuOpen ? " active" : ""}`}
              type="button"
              title="更多选项"
              aria-label={`更多书籍选项：${entry.title}`}
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              <DotsVerticalIcon />
            </button>

            {typeof document !== "undefined" && (menuOpen || menuClosing) &&
              createPortal(
                <div
                  ref={menuPanelRef}
                  className={`shelf-card-pop-menu${menuCoords?.placement === "up" ? " placement-up" : " placement-down"}${menuClosing ? " is-closing" : ""}`}
                  role="menu"
                  style={
                    menuCoords
                      ? {
                          position: "fixed",
                          left: `${menuCoords.left}px`,
                          top: `${menuCoords.top}px`,
                          maxWidth: `${menuCoords.width}px`,
                          maxHeight: `${menuCoords.maxHeight}px`,
                          visibility: "visible",
                        }
                      : {
                          position: "fixed",
                          left: "-9999px",
                          top: "-9999px",
                          visibility: "hidden",
                        }
                  }
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="shelf-card-pop-title" aria-label={`完整书名：${entry.title}`}>
                    {entry.title}
                  </div>
                  <button
                    className="shelf-card-pop-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onOpen(entry.id);
                    }}
                  >
                    <BookLogoIcon />
                    <span>打开阅读</span>
                  </button>
                  {props.onToggleFavorite && (
                    <button
                      className="shelf-card-pop-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        props.onToggleFavorite?.(entry);
                      }}
                    >
                      <StarIcon filled={props.isFavorite} />
                      <span>{props.isFavorite ? "取消收藏" : "加入收藏"}</span>
                    </button>
                  )}
                  {props.onMoveToFolder && (
                    <button
                      className="shelf-card-pop-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        props.onMoveToFolder?.(entry);
                      }}
                    >
                      <FolderIcon />
                      <span>移至文件夹</span>
                    </button>
                  )}
                  {props.onRemoveFromFolder && (
                    <button
                      className="shelf-card-pop-item"
                      type="button"
                      role="menuitem"
                      disabled={removePending || props.busy}
                      onClick={() => {
                        void handleRemoveFromFolder();
                      }}
                    >
                      <FolderIcon />
                      <span>{removePending ? "正在移出…" : "从文件夹移除"}</span>
                    </button>
                  )}
                  {removeError && (
                    <div className="shelf-dialog-error" role="alert" style={{ padding: "4px 8px 2px" }}>
                      {removeError}
                    </div>
                  )}
                  <button
                    className="shelf-card-pop-item danger"
                    type="button"
                    role="menuitem"
                    disabled={props.deleteDisabled}
                    onClick={() => {
                      setMenuOpen(false);
                      props.onDeleteRequest(entry);
                    }}
                  >
                    <TrashIcon />
                    <span>从书架删除</span>
                  </button>
                </div>,
                getShelfMenuPortalHost(triggerRef.current),
              )}
          </div>
        )}
      </div>

      {/* 底部标题与元数据 */}
      <div className="shelf-card-info">
        <div className="shelf-card-title">{entry.title}</div>
        <div className="shelf-card-meta">
          <span className="shelf-card-creator" title={entry.creator || "未知作者"}>
            {entry.creator || "未知作者"}
          </span>
          <span className="shelf-card-subline">
            {read ? (
              <span className="shelf-read-stat">{shelfProgressLabel(entry, " 已读")}</span>
            ) : (
              <span className="shelf-read-stat unread">未读</span>
            )}
            <span className="shelf-dot" aria-hidden="true">·</span>
            <span className="shelf-time">{formatShelfTime(last) || "刚刚"}</span>
          </span>
        </div>
      </div>
    </div>
  );
});

/* =========================================================================
 * 文件夹卡片组件（4图马赛克拼图、弹层菜单、触控安全区）
 * ========================================================================= */

interface ShelfFolderCardProps extends ShelfSubmenuBackProps {
  id: string;
  name: string;
  books: ShelfEntry[];
  provider: ThumbnailProvider;
  selectionMode: boolean;
  isDropTarget?: boolean;
  onOpen(id: string, element?: HTMLElement | null): void;
  onRename(id: string, name: string): void;
  onDissolve(id: string, name: string): void;
}

const ShelfFolderCard = memo(function ShelfFolderCard(props: ShelfFolderCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const {
    menuClosing,
    menuCoords,
    triggerRef,
    menuPanelRef,
    closeMenu,
  } = useShelfMenuPopover(menuOpen, setMenuOpen);

  useShelfSubmenuBack(menuOpen, closeMenu, props);

  const handleCardClick = (e?: React.MouseEvent): void => {
    const target = e?.target as HTMLElement | null;
    if (target?.closest(".shelf-card-actions-wrap, .shelf-card-pop-menu")) {
      return;
    }
    if (!props.selectionMode) {
      props.onOpen(props.id, cardRef.current);
    }
  };

  const sampleBooks = props.books.slice(0, 9);

  return (
    <div
      ref={cardRef}
      className={`shelf-card shelf-folder-card${props.isDropTarget ? " is-drop-target" : ""}`}
      role="button"
      tabIndex={0}
      data-shelf-target="folder"
      data-folder-id={props.id}
      onClick={handleCardClick}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        if (props.selectionMode) return;
        e.preventDefault();
        setMenuOpen(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      title={`文件夹：${props.name}（${props.books.length} 本）`}
    >
      <div className="shelf-cover-box shelf-folder-cover-box">
        {props.isDropTarget && (
          <div className="shelf-folder-drop-overlay" aria-hidden="true">
            <div className="shelf-folder-drop-badge">
              <PlusIcon />
              <span>放入文件夹</span>
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

        {!props.selectionMode && (
          <div className="shelf-card-actions-wrap">
            <button
              ref={triggerRef}
              className={`shelf-card-more-btn${menuOpen ? " active" : ""}`}
              type="button"
              title="文件夹选项"
              aria-label={`文件夹选项：${props.name}`}
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              <DotsVerticalIcon />
            </button>

            {typeof document !== "undefined" && (menuOpen || menuClosing) &&
              createPortal(
                <div
                  ref={menuPanelRef}
                  className={`shelf-card-pop-menu${menuCoords?.placement === "up" ? " placement-up" : " placement-down"}${menuClosing ? " is-closing" : ""}`}
                  role="menu"
                  style={
                    menuCoords
                      ? {
                          position: "fixed",
                          left: `${menuCoords.left}px`,
                          top: `${menuCoords.top}px`,
                          maxWidth: `${menuCoords.width}px`,
                          maxHeight: `${menuCoords.maxHeight}px`,
                          visibility: "visible",
                        }
                      : {
                          position: "fixed",
                          left: "-9999px",
                          top: "-9999px",
                          visibility: "hidden",
                        }
                  }
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    className="shelf-card-pop-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onOpen(props.id, cardRef.current);
                    }}
                  >
                    <FolderIcon />
                    <span>打开文件夹</span>
                  </button>
                  <button
                    className="shelf-card-pop-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onRename(props.id, props.name);
                    }}
                  >
                    <EditIcon />
                    <span>重命名</span>
                  </button>
                  <button
                    className="shelf-card-pop-item danger"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onDissolve(props.id, props.name);
                    }}
                  >
                    <TrashIcon />
                    <span>解散文件夹</span>
                  </button>
                </div>,
                getShelfMenuPortalHost(triggerRef.current),
              )}
          </div>
        )}
      </div>

      <div className="shelf-card-info">
        <div className="shelf-card-title">{props.name}</div>
        <div className="shelf-card-meta">
          <span className="shelf-card-creator">{props.books.length} 本书</span>
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
          <div className="shelf-confirm-title">新建文件夹</div>
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
              placeholder="请输入文件夹名称…"
              error={error}
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
            />
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
              取消
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy}>
              {props.busy ? "创建中…" : "创建"}
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
          <div className="shelf-confirm-title">重命名文件夹</div>
          <div style={{ margin: "14px 0" }}>
            <FolderNameField
              inputRef={inputRef}
              value={name}
              disabled={props.busy}
              placeholder="请输入文件夹名称…"
              error={error}
              onChange={(value) => {
                setName(value);
                setError(null);
              }}
            />
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
              取消
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy}>
              {props.busy ? "保存中…" : "确定"}
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
  const [isClosing, setIsClosing] = useState(false);

  const handleCancel = () => {
    setIsClosing(true);
    window.setTimeout(props.onCancel, MENU_CLOSE_MS);
  };

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="shelf-confirm-title">解散文件夹“{props.folderName}”？</div>
        <div className="shelf-confirm-hint">书籍将回到未归类，收藏、进度和笔记保留。</div>
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
            取消
          </button>
          <button
            className="shelf-selection-delete"
            type="button"
            disabled={props.busy}
            onClick={() => void props.onDissolve(props.folderId)}
          >
            {props.busy ? "解散中…" : "解散文件夹"}
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
      ? `《${props.targets[0].title}》`
      : `${props.targets.length} 本书`;

  const isRootCurrent = props.currentFolderId === null;
  const isSelectedSame = selectedFolderId === props.currentFolderId;

  return (
    <div className={`shelf-confirm-backdrop${isClosing ? " is-closing" : ""}`} onClick={handleCancel}>
      <div className="shelf-confirm shelf-move-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="shelf-confirm-title">移动 {targetTitle} 至</div>
        <div className="shelf-move-list" role="radiogroup">
          <label
            className={`shelf-move-item${selectedFolderId === null ? " selected" : ""}${isRootCurrent ? " disabled is-current" : ""}`}
            title={isRootCurrent ? "当前所在位置" : undefined}
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
            <span className="shelf-move-item-name">未归类（书架根目录）</span>
            {isRootCurrent && <span className="shelf-move-current-badge">（当前）</span>}
          </label>
          {props.folders.map((f) => {
            const isFolderCurrent = props.currentFolderId === f.id;
            return (
              <label
                key={f.id}
                className={`shelf-move-item${selectedFolderId === f.id ? " selected" : ""}${isFolderCurrent ? " disabled is-current" : ""}`}
                title={isFolderCurrent ? "当前所在位置" : undefined}
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
                <span className="shelf-move-item-count">{f.count} 本</span>
                {isFolderCurrent && <span className="shelf-move-current-badge">（当前）</span>}
              </label>
            );
          })}
        </div>

        {creating ? (
          <div className="shelf-move-create-box">
            <FolderNameField
              value={newName}
              disabled={props.busy}
              placeholder="新文件夹名称…"
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
                取消
              </button>
              <button
                className="shelf-confirm-primary"
                type="button"
                disabled={props.busy}
                onClick={() => void handleCreateInline()}
              >
                创建并选择
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
            <span>新建文件夹</span>
          </button>
        )}

        {error && !creating && <div className="shelf-dialog-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={handleCancel} disabled={props.busy}>
            取消
          </button>
          <button
            className="shelf-confirm-primary"
            type="button"
            disabled={props.busy || isSelectedSame || (selectedFolderId === null && isRootCurrent)}
            onClick={() => void handleConfirmMove()}
          >
            {props.busy ? "移动中…" : "确定移动"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
 * 手机拟物居中文件夹弹窗组件（Folder Modal）
 * ========================================================================= */

interface ShelfFolderModalProps extends ShelfSubmenuBackProps {
  folder: { id: string; name: string };
  books: ShelfEntry[];
  provider: ThumbnailProvider;
  originRect?: DOMRect;
  closing: boolean;
  busy: boolean;
  deleteDisabled?: boolean;
  draggedEntry: ShelfEntry | null;
  organization: LibraryOrganization;
  onClose(): void;
  onOpenBook(id: string): void;
  onRename(folderId: string, currentName: string): void;
  onDissolve(folderId: string, folderName: string): void;
  onDeleteRequest(entry: ShelfEntry): void;
  onMoveToFolder(entry: ShelfEntry): void;
  onRemoveFromFolder(entry: ShelfEntry): Promise<void>;
  onToggleFavorite(entry: ShelfEntry): void;
  onDragStart(entry: ShelfEntry, pt: { x: number; y: number }): void;
  compact?: boolean;
  modalRef: React.RefObject<HTMLDivElement>;
}

const ShelfFolderModal = memo(function ShelfFolderModal(props: ShelfFolderModalProps) {
  const { folder, books, closing, modalRef } = props;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [props]);

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
        aria-label={`文件夹：${folder.name}`}
      >
        <div className="shelf-folder-modal-head">
          <div className="shelf-folder-modal-title-box">
            <FolderIcon />
            <span className="shelf-folder-modal-title" title={folder.name}>{folder.name}</span>
            <span className="shelf-folder-modal-count">{books.length} 本</span>
          </div>
          <div className="shelf-folder-modal-actions">
            <button
              className="shelf-folder-modal-action-btn"
              type="button"
              title="重命名文件夹"
              aria-label="重命名文件夹"
              onClick={() => props.onRename(folder.id, folder.name)}
            >
              <EditIcon />
            </button>
            <button
              className="shelf-folder-modal-action-btn danger"
              type="button"
              title="解散文件夹"
              aria-label="解散文件夹"
              onClick={() => props.onDissolve(folder.id, folder.name)}
            >
              <TrashIcon />
            </button>
            <button
              className="shelf-folder-modal-action-btn"
              type="button"
              title="关闭"
              aria-label="关闭文件夹"
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
                ? "文件夹暂无书籍，可在书籍“更多”菜单中选择“移动到文件夹”"
                : "文件夹暂无书籍，从书架将书拖入此处或移出"}
            </div>
          ) : (
            <div className="shelf-folder-modal-grid">
              {books.map((entry) => {
                const hash = entry.contentHash ?? entry.id;
                const inFolder = effectiveFolderId(props.organization, hash) !== null;
                return (
                  <ShelfCard
                    key={entry.id}
                    entry={entry}
                    selected={false}
                    selectionMode={false}
                    provider={props.provider}
                    busy={props.busy}
                    deleteDisabled={props.deleteDisabled}
                    isFavorite={isFavorite(props.organization, hash)}
                    isDragging={props.draggedEntry?.id === entry.id}
                    isDropTargetBook={false}
                    draggedEntry={props.draggedEntry}
                    onOpen={props.onOpenBook}
                    onToggleSelected={() => {}}
                    onDeleteRequest={props.onDeleteRequest}
                    onMoveToFolder={props.onMoveToFolder}
                    onRemoveFromFolder={inFolder ? props.onRemoveFromFolder : undefined}
                    onToggleFavorite={props.onToggleFavorite}
                    onDragStart={props.onDragStart}
                    registerSubmenuBackHandler={props.registerSubmenuBackHandler}
                    onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
                  />
                );
              })}
            </div>
          )}
        </div>
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

type ShelfFilterKey = "author" | "title" | "saved" | "language";

interface ShelfFilters {
  authors: Set<string>;
  titles: Set<string>;
  saved: Set<ShelfTimeSegment>;
  languages: Set<string>;
}

const EMPTY_SHELF_FILTERS: ShelfFilters = {
  authors: new Set(),
  titles: new Set(),
  saved: new Set(),
  languages: new Set(),
};

function ShelfFilterOptionList(props: {
  options: Array<{ value: string; label: string; count: number }>;
  selected: ReadonlySet<string>;
  onToggle(value: string): void;
  emptyLabel: string;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const options = props.options.filter((option) =>
    !normalizedQuery || option.label.toLocaleLowerCase().includes(normalizedQuery)
  );
  const limited = options.slice(0, 80);
  return (
    <div className="shelf-filter-options">
      {props.options.length > 8 && (
        <input
          className="shelf-filter-search"
          type="search"
          placeholder={`搜索${props.emptyLabel}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={`搜索${props.emptyLabel}`}
        />
      )}
      {limited.length === 0 ? (
        <div className="shelf-filter-empty">没有匹配项</div>
      ) : (
        limited.map((option) => (
          <label className="shelf-filter-option" key={option.value}>
            <input
              type="checkbox"
              checked={props.selected.has(option.value)}
              onChange={() => props.onToggle(option.value)}
            />
            <span className="shelf-filter-option-label" title={option.label}>{option.label}</span>
            <span className="shelf-filter-option-count">{option.count}</span>
          </label>
        ))
      )}
      {options.length > limited.length && (
        <div className="shelf-filter-limit">仅显示前 {limited.length} 项，请搜索以缩小范围</div>
      )}
    </div>
  );
}

function ShelfFilterSection(props: {
  label: string;
  count: number;
  open: boolean;
  onToggleOpen(): void;
  children: ReactNode;
}) {
  return (
    <section className={`shelf-filter-section${props.open ? " open" : ""}`}>
      <button
        className="shelf-filter-section-toggle"
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggleOpen}
      >
        <span>{props.label}</span>
        <span className="shelf-filter-section-count">{props.count}</span>
        <span className="shelf-filter-section-arrow" aria-hidden="true" />
      </button>
      <div className="shelf-filter-section-body">
        <div className="shelf-filter-section-content">{props.children}</div>
      </div>
    </section>
  );
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
 * 书架侧边抽屉组件
 * ========================================================================= */

interface ShelfSettingsDrawerProps extends ShelfSubmenuBackProps {
  open: boolean;
  entries: ShelfEntry[];
  matchingEntries?: ShelfEntry[];
  busy: boolean;
  importArchiveDisabled?: boolean;
  importActive?: boolean;
  saveFileActive?: boolean;
  lanTransferActive?: boolean;
  onOpenLanTransfer?(selectedEntries?: ShelfEntry[]): void;
  query: string;
  onQueryChange(value: string): void;
  sort: ShelfSort;
  onSortChange(value: ShelfSort): void;
  density: ShelfDensity;
  onDensityChange(value: ShelfDensity): void;
  theme: Theme;
  onThemeChange(theme: Theme): void;
  batteryIndicatorEnabled?: boolean;
  onBatteryIndicatorChange?(enabled: boolean): void;
  hideReaderSystemStatusBar?: boolean;
  onHideReaderSystemStatusBarChange?(hidden: boolean): void;
  keepScreenOnWhileReading?: boolean;
  onKeepScreenOnWhileReadingChange?(enabled: boolean): void;
  filters: ShelfFilters;
  facets: ShelfFilterFacets;
  matchingCount: number;
  onFiltersChange(filters: ShelfFilters): void;
  onClose(): void;
  onOpenBook?(id: string): void;
  onImportArchive(): void;
  onExportArchive(selectedEntries?: ShelfEntry[]): void;
  onImportLegacyArchive?(): void;
  searchMode: ShelfSearchMode;
  onSearchModeChange?: (mode: ShelfSearchMode) => void;
  bodySearch?: ShelfBodySearchProps;
  viewMode?: ShelfViewMode;
  onViewModeChange?: (mode: ShelfViewMode) => void;
  onEnterSelection?: () => void;
}

function ShelfSettingsDrawer(props: ShelfSettingsDrawerProps) {
  const [uiMotion, setUiMotion] = useUiMotion();
  const language = useUiLanguageChoice();
  const [mounted, setMounted] = useState(props.open);
  const [closing, setClosing] = useState(false);
  const [cachePanelOpen, setCachePanelOpen] = useState(false);

  useEffect(() => {
    if (!props.open) setCachePanelOpen(false);
  }, [props.open]);

  useEffect(() => {
    if (props.open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const timer = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, MENU_CLOSE_MS);
      return () => clearTimeout(timer);
    }
  }, [props.open, mounted]);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const resultListRef = useRef<HTMLUListElement | null>(null);
  const [allBooksExpanded, setAllBooksExpanded] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<ShelfFilterKey>>(new Set());
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const capabilities = getRuntimeCapabilities();

  useShelfSubmenuBack(cachePanelOpen, () => setCachePanelOpen(false), props);

  const isSearchActive = Boolean(props.query.trim());
  const matchingList = props.matchingEntries ?? props.entries;

  useEffect(() => {
    setActiveSearchIndex(-1);
  }, [props.query]);

  useEffect(() => {
    if (activeSearchIndex >= 0 && resultListRef.current) {
      const activeEl = resultListRef.current.children[activeSearchIndex] as HTMLElement | undefined;
      activeEl?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeSearchIndex]);

  const openingBookRef = useRef(false);
  const handleOpenBook = useCallback((id: string) => {
    if (openingBookRef.current) return;
    openingBookRef.current = true;
    props.onOpenBook?.(id);
    props.onClose();
    setTimeout(() => {
      openingBookRef.current = false;
    }, 600);
  }, [props.onOpenBook, props.onClose]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!isSearchActive || matchingList.length === 0) return;
    const maxItems = Math.min(matchingList.length, 20);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSearchIndex((prev) => (prev < maxItems - 1 ? prev + 1 : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSearchIndex((prev) => (prev > 0 ? prev - 1 : maxItems - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const targetIndex = activeSearchIndex >= 0 ? activeSearchIndex : 0;
      const target = matchingList[targetIndex];
      if (target) {
        handleOpenBook(target.id);
      }
    }
  };

  useEffect(() => {
    if (!props.open) return;
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  const toggleSection = (key: ShelfFilterKey): void => {
    setExpandedSections((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleFilter = (key: keyof ShelfFilters, value: string): void => {
    const previous = props.filters[key];
    const next = new Set(previous);
    if (next.has(value as never)) next.delete(value as never);
    else next.add(value as never);
    props.onFiltersChange({ ...props.filters, [key]: next });
  };

  const clearFilters = (): void => props.onFiltersChange({
    authors: new Set(),
    titles: new Set(),
    saved: new Set(),
    languages: new Set(),
  });
  const activeFilterCount = props.filters.authors.size + props.filters.titles.size
    + props.filters.saved.size + props.filters.languages.size;

  const [indexActionBusy, setIndexActionBusy] = useState(false);
  const runIndexAction = (fn?: () => void) => {
    if (indexActionBusy || !fn) return;
    setIndexActionBusy(true);
    fn();
    setTimeout(() => setIndexActionBusy(false), 600);
  };

  if (!mounted) return null;
  const body = props.bodySearch;
  const bodyIndexBusy = body?.indexStatus === "indexing" || body?.indexStatus === "cancelling";
  const bodyIndexUnavailable = body?.indexStatus === "checking" || bodyIndexBusy;
  const bodyStatus = body?.statusMessage ?? (body ? getSearchStatusLabel(body.status, body.processed, body.total) : "");
  const bodyHasQuery = Boolean(body?.query.trim());
  return (
    <div className={`shelf-drawer-layer${closing ? " closing" : ""}`}>
      <div className={`shelf-drawer-backdrop${closing ? " closing" : ""}`} aria-hidden="true" onClick={props.onClose} />
      <aside id="shelf-settings-drawer" className={`shelf-drawer${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label="书架菜单">
        <div className="shelf-drawer-head">
          <div>
            <div className="shelf-drawer-title">书架菜单</div>
            <div className="shelf-drawer-subtitle">{props.entries.length} 本书</div>
          </div>
          <button className="shelf-drawer-close tb-btn" type="button" onClick={props.onClose} aria-label="关闭书架菜单">
            <CloseIcon />
          </button>
        </div>

        <div className="shelf-drawer-scroll">
          {props.onSearchModeChange && body && (
            <div className="shelf-search-mode" role="group" aria-label="书架搜索模式">
              <button type="button" className={props.searchMode === "metadata" ? "active" : ""} aria-pressed={props.searchMode === "metadata"} onClick={() => props.onSearchModeChange?.("metadata")}>书名与作者</button>
              <button type="button" className={props.searchMode === "body" ? "active" : ""} aria-pressed={props.searchMode === "body"} onClick={() => props.onSearchModeChange?.("body")}>正文</button>
            </div>
          )}

          {props.searchMode === "body" && body ? <div className="shelf-body-search">
            <div className="shelf-body-search-scope-note">范围：全部书籍</div>
            <label className="shelf-drawer-search-wrap">
              <span className="shelf-drawer-search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="11" cy="11" r="7" /><path d="m16.25 16.25 4.25 4.25" /></svg></span>
              <input className="shelf-drawer-search shelf-search" type="search" placeholder="搜索全部书籍正文" value={body.query} disabled={props.busy || bodyIndexUnavailable} onChange={(event) => body.onQueryChange(event.target.value)} />
              {body.query && <button className="shelf-drawer-search-clear" type="button" onClick={() => body.onQueryChange("")} aria-label="清除正文搜索">×</button>}
            </label>
            {(body.onRebuildIndex || body.onClearIndex) && <div className="search-index-actions" aria-label="全文索引管理">
              {body.onRebuildIndex && <button type="button" disabled={body.status === "searching" || bodyIndexBusy || indexActionBusy} onClick={() => runIndexAction(body.onRebuildIndex)}>重新建立索引</button>}
              {body.onClearIndex && <button type="button" disabled={body.status === "searching" || bodyIndexBusy || indexActionBusy} onClick={() => runIndexAction(body.onClearIndex)}>清除索引</button>}
            </div>}
            {body.indexStatus && <SearchIndexCard props={{ ...body, onClose: () => undefined, scope: "all" }} />}
            <div className="search-status" aria-live="polite">{bodyStatus}{body.status === "searching" && body.onCancel && <button className="search-cancel" type="button" onClick={body.onCancel}>取消</button>}{body.status === "error" && body.errorMessage && <span className="search-error">：{body.errorMessage}</span>}</div>
            {!bodyHasQuery && body.status !== "searching" && <div className="search-empty">输入关键词搜索全部书籍的正文</div>}
            {body.status === "complete" && bodyHasQuery && body.results.length === 0 && <div className="search-empty">未找到匹配内容</div>}
            {body.navigationBusy && <div className="search-navigation-busy">正在定位结果…</div>}
            <SearchResultList results={body.results} navigationBusy={body.navigationBusy} onSelect={body.onSelect} />
            {body.truncated && body.results.length <= 100 && <div className="search-truncated">结果较多，仅显示前 100 条</div>}
          </div> : <>
          <label className="shelf-drawer-search-wrap">
            <span className="shelf-drawer-search-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <circle cx="11" cy="11" r="7" />
                <path d="m16.25 16.25 4.25 4.25" />
              </svg>
            </span>
            <input
              ref={searchRef}
              className="shelf-drawer-search shelf-search"
              type="search"
              placeholder="搜索书名或作者"
              value={props.query}
              disabled={props.busy}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            {props.query && (
              <button className="shelf-drawer-search-clear" type="button" onClick={() => props.onQueryChange("")} aria-label="清除搜索">
                ×
              </button>
            )}
          </label>

          {isSearchActive ? (
            <div className="shelf-drawer-live-results" role="region" aria-label="搜索结果直达">
              <div className="shelf-drawer-results-head">
                <span className="shelf-drawer-results-count">
                  找到 {matchingList.length} 本匹配书籍
                </span>
                {matchingList.length > 0 && (
                  <button
                    type="button"
                    className="shelf-drawer-view-shelf-btn"
                    onClick={props.onClose}
                    title="在书架中浏览结果并收起菜单"
                  >
                    在书架中浏览 ➔
                  </button>
                )}
              </div>

              {matchingList.length === 0 ? (
                <div className="shelf-drawer-search-empty">
                  未找到与 “{props.query.trim()}” 相关的书籍
                </div>
              ) : (
                <ul ref={resultListRef} className="shelf-drawer-results-list" role="listbox">
                  {matchingList.slice(0, 20).map((entry, index) => {
                    const isSelected = index === activeSearchIndex;
                    const progressBadge = isShelfProgressPending(entry) || entry.progressPct > 0
                      ? shelfProgressLabel(entry)
                      : (entry.lastReadAtMs > 0 ? "在读" : "未读");
                    return (
                      <li
                        key={entry.id}
                        role="option"
                        aria-selected={isSelected}
                        className={`shelf-drawer-result-item${isSelected ? " active" : ""}`}
                        onClick={() => handleOpenBook(entry.id)}
                        onMouseEnter={() => setActiveSearchIndex(index)}
                      >
                        <div className="shelf-drawer-result-icon" aria-hidden="true">
                          <BookLogoIcon />
                        </div>
                        <div className="shelf-drawer-result-info">
                          <div className="shelf-drawer-result-title" title={entry.title}>
                            {entry.title}
                          </div>
                          <div className="shelf-drawer-result-meta">
                            <span className="shelf-drawer-result-creator">
                              {entry.creator || "未知作者"}
                            </span>
                          </div>
                        </div>
                        <div className={`shelf-drawer-result-badge${entry.progressPct > 0 ? " has-progress" : ""}`}>
                          {progressBadge}
                        </div>
                      </li>
                    );
                  })}
                  {matchingList.length > 20 && (
                    <li className="shelf-drawer-results-more">
                      仅显示前 20 本，可在书架中浏览全部 {matchingList.length} 本
                    </li>
                  )}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className="shelf-drawer-group-label">书籍筛选</div>
              <button
                className={`shelf-all-books${allBooksExpanded ? " expanded" : ""}`}
                type="button"
                aria-expanded={allBooksExpanded}
                onClick={() => setAllBooksExpanded((value) => !value)}
              >
                <span className="shelf-all-books-icon" aria-hidden="true"><FolderIcon /></span>
                <span className="shelf-all-books-label">全部书籍</span>
                <span className="shelf-all-books-count">{props.matchingCount}</span>
                <span className="shelf-filter-section-arrow" aria-hidden="true" />
              </button>
              <div className="shelf-all-books-details">
                <div className="shelf-all-books-details-inner">
                  <ShelfFilterSection
                    label="作者"
                    count={props.facets.authors.options.length}
                    open={expandedSections.has("author")}
                    onToggleOpen={() => toggleSection("author")}
                  >
                    <ShelfFilterOptionList
                      options={props.facets.authors.options}
                      selected={props.filters.authors}
                      onToggle={(value) => toggleFilter("authors", value)}
                      emptyLabel="作者"
                    />
                  </ShelfFilterSection>
                  <ShelfFilterSection
                    label="书名"
                    count={props.facets.titles.options.length}
                    open={expandedSections.has("title")}
                    onToggleOpen={() => toggleSection("title")}
                  >
                    <ShelfFilterOptionList
                      options={props.facets.titles.options}
                      selected={props.filters.titles}
                      onToggle={(value) => toggleFilter("titles", value)}
                      emptyLabel="书名"
                    />
                  </ShelfFilterSection>
                  <ShelfFilterSection
                    label="保存时间"
                    count={props.facets.timeSegments.options.filter((item) => item.count > 0).length}
                    open={expandedSections.has("saved")}
                    onToggleOpen={() => toggleSection("saved")}
                  >
                    <ShelfFilterOptionList
                      options={props.facets.timeSegments.options}
                      selected={props.filters.saved}
                      onToggle={(value) => toggleFilter("saved", value)}
                      emptyLabel="保存时间"
                    />
                  </ShelfFilterSection>
                  <ShelfFilterSection
                    label="语言"
                    count={props.facets.languages.options.length}
                    open={expandedSections.has("language")}
                    onToggleOpen={() => toggleSection("language")}
                  >
                    <ShelfFilterOptionList
                      options={props.facets.languages.options}
                      selected={props.filters.languages}
                      onToggle={(value) => toggleFilter("languages", value)}
                      emptyLabel="语言"
                    />
                  </ShelfFilterSection>
                </div>
              </div>
              {activeFilterCount > 0 && (
                <button className="shelf-filter-clear" type="button" onClick={clearFilters}>
                  清除筛选（{activeFilterCount}）
                </button>
              )}
            </>
          )}
          </>
          }

          <div className="shelf-drawer-group-label">显示设置</div>
          <div className="shelf-drawer-setting">
            <span>{language.label}</span>
            <ShelfSelect
              registerSubmenuBackHandler={props.registerSubmenuBackHandler}
              onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
              value={language.preference}
              busy={props.busy}
              title={language.label}
              options={language.options}
              onChange={(value) => language.choose(value as UiLanguagePreference)}
            />
          </div>
          {language.error && <p className="shelf-drawer-setting-error" role="alert">{language.error}</p>}
          {props.viewMode && props.onViewModeChange && (
            <div className="shelf-drawer-setting">
              <span>视图模式</span>
              <ShelfSelect
                registerSubmenuBackHandler={props.registerSubmenuBackHandler}
                onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
                value={props.viewMode}
                busy={props.busy}
                title="视图模式"
                options={[
                  { value: "grid", label: "网格视图" },
                  { value: "list", label: "列表视图" },
                ]}
                onChange={(value) => props.onViewModeChange!(value as ShelfViewMode)}
              />
            </div>
          )}
          <div className="shelf-drawer-setting">
            <span>排列方式</span>
            <ShelfSelect
              registerSubmenuBackHandler={props.registerSubmenuBackHandler}
              onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
              value={props.sort}
              busy={props.busy}
              title="排列方式"
              options={[
                { value: "recent", label: "最近阅读" },
                { value: "added", label: "最近添加" },
                { value: "title", label: "书名" },
              ]}
              onChange={(value) => props.onSortChange(value as ShelfSort)}
            />
          </div>
          <div className="shelf-drawer-setting">
            <span>排布密度</span>
            <ShelfSelect
              registerSubmenuBackHandler={props.registerSubmenuBackHandler}
              onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
              value={props.density}
              busy={props.busy}
              title="排布密度"
              options={[
                { value: "comfortable", label: "舒适" },
                { value: "standard", label: "标准" },
                { value: "compact", label: "紧凑" },
              ]}
              onChange={(value) => props.onDensityChange(value as ShelfDensity)}
            />
          </div>
          <div className="shelf-drawer-setting">
            <span>主题</span>
            <ShelfSelect
              registerSubmenuBackHandler={props.registerSubmenuBackHandler}
              onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
              value={props.theme}
              busy={props.busy}
              title="书架主题"
              options={[
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
                { value: "sepia", label: "羊皮纸" },
                { value: "gray", label: "深灰" },
              ]}
              onChange={(value) => props.onThemeChange(value as Theme)}
            />
          </div>
          <div className="shelf-drawer-setting">
            <span>界面动画</span>
            <ShelfSelect
              registerSubmenuBackHandler={props.registerSubmenuBackHandler}
              onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
              value={uiMotion}
              busy={props.busy}
              title="界面动画"
              options={[
                { value: "full", label: "完整" },
                { value: "reduced", label: "简化" },
              ]}
              onChange={(value) => setUiMotion(value as UiMotion)}
            />
          </div>
          {props.batteryIndicatorEnabled !== undefined && props.onBatteryIndicatorChange && (
            <div className="shelf-drawer-setting">
              <span>阅读电量</span>
              <ShelfSelect
                registerSubmenuBackHandler={props.registerSubmenuBackHandler}
                onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
                value={props.batteryIndicatorEnabled ? "on" : "off"}
                busy={props.busy}
                title="阅读栏显示电量"
                options={[
                  { value: "on", label: "显示" },
                  { value: "off", label: "隐藏" },
                ]}
                onChange={(value) => props.onBatteryIndicatorChange!(value === "on")}
              />
            </div>
          )}

          {props.hideReaderSystemStatusBar !== undefined && props.onHideReaderSystemStatusBarChange && (
            <div className="shelf-drawer-setting">
              <span>阅读时系统状态栏</span>
              <ShelfSelect
                registerSubmenuBackHandler={props.registerSubmenuBackHandler}
                onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
                value={props.hideReaderSystemStatusBar ? "hide" : "show"}
                busy={props.busy}
                title="阅读时隐藏系统状态栏"
                options={[{ value: "hide", label: "隐藏" }, { value: "show", label: "显示" }]}
                onChange={(value) => props.onHideReaderSystemStatusBarChange!(value === "hide")}
              />
            </div>
          )}

          {props.keepScreenOnWhileReading !== undefined && props.onKeepScreenOnWhileReadingChange && (
            <div className="shelf-drawer-setting">
              <span>阅读时屏幕常亮</span>
              <ShelfSelect
                registerSubmenuBackHandler={props.registerSubmenuBackHandler}
                onSubmenuBackActiveChange={props.onSubmenuBackActiveChange}
                value={props.keepScreenOnWhileReading ? "on" : "off"}
                busy={props.busy}
                title="阅读时保持屏幕常亮，回到书架或切到后台即恢复系统熄屏"
                options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]}
                onChange={(value) => props.onKeepScreenOnWhileReadingChange!(value === "on")}
              />
            </div>
          )}

          <div className="shelf-drawer-group-label">备份与传输</div>
          <div className="shelf-drawer-list">
            {capabilities.supportsLanTransfer && props.onOpenLanTransfer && (
              <ShelfDrawerRow
                icon={<LanTransferIcon />}
                title="设备互传"
                detail="同一 Wi‑Fi 下传书和阅读进度"
                disabled={!props.lanTransferActive && (props.busy || props.importActive || props.saveFileActive)}
                onClick={() => props.onOpenLanTransfer!()}
              />
            )}
            <ShelfDrawerRow
              icon={<ExportIcon />}
              title="导出存档"
              detail="保存为 .epubsave 文件"
              disabled={props.busy || props.saveFileActive || props.lanTransferActive || props.entries.length === 0}
              onClick={() => props.onExportArchive()}
            />
            <ShelfDrawerRow
              icon={<ImportArchiveIcon />}
              title="导入存档"
              detail="合并存档里的书和阅读资料"
              disabled={props.busy || props.importArchiveDisabled || props.saveFileActive || props.lanTransferActive}
              onClick={props.onImportArchive}
            />
            {props.onImportLegacyArchive && (
              <ShelfDrawerRow
                icon={<ImportArchiveIcon />}
                title="导入旧版 JSON 存档"
                detail="兼容早期版本导出的存档"
                disabled={props.busy || props.importArchiveDisabled || props.saveFileActive || props.lanTransferActive}
                onClick={props.onImportLegacyArchive}
              />
            )}
          </div>

          {(props.onEnterSelection || capabilities.supportsCacheStorage) && (
            <>
              <div className="shelf-drawer-group-label">管理</div>
              <div className="shelf-drawer-list">
                {props.onEnterSelection && (
                  <ShelfDrawerRow
                    icon={<CheckListIcon />}
                    tone="neutral"
                    title="批量选择"
                    detail="多选后收藏、移动、导出或删除"
                    disabled={props.busy || props.entries.length === 0}
                    onClick={() => {
                      props.onClose();
                      props.onEnterSelection!();
                    }}
                  />
                )}
                {capabilities.supportsCacheStorage && (
                  <ShelfDrawerRow
                    icon={<StorageIcon />}
                    tone="neutral"
                    title="缓存与存储"
                    detail="查看占用，清除全文索引"
                    disabled={props.busy}
                    onClick={() => setCachePanelOpen(true)}
                  />
                )}
              </div>
            </>
          )}

          <div className="shelf-drawer-group-label">关于</div>
          <AboutInfo />
        </div>
      </aside>
      <CacheStoragePanel open={cachePanelOpen} onClose={() => setCachePanelOpen(false)} />
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
  return (
    <div className="shelf-az-rail" aria-label="首字母快速索引">
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
            title={hasBooks ? `跳转到首字母 ${letter}` : undefined}
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
    if (!container || viewMode !== "grid") {
      setGridGeometry(null);
      return;
    }
    let frame: number | null = null;
    const measure = () => {
      if (frame !== null) return;
      const schedule = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame
        : ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
      frame = schedule(() => {
        frame = null;
        const next = measureShelfGridGeometry(container);
        setGridGeometry((previous) => (
          next && previous && sameShelfGridGeometry(previous, next) ? previous : next
        ));
      });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    const anchor = container.querySelector<HTMLElement>(".shelf-book-prefix");
    if (anchor) observer?.observe(anchor);
    const grid = container.querySelector<HTMLElement>(".shelf-book-grid");
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
        gridGeometry: viewMode === "grid" ? geometry : null,
      };
    }
    if (viewMode === "list") {
      const { scrollTop, viewportHeight } = scrollState;
      const rowHeight = 52;
      const overscan = 5;
      const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
      const endRow = Math.min(totalCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
      return {
        startIndex: startRow,
        endIndex: endRow,
        topPadding: startRow * rowHeight,
        bottomPadding: Math.max(0, (totalCount - endRow) * rowHeight),
        isVirtual: true,
        gridGeometry: null,
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
    const overscan = 2;
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
  }, [totalCount, threshold, scrollState, viewMode, gridGeometry]);
}

/* =========================================================================
 * 列表模式单行组件 (ShelfTableRow)
 * ========================================================================= */

interface ShelfTableRowProps extends ShelfSubmenuBackProps {
  entry: ShelfEntry;
  index: number;
  provider: ThumbnailProvider;
  selected: boolean;
  selectionMode: boolean;
  isFavorite: boolean;
  inFolder: boolean;
  busy?: boolean;
  deleteDisabled?: boolean;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onToggleFavorite(entry: ShelfEntry): void;
  onDeleteRequest(entry: ShelfEntry): void;
  onMoveToFolder(entry: ShelfEntry): void;
  onRemoveFromFolder?(entry: ShelfEntry): Promise<void>;
  onLongPressSelect?(id: string): void;
}

export function chooseShelfMenuPlacement(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  menuHeight: number
): "up" | "down" {
  const margin = 8;
  const fitsDown = anchor.bottom + 4 + menuHeight <= viewportHeight - margin;
  const fitsUp = anchor.top - 4 - menuHeight >= margin;
  if (!fitsDown && fitsUp) return "up";
  if (!fitsDown && !fitsUp) {
    const spaceDown = viewportHeight - margin - (anchor.bottom + 4);
    const spaceUp = anchor.top - 4 - margin;
    return spaceUp > spaceDown ? "up" : "down";
  }
  return "down";
}

const ShelfTableRow = memo(function ShelfTableRow({
  entry,
  index,
  provider,
  selected,
  selectionMode,
  isFavorite,
  inFolder,
  busy,
  deleteDisabled,
  onOpen,
  onToggleSelected,
  onToggleFavorite,
  onDeleteRequest,
  onMoveToFolder,
  onRemoveFromFolder,
  onLongPressSelect,
  registerSubmenuBackHandler,
  onSubmenuBackActiveChange,
}: ShelfTableRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    menuClosing,
    menuCoords,
    triggerRef,
    menuPanelRef,
    closeMenu,
  } = useShelfMenuPopover(menuOpen, setMenuOpen);

  useShelfSubmenuBack(menuOpen, closeMenu, {
    registerSubmenuBackHandler,
    onSubmenuBackActiveChange,
  });

  const longPressTimerRef = useRef<number | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressDidFireRef = useRef(false);
  const suppressClickUntilRef = useRef(0);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pointerStartRef.current = null;
  }, []);

  const handleRowPointerDown = (e: React.PointerEvent<HTMLTableRowElement>): void => {
    if (selectionMode || e.button !== 0 || e.pointerType !== "touch" || !onLongPressSelect) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, .shelf-card-pop-menu, .shelf-card-actions-wrap, .shelf-card-star-btn")) return;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    longPressDidFireRef.current = false;
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => {
      longPressDidFireRef.current = true;
      suppressClickUntilRef.current = Date.now() + 2000;
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try {
          navigator.vibrate(40);
        } catch {
          // ignore
        }
      }
      onLongPressSelect(entry.id);
    }, 500);
  };

  const handleRowPointerMove = (e: React.PointerEvent<HTMLTableRowElement>): void => {
    if (!pointerStartRef.current || longPressDidFireRef.current) return;
    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    if (Math.hypot(dx, dy) > 10) cancelLongPress();
  };

  const handleRowPointerUp = (): void => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (longPressDidFireRef.current) {
      suppressClickUntilRef.current = Math.max(suppressClickUntilRef.current, Date.now() + 600);
      window.setTimeout(() => {
        longPressDidFireRef.current = false;
      }, 350);
    }
    pointerStartRef.current = null;
  };

  useEffect(() => () => cancelLongPress(), [cancelLongPress]);

  const handleRowClick = (e: React.MouseEvent) => {
    if (longPressDidFireRef.current || Date.now() < suppressClickUntilRef.current) {
      e.preventDefault();
      e.stopPropagation();
      longPressDidFireRef.current = false;
      return;
    }
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        "button, input, select, .shelf-card-pop-menu, .shelf-card-actions-wrap, .shelf-card-star-btn"
      )
    ) {
      return;
    }
    if (selectionMode) {
      onToggleSelected(entry.id);
    } else {
      onOpen(entry.id);
    }
  };

  return (
    <tr
      className={`shelf-table-row${selected ? " selected" : ""}`}
      data-shelf-target="book"
      data-book-id={entry.id}
      onClick={handleRowClick}
      onPointerDown={handleRowPointerDown}
      onPointerMove={handleRowPointerMove}
      onPointerUp={handleRowPointerUp}
      onPointerCancel={cancelLongPress}
    >
      <td style={{ textAlign: "center", width: 44 }}>
        {selectionMode ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelected(entry.id)}
            aria-label={`选择 ${entry.title}`}
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
              新
            </span>
          )}
        </div>
      </td>
      <td style={{ color: "var(--muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {entry.creator || "未知作者"}
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
        {formatRelativeTime(entry.lastReadAtMs) || formatShelfTime(entry.addedAtMs) || "刚刚"}
      </td>
      <td className="shelf-table-action-cell" style={{ whiteSpace: "nowrap" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <button
            className={`shelf-card-star-btn${isFavorite ? " active" : ""}`}
            style={{ position: "static", opacity: 1, display: "inline-flex" }}
            type="button"
            title={isFavorite ? "取消收藏" : "加入收藏"}
            aria-label={isFavorite ? `取消收藏：${entry.title}` : `加入收藏：${entry.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(entry);
            }}
          >
            <StarIcon filled={isFavorite} />
          </button>
          <div className="shelf-card-actions-wrap" style={{ position: "relative", opacity: 1 }}>
            <button
              ref={triggerRef}
              className={`shelf-card-more-btn${menuOpen ? " active" : ""}`}
              style={{ position: "static", opacity: 1 }}
              type="button"
              title="更多选项"
              aria-label={`更多选项：${entry.title}`}
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              <DotsVerticalIcon />
            </button>
            {typeof document !== "undefined" && (menuOpen || menuClosing) &&
              createPortal(
                <div
                  ref={menuPanelRef}
                  className={`shelf-card-pop-menu${menuCoords?.placement === "up" ? " placement-up" : " placement-down"}${menuClosing ? " is-closing" : ""}`}
                  role="menu"
                  style={
                    menuCoords
                      ? {
                          position: "fixed",
                          left: `${menuCoords.left}px`,
                          top: `${menuCoords.top}px`,
                          maxWidth: `${menuCoords.width}px`,
                          maxHeight: `${menuCoords.maxHeight}px`,
                          visibility: "visible",
                        }
                      : {
                          position: "fixed",
                          left: "-9999px",
                          top: "-9999px",
                          visibility: "hidden",
                        }
                  }
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="shelf-card-pop-title" aria-label={`完整书名：${entry.title}`}>
                    {entry.title}
                  </div>
                  <button
                    className="shelf-card-pop-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpen(entry.id);
                    }}
                  >
                    <BookLogoIcon />
                    <span>打开阅读</span>
                  </button>
                  <button
                    className="shelf-card-pop-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleFavorite(entry);
                    }}
                  >
                    <StarIcon filled={isFavorite} />
                    <span>{isFavorite ? "取消收藏" : "加入收藏"}</span>
                  </button>
                  <button
                    className="shelf-card-pop-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onMoveToFolder(entry);
                    }}
                  >
                    <FolderIcon />
                    <span>移至文件夹</span>
                  </button>
                  {inFolder && onRemoveFromFolder && (
                    <button
                      className="shelf-card-pop-item"
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        void onRemoveFromFolder(entry);
                      }}
                    >
                      <FolderIcon />
                      <span>从文件夹移除</span>
                    </button>
                  )}
                  <button
                    className="shelf-card-pop-item danger"
                    type="button"
                    role="menuitem"
                    disabled={busy || deleteDisabled}
                    onClick={() => {
                      setMenuOpen(false);
                      onDeleteRequest(entry);
                    }}
                  >
                    <TrashIcon />
                    <span>从书架删除</span>
                  </button>
                </div>,
                getShelfMenuPortalHost(triggerRef.current),
              )}
          </div>
        </div>
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
const SHELF_DENSITY_LABEL: Record<ShelfDensity, string> = {
  comfortable: "舒适",
  standard: "标准",
  compact: "紧凑",
};

const NEXT_SHELF_DENSITY: Record<ShelfDensity, ShelfDensity> = {
  comfortable: "standard",
  standard: "compact",
  compact: "comfortable",
};

export function ShelfView(props: ShelfViewProps) {
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

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filters, setFilters] = useState<ShelfFilters>(EMPTY_SHELF_FILTERS);
  const [selectionMode, setSelectionMode] = useState(false);
  const [dockClosing, setDockClosing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<ShelfEntry[] | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [dissolveFolderTarget, setDissolveFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveDialogTargets, setMoveDialogTargets] = useState<ShelfEntry[] | null>(null);
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
  const emptyShelfHint = getRuntimeCapabilities().platform === "android"
    ? "导入 EPUB 后会出现在这里，点击上方“导入”从设备文件中选择"
    : "导入 EPUB 后会出现在这里，点击上方“导入”或直接将文件拖拽到窗口";
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const categoryDropdownRef = useRef<HTMLDivElement | null>(null);
  const [folderPrefixExpanded, setFolderPrefixExpanded] = useState(false);

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

  const handleCancelDelete = useCallback(() => {
    setDeleteTargetsClosing(true);
    window.setTimeout(() => {
      setDeleteTargets(null);
      setDeleteTargetsClosing(false);
    }, MENU_CLOSE_MS);
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
  const [pendingMergeBooks, setPendingMergeBooks] = useState<ShelfEntry[] | null>(null);

  const draggedEntryRef = useRef<ShelfEntry | null>(null);
  draggedEntryRef.current = draggedEntry;

  const dropTargetRef = useRef<typeof dropTarget>(null);
  dropTargetRef.current = dropTarget;

  const entriesRef = useRef(props.entries);
  entriesRef.current = props.entries;

  const dragEndedAtRef = useRef(0);

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
    return { folderBooksMap: folderMap, unclassifiedBooks: unclassified, favoriteBooks: favorites };
  }, [organization, props.entries, activeFolders]);

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
    all: "全部",
    reading: "正在读",
    unread: "未读",
    finished: "已读完",
    favorites: "收藏",
  }), []);

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

  const visibleFolders = useMemo(() => {
    if (scope.type !== "root") return [];
    if (statusTab !== "all") return [];
    if (!query.trim()) return activeFolders;
    const q = query.trim().toLowerCase();
    return activeFolders.filter((f) => f.name.toLowerCase().includes(q));
  }, [scope, statusTab, activeFolders, query]);

  useShelfSubmenuBack(
    isCompactMobile && viewMode === "grid" && scope.type === "root" && visibleFolders.length > 0 && folderPrefixExpanded,
    () => setFolderPrefixExpanded(false),
    {
      registerSubmenuBackHandler,
      onSubmenuBackActiveChange: reportSubmenuBackActive,
    },
  );

  const virtualizer = useShelfVirtualizer(
    shelfViewRef,
    visible.length,
    viewMode,
    density,
    visibleFolders.length,
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

      if (viewMode === "list") {
        scrollShelfToOffset(targetIndex * 52);
        return;
      }

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
    [scrollShelfToOffset, viewMode, virtualizer.gridGeometry, visible]
  );

  useEffect(() => {
    const pending = pendingLetterTargetRef.current;
    if (!pending || viewMode !== "grid" || !virtualizer.gridGeometry) return;
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

  // 当可见书籍变化或筛选/scope 变更时，自动清理不在当前可见范围的选择
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visibleIds = new Set(visible.map((e) => e.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visible]);

  const toggleSelected = useCallback((id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  const onDeleteRequest = useCallback((entry: ShelfEntry): void => {
    setDeleteTargets([entry]);
  }, []);

  const closeDrawer = useCallback((): void => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  const handleToggleFavorite = useCallback(
    async (entry: ShelfEntry): Promise<void> => {
      const hash = entry.contentHash ?? entry.id;
      const current = isFavorite(organization, hash);
      await props.onApplyOrganization?.({
        type: "setFavorite",
        contentHashes: [hash],
        value: !current,
      });
    },
    [organization, props.onApplyOrganization]
  );

  const handleBatchFavorite = useCallback(
    async (value: boolean): Promise<void> => {
      const targets = props.entries.filter((e) => selectedIds.has(e.id));
      const hashes = targets.map((e) => e.contentHash ?? e.id);
      if (hashes.length === 0) return;
      await props.onApplyOrganization?.({
        type: "setFavorite",
        contentHashes: hashes,
        value,
      });
      exitSelection();
    },
    [selectedIds, props.entries, props.onApplyOrganization]
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
    if (submenuBackHandlerRef.current?.()) return true;
    if (deleteTargets) {
      handleCancelDelete();
      return true;
    }
    if (createFolderOpen) {
      setCreateFolderOpen(false);
      setPendingMergeBooks(null);
      return true;
    }
    if (pendingMergeBooks) {
      setPendingMergeBooks(null);
      return true;
    }
    if (moveDialogTargets) {
      setMoveDialogTargets(null);
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
    if (drawerOpen) {
      closeDrawer();
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
    closeDrawer,
    createFolderOpen,
    deleteTargets,
    dissolveFolderTarget,
    drawerOpen,
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
    deleteTargets ||
    pendingMergeBooks ||
    moveDialogTargets ||
    createFolderOpen ||
    renameFolderTarget ||
    dissolveFolderTarget ||
    activeFolderModal ||
    drawerOpen ||
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

  // 触摸拖书只在多选状态由长按发起：此时挂一个非被动 touchmove，拖动中阻止页面滚动，
  // 否则浏览器接管为平移并发 pointercancel 中断拖动。必须在 touchstart 前就已注册，
  // 合成器才会等主线程决定；未拖动时不拦截，上下滚动照常。
  useEffect(() => {
    if (!selectionMode) return;
    const blockScrollWhileDragging = (e: TouchEvent): void => {
      if (draggedEntryRef.current && e.cancelable) e.preventDefault();
    };
    window.addEventListener("touchmove", blockScrollWhileDragging, { passive: false });
    return () => window.removeEventListener("touchmove", blockScrollWhileDragging);
  }, [selectionMode]);

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
      const currentDragged = draggedEntryRef.current;
      const currentTarget = dropTargetRef.current;
      const fromFolderId = draggedFromFolderIdRef.current;
      const wasInsideModal = isDraggingFromFolderModalRef.current;

      // 重置弹窗拖拽状态
      isDraggingFromFolderModalRef.current = false;
      draggedFromFolderIdRef.current = null;

      if (currentDragged) {
        dragEndedAtRef.current = Date.now();
      }

      setDraggedEntry(null);
      setDragCoord(null);
      setDropTarget(null);

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
            });
          }
        } else if (currentTarget.type === "book") {
          const otherBook = entriesRef.current.find((b) => b.id === currentTarget.id);
          if (otherBook && otherBook.id !== currentDragged.id) {
            setPendingMergeBooks([currentDragged, otherBook]);
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
        });
      }
    };

    const handleWindowPointerCancel = (): void => {
      if (draggedEntryRef.current) {
        dragEndedAtRef.current = Date.now();
      }
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

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("mousemove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("mouseup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
      if (canAutoScroll) window.cancelAnimationFrame(autoScrollFrame);
    };
  }, [draggedEntry, handleCloseFolderModal, props.onApplyOrganization]);

  // 全局点击捕获拦截器：长按/拖拽识别后（或松手 400ms 内），拦截卡片合成点击，杜绝误开书籍；弹窗区域正常响应
  useEffect(() => {
    const handleWindowClickCapture = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.(
          ".shelf-confirm-backdrop, .shelf-confirm, dialog, [role='dialog'], .shelf-card-pop-menu, .shelf-card-actions-wrap, .shelf-folder-modal"
        )
      ) {
        return;
      }
      if (draggedEntryRef.current || Date.now() - dragEndedAtRef.current < 400) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("click", handleWindowClickCapture, { capture: true });
    return () => {
      window.removeEventListener("click", handleWindowClickCapture, { capture: true });
    };
  }, []);

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
        setPendingMergeBooks(null);
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

  const handleSingleMoveToFolder = useCallback((entry: ShelfEntry) => {
    setMoveDialogTargets([entry]);
  }, []);

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
      setMoveDialogTargets(null);
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

  return (
    <div
      ref={shelfViewRef}
      className={`shelf-view density-${density}${selectionMode ? " selection-mode" : ""} view-${viewMode}${props.busy ? " busy" : ""}${props.importActive ? " import-active" : ""}`}
      aria-busy={props.busy || props.importActive}
    >
      {/* 现代极简顶部操作栏 (Level 1) */}
      <header className="shelf-head shelf-head-zen">
        {selectionMode ? (
          /* 多选管理模式状态栏 */
          <div className="shelf-selection-bar">
            <div className="shelf-selection-left">
              {/* 手机：取消在左上，批量动作统一放底部操作栏（与平板/桌面同一底坞）。 */}
              <button className="shelf-selection-exit" type="button" onClick={exitSelection}>
                取消
              </button>
              <span className="shelf-selection-title">已选 {selectedIds.size} 本</span>
              <button
                className="shelf-selection-toggle-all"
                type="button"
                aria-pressed={selectedIds.size === visible.length && visible.length > 0}
                disabled={props.busy || visible.length === 0}
                onClick={() => {
                  if (selectedIds.size === visible.length) setSelectedIds(new Set());
                  else setSelectedIds(new Set(visible.map((e) => e.id)));
                }}
              >
                <CheckSquareIcon checked={selectedIds.size === visible.length && visible.length > 0} />
                <span>{selectedIds.size === visible.length && visible.length > 0 ? "取消全选" : "全选"}</span>
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
                <span className="shelf-brand-title">书架</span>
              </div>

              {/* Level 1 右侧：导入图书主按钮、设置/更多 */}
              <div className="shelf-actions-zone-zen shelf-actions-zone-mobile">
                <ShelfImportButton
                  compact
                  disabled={Boolean(props.busy || props.importActive)}
                  showDropHint={false}
                  onImport={props.onImport}
                  onImportFolder={props.onImportFolder}
                  registerSubmenuBackHandler={registerSubmenuBackHandler}
                  onSubmenuBackActiveChange={reportSubmenuBackActive}
                />

                <button
                  className="shelf-icon-btn-zen shelf-mobile-more-btn"
                  ref={menuButtonRef}
                  type="button"
                  aria-label="书架设置与更多"
                  aria-expanded={drawerOpen}
                  aria-controls="shelf-settings-drawer"
                  onClick={() => setDrawerOpen(true)}
                  disabled={props.busy}
                  title="书架设置与更多"
                >
                  <SettingsIcon />
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
                  placeholder="搜书名或作者"
                  value={query}
                  disabled={props.busy}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="搜书名或作者"
                />
                {query && (
                  <button
                    className="shelf-quick-filter-clear shelf-mobile-search-clear"
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="清除搜索"
                    title="清除搜索内容"
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
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
              <span className="shelf-brand-title">书架</span>
            </div>

            {/* Level 1 中间：极速书名快速过滤框 [ 🔍 快速搜书名... (按 / 键聚焦) ] */}
            <div className="shelf-quick-filter-box">
              <span className="shelf-quick-filter-icon" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                ref={quickInputRef}
                className="shelf-quick-filter-input"
                type="search"
                placeholder="快速搜书名... (按 / 键聚焦)"
                value={query}
                disabled={props.busy}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="快速搜书名"
              />
              {query && (
                <button
                  className="shelf-quick-filter-clear"
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="清除搜索"
                  title="清除搜索内容"
                >
                  <CloseIcon />
                </button>
              )}
            </div>

            {/* Level 1 右侧：导入图书主按钮、视图切换 [⊞/☰]、设置 */}
            <div className="shelf-actions-zone-zen">
              <ShelfImportButton
                compact={false}
                disabled={Boolean(props.busy || props.importActive)}
                showDropHint={!coarsePointer}
                onImport={props.onImport}
                onImportFolder={props.onImportFolder ? () => {
                  if (!props.saveFileActive && !props.lanTransferActive) props.onImportFolder!();
                } : undefined}
                registerSubmenuBackHandler={registerSubmenuBackHandler}
                onSubmenuBackActiveChange={reportSubmenuBackActive}
              />

              {/* 视图切换 [⊞/☰] */}
              <div className="shelf-view-toggle-group" role="group" aria-label="视图模式切换">
                <button
                  className={`shelf-view-toggle-btn${viewMode === "grid" ? " active" : ""}`}
                  type="button"
                  onClick={() => handleViewModeChange("grid")}
                  title="网格视图"
                  aria-label="网格视图"
                  aria-pressed={viewMode === "grid"}
                >
                  <GridIcon />
                </button>
                <button
                  className={`shelf-view-toggle-btn${viewMode === "list" ? " active" : ""}`}
                  type="button"
                  onClick={() => handleViewModeChange("list")}
                  title="列表视图"
                  aria-label="列表视图"
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
                title="开启批量选择 (多选删除/移动/收藏)"
                data-testid="shelf-batch-select-btn"
              >
                <CheckListIcon />
                <span>批量选择</span>
              </button>

              {/* 设置按钮 */}
              <button
                className="shelf-icon-btn-zen"
                ref={menuButtonRef}
                type="button"
                aria-label="书架设置与高级工具"
                aria-expanded={drawerOpen}
                aria-controls="shelf-settings-drawer"
                onClick={() => setDrawerOpen(true)}
                disabled={props.busy}
                title="书架设置与高级工具"
              >
                <SettingsIcon />
              </button>
            </div>
          </div>
        )}
      </header>

      {/* 书架高级设置与分面抽屉 */}
      <ShelfSettingsDrawer
        registerSubmenuBackHandler={registerSubmenuBackHandler}
        onSubmenuBackActiveChange={reportSubmenuBackActive}
        open={drawerOpen}
        entries={props.entries}
        matchingEntries={visible}
        busy={props.busy}
        query={query}
        onQueryChange={setQuery}
        sort={sort}
        onSortChange={setSort}
        density={density}
        onDensityChange={setDensity}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onEnterSelection={enterSelection}
        theme={props.theme}
        onThemeChange={props.onThemeChange}
        hideReaderSystemStatusBar={props.hideReaderSystemStatusBar}
        onHideReaderSystemStatusBarChange={props.onHideReaderSystemStatusBarChange}
        keepScreenOnWhileReading={props.keepScreenOnWhileReading}
        onKeepScreenOnWhileReadingChange={props.onKeepScreenOnWhileReadingChange}
        batteryIndicatorEnabled={props.batteryIndicatorEnabled}
        onBatteryIndicatorChange={props.onBatteryIndicatorChange}
        filters={filters}
        facets={filterModel.facets}
        matchingCount={filterModel.entries.length}
        onFiltersChange={setFilters}
        onClose={closeDrawer}
        onOpenBook={(id) => {
          props.onOpen(id);
          closeDrawer();
        }}
        importArchiveDisabled={props.importActive}
        importActive={props.importActive}
        saveFileActive={props.saveFileActive}
        lanTransferActive={props.lanTransferActive}
        onOpenLanTransfer={props.onOpenLanTransfer}
        onImportArchive={props.onImportArchive}
        onExportArchive={props.onExportArchive}
        onImportLegacyArchive={props.onImportLegacyArchive}
        searchMode={props.searchMode ?? "metadata"}
        onSearchModeChange={props.onSearchModeChange}
        bodySearch={props.bodySearch}
      />

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
      <nav className="shelf-nav-rail" aria-label="书架分类导航与排序">
        <div className="shelf-nav-rail-left">
          {/* 状态分流胶囊组（手机端合并为单个分类选择下拉，桌面保留平铺胶囊） */}
          {isCompactMobile ? (
            <div className="shelf-category-select-wrap" ref={categoryDropdownRef}>
              <button
                className="shelf-category-dropdown-btn"
                type="button"
                onClick={() => setCategoryMenuOpen(!categoryMenuOpen)}
                aria-expanded={categoryMenuOpen}
                title="选择分类与状态"
              >
                <span>{categoryLabels[statusTab]} ({categoryCounts[statusTab]})</span>
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
            <div className="shelf-capsule-tabs" role="tablist" aria-label="阅读状态分流">
              <button
                className={`shelf-capsule-tab${statusTab === "all" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "all"}
                onClick={() => setStatusTab("all")}
              >
                <span>全部</span>
                <span className="shelf-capsule-count">{allCount}</span>
              </button>
              <button
                className={`shelf-capsule-tab${statusTab === "reading" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "reading"}
                onClick={() => setStatusTab("reading")}
              >
                <span>正在读</span>
                <span className="shelf-capsule-count">{readingCount}</span>
              </button>
              <button
                className={`shelf-capsule-tab${statusTab === "unread" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "unread"}
                onClick={() => setStatusTab("unread")}
              >
                <span>未读</span>
                <span className="shelf-capsule-count">{unreadCount}</span>
              </button>
              <button
                className={`shelf-capsule-tab${statusTab === "finished" ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={statusTab === "finished"}
                onClick={() => setStatusTab("finished")}
              >
                <span>已读完</span>
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
                <span>收藏</span>
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
              title="选择或管理文件夹"
            >
              <FolderIcon />
              <span className="shelf-folder-dropdown-label" title={currentFolder?.name}>
                {scope.type === "folder"
                  ? currentFolder?.name ?? "文件夹"
                  : `文件夹 (${activeFolders.length})`}
              </span>
              <ChevronDownIcon />
            </button>
            {folderMenuOpen && (
              <div className="shelf-folder-popover-menu">
                <button
                  className={`shelf-folder-menu-item${scope.type === "all" ? " selected" : ""}`}
                  type="button"
                  onClick={() => {
                    setScope({ type: "all" });
                    setFolderMenuOpen(false);
                  }}
                >
                  <span>全部藏书</span>
                  <span className="shelf-capsule-count">{props.entries.length}</span>
                </button>
                <button
                  className={`shelf-folder-menu-item${scope.type === "root" ? " selected" : ""}`}
                  type="button"
                  onClick={() => {
                    setScope({ type: "root" });
                    setFolderMenuOpen(false);
                  }}
                >
                  <span>未归类书籍</span>
                  <span className="shelf-capsule-count">{unclassifiedBooks.length}</span>
                </button>
                <div className="shelf-folder-menu-divider" />
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
                {isCompactMobile && viewMode === "grid" && scope.type === "root" && visibleFolders.length > 0 && (
                  <>
                    <div className="shelf-folder-menu-divider" />
                    <button
                      className="shelf-folder-menu-item"
                      type="button"
                      onClick={() => {
                        setFolderPrefixExpanded((prev) => !prev);
                        setFolderMenuOpen(false);
                      }}
                    >
                      <FolderIcon />
                      <span>{folderPrefixExpanded ? "收起书架文件夹卡片" : "在书架展开文件夹卡片"}</span>
                    </button>
                  </>
                )}
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
                  <span>新建文件夹</span>
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
                title="退出当前文件夹"
                aria-label="退出当前文件夹"
              >
                <CloseIcon />
              </button>
              <div className="shelf-folder-active-info">
                <span className="shelf-folder-active-name" title={currentFolder?.name}>《{currentFolder?.name ?? "文件夹"}》</span>
                <span className="shelf-folder-active-count">
                  {(folderBooksMap.get(scope.folderId) ?? []).length} 本书
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
                      title="文件夹操作"
                    >
                      <DotsVerticalIcon />
                    </button>
                    {folderActiveMoreOpen && (
                      <div className="shelf-folder-active-menu">
                        <button
                          className="shelf-folder-menu-item"
                          type="button"
                          onClick={() => {
                            setFolderActiveMoreOpen(false);
                            setRenameFolderTarget(currentFolder);
                          }}
                        >
                          <EditIcon />
                          <span>重命名</span>
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
                          <span>解散</span>
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <button
                      className="shelf-folder-action-btn"
                      type="button"
                      onClick={() => setRenameFolderTarget(currentFolder)}
                      title="重命名文件夹"
                    >
                      <EditIcon />
                      <span>重命名</span>
                    </button>
                    <button
                      className="shelf-folder-action-btn danger"
                      type="button"
                      onClick={() => setDissolveFolderTarget(currentFolder)}
                      title="解散文件夹"
                    >
                      <TrashIcon />
                      <span>解散</span>
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
                title="书籍排序方式"
                options={[
                  { value: "recent", label: "排序：最近阅读" },
                  { value: "added", label: "排序：最近添加" },
                  { value: "title", label: "排序：书名排序" },
                  { value: "progress", label: "排序：阅读进度" },
                ]}
                onChange={(val) => setSort(val as ShelfSort)}
              />
              <select
                className="shelf-sort-select-zen"
                value={sort}
                disabled={props.busy}
                onChange={(e) => setSort(e.target.value as ShelfSort)}
                aria-label="书籍排序方式"
                style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 0, height: 0 }}
                tabIndex={-1}
                aria-hidden="true"
              >
                <option value="recent">排序：最近阅读</option>
                <option value="added">排序：最近添加</option>
                <option value="title">排序：书名排序</option>
                <option value="progress">排序：阅读进度</option>
              </select>
            </div>

            <button
              className="shelf-icon-btn-zen"
              type="button"
              onClick={() => setDensity(NEXT_SHELF_DENSITY[density])}
              title={`排布密度：${SHELF_DENSITY_LABEL[density]}，点按切换为${SHELF_DENSITY_LABEL[NEXT_SHELF_DENSITY[density]]}`}
              style={{ width: "auto", padding: "0 12px", fontSize: "13px" }}
            >
              {SHELF_DENSITY_LABEL[density]}
            </button>
          </div>
        )}
      </nav>

      {/* 书架内容区 */}
      {props.entries.length === 0 && activeFolders.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-icon" aria-hidden="true">
            <BookLogoIcon />
          </div>
          <div className="shelf-empty-title">书架还是空的</div>
          <div className="shelf-empty-hint">
            {emptyShelfHint}
          </div>
          <button className="shelf-empty-btn" onClick={props.onImport} disabled={props.busy || props.importActive}>
            <PlusIcon />
            <span>导入第一本书</span>
          </button>
        </div>
      ) : scope.type === "all" && props.entries.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-icon" aria-hidden="true">
            <BookLogoIcon />
          </div>
          <div className="shelf-empty-title">书架还是空的</div>
          <div className="shelf-empty-hint">
            {emptyShelfHint}
          </div>
          <button className="shelf-empty-btn" onClick={props.onImport} disabled={props.busy || props.importActive}>
            <PlusIcon />
            <span>导入第一本书</span>
          </button>
        </div>
      ) : scope.type === "favorites" && favoriteBooks.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-icon" aria-hidden="true">
            <StarIcon />
          </div>
          <div className="shelf-empty-title">暂无收藏书籍</div>
          <div className="shelf-empty-hint">点击书籍卡片左上角的星标即可将书籍加入收藏</div>
          <button className="shelf-empty-btn" onClick={() => setScope({ type: "all" })} disabled={props.busy}>
            <BookLogoIcon />
            <span>查看全部书籍</span>
          </button>
        </div>
      ) : scope.type === "folder" && (folderBooksMap.get(scope.folderId) ?? []).length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-icon" aria-hidden="true">
            <FolderIcon />
          </div>
          <div className="shelf-empty-title">文件夹为空</div>
          <div className="shelf-empty-hint">多选书籍或点击卡片菜单可将书籍移入此文件夹</div>
          <button className="shelf-empty-btn" onClick={() => setScope({ type: "root" })} disabled={props.busy}>
            <BookLogoIcon />
            <span>返回书架</span>
          </button>
        </div>
      ) : visible.length === 0 && visibleFolders.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-icon" aria-hidden="true">
            <SearchIcon />
          </div>
          <div className="shelf-empty-title">没有找到匹配的内容</div>
          <div className="shelf-empty-hint">换一个关键词或清除筛选条件试试</div>
          {query && (
            <button className="shelf-selection-cancel" type="button" onClick={() => setQuery("")}>
              清除搜索词
            </button>
          )}
        </div>
      ) : viewMode === "list" ? (
        <div className="shelf-table-view">
          <table className="shelf-table">
            <thead>
              <tr>
                <th style={{ width: 44, textAlign: "center" }}>
                  {selectionMode ? "选择" : "#"}
                </th>
                <th style={{ width: 48 }}>封面</th>
                <th
                  className={`sortable${sort === "title" ? " active" : ""}`}
                  onClick={() => setSort("title")}
                  title="点击按书名排序"
                >
                  书名 {sort === "title" ? "▾" : ""}
                </th>
                <th style={{ width: "16%" }}>作者</th>
                <th
                  className={`sortable${sort === "progress" ? " active" : ""}`}
                  style={{ width: 140 }}
                  onClick={() => setSort("progress")}
                  title="点击按进度排序"
                >
                  进度 {sort === "progress" ? "▾" : ""}
                </th>
                <th style={{ width: 90 }}>大小</th>
                <th
                  className={`sortable${sort === "recent" ? " active" : ""}`}
                  style={{ width: 120 }}
                  onClick={() => setSort("recent")}
                  title="点击按阅读时间排序"
                >
                  阅读时间 {sort === "recent" ? "▾" : ""}
                </th>
                <th className="shelf-table-action-th" style={{ width: 104 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {scope.type === "root" &&
                visibleFolders.map((folder) => {
                  const fBooks = folderBooksMap.get(folder.id) ?? [];
                  return (
                    <tr
                      key={folder.id}
                      className="shelf-table-row folder-row"
                      data-shelf-target="folder"
                      data-folder-id={folder.id}
                      onClick={() => handleOpenFolderModal(folder.id)}
                    >
                      <td style={{ textAlign: "center" }}>
                        <FolderIcon />
                      </td>
                      <td>
                        <div
                          className="shelf-table-thumb-box"
                          style={{
                            background:
                              "color-mix(in srgb, var(--accent, #2563eb) 12%, transparent)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--accent)",
                          }}
                        >
                          <FolderIcon />
                        </div>
                      </td>
                      <td>
                        <div className="shelf-table-title-cell">
                          <span className="shelf-table-title" style={{ fontWeight: 700 }} title={folder.name}>
                            {folder.name}
                          </span>
                          <span className="shelf-capsule-count">
                            {fBooks.length} 本
                          </span>
                        </div>
                      </td>
                      <td style={{ color: "var(--muted)" }}>文件夹</td>
                      <td style={{ color: "var(--muted)" }}>--</td>
                      <td style={{ color: "var(--muted)" }}>--</td>
                      <td style={{ color: "var(--muted)" }}>--</td>
                      <td className="shelf-table-action-cell">
                        <button
                          className="shelf-card-more-btn"
                          style={{ position: "static", opacity: 1 }}
                          type="button"
                          title="打开文件夹"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenFolderModal(folder.id);
                          }}
                        >
                          <ArrowRightIcon />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              {virtualizer.topPadding > 0 && (
                <tr style={{ height: `${virtualizer.topPadding}px` }} aria-hidden="true">
                  <td colSpan={8} style={{ padding: 0, border: "none" }} />
                </tr>
              )}
              {renderedBooks.map((entry, idx) => {
                const actualIndex = virtualizer.isVirtual ? virtualizer.startIndex + idx : idx;
                const hash = entry.contentHash ?? entry.id;
                const inFolder = effectiveFolderId(organization, hash) !== null;
                return (
                  <ShelfTableRow
                    key={entry.id}
                    entry={entry}
                    index={actualIndex}
                    provider={thumbnailProvider}
                    selected={selectedIds.has(entry.id)}
                    selectionMode={selectionMode}
                    isFavorite={isFavorite(organization, hash)}
                    inFolder={inFolder}
                    busy={props.busy}
                    deleteDisabled={props.importActive}
                    onOpen={props.onOpen}
                    onToggleSelected={toggleSelected}
                    onToggleFavorite={handleToggleFavorite}
                    onDeleteRequest={onDeleteRequest}
                    onMoveToFolder={handleSingleMoveToFolder}
                    onRemoveFromFolder={inFolder ? handleRemoveFromFolder : undefined}
                    onLongPressSelect={handleTouchLongPressSelect}
                    registerSubmenuBackHandler={registerSubmenuBackHandler}
                    onSubmenuBackActiveChange={reportSubmenuBackActive}
                  />
                );
              })}
              {virtualizer.bottomPadding > 0 && (
                <tr style={{ height: `${virtualizer.bottomPadding}px` }} aria-hidden="true">
                  <td colSpan={8} style={{ padding: 0, border: "none" }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {scope.type === "root" && visibleFolders.length > 0 && (!isCompactMobile || folderPrefixExpanded) && (
            <div className="shelf-folder-prefix">
              {isCompactMobile && folderPrefixExpanded && (
                <div className="shelf-folder-summary-rail expanded">
                  <div className="shelf-folder-summary-info">
                    <FolderIcon />
                    <span>文件夹 ({visibleFolders.length})</span>
                  </div>
                  <button
                    className="shelf-folder-summary-toggle-btn"
                    type="button"
                    onClick={() => setFolderPrefixExpanded(false)}
                    title="收起文件夹目录"
                    aria-label="收起文件夹目录"
                  >
                    <span>收起</span>
                    <ChevronUpIcon />
                  </button>
                </div>
              )}
              <div className="shelf-grid shelf-folder-grid">
                {visibleFolders.map((folder) => (
                  <ShelfFolderCard
                    key={folder.id}
                    id={folder.id}
                    name={folder.name}
                    books={folderBooksMap.get(folder.id) ?? []}
                    provider={thumbnailProvider}
                    selectionMode={selectionMode}
                    isDropTarget={dropTarget?.type === "folder" && dropTarget.id === folder.id}
                    onOpen={(fId, el) => handleOpenFolderModal(fId, el)}
                    onRename={(fId, fName) => setRenameFolderTarget({ id: fId, name: fName })}
                    onDissolve={(fId, fName) => setDissolveFolderTarget({ id: fId, name: fName })}
                    registerSubmenuBackHandler={registerSubmenuBackHandler}
                    onSubmenuBackActiveChange={reportSubmenuBackActive}
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
              {renderedBooks.map((entry) => {
                const hash = entry.contentHash ?? entry.id;
                const inFolder = effectiveFolderId(organization, hash) !== null;
                return (
                  <ShelfCard
                    key={entry.id}
                    entry={entry}
                    selected={selectedIds.has(entry.id)}
                    selectionMode={selectionMode}
                    provider={thumbnailProvider}
                    busy={props.busy}
                    deleteDisabled={props.importActive}
                    isFavorite={isFavorite(organization, hash)}
                    isDragging={draggedEntry?.id === entry.id}
                    isDropTargetBook={dropTarget?.type === "book" && dropTarget.id === entry.id}
                    draggedEntry={draggedEntry}
                    onOpen={props.onOpen}
                    onToggleSelected={toggleSelected}
                    onDeleteRequest={onDeleteRequest}
                    onMoveToFolder={handleSingleMoveToFolder}
                    onRemoveFromFolder={inFolder ? handleRemoveFromFolder : undefined}
                    onToggleFavorite={handleToggleFavorite}
                    onDragStart={handleDragStart}
                    onLongPressSelect={handleTouchLongPressSelect}
                    registerSubmenuBackHandler={registerSubmenuBackHandler}
                    onSubmenuBackActiveChange={reportSubmenuBackActive}
                  />
                );
              })}
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
              ? `将合并《${pendingMergeBooks[0].title}》与《${pendingMergeBooks[1].title}》入新文件夹`
              : undefined
          }
          onCancel={() => {
            setCreateFolderOpen(false);
            setPendingMergeBooks(null);
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
          onCancel={() => setMoveDialogTargets(null)}
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
            busy={props.busy}
            deleteDisabled={props.importActive}
            originRect={activeFolderModal.originRect}
            closing={folderModalClosing}
            draggedEntry={draggedEntry}
            organization={organization}
            modalRef={folderModalRef}
            onClose={handleCloseFolderModal}
            onOpenBook={props.onOpen}
            onRename={(fId, fName) => setRenameFolderTarget({ id: fId, name: fName })}
            onDissolve={(fId, fName) => setDissolveFolderTarget({ id: fId, name: fName })}
            onDeleteRequest={onDeleteRequest}
            onMoveToFolder={handleSingleMoveToFolder}
            onRemoveFromFolder={handleRemoveFromFolder}
            onToggleFavorite={handleToggleFavorite}
            onDragStart={handleFolderBookDragStart}
            registerSubmenuBackHandler={registerSubmenuBackHandler}
            onSubmenuBackActiveChange={reportSubmenuBackActive}
          />
        );
      })()}

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
                ? `删除选中的 ${deleteTargets.length} 本书？`
                : "从书架删除此书？"}
            </div>
            <div className="shelf-confirm-name">
              {deleteTargets.length > 1
                ? deleteTargets
                    .slice(0, 3)
                    .map((t) => t.title)
                    .join("、") + (deleteTargets.length > 3 ? "…" : "")
                : deleteTargets[0].title}
            </div>
            <div className="shelf-confirm-hint">
              源文件不会被删除，但书签与本地进度将被移除。再次导入同一本书会恢复收藏和分类。
            </div>
            <div className="shelf-confirm-actions">
              <button className="shelf-selection-cancel" type="button" onClick={handleCancelDelete}>
                取消
              </button>
              <button
                className="shelf-selection-delete"
                type="button"
                disabled={props.busy || props.importActive}
                onClick={() => {
                  const ids = deleteTargets.map((t) => t.id);
                  setDeleteTargets(null);
                  if (selectionMode) {
                    if (ids.length > 1) props.onDeleteMany(ids);
                    else props.onDelete(ids[0]);
                    exitSelection();
                  } else {
                    props.onDelete(ids[0]);
                  }
                }}
              >
                确认删除
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
        <div className="shelf-drag-folder-strip" role="list" aria-label="拖到这里移入文件夹">
          <span className="shelf-drag-folder-strip-label">移入文件夹</span>
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
        <div className={`shelf-floating-batch-dock${dockClosing ? " is-closing" : ""}`} role="toolbar" aria-label="批量操作栏">
          <div className="shelf-floating-batch-info">
            <span className="shelf-floating-batch-badge">{selectedIds.size}</span>
            <span>{selectedIds.size > 0 ? `已选 ${selectedIds.size} 本` : "请点击图书卡片进行选择"}</span>
          </div>
          <div className="shelf-floating-batch-actions">
            {/* 动作常驻、未选时置灰：首次勾选时底栏不跳动。 */}
            <button
              className="shelf-batch-action-btn"
              type="button"
              disabled={noneSelected || props.busy}
              onClick={() => void handleBatchFavorite(true)}
              title="加入收藏"
            >
              <StarIcon filled />
              <span>收藏</span>
            </button>
            <button
              className="shelf-batch-action-btn"
              type="button"
              disabled={noneSelected || props.busy}
              onClick={() => void handleBatchFavorite(false)}
              title="取消收藏"
            >
              <StarIcon />
              <span>取消收藏</span>
            </button>
            <button
              className="shelf-batch-action-btn"
              type="button"
              disabled={noneSelected || props.busy}
              onClick={() => {
                const targets = props.entries.filter((e) => selectedIds.has(e.id));
                if (targets.length > 0) setMoveDialogTargets(targets);
              }}
              title="移至文件夹"
            >
              <FolderIcon />
              <span>移至文件夹</span>
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
              title="导出选中书籍为新存档"
            >
              <ExportIcon />
              <span>导出</span>
            </button>
            {getRuntimeCapabilities().supportsLanTransfer && props.onOpenLanTransfer && (
              <button
                className="shelf-batch-action-btn"
                type="button"
                disabled={!props.lanTransferActive && (noneSelected || props.busy || props.importActive || props.saveFileActive)}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (props.lanTransferActive || targets.length > 0) props.onOpenLanTransfer!(targets);
                }}
                title="通过设备互传发给另一台设备"
              >
                <LanTransferIcon />
                <span>发到设备</span>
              </button>
            )}
            <span className="shelf-batch-divider" aria-hidden="true" />
            <button
              className="shelf-batch-action-btn danger"
              type="button"
              disabled={noneSelected || props.busy || props.importActive}
              onClick={() => {
                const targets = props.entries.filter((e) => selectedIds.has(e.id));
                if (targets.length > 0) setDeleteTargets(targets);
              }}
              title="从书架删除选中的书籍"
            >
              <TrashIcon />
              <span>删除</span>
            </button>
            <button
              className="shelf-batch-action-btn cancel"
              type="button"
              onClick={exitSelection}
              title="退出多选"
            >
              <CloseIcon />
              <span>退出选择</span>
            </button>
          </div>
        </div>
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
