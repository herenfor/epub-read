import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  normalizeFolderName,
  MAX_FOLDER_NAME_CODE_POINTS,
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
import { isShelfCardActionTarget } from "./shelfCardEventScope";
import {
  getSearchStatusLabel,
  SearchIndexCard,
  SearchResultList,
  type SearchIndexProgress,
  type SearchIndexStatus,
  type SearchPanelResult,
  type SearchStatus,
} from "./SearchPanel";

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

export interface ShelfViewProps {
  entries: ShelfEntry[];
  organization?: LibraryOrganization;
  scope?: ShelfScope;
  onScopeChange?(scope: ShelfScope): void;
  onApplyOrganization?(command: OrganizationCommand): Promise<void>;
  /** 全局忙（导入/打开/删除中），书架禁用交互防止重复操作 */
  busy: boolean;
  theme: Theme;
  onThemeChange(theme: Theme): void;
  onOpen(id: string): void;
  onImport(): void;
  onImportArchive(): void;
  onExportArchive(): void;
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

function MenuIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
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

/* =========================================================================
 * 封面组件（高性能按需加载）
 * ========================================================================= */

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
    return (
      <div ref={nodeRef} className="shelf-cover fallback" aria-hidden="true">
        <span className="fallback-mark">{entry.title.trim().charAt(0) || "书"}</span>
        <span className="fallback-title">{entry.title}</span>
      </div>
    );
  }
  return <img className="shelf-cover" src={url} alt={entry.title} loading="lazy" draggable={false} />;
});

/* =========================================================================
 * 书籍卡片组件（现代极简排版、内嵌进度条、触控安全区）
 * ========================================================================= */

interface ShelfCardProps {
  entry: ShelfEntry;
  selected: boolean;
  selectionMode: boolean;
  provider: ThumbnailProvider;
  isFavorite?: boolean;
  isDragging?: boolean;
  isDropTargetBook?: boolean;
  /** 全局忙（导入/打开/删除中）：禁用卡片内会写数据的操作 */
  busy?: boolean;
  draggedEntry?: ShelfEntry | null;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onDeleteRequest(entry: ShelfEntry): void;
  onMoveToFolder?(entry: ShelfEntry): void;
  onRemoveFromFolder?(entry: ShelfEntry): Promise<void>;
  onToggleFavorite?(entry: ShelfEntry): void;
  onDragStart?(entry: ShelfEntry, point: { x: number; y: number }): void;
}

