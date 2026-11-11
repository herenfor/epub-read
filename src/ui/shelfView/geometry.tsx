import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ShelfDensity } from "../ShelfView";
import { formatShelfTime, type ShelfEntry } from "../shelf";
import type { FolderSelectionState } from "../shelfFolderSelection";
import type { ThumbnailProvider } from "../thumbnail";
import { shelfProgressLabel } from "../shelfProgressDisplay";
import { useShelfPress, shelfLongPressKind, type ShelfLongPress } from "../shelfPress";
import { isShelfCardActionTarget } from "../shelfCardEventScope";
import { useUiText } from "../localization/UiLanguageProvider";
import { ArrowRightIcon, DotsVerticalIcon, FolderIcon, StarIcon } from "./icons";
import { Cover, formatFileSize, formatRelativeTime } from "./cards";
import {
  buttonMenuOpener,
  contextMenuOpener,
  type ShelfMenuOpener,
  type ShelfMenuTarget,
} from "./menuTarget";

interface ShelfGridGeometry {
  columns: number;
  /** 书籍行步长，已还原到书架布局 CSS px。 */
  rowStep: number;
  /** 书籍占位容器在滚动内容中的稳定起点，不含自身虚拟 topPadding。 */
  contentTop: number;
}

function sameShelfGridGeometry(a: ShelfGridGeometry, b: ShelfGridGeometry): boolean {
  return a.columns === b.columns &&
    Math.abs(a.rowStep - b.rowStep) < 0.01 &&
    Math.abs(a.contentTop - b.contentTop) < 0.01;
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
    rowStep: Math.max(1, rowStep),
    contentTop: Math.max(0, contentTop),
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
    contentTop: Math.max(0, contentTop),
  };
}

/* =========================================================================
 * 书架虚拟窗口：统一布局坐标，按浏览器帧合并测量与滚动
 * ========================================================================= */

interface VirtualizerResult {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
  isVirtual: boolean;
}

/**
 * The shelf unmounts while a book is open. Its last position, with the
 * geometry it was measured against, lets it come back where it was: the
 * first render already has the full height, so the scroll lands before the
 * page transition takes its snapshot. Only an identical shelf restores.
 */
let lastShelfScroll: {
  key: string;
  scrollTop: number;
  viewportHeight: number;
  geometry: ShelfGridGeometry | null;
} | null = null;

export function useShelfVirtualizer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  totalCount: number,
  viewMode: "grid" | "list",
  density: ShelfDensity,
  folderCount = 0,
  threshold = 40,
  scopeKey = ""
): VirtualizerResult & { gridGeometry: ShelfGridGeometry | null } {
  const restoreKey = `${scopeKey}|${viewMode}|${density}|${folderCount}|${totalCount}`;
  const [restored] = useState(() => (lastShelfScroll?.key === restoreKey ? lastShelfScroll : null));
  const [scrollState, setScrollState] = useState(() => restored
    ? { scrollTop: restored.scrollTop, viewportHeight: restored.viewportHeight }
    : { scrollTop: 0, viewportHeight: 800 });
  const [gridGeometry, setGridGeometry] = useState<ShelfGridGeometry | null>(restored?.geometry ?? null);

  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (restored && container) container.scrollTop = restored.scrollTop;
    // Mount only: later key changes are a different shelf, which starts where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measureGeometry = viewMode === "grid" ? measureShelfGridGeometry : measureShelfListGeometry;
    let frame: number | null = null;
    let observed = new Set<Element>();
    const requestFrame = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
    const cancelFrame = typeof window.cancelAnimationFrame === "function"
      ? window.cancelAnimationFrame.bind(window) : window.clearTimeout.bind(window);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduleMeasure()) : null;

    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        // Observe current nodes, including the prefix above the books. Empty/error views
        // may replace the whole list without changing the count or view preference.
        // The grid's prefixes sit one level down, inside the level page that animates folder navigation.
        const levelPage = container.querySelector(":scope > .shelf-level-page");
        const targets = new Set<Element>([container, ...container.children, ...(levelPage?.children ?? [])]);
        const item = container.querySelector(viewMode === "grid"
          ? ".shelf-book-grid .shelf-card"
          : 'tr.shelf-table-row[data-shelf-target="book"]');
        if (item) targets.add(item);
        for (const old of observed) if (!targets.has(old)) observer?.unobserve(old);
        for (const target of targets) if (!observed.has(target)) observer?.observe(target);
        observed = targets;

        const next = measureGeometry(container);
        setGridGeometry(previous => next && previous && sameShelfGridGeometry(previous, next) ? previous : next);
        // Read the real position together with geometry, including native scroll clamping
        // after a search shrinks the list. Never combine a new origin with an old offset.
        const scrollTop = container.scrollTop;
        const viewportHeight = container.clientHeight || 800;
        setScrollState(previous => previous.scrollTop === scrollTop && previous.viewportHeight === viewportHeight
          ? previous : { scrollTop, viewportHeight });
        lastShelfScroll = { key: restoreKey, scrollTop, viewportHeight, geometry: next };
      });
    };
    measureRef.current = scheduleMeasure;
    scheduleMeasure();
    const scaleOwner = container.closest(".app");
    const styleObserver = typeof MutationObserver !== "undefined" && scaleOwner
      ? new MutationObserver(scheduleMeasure) : null;
    if (scaleOwner) styleObserver?.observe(scaleOwner, { attributes: true, attributeFilter: ["style"] });
    container.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure, { passive: true });
    return () => {
      measureRef.current = null;
      if (frame !== null) cancelFrame(frame);
      observer?.disconnect();
      styleObserver?.disconnect();
      container.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [containerRef, density, folderCount, viewMode, totalCount, restoreKey]);

  // Rebind after React replaces nodes or changes the content above the window;
  // unchanged geometry returns the same state, so this cannot sustain a render loop.
  useLayoutEffect(() => { measureRef.current?.(); });

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
    const totalRows = Math.ceil(totalCount / geometry.columns);
    const relativeTop = Math.min(Math.max(0, scrollTop - geometry.contentTop),
      Math.max(0, totalRows * geometry.rowStep - viewportHeight));
    // 列表一行一本，多留几行；网格按行留两行。
    const overscan = geometry.columns === 1 ? 5 : 2;
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

