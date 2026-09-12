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
      // The shelf itself scrolls; one viewport of look-ahead keeps scrolling
      // smooth without starting work for the whole bookcase.
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

interface ShelfCardProps {
  entry: ShelfEntry;
  selected: boolean;
  selectionMode: boolean;
  provider: ThumbnailProvider;
  onOpen(id: string): void;
  onToggleSelected(id: string): void;
  onDeleteRequest(entry: ShelfEntry): void;
}

const ShelfCard = memo(function ShelfCard(props: ShelfCardProps) {
  const { entry } = props;
  const last = entry.lastReadAtMs > 0 ? entry.lastReadAtMs : entry.addedAtMs;
  const recent = Date.now() - last < 1000 * 60 * 60 * 24 * 7;
  const read = hasReadPosition(entry);
  return (
    <div
      className={`shelf-card${props.selected ? " selected" : ""}${entry.available === false ? " unavailable" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (props.selectionMode) props.onToggleSelected(entry.id);
        else props.onOpen(entry.id);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        if (props.selectionMode) props.onToggleSelected(entry.id);
        else props.onOpen(entry.id);
      }}
      title={`${entry.title}${entry.creator ? ` · ${entry.creator}` : ""}`}
    >
      <div className="shelf-cover-box">
        <Cover entry={entry} provider={props.provider} />
        {props.selectionMode && (
          <span className="shelf-select-mark">{props.selected ? "✓" : ""}</span>
        )}
        {entry.progressPct > 0 && (
          <div className="shelf-progress-wrap">
            <div className="shelf-progress">
              <div
                className="shelf-progress-fill"
                style={{ width: `${Math.min(100, entry.progressPct)}%` }}
              />
            </div>
            <span className="shelf-progress-pct">{entry.progressPct}%</span>
          </div>
        )}
        {entry.available === false ? (
          <span className="shelf-missing">源文件缺失 · 点击重新定位</span>
        ) : (
          <>
            {recent && read && <span className="shelf-continue">继续阅读</span>}
            {entry.isNew && !props.selectionMode && <span className="shelf-new">新</span>}
          </>
        )}
        {!props.selectionMode && (
          <span
            className="shelf-delete"
            title="从书架删除"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              props.onDeleteRequest(entry);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                props.onDeleteRequest(entry);
              }
            }}
          >
            ✕
          </span>
        )}
      </div>
      <div className="shelf-card-title">{entry.title}</div>
      <div className="shelf-card-meta">
        {entry.creator ? <span className="shelf-card-creator">{entry.creator}</span> : null}
        <span className="shelf-card-time">
          {formatShelfTime(last) || "刚刚"}
          {read ? " · 读过" : " · 未读"}
        </span>
      </div>
    </div>
  );
});

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
        <div className="shelf-filter-section-content">{props.open ? props.children : null}</div>
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = props.options.find((o) => o.value === props.value) ?? props.options[0];

  return (
    <div className="shelf-select-wrap" ref={ref}>
      <button
        className={`shelf-select-btn${open ? " open" : ""}`}
        title={props.title}
        disabled={props.busy}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current.label}</span>
        <span className="shelf-select-arrow" aria-hidden="true" />
      </button>
      {open && (
        <div className="shelf-select-pop" role="listbox">
          {props.options.map((o) => (
            <button
              key={o.value}
              className={`shelf-select-option${o.value === props.value ? " selected" : ""}`}
              role="option"
              aria-selected={o.value === props.value}
              onClick={() => {
                props.onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
              {o.value === props.value ? <span className="shelf-select-check">✓</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ShelfSettingsDrawerProps {
  open: boolean;
  entries: ShelfEntry[];
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
  onImportArchive(): void;
  onExportArchive(): void;
  searchMode: ShelfSearchMode;
  onSearchModeChange?: (mode: ShelfSearchMode) => void;
  bodySearch?: ShelfBodySearchProps;
}

function ShelfSettingsDrawer(props: ShelfSettingsDrawerProps) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [allBooksExpanded, setAllBooksExpanded] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<ShelfFilterKey>>(new Set());

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

  if (!props.open) return null;
  const body = props.bodySearch;
  const bodyIndexBusy = body?.indexStatus === "indexing" || body?.indexStatus === "cancelling";
  const bodyIndexUnavailable = body?.indexStatus === "checking" || bodyIndexBusy;
  const bodyStatus = body?.statusMessage ?? (body ? getSearchStatusLabel(body.status, body.processed, body.total) : "");
  const bodyHasQuery = Boolean(body?.query.trim());
  return (
    <div className="shelf-drawer-layer">
      <div className="shelf-drawer-backdrop" aria-hidden="true" onClick={props.onClose} />
      <aside id="shelf-settings-drawer" className="shelf-drawer" role="dialog" aria-modal="true" aria-label="书架菜单">
        <div className="shelf-drawer-head">
          <div>
            <div className="shelf-drawer-title">书架菜单</div>
            <div className="shelf-drawer-subtitle">{props.entries.length} 本书</div>
          </div>
          <button className="shelf-drawer-close tb-btn" type="button" onClick={props.onClose} aria-label="关闭书架菜单">
            ×
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
              {body.onRebuildIndex && <button type="button" disabled={body.status === "searching" || bodyIndexBusy} onClick={body.onRebuildIndex}>重新建立索引</button>}
              {body.onClearIndex && <button type="button" disabled={body.status === "searching" || bodyIndexBusy} onClick={body.onClearIndex}>清除索引</button>}
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
            />
            {props.query && (
              <button className="shelf-drawer-search-clear" type="button" onClick={() => props.onQueryChange("")} aria-label="清除搜索">
                ×
              </button>
            )}
          </label>

          <div className="shelf-drawer-group-label">书籍筛选</div>
          <button
            className={`shelf-all-books${allBooksExpanded ? " expanded" : ""}`}
            type="button"
            aria-expanded={allBooksExpanded}
            onClick={() => setAllBooksExpanded((value) => !value)}
          >
            <span className="shelf-all-books-icon" aria-hidden="true">▦</span>
            <span className="shelf-all-books-label">全部书籍</span>
            <span className="shelf-all-books-count">{props.matchingCount}</span>
            <span className="shelf-filter-section-arrow" aria-hidden="true" />
          </button>
          <div className="shelf-all-books-details">
            <div className="shelf-all-books-details-inner">
              {allBooksExpanded && <>
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
              </>}
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button className="shelf-filter-clear" type="button" onClick={clearFilters}>
              清除筛选（{activeFilterCount}）
            </button>
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
      <header className="shelf-head">
        {selectionMode ? (
          <>
            <div className="shelf-title-block selection-title">
              <span className="shelf-title">已选 {selectedIds.size} 本</span>
            </div>
            <div className="shelf-controls selection-actions">
              <button
                className="shelf-select-all tb-btn"
                disabled={props.busy || visible.length === 0}
                onClick={() => {
                  if (selectedIds.size === visible.length) setSelectedIds(new Set());
                  else setSelectedIds(new Set(visible.map((e) => e.id)));
                }}
              >
                {selectedIds.size === visible.length ? "取消全选" : "全选"}
              </button>
              <button className="shelf-select-cancel tb-btn" onClick={exitSelection}>
                取消
              </button>
              <button
                className="shelf-select-delete tb-btn"
                disabled={selectedIds.size === 0 || props.busy}
                onClick={() => {
                  const targets = props.entries.filter((e) => selectedIds.has(e.id));
                  if (targets.length > 0) setDeleteTargets(targets);
                }}
              >
                🗑 确认删除{selectedIds.size > 0 ? `（${selectedIds.size}）` : ""}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="shelf-title-block">
              <button
                className={`shelf-menu-btn${drawerOpen ? " open" : ""}`}
                ref={menuButtonRef}
                type="button"
                aria-label="打开书架菜单"
                aria-expanded={drawerOpen}
                aria-controls="shelf-settings-drawer"
                onClick={() => setDrawerOpen(true)}
                disabled={props.busy}
              >
                <span aria-hidden="true">☰</span>
              </button>
              <span className="shelf-title">书架</span>
              <span className="shelf-count">{props.entries.length} 本</span>
            </div>
            <div className="shelf-controls">
              <button
                className="shelf-batch-btn tb-btn"
                onClick={enterSelection}
                disabled={props.busy || props.entries.length === 0}
                title="批量选择书籍"
              >
                🗑 批量删除
              </button>
              <button
                className="shelf-import tb-btn"
                onClick={props.onImport}
                disabled={props.busy}
                title="导入 EPUB 到书架"
              >
                ＋ 导入
              </button>
            </div>
          </>
        )}
      </header>

      <ShelfSettingsDrawer
        open={drawerOpen}
        entries={props.entries}
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
        onImportArchive={props.onImportArchive}
        onExportArchive={props.onExportArchive}
        searchMode={props.searchMode ?? "metadata"}
        onSearchModeChange={props.onSearchModeChange}
        bodySearch={props.bodySearch}
      />

      {props.entries.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-mark">📚</div>
          <div className="shelf-empty-title">书架还是空的</div>
          <div className="shelf-empty-hint">
            导入 EPUB 后会出现在这里；点击“导入”或把文件拖进窗口
          </div>
          <button className="shelf-empty-btn" onClick={props.onImport} disabled={props.busy}>
            导入第一本书
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="shelf-empty">
          <div className="shelf-empty-title">没有匹配的书</div>
          <div className="shelf-empty-hint">换一个关键词试试</div>
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
            />
          ))}
        </div>
      )}

      {deleteTargets && (
        <div className="shelf-confirm-backdrop" onClick={() => setDeleteTargets(null)}>
          <div
            className="shelf-confirm"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shelf-confirm-title">
              {deleteTargets.length > 1
                ? `删除选中的 ${deleteTargets.length} 本？`
                : "从书架删除？"}
            </div>
            <div className="shelf-confirm-name">
              {deleteTargets.length > 1
                ? deleteTargets
                    .slice(0, 3)
                    .map((t) => t.title)
                    .join("、") + (deleteTargets.length > 3 ? "…" : "")
                : deleteTargets[0].title}
            </div>
            <div className="shelf-confirm-hint">不会删除原始文件；阅读进度也会一并移除。</div>
            <div className="shelf-confirm-actions">
              <button className="tb-btn" onClick={() => setDeleteTargets(null)}>
                取消
              </button>
              <button
                className="tb-btn danger"
                onClick={() => {
                  const ids = deleteTargets.map((t) => t.id);
                  setDeleteTargets(null);
                  if (selectionMode) {
                    // 批量选择模式：无论选 1 本还是多本，确认后都退出选择模式
                    if (ids.length > 1) props.onDeleteMany(ids);
                    else props.onDelete(ids[0]);
                    exitSelection();
                  } else {
                    props.onDelete(ids[0]);
                  }
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
