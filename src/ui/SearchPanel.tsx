import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CloseIcon } from "./readerIcons";

export type SearchStatus = "idle" | "searching" | "complete" | "error";
export type SearchScope = "current" | "all";

/** Lifecycle of the optional all-books text index. */
export type SearchIndexStatus =
  | "idle"
  | "checking"
  | "confirmation"
  | "partial"
  | "indexing"
  | "cancelling"
  | "cancelled"
  | "ready"
  | "error";

export interface SearchIndexProgress {
  total: number;
  completed: number;
  /** The book currently being processed, if any. */
  currentBookTitle?: string;
  /** Optional explicit value when the caller has a filtered work set. */
  pending?: number;
}

export interface SearchMatchRange {
  /** UTF-16 offsets relative to the displayed snippet. */
  start: number;
  end: number;
}

export interface SearchTextSegment {
  text: string;
  highlighted: boolean;
}

export interface SearchPanelResult {
  id: string;
  chapterTitle: string;
  chapterPath?: string;
  snippet: string;
  /** Optional display ranges; callers may provide highlightedSnippet instead. */
  matchRanges?: SearchMatchRange[];
  highlightedSnippet?: SearchTextSegment[];
  bookTitle?: string;
  creator?: string;
  disabledReason?: string;
}

export interface SearchPanelProps {
  query: string;
  onQueryChange(query: string): void;
  results: SearchPanelResult[];
  status: SearchStatus;
  processed: number;
  total: number;
  truncated?: boolean;
  errorMessage?: string;
  onSelect(result: SearchPanelResult): void;
  onClose(): void;
  onCancel?(): void;
  navigationBusy?: boolean;
  scope?: SearchScope;
  onScopeChange?(scope: SearchScope): void;
  statusMessage?: string;
  onRebuildIndex?(): void;
  onClearIndex?(): void;
  /** Optional all-books index state. Omit these props to retain the legacy UI. */
  indexStatus?: SearchIndexStatus;
  indexProgress?: SearchIndexProgress;
  onStartIndex?(): void;
  onDeferIndex?(): void;
  onCancelIndex?(): void;
  indexErrorMessage?: string;
  concurrencyMode?: "automatic" | "manual";
  concurrency?: number;
  detectedCores?: number;
  recommendedConcurrency?: number;
  onConcurrencyChange?(mode: "automatic" | "manual", value?: number): void;
}

/** Keep a large result set from creating an equally large DOM tree. */
export const SEARCH_RESULT_RENDER_LIMIT = 100;

export function limitSearchResults<T>(results: readonly T[]): { items: T[]; limited: boolean } {
  return {
    items: results.slice(0, SEARCH_RESULT_RENDER_LIMIT),
    limited: results.length > SEARCH_RESULT_RENDER_LIMIT,
  };
}

function isValidRange(range: SearchMatchRange, length: number): boolean {
  return Number.isFinite(range.start) && Number.isFinite(range.end) &&
    Number.isInteger(range.start) && Number.isInteger(range.end) &&
    range.start >= 0 && range.end > range.start && range.start < length;
}

