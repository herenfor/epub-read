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
  descriptorForEntry,
  isAbortError,
  legacyThumbnailProvider,
  loadThumbnailAsset,
  thumbnailTaskQueue,
  type ThumbnailProvider,
} from "./thumbnail";
import { hasReadPosition } from "./readEvidence";
import {
  getSearchStatusLabel,
  SearchIndexCard,
  SearchResultList,
  type SearchIndexProgress,
  type SearchIndexStatus,
  type SearchPanelResult,
  type SearchStatus,
} from "./SearchPanel";

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
  return <img className="shelf-cover" src={url} alt={entry.title} loading="lazy" />;
});

/* =========================================================================
 * 书籍卡片组件（现代极简排版、内嵌进度条、触控安全区）
 * ========================================================================= */

interface ShelfCardProps {
  entry: ShelfEntry;
  selected: boolean;
  selectionMode: boolean;
  provider: ThumbnailProvider;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onDeleteRequest(entry: ShelfEntry): void;
  onMoveToFolder?(entry: ShelfEntry): void;
}

const ShelfCard = memo(function ShelfCard(props: ShelfCardProps) {
  const { entry } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const last = entry.lastReadAtMs > 0 ? entry.lastReadAtMs : entry.addedAtMs;
  const recent = Date.now() - last < 1000 * 60 * 60 * 24 * 7;
  const read = hasReadPosition(entry);

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

  const handleCardClick = (): void => {
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

  return (
    <div
      className={`shelf-card${props.selected ? " selected" : ""}${entry.available === false ? " unavailable" : ""}`}
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      title={`${entry.title}${entry.creator ? ` · ${entry.creator}` : ""}`}
    >
      <div className="shelf-cover-box">
        <Cover entry={entry} provider={props.provider} />

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
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ShelfSort>("recent");
  const [density, setDensity] = useState<ShelfDensity>("standard");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filters, setFilters] = useState<ShelfFilters>(EMPTY_SHELF_FILTERS);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<ShelfEntry[] | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const filterModel = useMemo(() => createShelfFilterModel(props.entries, {
    authors: [...filters.authors],
    titles: [...filters.titles],
    timeSegments: [...filters.saved],
    languages: [...filters.languages],
    query,
  }), [props.entries, query, filters]);

  const visible = useMemo(
    () => sortShelfEntries(filterModel.entries, sort),
    [filterModel.entries, sort],
  );

  const thumbnailProvider = props.thumbnailProvider ?? legacyThumbnailProvider;

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

  const onToggleSelected = toggleSelected;

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
              {props.onMoveToFolder && (
                <button
                  className="shelf-action-folder"
                  type="button"
                  disabled={selectedIds.size === 0 || props.busy}
                  onClick={() => props.onMoveToFolder?.(Array.from(selectedIds), null)}
                  title="移动到文件夹（预留）"
                >
                  <FolderIcon />
                  <span>移至文件夹</span>
                </button>
              )}
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
                {/* 标题占位：后续用户确定产品名后直接修改此处的文字即可 */}
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
                  placeholder="搜索书名或作者…"
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

      {/* 预留：文件夹路径面包屑导航（当处于子文件夹时激活） */}
      {props.currentFolderId && (
        <nav className="shelf-breadcrumb" aria-label="文件夹路径导航">
          <button
            className="shelf-breadcrumb-item"
            type="button"
            onClick={() => props.onOpenFolder?.("")}
          >
            全部书籍
          </button>
          <span className="shelf-breadcrumb-sep">/</span>
          <span className="shelf-breadcrumb-current">当前分类</span>
        </nav>
      )}

      {/* 书架内容区 */}
      {props.entries.length === 0 ? (
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
      ) : visible.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-icon" aria-hidden="true">
            <SearchIcon />
          </div>
          <div className="shelf-empty-title">没有找到匹配的书籍</div>
          <div className="shelf-empty-hint">换一个关键词或清除筛选条件试试</div>
          {query && (
            <button className="shelf-selection-cancel" type="button" onClick={() => setQuery("")}>
              清除搜索词
            </button>
          )}
        </div>
      ) : (
        <div className="shelf-grid">
          {visible.map((entry) => (
            <ShelfCard
              key={entry.id}
              entry={entry}
              selected={selectedIds.has(entry.id)}
              selectionMode={selectionMode}
              provider={thumbnailProvider}
              onOpen={props.onOpen}
              onToggleSelected={onToggleSelected}
              onDeleteRequest={onDeleteRequest}
              onMoveToFolder={props.onMoveToFolder ? () => props.onMoveToFolder?.([entry.id], null) : undefined}
            />
          ))}
        </div>
      )}

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
            <div className="shelf-confirm-hint">源文件不会被删除，但书签与本地进度将被移除。</div>
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
    </div>
  );
}
