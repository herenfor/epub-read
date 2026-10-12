import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SIDEBAR_TABS, createSidebarNavigationMemory, installSidebarSwipe, type SidebarNavigationMemory, type SidebarSwipeMotion } from "./sidebarSwipe";
import { useMenuClose } from "./menuMotion";
import type { TocNode } from "../core/types";
import { countTocNodes, defaultExpandedTocKeys, findActiveTocNode, limitNotes, tocAncestorKeys, tocNodeKeys, type NoteViewModel } from "./sidebarModel";
import type { Bookmark } from "./shelf";
import { BookmarkIcon, ChevronRightIcon, CloseIcon, PinIcon, WarningCircleIcon } from "./readerIcons";
import "./sidebarDrawer.css";
import { currentUiLocale, uiText, useUiText } from "./localization/UiLanguageProvider";

export type SidebarTab = "toc" | "bookmarks" | "notes";
export type SidebarMode = "overlay" | "docked";
export type SidebarSide = "left" | "right";

export interface SidebarDrawerProps {
  open: boolean;
  navigationMemory?: SidebarNavigationMemory;
  side?: SidebarSide;
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  onClose: () => void;
  /** 手机窄窗强制浮层，隐藏 pin/dock 入口，避免抽走正文真实宽度。 */
  compact?: boolean;

  // 目录数据
  toc: TocNode[];
  activeHref?: string;
  onNavigateToc: (href: string) => void;

  // 书签数据
  bookmarks: Array<Bookmark & { chapterLabel?: string }>;
  onSelectBookmark: (id: string) => void;
  onDeleteBookmark?: (id: string) => void;

  // 笔记数据
  notes: readonly NoteViewModel[];
  onNavigateNote: (note: NoteViewModel) => void;
  onEditNote?: (note: NoteViewModel) => void;
  onDeleteNote?: (note: NoteViewModel) => void;
}

function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return uiText("sidebar.unknownTime");
  return new Intl.DateTimeFormat(currentUiLocale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp));
}

function filterTocNodes(nodes: TocNode[], query: string): TocNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  const res: TocNode[] = [];
  for (const node of nodes) {
    const selfMatch = (node.label || "").toLowerCase().includes(q);
    const filteredChildren = node.children.length > 0 ? filterTocNodes(node.children, query) : [];
    if (selfMatch || filteredChildren.length > 0) {
      res.push({
        ...node,
        children: filteredChildren,
      });
    }
  }
  return res;
}

interface TocTreeState {
  keys: Map<TocNode, string>;
  /** null: every branch is shown (filtering). */
  expanded: ReadonlySet<string> | null;
  /** Whether any node has children; flat TOCs keep their original layout. */
  nested: boolean;
  toggle(key: string, expand: boolean): void;
}