/** Convert snippet-relative UTF-16 ranges into renderable text segments. */
export function highlightSearchSnippet(
  text: string,
  ranges: readonly SearchMatchRange[] = [],
): SearchTextSegment[] {
  const normalized = ranges
    .filter((range) => isValidRange(range, text.length))
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchMatchRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  if (merged.length === 0) return text ? [{ text, highlighted: false }] : [];
  const segments: SearchTextSegment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), highlighted: false });
    segments.push({ text: text.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments.filter((segment) => segment.text.length > 0);
}

export function getSearchStatusLabel(status: SearchStatus, processed: number, total: number): string {
  if (status === "searching") {
    const safeTotal = Math.max(0, total);
    return `正在搜索 ${Math.max(0, processed)}/${safeTotal} 章`;
  }
  if (status === "complete") return "搜索完成";
  if (status === "error") return "搜索失败";
  return "";
}

export function getSearchIndexPending(progress: SearchIndexProgress | undefined): number {
  if (!progress) return 0;
  if (progress.pending !== undefined) return Math.max(0, progress.pending);
  return Math.max(0, progress.total - progress.completed);
}

function indexProgressValues(progress: SearchIndexProgress | undefined): Required<Pick<SearchIndexProgress, "total" | "completed">> {
  return {
    total: Math.max(0, progress?.total ?? 0),
    completed: Math.max(0, progress?.completed ?? 0),
  };
}

function resultSegments(result: SearchPanelResult): SearchTextSegment[] {
  return result.highlightedSnippet ?? highlightSearchSnippet(result.snippet, result.matchRanges);
}

function CheckIcon() {
  return (
    <svg className="shelf-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

interface ConcurrencyOption {
  value: "automatic" | "manual";
  label: string;
}

function ConcurrencySelect(props: {
  value: "automatic" | "manual";
  options: ConcurrencyOption[];
  onChange(value: "automatic" | "manual"): void;
  title?: string;
  disabled?: boolean;
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
    if (closing || props.disabled) return;
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
  }, [open, closing, closeDropdown, props.disabled]);

  useEffect(() => {
    if (!open || closing) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeDropdown();
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
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
    <div className="shelf-select-wrap search-concurrency-select-wrap" ref={ref}>
      <button
        type="button"
        className={`shelf-select-btn${open && !closing ? " open" : ""}`}
        title={props.title}
        disabled={props.disabled}
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
              type="button"
              className={`shelf-select-option${o.value === props.value ? " selected" : ""}`}
              role="option"
              aria-selected={o.value === props.value}
              onClick={() => {
                props.onChange(o.value);
                closeDropdown();
              }}
            >
              <span>{o.label}</span>
              {o.value === props.value && (
                <span className="shelf-select-check">
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SearchIndexCard({ props }: { props: SearchPanelProps }) {
  const state = props.indexStatus ?? "idle";
  const progress = indexProgressValues(props.indexProgress);
  const pending = getSearchIndexPending(props.indexProgress);
  const canStart = Boolean(props.onStartIndex);
  const showStats = state === "confirmation" || state === "partial" || state === "cancelled" || state === "error";

  const [startDebounce, setStartDebounce] = useState(false);
  const handleStart = () => {
    if (startDebounce || !props.onStartIndex) return;
    setStartDebounce(true);
    props.onStartIndex();
    setTimeout(() => setStartDebounce(false), 500);
  };

  if (state === "idle" || state === "ready") return null;

  if (state === "checking") {
    return <div className="search-index-card search-index-card-checking" role="status" aria-live="polite">
      <div className="search-index-card-title">正在检查书库索引…</div>
      <div className="search-index-card-description">只检查已有索引状态，不会读取或处理 EPUB。</div>
    </div>;
  }

  if (state === "indexing" || state === "cancelling") {
    const cancelling = state === "cancelling";
    return <div className="search-index-card search-index-card-progress" role="status" aria-live="polite">
      <div className="search-index-progress-head">
        <span>{cancelling ? "正在取消索引" : "正在建立全文索引"} {progress.completed}/{progress.total} 本</span>
        {props.onCancelIndex && <button
          className="search-index-cancel"
          type="button"
          disabled={cancelling}
          onClick={props.onCancelIndex}
        >{cancelling ? "正在取消…" : "取消"}</button>}
      </div>
      <div className="search-index-progress-book" title={props.indexProgress?.currentBookTitle || undefined}>
        当前：{props.indexProgress?.currentBookTitle || (cancelling ? "正在等待当前任务结束…" : "准备中…")}
      </div>
      <div className="search-index-progress-track" aria-hidden="true">
        <span style={{ width: `${progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : 0}%` }} />
      </div>
    </div>;
  }

  const isConfirmation = state === "confirmation";
  const isPartial = state === "partial";
  const isCancelled = state === "cancelled";
  const heading = isConfirmation
    ? "建立全部书籍索引"
    : isPartial
      ? "书库索引尚未完成"
      : isCancelled
        ? "索引已取消"
        : "索引建立失败";
  const description = isConfirmation
    ? "建立全库索引会读取需要处理的 EPUB，期间可能占用较多 CPU 和内存，并需要一段时间。索引建立后会保留，后续搜索无需重复处理。"
    : isPartial
      ? "已完成的书籍可以正常搜索；继续建立索引后，剩余书籍也会加入搜索范围。"
      : isCancelled
        ? "已完成的书籍仍然保留，可以继续搜索；需要时可从剩余书籍继续建立索引。"
      : (props.indexErrorMessage || "本次索引未能完成，已完成的书籍仍然保留。");
  const detectedLogicalProcessors = Math.max(1, Math.floor(props.detectedCores ?? 1));
  const maximumConcurrency = Math.min(16, Math.max(1, detectedLogicalProcessors - 1));

  const concurrencyOptions: ConcurrencyOption[] = [
    {
      value: "automatic",
      label: `自动${props.recommendedConcurrency ? `（推荐 ${props.recommendedConcurrency}）` : ""}`,
    },
    {
      value: "manual",
      label: "手动",
    },
  ];

  return <section className={`search-index-card search-index-card-${state}`} role={state === "error" ? "alert" : "status"} aria-live="polite">
    <div className="search-index-card-title">{heading}</div>
    <div className="search-index-card-description">{description}</div>
    {props.indexErrorMessage && state !== "error" && (
      <div className="search-index-card-notice">{props.indexErrorMessage}</div>
    )}
    {showStats && <div className="search-index-stats" aria-label="索引统计">
      <span>书库总数 <strong>{progress.total}</strong></span>
      <span>已可搜索 <strong>{progress.completed}</strong></span>
      <span>待处理 <strong>{pending}</strong></span>
    </div>}
    {props.onConcurrencyChange && <div className="search-index-concurrency" aria-label="索引并发设置">
      <span className="search-index-concurrency-label">索引并发</span>
      <ConcurrencySelect
        value={props.concurrencyMode ?? "automatic"}
        options={concurrencyOptions}
        onChange={(mode) => props.onConcurrencyChange?.(mode, props.concurrency)}
      />
      {props.concurrencyMode === "manual" && <div className="search-index-stepper">
        <button
          type="button"
          className="search-index-stepper-btn"
          disabled={(props.concurrency ?? 1) <= 1}
          onClick={() => props.onConcurrencyChange?.("manual", Math.max(1, (props.concurrency ?? 1) - 1))}
          aria-label="减少并发数"
        >−</button>
        <input
          aria-label="索引并发数"
          type="number"
          min={1}
          max={maximumConcurrency}
          value={props.concurrency ?? 1}
          onChange={(event) => props.onConcurrencyChange?.("manual", Number(event.target.value))}
        />
        <button
          type="button"
          className="search-index-stepper-btn"
          disabled={(props.concurrency ?? 1) >= maximumConcurrency}
          onClick={() => props.onConcurrencyChange?.("manual", Math.min(maximumConcurrency, (props.concurrency ?? 1) + 1))}
          aria-label="增加并发数"
        >+</button>
      </div>}
      {props.detectedCores && <small className="search-index-cores-chip">检测到 {props.detectedCores} 个逻辑处理器</small>}
    </div>}
    {props.onConcurrencyChange && props.detectedCores && <div className="search-index-concurrency-help">
      自动推荐 {props.recommendedConcurrency ?? 1}；手动最大 {maximumConcurrency}。在可用时为系统至少保留 1 个逻辑处理器，且应用硬上限为 16；并发越高，占用的内存也越多。
    </div>}
    <div className="search-index-card-actions">
      {(isConfirmation || isPartial) && props.onDeferIndex && <button type="button" className="search-index-secondary" onClick={props.onDeferIndex}>暂不建立</button>}
      {isCancelled && props.onDeferIndex && <button type="button" className="search-index-secondary" onClick={props.onDeferIndex}>暂不处理</button>}
      {canStart && (isConfirmation || isPartial || isCancelled || state === "error") && <button type="button" className="search-index-primary" onClick={handleStart} disabled={(pending === 0 && !isConfirmation) || startDebounce}>{isConfirmation ? "开始建立索引" : "继续建立索引"}</button>}
    </div>
  </section>;
}

/** Shared bounded result presentation used by reader and shelf search surfaces. */
export function SearchResultList({
  results,
  navigationBusy = false,
  onSelect,
}: Pick<SearchPanelProps, "results" | "onSelect"> & { navigationBusy?: boolean }) {
  const rendered = limitSearchResults(results);
  return <>
    {rendered.items.length > 0 && (
      <div className="search-results" role="list" aria-label="搜索结果">
        {rendered.items.map((result) => (
          <button
            key={result.id}
            type="button"
            className="search-result"
            role="listitem"
            disabled={navigationBusy || Boolean(result.disabledReason)}
            onClick={() => onSelect(result)}
            title={result.disabledReason ?? result.chapterPath ?? result.chapterTitle}
          >
            {result.bookTitle && <span className="search-result-book">{result.bookTitle}{result.creator ? ` · ${result.creator}` : ""}</span>}
            <span className="search-result-chapter">{result.chapterTitle}</span>
            <span className="search-result-snippet">
              {resultSegments(result).map((segment, index) => segment.highlighted
                ? <mark key={`${result.id}-match-${index}`}>{segment.text}</mark>
                : <span key={`${result.id}-text-${index}`}>{segment.text}</span>)}
            </span>
            {result.disabledReason && <span className="search-result-disabled">{result.disabledReason}</span>}
          </button>
        ))}
      </div>
    )}
    {(results.length > SEARCH_RESULT_RENDER_LIMIT || rendered.limited) && (
      <div className="search-truncated">结果较多，仅显示前 {SEARCH_RESULT_RENDER_LIMIT} 条</div>
    )}
  </>;
}

export function SearchPanel(props: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rendered = limitSearchResults(props.results);
  const statusLabel = props.statusMessage ?? getSearchStatusLabel(props.status, props.processed, props.total);
  const hasQuery = props.query.trim().length > 0;
  const showEmpty = props.status === "complete" && hasQuery && props.results.length === 0;
  const scope = props.scope ?? "current";
  const indexBusy = props.indexStatus === "indexing" || props.indexStatus === "cancelling";
  const indexSearchUnavailable = scope === "all" && (
    props.indexStatus === "checking"
    || indexBusy
    || ((props.indexStatus === "confirmation" || props.indexStatus === "cancelled" || props.indexStatus === "error")
      && (props.indexProgress?.completed ?? 0) === 0)
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  };

  return (
    <>
      <div className="search-backdrop" aria-hidden="true" onClick={props.onClose} />
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="正文搜索"
        onKeyDown={handleKeyDown}
      >
        <div className="drawer-drag-handle" aria-hidden="true" />
        <div className="menu-head search-head">
          <div className="drawer-title-wrap">
            <span className="search-title">正文搜索</span>
            {props.status === "complete" && hasQuery && (
              <span className="search-count-badge">
                {props.results.length > 0 ? `${props.results.length} 条` : "无结果"}
              </span>
            )}
          </div>
          <button className="tb-btn tb-close" type="button" onClick={props.onClose} aria-label="关闭搜索" title="关闭搜索">
            <CloseIcon size={14} />
          </button>
        </div>
        {props.onScopeChange && (
          <div className="search-scope" role="group" aria-label="搜索范围">
            <button
              type="button"
              className={scope === "current" ? "active" : ""}
              aria-pressed={scope === "current"}
              onClick={() => props.onScopeChange?.("current")}
            >当前书</button>
            <button
              type="button"
              className={scope === "all" ? "active" : ""}
              aria-pressed={scope === "all"}
              onClick={() => props.onScopeChange?.("all")}
            >全部书籍</button>
          </div>
        )}
        {scope === "all" && (props.onRebuildIndex || props.onClearIndex) && (
          <div className="search-index-actions" aria-label="全文索引管理">
            {props.onRebuildIndex && <button type="button" disabled={props.status === "searching" || indexBusy} onClick={props.onRebuildIndex}>重新建立索引</button>}
            {props.onClearIndex && <button type="button" disabled={props.status === "searching" || indexBusy} onClick={props.onClearIndex}>清除索引</button>}
          </div>
        )}
        {scope === "all" && <SearchIndexCard props={props} />}
        <div className="search-input-wrap">
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            value={props.query}
            disabled={indexSearchUnavailable}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={scope === "all" ? "搜索全部书籍正文" : "搜索当前书正文"}
            aria-label={scope === "all" ? "搜索全部书籍正文" : "搜索当前书正文"}
          />
          {props.query.length > 0 && (
            <button
              className="search-clear"
              type="button"
              onClick={() => props.onQueryChange("")}
              aria-label="清空搜索"
            >
              ×
            </button>
          )}
        </div>
        <div className="search-status" aria-live="polite">
          {statusLabel}
          {props.status === "searching" && props.onCancel && (
            <button className="search-cancel" type="button" onClick={props.onCancel}>取消</button>
          )}
          {props.status === "error" && props.errorMessage && <span className="search-error">：{props.errorMessage}</span>}
        </div>
        {!hasQuery && props.status !== "searching" && (
          <div className="search-empty">
            {scope === "all" ? "输入关键词搜索全部书籍的正文" : "输入关键词搜索当前书的正文"}
          </div>
        )}
        {showEmpty && <div className="search-empty">未找到匹配内容</div>}
        {props.navigationBusy && <div className="search-navigation-busy">正在定位结果…</div>}
        <SearchResultList results={props.results} navigationBusy={props.navigationBusy} onSelect={props.onSelect} />
        {props.truncated && !rendered.limited && <div className="search-truncated">结果较多，仅显示前 {SEARCH_RESULT_RENDER_LIMIT} 条</div>}
      </div>
    </>
  );
}