/**
 * The list's horizontal scroller. The table grows with the virtual list, so
 * its own scrollbar sits under the last book; a second bar after it sticks to
 * the bottom of the shelf's viewport and shares scrollLeft with the table.
 * Trackpad and Shift+wheel still scroll the table itself. One observer on the
 * table (width and virtual height changes), no per-row listeners or polling.
 */
export function ShelfTableScroller({ children }: { children: ReactNode }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [scrollWidth, setScrollWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const measure = () => {
      // Null while everything fits: no second bar.
      const next = view.scrollWidth > view.clientWidth + 1 ? view.scrollWidth : null;
      setScrollWidth((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    if (view.firstElementChild) observer.observe(view.firstElementChild);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (barRef.current && viewRef.current) barRef.current.scrollLeft = viewRef.current.scrollLeft;
  }, [scrollWidth]);

  // Setting an equal scrollLeft fires no scroll event, so the two never ping-pong.
  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (from && to && to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
  };

  return (
    <>
      <div
        ref={viewRef}
        className={`shelf-table-view${scrollWidth !== null ? " has-hscroll" : ""}`}
        onScroll={() => follow(viewRef.current, barRef.current)}
      >
        {children}
      </div>
      {scrollWidth !== null && (
        <div ref={barRef} className="shelf-table-hscroll" aria-hidden="true" onScroll={() => follow(barRef.current, viewRef.current)}>
          <div style={{ width: scrollWidth, height: 1 }} />
        </div>
      )}
    </>
  );
}

export const ShelfTableRow = memo(function ShelfTableRow({
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
          <span style={{ fontSize: "calc(11px * var(--ui-scale))", color: "var(--muted)" }}>{index + 1}</span>
        )}
      </td>
      <td className="shelf-table-cover-col">
        <div className="shelf-table-thumb-box">
          <Cover entry={entry} provider={provider} />
        </div>
      </td>
      <td>
        <div className="shelf-table-title-cell">
          {/* 手机竖屏没有作者列，作者作为第二行跟在书名下。 */}
          <div className="shelf-table-title-text">
            <span className="shelf-table-title" title={entry.title}>{entry.title}</span>
            <span className="shelf-table-title-author">{entry.creator || t("shelf.unknownAuthor")}</span>
          </div>
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
      <td style={{ color: "var(--muted)", fontSize: "var(--fs-caption)", whiteSpace: "nowrap" }}>
        {formatFileSize(entry.fileSize)}
      </td>
      <td style={{ color: "var(--muted)", fontSize: "var(--fs-caption)", whiteSpace: "nowrap" }}>
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
export const ShelfFolderTableRow = memo(function ShelfFolderTableRow(props: {
  id: string;
  name: string;
  books: ShelfEntry[];
  /** Effective direct child folders; 0 keeps the flat count line. */
  childCount?: number;
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
      <td className="shelf-table-cover-col">
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
          {/* 名称和首本同在一列，卷数相对两行整体垂直居中。 */}
          <div className="shelf-table-folder-text">
            <span className="shelf-table-title" style={{ fontWeight: 700 }} title={props.name}>
              {props.name}
            </span>
            {first && (
              <div className="shelf-table-folder-first" title={first.title}>
                {t("shelfMain.table.folderFirst", { title: first.title })}
              </div>
            )}
          </div>
          <span className="shelf-capsule-count">
            {(props.childCount ?? 0) > 0
              ? t("shelfFolder.card.meta", { books: props.books.length, folders: props.childCount ?? 0 })
              : tn("shelfMain.table.folderCount", props.books.length, { count: props.books.length })}
          </span>
        </div>
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
          <td style={{ color: "var(--muted)", fontSize: "var(--fs-caption)", whiteSpace: "nowrap" }}>
            {formatFileSize(first.fileSize)}
          </td>
          <td style={{ color: "var(--muted)", fontSize: "var(--fs-caption)", whiteSpace: "nowrap" }}>
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
