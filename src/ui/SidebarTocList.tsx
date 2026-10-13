import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRightIcon, WarningCircleIcon } from "./readerIcons";
import { useUiText } from "./localization/UiLanguageProvider";
import type { SidebarNavigationMemory } from "./sidebarSwipe";
import { tocOffsets, tocWindow, type TocRow } from "./sidebarToc";

const WINDOW_THRESHOLD = 80;

/**
 * Only this list updates its window. Scrolling never rebuilds the TOC or the drawer.
 * While not `live` (drawer closed or only prepared) it keeps its rows but does
 * not scroll, center, measure or write the remembered position.
 */
export function SidebarTocList({ rows, activeKey, nested, filtering, memory, live = true, onToggle, onNavigate }: {
  rows: readonly TocRow[];
  activeKey?: string;
  nested: boolean;
  filtering: boolean;
  memory: SidebarNavigationMemory;
  live?: boolean;
  onToggle(key: string, expand: boolean): void;
  onNavigate(href: string): void;
}) {
  const { t } = useUiText();
  const root = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState(() => [...(memory.tocRowHeights ?? [32, 32, 32, 32])]);
  const offsets = useMemo(() => tocOffsets(rows, heights), [rows, heights]);
  const rowByKey = useMemo(() => new Map(rows.map((row, i) => [row.entry.key, i])), [rows]);
  const virtual = rows.length > WINDOW_THRESHOLD;
  const [range, setRange] = useState(() => tocWindow(offsets, memory.scrollTop.toc ?? Math.max(0, offsets[rowByKey.get(activeKey ?? "") ?? 0] - 250), 600));
  const rendered = virtual ? (range.start < rows.length ? range : tocWindow(offsets, 0, 600)) : { start: 0, end: rows.length };
  const current = useRef({ offsets, rendered, virtual, rowByKey });
  current.current = { offsets, rendered, virtual, rowByKey };
  const previousOffsets = useRef(offsets);
  const centerOnFirstOpen = useRef(memory.scrollTop.toc === undefined);
  const focusedKey = useRef<string>();
  const pendingFocus = useRef<string>();

  const syncWindow = (force = false) => {
    const list = root.current, pane = list?.closest<HTMLDivElement>(".sidebar-toc-pane");
    if (!list || !pane || !current.current.virtual) return;
    const top = Math.max(0, pane.scrollTop - list.offsetTop);
    const visible = tocWindow(current.current.offsets, top, pane.clientHeight, 0);
    const old = current.current.rendered;
    // Keep a buffer so most native scroll frames do no React work at all.
    if (!force && (old.start === 0 || visible.start >= old.start + 3) &&
        (old.end === current.current.offsets.length - 1 || visible.end <= old.end - 3)) return;
    const next = tocWindow(current.current.offsets, top, pane.clientHeight);
    const focused = document.activeElement?.closest<HTMLElement>("[data-toc-key]");
    const at = focused && list.contains(focused) ? current.current.rowByKey.get(focused.dataset.tocKey!) : undefined;
    if (at !== undefined && (at < next.start || at >= next.end)) list.focus({ preventScroll: true });
    if (next.start !== old.start || next.end !== old.end) setRange(next);
  };
  const syncRef = useRef(syncWindow);
  syncRef.current = syncWindow;

  useLayoutEffect(() => {
    if (!live) return;
    const list = root.current!, pane = list.closest<HTMLDivElement>(".sidebar-toc-pane")!;
    const active = current.current.rowByKey.get(activeKey ?? "");
    pane.scrollTop = memory.scrollTop.toc ?? (active === undefined ? 0 : Math.max(0,
      list.offsetTop + current.current.offsets[active] - (pane.clientHeight - heights[Math.min(rows[active].entry.level, 3)]) / 2));
    memory.scrollTop.toc = pane.scrollTop;
    syncRef.current(true);
    let frame = 0;
    const scroll = () => {
      memory.scrollTop.toc = pane.scrollTop;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; syncRef.current(); });
    };
    const observer = new ResizeObserver(() => syncRef.current(true));
    observer.observe(pane);
    pane.addEventListener("scroll", scroll, { passive: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); pane.removeEventListener("scroll", scroll); };
  }, [memory, live]);

  useLayoutEffect(() => {
    if (!live) return;
    const list = root.current!, pane = list.closest<HTMLDivElement>(".sidebar-toc-pane")!;
    const old = previousOffsets.current;
    // A newly measured height must not move the visible row under the user's finger.
    if (centerOnFirstOpen.current) {
      const active = rowByKey.get(activeKey ?? "");
      if (active !== undefined) pane.scrollTop = Math.max(0, list.offsetTop + offsets[active]
        - (pane.clientHeight - (offsets[active + 1] - offsets[active])) / 2);
      memory.scrollTop.toc = pane.scrollTop;
    } else if (old !== offsets && old.length === offsets.length && pane.scrollTop > list.offsetTop) {
      const top = pane.scrollTop - list.offsetTop;
      const first = tocWindow(old, top, 0, 0).start;
      pane.scrollTop += offsets[first] - old[first];
      memory.scrollTop.toc = pane.scrollTop;
    }
    previousOffsets.current = offsets;
    syncRef.current(true);
    const pending = pendingFocus.current;
    if (pending) {
      const target = list.querySelector<HTMLElement>(`[data-toc-key="${pending}"]`);
      if (target) { pendingFocus.current = undefined; target.focus({ preventScroll: true }); }
    }
    // Rows are single-line. Measure a representative for each existing CSS depth,
    // retaining fractional CSS pixels and avoiding zoom-scaled screen coordinates.
    const measure = () => {
      const next = [...heights], seen = new Set<number>();
      for (const element of list.querySelectorAll<HTMLElement>("[data-toc-level]")) {
        const level = Number(element.dataset.tocLevel);
        if (seen.has(level)) continue;
        seen.add(level);
        const css = getComputedStyle(element);
        next[level] = parseFloat(css.height) + (css.boxSizing === "border-box" ? 0 :
          parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth));
      }
      if (next.some((height, i) => Math.abs(height - heights[i]) > 0.05)) {
        memory.tocRowHeights = next;
        setHeights(next);
      } else centerOnFirstOpen.current = false;
    };
    measure();
    const observer = new ResizeObserver(measure);
    const observed = new Set<string>();
    for (const row of list.querySelectorAll<HTMLElement>("[data-toc-level]")) {
      if (!observed.has(row.dataset.tocLevel!)) { observed.add(row.dataset.tocLevel!); observer.observe(row); }
    }
    return () => observer.disconnect();
  }, [offsets, rendered.start, rendered.end, heights, memory, live]);

  const focusRow = (at: number) => {
    const list = root.current!, pane = list.closest<HTMLDivElement>(".sidebar-toc-pane")!;
    const key = rows[at].entry.key;
    focusedKey.current = key;
    pendingFocus.current = key;
    const top = list.offsetTop + offsets[at], bottom = list.offsetTop + offsets[at + 1];
    if (top < pane.scrollTop) pane.scrollTop = top;
    else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight;
    memory.scrollTop.toc = pane.scrollTop;
    const mounted = list.querySelector<HTMLElement>(`[data-toc-key="${key}"]`);
    if (mounted) { pendingFocus.current = undefined; mounted.focus({ preventScroll: true }); }
    else syncRef.current(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = rowByKey.get(focusedKey.current ?? activeKey ?? "") ?? 0;
    const row = rows[at];
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
      event.preventDefault(); event.stopPropagation();
      focusRow(event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); event.stopPropagation();
      if (row.parent && !filtering) onToggle(row.entry.key, event.key === "ArrowRight");
    } else if (event.key === "Enter" || event.key === " ") {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault(); event.stopPropagation();
      if (!row.entry.node.disabled) onNavigate(row.entry.node.href);
    } else if (event.key === "Tab" && event.target !== root.current) {
      const next = at + (event.shiftKey ? -1 : 1);
      if (next >= 0 && next < rows.length && (next < rendered.start || next >= rendered.end)) {
        event.preventDefault(); focusRow(next);
      }
    }
  };

  return <div className="sidebar-toc-branch" role="tree" ref={root} tabIndex={-1} onKeyDown={onKeyDown}
    onFocusCapture={event => { const key = (event.target as HTMLElement).closest<HTMLElement>("[data-toc-key]")?.dataset.tocKey; if (key) focusedKey.current = key; }}>
    {virtual && <div aria-hidden="true" style={{ height: offsets[rendered.start] }} />}
    {rows.slice(rendered.start, rendered.end).map(row => {
      const { entry, parent, open, position, siblings } = row, { node, key, level } = entry;
      const active = key === activeKey, canToggle = parent && !filtering;
      return <div key={key} data-toc-key={key} data-toc-level={Math.min(level, 3)}
        className={`sidebar-toc-item level-${Math.min(level, 3)}${active ? " active" : ""}${node.disabled ? " disabled" : ""}${nested ? " has-toggle-column" : ""}`}
        style={{ paddingLeft: (nested ? 4 : 14) + level * 16 }}
        title={node.disabled ? t("sidebar.toc.unavailable", { href: node.href || t("sidebar.toc.noLink") }) : node.label}
        role="treeitem" tabIndex={0} aria-level={level + 1} aria-posinset={position} aria-setsize={siblings}
        aria-current={active ? "location" : undefined} aria-expanded={parent ? open : undefined} aria-disabled={node.disabled || undefined}
        onClick={() => { if (!node.disabled) onNavigate(node.href); }}>
        {nested && (canToggle ? <button type="button" className={`sidebar-toc-toggle${open ? " is-open" : ""}`} tabIndex={-1}
          aria-label={open ? t("sidebar.toc.collapse") : t("sidebar.toc.expand")}
          onClick={event => { event.stopPropagation(); onToggle(key, !open); }}><ChevronRightIcon size={12} /></button> :
          <span className="sidebar-toc-toggle-spacer" aria-hidden="true" />)}
        <span className="sidebar-toc-text">{node.label || t("sidebar.toc.untitled")}</span>
        {node.disabled && <WarningCircleIcon size={13} className="sidebar-disabled-icon" />}
      </div>;
    })}
    {virtual && <div aria-hidden="true" style={{ height: offsets[offsets.length - 1] - offsets[Math.min(rendered.end, rows.length)] }} />}
  </div>;
}
