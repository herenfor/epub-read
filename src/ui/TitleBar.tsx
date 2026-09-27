import React, { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./titleBar.css";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface TitleBarProps {
  view: "shelf" | "reader";
  title?: string;
  chapterTitle?: string;
  onBackToShelf?: () => void;
  /** 侧边栏开关（综合目录/书签/笔记抽屉） */
  onToggleSidebar?: (side?: "left" | "right") => void;
  sidebarOpen?: boolean;
  /** 外观与排版弹层开关（Aa） */
  onToggleAppearance?: () => void;
  appearanceOpen?: boolean;
  /** 正文搜索开关（🔍） */
  onOpenSearch?: () => void;
  searchOpen?: boolean;
  /** 书签：切换当前页书签 */
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  /** 书签浮层是否已展开 */
  bookmarksOpen?: boolean;
  /** 收到实际点击的按钮，供 App 决定浮层定位 */
  onOpenBookmarks?: (button: HTMLButtonElement) => void;
  /** 沉浸模式 / 自动隐藏开关 */
  zenMode?: boolean;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  view,
  title,
  chapterTitle,
  onBackToShelf,
  onToggleSidebar,
  sidebarOpen,
  onToggleAppearance,
  appearanceOpen,
  onOpenSearch,
  searchOpen,
  isBookmarked,
  onToggleBookmark,
  bookmarksOpen,
  onOpenBookmarks,
  zenMode = false,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isZenRevealed, setIsZenRevealed] = useState(false);
  const zenHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearZenTimer = () => {
    if (zenHideTimerRef.current) {
      clearTimeout(zenHideTimerRef.current);
      zenHideTimerRef.current = null;
    }
  };

  // Tauri 窗口最大化状态监听
  useEffect(() => {
    if (!isTauriEnv()) return;
    try {
      const win = getCurrentWindow();
      void win.isMaximized().then(setIsMaximized).catch(() => {});
      const unlistenPromise = win.onResized(async () => {
        try {
          setIsMaximized(await win.isMaximized());
        } catch {}
      });
      return () => {
        void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      };
    } catch {}
  }, []);

  // 沉浸模式快捷键（Alt 键呼出/收起）与鼠标顶部感应监听
  useEffect(() => {
    if (view !== "reader" || !zenMode) {
      clearZenTimer();
      setIsZenRevealed(false);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        clearZenTimer();
        setIsZenRevealed((prev) => !prev);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      // 鼠标滑到顶部 0~10px 感应区
      if (e.clientY <= 10) {
        clearZenTimer();
        setIsZenRevealed(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousemove", handleMouseMove);
      clearZenTimer();
    };
  }, [view, zenMode]);

  // 当有子菜单/抽屉打开时，必须保持顶栏可见，不触发沉浸收起
  const isAnyMenuOpen = Boolean(sidebarOpen || appearanceOpen || searchOpen || bookmarksOpen);

  const handleMouseEnter = () => {
    if (!zenMode) return;
    clearZenTimer();
    setIsZenRevealed(true);
  };

  const handleMouseLeave = () => {
    if (!zenMode || isAnyMenuOpen) return;
    clearZenTimer();
    zenHideTimerRef.current = setTimeout(() => {
      setIsZenRevealed(false);
    }, 1500);
  };

  const handleMinimize = useCallback(() => {
    if (!isTauriEnv()) return;
    try {
      void getCurrentWindow().minimize();
    } catch (e) {
      console.error("Failed to minimize", e);
    }
  }, []);

  const handleToggleMaximize = useCallback(() => {
    if (!isTauriEnv()) return;
    try {
      void getCurrentWindow().toggleMaximize();
    } catch (e) {
      console.error("Failed to toggle maximize", e);
    }
  }, []);

  const handleClose = useCallback(() => {
    if (!isTauriEnv()) return;
    try {
      void getCurrentWindow().close();
    } catch (e) {
      console.error("Failed to close window", e);
    }
  }, []);

  // 非 Tauri 桌面环境：书架视图在 Web 端有 ShelfView 自身操作栏，静默不渲染
  if (!isTauriEnv() && view === "shelf") {
    return null;
  }

  // 沉浸隐藏判定：处于阅读模式且开启 zenMode，且无子菜单打开，且未主动唤出时隐藏
  const isZenHidden = view === "reader" && zenMode && !isAnyMenuOpen && !isZenRevealed;

  return (
    <>
      {/* 沉浸隐藏时的顶部微感应区（0~10px） */}
      {isZenHidden && (
        <div
          className="titlebar-zen-sensor"
          onMouseEnter={() => {
            clearZenTimer();
            setIsZenRevealed(true);
          }}
          aria-hidden="true"
        />
      )}
      <header
        className={`titlebar titlebar-${view}${isZenHidden ? " zen-hidden" : ""}`}
        data-tauri-drag-region=""
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* 左侧：返回书架 + 侧边栏开关 */}
        <div className="titlebar-left">
          {view === "reader" && onBackToShelf && (
            <button
              type="button"
              className="titlebar-btn-pill titlebar-back-btn"
              onClick={onBackToShelf}
              title="返回书架"
              aria-label="返回书架"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 12L6 8l4-4" />
              </svg>
              <span>书架</span>
            </button>
          )}

          {view === "reader" && onToggleSidebar && (
            <button
              type="button"
              className={`titlebar-action-btn titlebar-sidebar-btn${sidebarOpen ? " active" : ""}`}
              onClick={() => onToggleSidebar?.("left")}
              title="切换侧边栏目录与书签 (Ctrl+T)"
              aria-label="切换侧边栏"
              aria-expanded={sidebarOpen}
            >
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="14" height="14" rx="2" />
                <line x1="8" y1="3" x2="8" y2="17" />
              </svg>
            </button>
          )}
        </div>

        {/* 中央：拖拽区域 + 书名 · 章节名 */}
        <div className="titlebar-drag-area" data-tauri-drag-region="">
          <span
            className={`titlebar-app-title${view === "reader" ? " titlebar-book-title" : ""}`}
            data-tauri-drag-region=""
            title={title}
          >
            {title || "EPUB 阅读器"}
          </span>
          {view === "reader" && chapterTitle && (
            <>
              <span className="titlebar-title-sep" data-tauri-drag-region="">·</span>
              <span className="titlebar-chapter-title" data-tauri-drag-region="" title={chapterTitle}>
                {chapterTitle}
              </span>
            </>
          )}
        </div>

        {/* 右侧：操作区（Aa 外观、搜索、书签） + 系统控制按键 */}
        <div className="titlebar-right">
          {view === "reader" && (
            <div className="titlebar-actions">
              {/* Aa 外观设置 */}
              {onToggleAppearance && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-appearance-btn${appearanceOpen ? " active" : ""}`}
                  onClick={onToggleAppearance}
                  title="外观与排版设置"
                  aria-label="外观与排版设置"
                  aria-expanded={appearanceOpen}
                >
                  <span className="titlebar-aa-text">Aa</span>
                </button>
              )}

              {/* 正文搜索 */}
              {onOpenSearch && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-search-btn${searchOpen ? " active" : ""}`}
                  onClick={onOpenSearch}
                  title="搜索正文 (Ctrl+F)"
                  aria-label="搜索正文"
                  aria-expanded={searchOpen}
                >
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="9" cy="9" r="5.5" />
                    <path d="M13.2 13.2L17.5 17.5" />
                  </svg>
                </button>
              )}

              {/* 当前页书签切换 */}
              {onToggleBookmark && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-bookmark-btn${isBookmarked ? " active" : ""}`}
                  onClick={onToggleBookmark}
                  title={isBookmarked ? "移除当前页书签 (Ctrl+B)" : "添加当前页书签 (Ctrl+B)"}
                  aria-label={isBookmarked ? "移除当前页书签" : "添加当前页书签"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={isBookmarked ? "#f43f5e" : "none"} stroke={isBookmarked ? "#f43f5e" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              )}

              {/* 书签列表下拉浮层 */}
              {onOpenBookmarks && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-bookmark-list-btn${bookmarksOpen ? " active" : ""}`}
                  onClick={(event) => onOpenBookmarks(event.currentTarget)}
                  title="查看所有书签"
                  aria-label="查看所有书签"
                  aria-expanded={bookmarksOpen === true}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* 窗口三联按键（仅在 Tauri 桌面原生环境中渲染） */}
          {isTauriEnv() && (
            <nav className="titlebar-controls" aria-label="窗口控制">
              <button
                type="button"
                className="titlebar-btn titlebar-minimize"
                onClick={handleMinimize}
                title="最小化"
                aria-label="最小化"
              >
                <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
                  <rect width="10" height="1" />
                </svg>
              </button>
              <button
                type="button"
                className="titlebar-btn titlebar-maximize"
                onClick={handleToggleMaximize}
                title={isMaximized ? "向下还原" : "最大化"}
                aria-label={isMaximized ? "向下还原" : "最大化"}
              >
                {isMaximized ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                    <path d="M2.5 7.5H1.5V1.5H7.5V2.5" strokeWidth="1" />
                    <rect x="2.5" y="2.5" width="6" height="6" strokeWidth="1" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                    <rect x="0.5" y="0.5" width="9" height="9" strokeWidth="1" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="titlebar-btn titlebar-close"
                onClick={handleClose}
                title="关闭"
                aria-label="关闭"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                  <path d="M1 1L9 9M9 1L1 9" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </nav>
          )}
        </div>
      </header>
    </>
  );
};