const ShelfCard = memo(function ShelfCard(props: ShelfCardProps) {
  const { entry } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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
    if (props.selectionMode || e.button !== 0) return;
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

    startPosRef.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = false;
    didLongPressRef.current = false;

    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = window.setTimeout(() => {
      didLongPressRef.current = true;
      isDraggingRef.current = true;
      suppressClickUntilRef.current = Date.now() + 2000;
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try {
          navigator.vibrate(40);
        } catch {
          // ignore
        }
      }
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

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
    if (props.selectionMode) return;
    e.preventDefault();
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
            <span className="shelf-badge missing">源文件缺失</span>
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
          <div className="shelf-card-actions-wrap" ref={menuRef}>
            <button
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

            {menuOpen && (
              <div className="shelf-card-pop-menu" role="menu" onClick={(e) => e.stopPropagation()}>
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
                  onClick={() => {
                    setMenuOpen(false);
                    props.onDeleteRequest(entry);
                  }}
                >
                  <TrashIcon />
                  <span>从书架删除</span>
                </button>
              </div>
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
              <span className="shelf-read-stat">{entry.progressPct}% 已读</span>
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

interface ShelfFolderCardProps {
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
  const menuRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
          <div className="shelf-card-actions-wrap" ref={menuRef}>
            <button
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

            {menuOpen && (
              <div className="shelf-card-pop-menu" role="menu" onClick={(e) => e.stopPropagation()}>
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
              </div>
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const normalized = normalizeFolderName(name);
    if (!normalized) {
      setError("文件夹名称不能为空");
      return;
    }
    const codePoints = Array.from(normalized).length;
    if (codePoints > MAX_FOLDER_NAME_CODE_POINTS) {
      setError(`名称不能超过 ${MAX_FOLDER_NAME_CODE_POINTS} 个字符`);
      return;
    }
    if (props.existingNames.includes(normalized)) {
      setError("已存在同名文件夹");
      return;
    }
    try {
      await props.onCreate(normalized);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="shelf-confirm-backdrop" onClick={props.onCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="shelf-confirm-title">新建文件夹</div>
          {props.subtitle && (
            <div style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0 10px" }}>
              {props.subtitle}
            </div>
          )}
          <div style={{ margin: "14px 0" }}>
            <input
              ref={inputRef}
              className="shelf-dialog-input"
              type="text"
              placeholder="请输入文件夹名称…"
              value={name}
              disabled={props.busy}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              maxLength={MAX_FOLDER_NAME_CODE_POINTS * 2}
            />
            {error && <div className="shelf-dialog-error" style={{ marginTop: 6 }}>{error}</div>}
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={props.onCancel} disabled={props.busy}>
              取消
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy || !name.trim()}>
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const normalized = normalizeFolderName(name);
    if (!normalized) {
      setError("文件夹名称不能为空");
      return;
    }
    const codePoints = Array.from(normalized).length;
    if (codePoints > MAX_FOLDER_NAME_CODE_POINTS) {
      setError(`名称不能超过 ${MAX_FOLDER_NAME_CODE_POINTS} 个字符`);
      return;
    }
    if (normalized !== props.currentName && props.existingNames.includes(normalized)) {
      setError("已存在同名文件夹");
      return;
    }
    if (normalized === props.currentName) {
      props.onCancel();
      return;
    }
    try {
      await props.onRename(props.folderId, normalized);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="shelf-confirm-backdrop" onClick={props.onCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="shelf-confirm-title">重命名文件夹</div>
          <div style={{ margin: "14px 0" }}>
            <input
              ref={inputRef}
              className="shelf-dialog-input"
              type="text"
              value={name}
              disabled={props.busy}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              maxLength={MAX_FOLDER_NAME_CODE_POINTS * 2}
            />
            {error && <div className="shelf-dialog-error" style={{ marginTop: 6 }}>{error}</div>}
          </div>
          <div className="shelf-confirm-actions">
            <button className="shelf-selection-cancel" type="button" onClick={props.onCancel} disabled={props.busy}>
              取消
            </button>
            <button className="shelf-confirm-primary" type="submit" disabled={props.busy || !name.trim()}>
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
  return (
    <div className="shelf-confirm-backdrop" onClick={props.onCancel}>
      <div className="shelf-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="shelf-confirm-title">解散文件夹“{props.folderName}”？</div>
        <div className="shelf-confirm-hint">书籍将回到未归类，收藏、进度和笔记保留。</div>
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={props.onCancel} disabled={props.busy}>
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
    const normalized = normalizeFolderName(newName);
    if (!normalized) {
      setError("文件夹名称不能为空");
      return;
    }
    const codePoints = Array.from(normalized).length;
    if (codePoints > MAX_FOLDER_NAME_CODE_POINTS) {
      setError(`名称不能超过 ${MAX_FOLDER_NAME_CODE_POINTS} 个字符`);
      return;
    }
    if (props.folders.some((f) => f.name === normalized)) {
      setError("已存在同名文件夹");
      return;
    }
    try {
      const createdId = await props.onCreateFolder(normalized);
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
    <div className="shelf-confirm-backdrop" onClick={props.onCancel}>
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
                <span className="shelf-move-item-name">{f.name}</span>
                <span className="shelf-move-item-count">{f.count} 本</span>
                {isFolderCurrent && <span className="shelf-move-current-badge">（当前）</span>}
              </label>
            );
          })}
        </div>

        {creating ? (
          <div className="shelf-move-create-box">
            <input
              className="shelf-dialog-input"
              type="text"
              placeholder="新文件夹名称…"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setError(null);
              }}
              autoFocus
              maxLength={MAX_FOLDER_NAME_CODE_POINTS * 2}
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
                disabled={props.busy || !newName.trim()}
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

        {error && <div className="shelf-dialog-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={props.onCancel} disabled={props.busy}>
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

interface ShelfFolderModalProps {
  folder: { id: string; name: string };
  books: ShelfEntry[];
  provider: ThumbnailProvider;
  originRect?: DOMRect;
  closing: boolean;
  busy: boolean;
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
            <span className="shelf-folder-modal-title">{folder.name}</span>
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
            <div className="shelf-folder-modal-empty">文件夹暂无书籍，从书架将书拖入此处或移出</div>
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

function ShelfSelect(props: {
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
    }, 150);
  }, [open, closing]);

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

interface ShelfSettingsDrawerProps {
  open: boolean;
  entries: ShelfEntry[];
  matchingEntries?: ShelfEntry[];
  busy: boolean;
  query: string;
  onQueryChange(value: string): void;
  sort: ShelfSort;
  onSortChange(value: ShelfSort): void;
  density: ShelfDensity;
  onDensityChange(value: ShelfDensity): void;
  theme: Theme;
  onThemeChange(theme: Theme): void;
  filters: ShelfFilters;
  facets: ShelfFilterFacets;
  matchingCount: number;
  onFiltersChange(filters: ShelfFilters): void;
  onClose(): void;
  onOpenBook?(id: string): void;
  onImportArchive(): void;
  onExportArchive(): void;
  searchMode: ShelfSearchMode;
  onSearchModeChange?: (mode: ShelfSearchMode) => void;
  bodySearch?: ShelfBodySearchProps;
}

function ShelfSettingsDrawer(props: ShelfSettingsDrawerProps) {
  const [mounted, setMounted] = useState(props.open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (props.open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const timer = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, 190);
      return () => clearTimeout(timer);
    }
  }, [props.open, mounted]);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const resultListRef = useRef<HTMLUListElement | null>(null);
  const [allBooksExpanded, setAllBooksExpanded] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<ShelfFilterKey>>(new Set());
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);

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
                    const progressBadge = entry.progressPct > 0
                      ? `${entry.progressPct}%`
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
            <span>排列方式</span>
            <ShelfSelect
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
              value={props.theme}
              busy={props.busy}
              title="书架主题"
              options={[
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
                { value: "sepia", label: "羊皮纸" },
              ]}
              onChange={(value) => props.onThemeChange(value as Theme)}
            />
          </div>

          <div className="shelf-drawer-group-label">数据管理</div>
          <div className="shelf-drawer-actions">
            <button className="tb-btn" type="button" onClick={props.onImportArchive} disabled={props.busy}>
              导入存档
            </button>
            <button className="tb-btn" type="button" onClick={props.onExportArchive} disabled={props.busy || props.entries.length === 0}>
              导出存档
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

/* =========================================================================
 * 主书架视图
 * ========================================================================= */

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
  const [density, setDensity] = useState<ShelfDensity>("standard");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filters, setFilters] = useState<ShelfFilters>(EMPTY_SHELF_FILTERS);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<ShelfEntry[] | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [dissolveFolderTarget, setDissolveFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveDialogTargets, setMoveDialogTargets] = useState<ShelfEntry[] | null>(null);

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

  const filterModel = useMemo(
    () =>
      createShelfFilterModel(scopedCandidateBooks, {
        authors: [...filters.authors],
        titles: [...filters.titles],
        timeSegments: [...filters.saved],
        languages: [...filters.languages],
        query,
      }),
    [scopedCandidateBooks, query, filters]
  );

  const visible = useMemo(
    () => sortShelfEntries(filterModel.entries, sort),
    [filterModel.entries, sort]
  );

  const visibleFolders = useMemo(() => {
    if (scope.type !== "root") return [];
    if (!query.trim()) return activeFolders;
    const q = query.trim().toLowerCase();
    return activeFolders.filter((f) => f.name.toLowerCase().includes(q));
  }, [scope, activeFolders, query]);

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
    setSelectionMode(true);
  };

  const exitSelection = (): void => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

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
    }, 180);
  }, []);

  const handleDragStart = useCallback(
    (entry: ShelfEntry, point: { x: number; y: number }): void => {
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

      const elem = document.elementFromPoint(e.clientX, e.clientY);
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
    };

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

  const searchPlaceholder = useMemo(() => {
    if (scope.type === "root") return "搜索未归类书籍…";
    if (scope.type === "favorites") return "搜索收藏书籍…";
    if (scope.type === "folder") return `搜索《${currentFolder?.name ?? "文件夹"}》内部…`;
    return "搜索书名或作者…";
  }, [scope.type, currentFolder?.name]);

  return (
    <div
      className={`shelf-view density-${density}${selectionMode ? " selection-mode" : ""}${props.busy ? " busy" : ""}`}
      aria-busy={props.busy}
    >
      {/* 现代极简顶部操作栏 */}
      <header className="shelf-head">
        {selectionMode ? (
          /* 多选管理模式状态栏 */
          <div className="shelf-selection-bar">
            <div className="shelf-selection-left">
              <span className="shelf-selection-title">已选 {selectedIds.size} 本</span>
              <button
                className="shelf-selection-toggle-all"
                type="button"
                disabled={props.busy || visible.length === 0}
                onClick={() => {
                  if (selectedIds.size === visible.length) setSelectedIds(new Set());
                  else setSelectedIds(new Set(visible.map((e) => e.id)));
                }}
              >
                {selectedIds.size === visible.length ? "取消全选" : "全选全部"}
              </button>
            </div>
            <div className="shelf-selection-actions">
              <button
                className="shelf-action-fav"
                type="button"
                disabled={selectedIds.size === 0 || props.busy}
                onClick={() => void handleBatchFavorite(true)}
                title="加入收藏"
              >
                <StarIcon filled />
                <span>加入收藏</span>
              </button>
              <button
                className="shelf-action-fav"
                type="button"
                disabled={selectedIds.size === 0 || props.busy}
                onClick={() => void handleBatchFavorite(false)}
                title="取消收藏"
              >
                <StarIcon />
                <span>取消收藏</span>
              </button>
              <button
                className="shelf-action-folder"
                type="button"
                disabled={selectedIds.size === 0 || props.busy}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (targets.length > 0) setMoveDialogTargets(targets);
                }}
                title="移至文件夹"
              >
                <FolderIcon />
                <span>移至文件夹</span>
              </button>
              <button className="shelf-selection-cancel" type="button" onClick={exitSelection}>
                取消
              </button>
              <button
                className="shelf-selection-delete"
                type="button"
                disabled={selectedIds.size === 0 || props.busy}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (targets.length > 0) setDeleteTargets(targets);
                }}
              >
                <TrashIcon />
                <span>删除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}</span>
              </button>
            </div>
          </div>
        ) : (
          /* 常态操作栏：品牌占位、前置快捷检索、排序与主要操作 */
          <div className="shelf-normal-bar">
            <div className="shelf-brand-zone">
              <button
                className={`shelf-menu-btn${drawerOpen ? " open" : ""}`}
                ref={menuButtonRef}
                type="button"
                aria-label="打开书架菜单"
                aria-expanded={drawerOpen}
                aria-controls="shelf-settings-drawer"
                onClick={() => setDrawerOpen(true)}
                disabled={props.busy}
                title="书架菜单与高级筛选"
              >
                <MenuIcon />
              </button>
              <div className="shelf-brand-identity">
                <div className="shelf-brand-icon-wrap" aria-hidden="true">
                  <BookLogoIcon />
                </div>
                <span className="shelf-title">书架</span>
                <span className="shelf-count-chip">{props.entries.length} 本</span>
              </div>
            </div>

            <div className="shelf-tools-zone">
              {/* 前置即时搜索胶囊 */}
              <div className="shelf-quick-search">
                <span className="shelf-quick-search-icon" aria-hidden="true">
                  <SearchIcon />
                </span>
                <input
                  className="shelf-quick-search-input"
                  type="search"
                  placeholder={searchPlaceholder}
                  value={query}
                  disabled={props.busy}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="在书架中即时搜索"
                />
                {query && (
                  <button
                    className="shelf-quick-search-clear"
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="清除搜索"
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>

              {/* 外露快捷排序 */}
              <ShelfSelect
                value={sort}
                busy={props.busy}
                title="快速排序"
                options={[
                  { value: "recent", label: "最近阅读" },
                  { value: "added", label: "最近添加" },
                  { value: "title", label: "书名排序" },
                ]}
                onChange={(value) => setSort(value as ShelfSort)}
              />

              {/* 批量管理模式切换 */}
              <button
                className="shelf-manage-btn"
                type="button"
                onClick={enterSelection}
                disabled={props.busy || props.entries.length === 0}
                title="多选管理书籍"
              >
                <CheckListIcon />
                <span>管理</span>
              </button>

              {/* 导入书籍 */}
              <button
                className="shelf-import-btn"
                type="button"
                onClick={props.onImport}
                disabled={props.busy}
                title="导入 EPUB 到书架"
              >
                <PlusIcon />
                <span>导入</span>
              </button>
            </div>
          </div>
        )}
      </header>

      {/* 书架高级设置与分面抽屉 */}
      <ShelfSettingsDrawer
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
        theme={props.theme}
        onThemeChange={props.onThemeChange}
        filters={filters}
        facets={filterModel.facets}
        matchingCount={filterModel.entries.length}
        onFiltersChange={setFilters}
        onClose={closeDrawer}
        onOpenBook={(id) => {
          props.onOpen(id);
          closeDrawer();
        }}
        onImportArchive={props.onImportArchive}
        onExportArchive={props.onExportArchive}
        searchMode={props.searchMode ?? "metadata"}
        onSearchModeChange={props.onSearchModeChange}
        bodySearch={props.bodySearch}
      />

      {/* Scope 导航栏或文件夹面包屑 */}
      {scope.type === "folder" ? (
        <nav className="shelf-breadcrumb" aria-label="文件夹路径导航">
          <button
            className="shelf-breadcrumb-item"
            type="button"
            onClick={() => setScope({ type: "root" })}
          >
            书架
          </button>
          <span className="shelf-breadcrumb-sep">/</span>
          <span className="shelf-breadcrumb-current">{currentFolder?.name ?? "文件夹"}</span>
          <span className="shelf-breadcrumb-count">
            {(folderBooksMap.get(scope.folderId) ?? []).length} 本书
          </span>
          <div className="shelf-folder-actions">
            {currentFolder && (
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
                  <span>解散文件夹</span>
                </button>
              </>
            )}
          </div>
        </nav>
      ) : (
        <div className="shelf-scope-bar" role="tablist" aria-label="书架范围切换">
          <button
            className={`shelf-scope-item${scope.type === "root" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={scope.type === "root"}
            onClick={() => setScope({ type: "root" })}
          >
            书架
          </button>
          <button
            className={`shelf-scope-item${scope.type === "all" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={scope.type === "all"}
            onClick={() => setScope({ type: "all" })}
          >
            <span>全部书籍</span>
            <span className="shelf-scope-badge">{props.entries.length}</span>
          </button>
          <button
            className={`shelf-scope-item${scope.type === "favorites" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={scope.type === "favorites"}
            onClick={() => setScope({ type: "favorites" })}
          >
            <StarIcon filled={scope.type === "favorites"} />
            <span>收藏</span>
            <span className="shelf-scope-badge">{favoriteBooks.length}</span>
          </button>
          <div className="shelf-scope-spacer" />
          <button
            className="shelf-new-folder-btn"
            type="button"
            disabled={props.busy}
            onClick={() => setCreateFolderOpen(true)}
            title="新建文件夹"
          >
            <PlusIcon />
            <span>新建文件夹</span>
          </button>
        </div>
      )}

      {/* 书架内容区 */}
      {props.entries.length === 0 && activeFolders.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-icon" aria-hidden="true">
            <BookLogoIcon />
          </div>
          <div className="shelf-empty-title">书架还是空的</div>
          <div className="shelf-empty-hint">
            导入 EPUB 后会出现在这里，点击上方“导入”或直接将文件拖拽到窗口
          </div>
          <button className="shelf-empty-btn" onClick={props.onImport} disabled={props.busy}>
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
            导入 EPUB 后会出现在这里，点击上方“导入”或直接将文件拖拽到窗口
          </div>
          <button className="shelf-empty-btn" onClick={props.onImport} disabled={props.busy}>
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
      ) : (
        <div className="shelf-grid">
          {scope.type === "root" &&
            visibleFolders.map((folder) => (
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
              />
            ))}
          {visible.map((entry) => {
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
              />
            );
          })}
        </div>
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
            folder={folder}
            books={books}
            provider={thumbnailProvider}
            busy={props.busy}
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
          />
        );
      })()}

      {/* 删除确认弹层 */}
      {deleteTargets && (
        <div className="shelf-confirm-backdrop" onClick={() => setDeleteTargets(null)}>
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
              <button className="shelf-selection-cancel" type="button" onClick={() => setDeleteTargets(null)}>
                取消
              </button>
              <button
                className="shelf-selection-delete"
                type="button"
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
      {draggedEntry && dragCoord && (
        <div
          className="shelf-drag-ghost"
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
    </div>
  );
}