function TocBranch({
  nodes,
  level,
  activeNode,
  activeItemRef,
  onNavigate,
  tree,
}: {
  nodes: TocNode[];
  level: number;
  activeNode?: TocNode;
  activeItemRef: React.RefObject<HTMLDivElement | null>;
  onNavigate: (href: string) => void;
  tree: TocTreeState;
}) {
  const { t } = useUiText();
  return (
    <div className="sidebar-toc-branch" role={level === 0 ? "tree" : "group"}>
      {nodes.map((node, i) => {
        const active = node === activeNode;
        const disabled = node.disabled === true;
        const key = tree.keys.get(node);
        const parent = node.children.length > 0;
        const open = parent && (tree.expanded === null || (key !== undefined && tree.expanded.has(key)));
        const canToggle = parent && tree.expanded !== null && key !== undefined;
        return (
          <div key={`${level}-${i}-${node.label}`}>
            <div
              ref={active ? (activeItemRef as React.Ref<HTMLDivElement>) : undefined}
              className={`sidebar-toc-item level-${Math.min(level, 3)}${active ? " active" : ""}${disabled ? " disabled" : ""}${tree.nested ? " has-toggle-column" : ""}`}
              style={{ paddingLeft: `${(tree.nested ? 4 : 14) + level * 16}px` }}
              title={disabled ? t("sidebar.toc.unavailable", { href: node.href || t("sidebar.toc.noLink") }) : node.label}
              role="treeitem"
              tabIndex={0}
              aria-current={active ? "location" : undefined}
              aria-expanded={parent ? open : undefined}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (!disabled) onNavigate(node.href);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!disabled) onNavigate(node.href);
                } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.altKey && !event.ctrlKey && !event.metaKey) {
                  // Never let arrows fall through to page turning while the TOC has focus.
                  event.preventDefault();
                  event.stopPropagation();
                  if (canToggle) tree.toggle(key!, event.key === "ArrowRight");
                }
              }}
            >
              {tree.nested ? (
                canToggle ? (
                  <button
                    type="button"
                    className={`sidebar-toc-toggle${open ? " is-open" : ""}`}
                    tabIndex={-1}
                    aria-label={open ? t("sidebar.toc.collapse") : t("sidebar.toc.expand")}
                    onClick={(event) => {
                      event.stopPropagation();
                      tree.toggle(key!, !open);
                    }}
                  >
                    <ChevronRightIcon size={12} />
                  </button>
                ) : (
                  <span className="sidebar-toc-toggle-spacer" aria-hidden="true" />
                )
              ) : null}
              <span className="sidebar-toc-text">{node.label || t("sidebar.toc.untitled")}</span>
              {disabled ? <WarningCircleIcon size={13} className="sidebar-disabled-icon" /> : null}
            </div>
            {open ? (
              <TocBranch
                nodes={node.children}
                level={level + 1}
                activeNode={activeNode}
                activeItemRef={activeItemRef}
                onNavigate={onNavigate}
                tree={tree}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export const SidebarDrawer: React.FC<SidebarDrawerProps> = ({
  open,
  navigationMemory,
  side = "left",
  activeTab,
  onTabChange,
  mode,
  onModeChange,
  onClose,
  compact = false,
  toc,
  activeHref,
  onNavigateToc,
  bookmarks,
  onSelectBookmark,
  onDeleteBookmark,
  notes,
  onNavigateNote,
  onEditNote,
  onDeleteNote,
}) => {
  const { t } = useUiText();
  const activeTocNode = findActiveTocNode(toc, activeHref);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [tocFilter, setTocFilter] = useState(navigationMemory?.tocFilter ?? "");
  const { isClosing, requestClose, cancelClose } = useMenuClose(onClose, open);
  // 浮层模式打开时焦点进入抽屉；停靠模式是阅读的一部分，不抢焦点。
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open && mode === "overlay") drawerRef.current?.focus({ preventScroll: true });
  }, [open, mode]);
  const localMemory = useRef(createSidebarNavigationMemory());
  const memory = navigationMemory ?? localMemory.current;
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<Partial<Record<SidebarTab, HTMLDivElement>>>({});
  const motionRef = useRef<SidebarSwipeMotion>();
  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;
  const visible = open || isClosing;
  const tocKeys = useMemo(() => tocNodeKeys(toc), [toc]);
  const tocNested = useMemo(() => toc.some((node) => node.children.length > 0), [toc]);
  const [tocExpanded, setTocExpanded] = useState<ReadonlySet<string>>(
    () => memory.tocExpanded ?? defaultExpandedTocKeys(toc),
  );
  // Each time the drawer opens or the current chapter changes, reveal the
  // current entry's branch before the scroll-to-active layout effect runs.
  // Adjusting state during render keeps that in the same commit.
  const revealTarget = visible ? activeTocNode ?? null : null;
  const [revealedTarget, setRevealedTarget] = useState<TocNode | null>(null);
  if (revealTarget !== revealedTarget) {
    setRevealedTarget(revealTarget);
    const ancestors = tocAncestorKeys(toc, revealTarget ?? undefined);
    if (ancestors.some((key) => !tocExpanded.has(key))) {
      const next = new Set(tocExpanded);
      for (const key of ancestors) next.add(key);
      memory.tocExpanded = next;
      setTocExpanded(next);
    }
  }
  const toggleTocBranch = (key: string, expand: boolean): void => {
    setTocExpanded((previous) => {
      if (previous.has(key) === expand) return previous;
      const next = new Set(previous);
      if (expand) next.add(key);
      else next.delete(key);
      memory.tocExpanded = next;
      return next;
    });
  };

  useLayoutEffect(() => {
    if (!visible) return;
    for (const tab of SIDEBAR_TABS) {
      const pane = paneRefs.current[tab];
      if (!pane) continue;
      if (memory.scrollTop[tab] !== undefined) pane.scrollTop = memory.scrollTop[tab]!;
      else if (tab === "toc" && activeItemRef.current) {
        const item = activeItemRef.current;
        const rect = pane.getBoundingClientRect();
        const scaleY = rect.height / pane.clientHeight;
        pane.scrollTop = (item.getBoundingClientRect().top - rect.top) / scaleY + pane.scrollTop
          - (pane.clientHeight - item.clientHeight) / 2;
      }
      memory.scrollTop[tab] = pane.scrollTop;
    }
    const binding = installSidebarSwipe(viewportRef.current!, trackRef.current!, SIDEBAR_TABS.indexOf(activeTab),
      index => onTabChangeRef.current(SIDEBAR_TABS[index]));
    motionRef.current = binding.motion;
    return () => { binding.dispose(); motionRef.current = undefined; };
  }, [visible, memory]);

  useLayoutEffect(() => {
    motionRef.current?.select(SIDEBAR_TABS.indexOf(activeTab), false, false);
  }, [activeTab]);

  const selectTab = (tab: SidebarTab) => {
    cancelClose();
    if (motionRef.current) motionRef.current.select(SIDEBAR_TABS.indexOf(tab), true);
    else onTabChange(tab);
  };

  const paneProps = (tab: SidebarTab) => ({
    ref: (pane: HTMLDivElement | null) => { if (pane) paneRefs.current[tab] = pane; },
    role: "tabpanel",
    "aria-label": tab === "toc" ? t("sidebar.tab.toc") : tab === "bookmarks" ? t("sidebar.tab.bookmarks") : t("sidebar.tab.notes"),
    "aria-hidden": activeTab !== tab,
    // React 18 does not type inert; the native attribute also removes hidden controls from tab order.
    ...(activeTab !== tab ? { inert: "" } : {}),
    onScroll: (event: React.UIEvent<HTMLDivElement>) => { memory.scrollTop[tab] = event.currentTarget.scrollTop; },
  });

  if (!open && mode === "overlay" && !isClosing) {
    return null;
  }

  const tocCount = countTocNodes(toc);
  const displayedToc = tocFilter.trim() ? filterTocNodes(toc, tocFilter.trim()) : toc;
  const sortedNotes = limitNotes(notes, 200).items;

  return (
    <>
      {/* 浮动微浮岛遮罩模式下渲染背景半透明蒙层 */}
      {open && mode === "overlay" && (
        <div
          className={`sidebar-backdrop${isClosing ? " is-closing" : ""}`}
          onClick={requestClose}
          aria-hidden="true"
        />
      )}

      <aside
        ref={drawerRef}
        tabIndex={-1}
        className={`sidebar-drawer ${mode === "docked" ? "is-docked" : "is-overlay"} side-${side}${compact ? " is-compact" : ""}${open ? " is-open" : " is-closed"}${isClosing ? " is-closing" : ""}`}
        role="region"
        aria-label={t("sidebar.drawer")}
      >
        {/* 抽屉顶栏：Segmented Tabs + Pin + 关闭 */}
        <div className="sidebar-header">
          <div className="sidebar-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "toc"}
              className={`sidebar-tab${activeTab === "toc" ? " active" : ""}`}
              onClick={() => selectTab("toc")}
            >
              {t("sidebar.tab.toc")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "bookmarks"}
              className={`sidebar-tab${activeTab === "bookmarks" ? " active" : ""}`}
              onClick={() => selectTab("bookmarks")}
            >
              {bookmarks.length > 0 ? t("sidebar.tab.count", { label: t("sidebar.tab.bookmarks"), count: bookmarks.length }) : t("sidebar.tab.bookmarks")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "notes"}
              className={`sidebar-tab${activeTab === "notes" ? " active" : ""}`}
              onClick={() => selectTab("notes")}
            >
              {notes.length > 0 ? t("sidebar.tab.count", { label: t("sidebar.tab.notes"), count: notes.length }) : t("sidebar.tab.notes")}
            </button>
          </div>

          <div className="sidebar-header-actions">
            {!compact && (
            <button
              type="button"
              className={`sidebar-icon-btn sidebar-pin-btn${mode === "docked" ? " active" : ""}`}
              onClick={() => onModeChange(mode === "docked" ? "overlay" : "docked")}
              title={mode === "docked" ? t("sidebar.unpin.tip") : t("sidebar.pin")}
              aria-label={mode === "docked" ? t("sidebar.unpin") : t("sidebar.pin")}
            >
              <PinIcon size={14} pinned={mode === "docked"} />
            </button>
            )}
            <button
              type="button"
              className="sidebar-icon-btn sidebar-close-btn"
              onClick={requestClose}
              title={t("sidebar.close.tip")}
              aria-label={t("sidebar.close")}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>

        {/* 抽屉内容区 */}
        <div className="sidebar-body" ref={viewportRef}>
          <div className="sidebar-track" ref={trackRef}>
          {/* TAB 1: 目录 */}
            <div className="sidebar-pane sidebar-toc-pane" {...paneProps("toc")}>
              {tocCount > 8 && (
                <div className="sidebar-toc-filter-wrap">
                  <input
                    type="search"
                    className="sidebar-toc-filter-input"
                    placeholder={t("sidebar.toc.filter")}
                    value={tocFilter}
                    onChange={(e) => { memory.tocFilter = e.target.value; setTocFilter(e.target.value); }}
                    aria-label={t("sidebar.toc.filter.label")}
                  />
                  {tocFilter && (
                    <button
                      type="button"
                      className="sidebar-toc-filter-clear"
                      onClick={() => { memory.tocFilter = ""; setTocFilter(""); }}
                      title={t("sidebar.toc.filter.clear")}
                      aria-label={t("sidebar.toc.filter.clear")}
                    >
                      <CloseIcon size={11} />
                    </button>
                  )}
                </div>
              )}
              {tocCount === 0 ? (
                <div className="sidebar-empty">{t("sidebar.toc.empty")}</div>
              ) : displayedToc.length === 0 ? (
                <div className="sidebar-empty">{t("sidebar.toc.noMatch")}</div>
              ) : (
                <TocBranch
                  nodes={displayedToc}
                  level={0}
                  activeNode={activeTocNode}
                  activeItemRef={activeItemRef}
                  tree={{
                    keys: tocKeys,
                    // Filtered results are already pruned to matches and their ancestors.
                    expanded: tocFilter.trim() ? null : tocExpanded,
                    nested: tocNested,
                    toggle: toggleTocBranch,
                  }}
                  onNavigate={(href) => {
                    onNavigateToc(href);
                    if (mode === "overlay") requestClose();
                  }}
                />
              )}
            </div>


          {/* TAB 2: 书签 */}
            <div className="sidebar-pane sidebar-bookmarks-pane" {...paneProps("bookmarks")}>
              {bookmarks.length === 0 ? (
                <div className="sidebar-empty">
                  <span>{t("sidebar.bookmarks.empty")}</span>
                  <span className="sidebar-empty-tip">{t("sidebar.bookmarks.emptyTip")}</span>
                </div>
              ) : (
                <div className="sidebar-bookmark-list">
                  {bookmarks.map((b) => (
                    <div key={b.id} className="sidebar-bookmark-row">
                      <button
                        type="button"
                        className="sidebar-bookmark-card"
                        onClick={() => {
                          onSelectBookmark(b.id);
                          if (mode === "overlay") requestClose();
                        }}
                        title={b.text}
                      >
                        <span className="sidebar-bookmark-icon">
                          <BookmarkIcon size={14} active={true} />
                        </span>
                        <span className="sidebar-bookmark-meta">
                          <span className="sidebar-bookmark-text">{b.text || t("sidebar.bookmark.noText")}</span>
                          <span className="sidebar-bookmark-chapter">
                            {b.chapterLabel ? `${b.chapterLabel} · ` : ""}
                            {t("sidebar.bookmark.addedAt", { time: formatDate(b.createdAtMs) })}
                          </span>
                        </span>
                      </button>
                      {onDeleteBookmark && (
                        <button
                          type="button"
                          className="sidebar-bookmark-del-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteBookmark(b.id);
                          }}
                          title={t("sidebar.bookmark.delete.tip")}
                          aria-label={t("sidebar.bookmark.delete")}
                        >
                          <CloseIcon size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>


          {/* TAB 3: 笔记 */}
            <div className="sidebar-pane sidebar-notes-pane" {...paneProps("notes")}>
              {sortedNotes.length === 0 ? (
                <div className="sidebar-empty">
                  <span>{t("sidebar.notes.empty")}</span>
                  <span className="sidebar-empty-tip">{t("sidebar.notes.emptyTip")}</span>
                </div>
              ) : (
                <div className="sidebar-notes-list">
                  {sortedNotes.map((note) => (
                    <article className="sidebar-note-card" key={note.id}>
                      <button
                        type="button"
                        className="sidebar-note-main"
                        onClick={() => {
                          onNavigateNote(note);
                          if (mode === "overlay") requestClose();
                        }}
                      >
                        <span className="sidebar-note-content">{note.content}</span>
                        <span className="sidebar-note-meta">
                          {note.chapterTitle} · {formatDate(note.createdAtMs)}
                        </span>
                        <span className="sidebar-note-selection" title={note.selectedText}>
                          {t("sidebar.note.quote", { text: note.selectedText })}
                        </span>
                      </button>
                      <div className="sidebar-note-actions">
                        {onEditNote && (
                          <button
                            type="button"
                            className="sidebar-note-act"
                            onClick={() => onEditNote(note)}
                          >
                            {t("sidebar.note.edit")}
                          </button>
                        )}
                        {onDeleteNote &&
                          (deletingNoteId === note.id ? (
                            <>
                              <span className="sidebar-note-confirm">{t("sidebar.note.confirmDelete")}</span>
                              <button
                                type="button"
                                className="sidebar-note-act danger"
                                onClick={() => {
                                  onDeleteNote(note);
                                  setDeletingNoteId(null);
                                }}
                              >
                                {t("sidebar.note.delete")}
                              </button>
                              <button
                                type="button"
                                className="sidebar-note-act"
                                onClick={() => setDeletingNoteId(null)}
                              >
                                {t("sidebar.note.cancel")}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="sidebar-note-act danger"
                              onClick={() => setDeletingNoteId(note.id)}
                            >
                              {t("sidebar.note.delete")}
                            </button>
                          ))}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};
