import React, { useEffect, useRef, useState } from "react";
import type { TocNode } from "../core/types";
import { countTocNodes, findActiveTocNode } from "./TocPanel";
import type { NoteViewModel } from "./NotesPanel";
import { limitNotes } from "./NotesPanel";
import type { Bookmark } from "./shelf";
import { BookmarkIcon, CloseIcon, PinIcon, WarningCircleIcon } from "./readerIcons";
import "./sidebarDrawer.css";

export type SidebarTab = "toc" | "bookmarks" | "notes";
export type SidebarMode = "overlay" | "docked";
export type SidebarSide = "left" | "right";

export interface SidebarDrawerProps {
  open: boolean;
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
  if (!Number.isFinite(timestamp)) return "未知时间";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp));
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

function TocBranch({
  nodes,
  level,
  activeNode,
  activeItemRef,
  onNavigate,
}: {
  nodes: TocNode[];
  level: number;
  activeNode?: TocNode;
  activeItemRef: React.RefObject<HTMLDivElement | null>;
  onNavigate: (href: string) => void;
}) {
  return (
    <div className="sidebar-toc-branch">
      {nodes.map((node, i) => {
        const active = node === activeNode;
        const disabled = node.disabled === true;
        return (
          <div key={`${level}-${i}-${node.label}`}>
            <div
              ref={active ? (activeItemRef as React.Ref<HTMLDivElement>) : undefined}
              className={`sidebar-toc-item level-${Math.min(level, 3)}${active ? " active" : ""}${disabled ? " disabled" : ""}`}
              style={{ paddingLeft: `${14 + level * 16}px` }}
              title={disabled ? `无法使用：${node.href || "无有效链接"}` : node.label}
              onClick={() => {
                if (!disabled) onNavigate(node.href);
              }}
            >
              <span className="sidebar-toc-text">{node.label || "(无标题)"}</span>
              {disabled ? <WarningCircleIcon size={13} className="sidebar-disabled-icon" /> : null}
            </div>
            {node.children.length > 0 ? (
              <TocBranch
                nodes={node.children}
                level={level + 1}
                activeNode={activeNode}
                activeItemRef={activeItemRef}
                onNavigate={onNavigate}
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
  const activeTocNode = findActiveTocNode(toc, activeHref);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [tocFilter, setTocFilter] = useState("");
  const [isClosing, setIsClosing] = useState(false);

  const requestClose = React.useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 250);
  }, [onClose]);

  // 滚动活动目录到视图中央
  useEffect(() => {
    if (open && activeTab === "toc" && activeItemRef.current && !tocFilter) {
      activeItemRef.current.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }, [open, activeTab, activeTocNode, tocFilter]);

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
        className={`sidebar-drawer ${mode === "docked" ? "is-docked" : "is-overlay"} side-${side}${compact ? " is-compact" : ""}${open ? " is-open" : " is-closed"}${isClosing ? " is-closing" : ""}`}
        role="region"
        aria-label="阅读导航与笔记抽屉"
      >
        {/* 抽屉顶栏：Segmented Tabs + Pin + 关闭 */}
        <div className="sidebar-header">
          <div className="sidebar-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "toc"}
              className={`sidebar-tab${activeTab === "toc" ? " active" : ""}`}
              onClick={() => onTabChange("toc")}
            >
              目录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "bookmarks"}
              className={`sidebar-tab${activeTab === "bookmarks" ? " active" : ""}`}
              onClick={() => onTabChange("bookmarks")}
            >
              书签{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "notes"}
              className={`sidebar-tab${activeTab === "notes" ? " active" : ""}`}
              onClick={() => onTabChange("notes")}
            >
              笔记{notes.length > 0 ? ` (${notes.length})` : ""}
            </button>
          </div>

          <div className="sidebar-header-actions">
            {!compact && (
            <button
              type="button"
              className={`sidebar-icon-btn sidebar-pin-btn${mode === "docked" ? " active" : ""}`}
              onClick={() => onModeChange(mode === "docked" ? "overlay" : "docked")}
              title={mode === "docked" ? "取消固定（浮动遮罩模式）" : "固定驻留侧边栏"}
              aria-label={mode === "docked" ? "取消固定" : "固定驻留侧边栏"}
            >
              <PinIcon size={14} pinned={mode === "docked"} />
            </button>
            )}
            <button
              type="button"
              className="sidebar-icon-btn sidebar-close-btn"
              onClick={requestClose}
              title="关闭侧边栏 (Esc)"
              aria-label="关闭侧边栏"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>

        {/* 抽屉内容区 */}
        <div className="sidebar-body">
          {/* TAB 1: 目录 */}
          {activeTab === "toc" && (
            <div className="sidebar-pane sidebar-toc-pane">
              {tocCount > 8 && (
                <div className="sidebar-toc-filter-wrap">
                  <input
                    type="search"
                    className="sidebar-toc-filter-input"
                    placeholder="过滤章节..."
                    value={tocFilter}
                    onChange={(e) => setTocFilter(e.target.value)}
                    aria-label="过滤目录章节"
                  />
                  {tocFilter && (
                    <button
                      type="button"
                      className="sidebar-toc-filter-clear"
                      onClick={() => setTocFilter("")}
                      title="清除过滤"
                      aria-label="清除过滤"
                    >
                      <CloseIcon size={11} />
                    </button>
                  )}
                </div>
              )}
              {tocCount === 0 ? (
                <div className="sidebar-empty">本书暂无目录</div>
              ) : displayedToc.length === 0 ? (
                <div className="sidebar-empty">无匹配章节</div>
              ) : (
                <TocBranch
                  nodes={displayedToc}
                  level={0}
                  activeNode={activeTocNode}
                  activeItemRef={activeItemRef}
                  onNavigate={(href) => {
                    onNavigateToc(href);
                    if (mode === "overlay") requestClose();
                  }}
                />
              )}
            </div>
          )}

          {/* TAB 2: 书签 */}
          {activeTab === "bookmarks" && (
            <div className="sidebar-pane sidebar-bookmarks-pane">
              {bookmarks.length === 0 ? (
                <div className="sidebar-empty">
                  <span>暂无书签</span>
                  <span className="sidebar-empty-tip">按 Ctrl+B 或顶栏 🔖 标记当前页</span>
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
                          <span className="sidebar-bookmark-text">{b.text || "（无书签文字）"}</span>
                          <span className="sidebar-bookmark-chapter">
                            {b.chapterLabel ? `${b.chapterLabel} · ` : ""}
                            添加于 {formatDate(b.createdAtMs)}
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
                          title="删除此书签"
                          aria-label="删除书签"
                        >
                          <CloseIcon size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: 笔记 */}
          {activeTab === "notes" && (
            <div className="sidebar-pane sidebar-notes-pane">
              {sortedNotes.length === 0 ? (
                <div className="sidebar-empty">
                  <span>暂无划线与笔记</span>
                  <span className="sidebar-empty-tip">在正文选中文本即可添加笔记</span>
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
                          “{note.selectedText}”
                        </span>
                      </button>
                      <div className="sidebar-note-actions">
                        {onEditNote && (
                          <button
                            type="button"
                            className="sidebar-note-act"
                            onClick={() => onEditNote(note)}
                          >
                            编辑
                          </button>
                        )}
                        {onDeleteNote &&
                          (deletingNoteId === note.id ? (
                            <>
                              <span className="sidebar-note-confirm">确认删除？</span>
                              <button
                                type="button"
                                className="sidebar-note-act danger"
                                onClick={() => {
                                  onDeleteNote(note);
                                  setDeletingNoteId(null);
                                }}
                              >
                                删除
                              </button>
                              <button
                                type="button"
                                className="sidebar-note-act"
                                onClick={() => setDeletingNoteId(null)}
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="sidebar-note-act danger"
                              onClick={() => setDeletingNoteId(note.id)}
                            >
                              删除
                            </button>
                          ))}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
};
