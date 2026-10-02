import React, { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { PinIcon } from "./readerIcons";
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
  onToggleZenMode?: () => void;
  /** 阅读进度百分比 (0~100) */
  progressPct?: number;
  /** 当前章节序号与总数 */
  chapterIndex?: number;
  totalChapters?: number;
  /** 全屏切换 */
  isFullscreen?: boolean;
  fullscreenBusy?: boolean;
  onToggleFullscreen?: () => void;
  /** AI 助手 / 设置 */
  onToggleAssistant?: () => void;
  assistantOpen?: boolean;
  /** 日志 / 诊断 */
  onToggleLog?: () => void;
  logOpen?: boolean;
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
  onToggleZenMode,
  progressPct,
  chapterIndex,
  totalChapters,
  isFullscreen = false,
  fullscreenBusy = false,
  onToggleFullscreen,
  assistantOpen,
  onToggleAssistant,
  logOpen,
  onToggleLog,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isZenRevealed, setIsZenRevealed] = useState(false);
  const zenHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runtime = getRuntimeCapabilities();
  const desktopChrome = runtime.hasDesktopWindowChrome;
  const desktopTools = runtime.shell !== "mobile";
  const dragRegion = isFullscreen || fullscreenBusy ? "false" : "";

  const dragProps = desktopChrome ? { "data-tauri-drag-region": dragRegion } : {};

  const clearZenTimer = () => {
    if (zenHideTimerRef.current) {
      clearTimeout(zenHideTimerRef.current);
      zenHideTimerRef.current = null;
    }
  };

  // Tauri 窗口最大化状态监听
  useEffect(() => {
    if (!desktopChrome) return;
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
  }, [desktopChrome]);

  // 当有子菜单/抽屉打开时，必须保持顶栏可见，不触发沉浸收起
  const isAnyMenuOpen = Boolean(
    sidebarOpen || appearanceOpen || searchOpen || bookmarksOpen || assistantOpen || logOpen
  );

  // 沉浸模式快捷键（Alt 键呼出/收起）与鼠标顶部感应监听 + 翻页/滚动自动滑隐
  useEffect(() => {
    if (!desktopTools || view !== "reader" || !zenMode) {
      clearZenTimer();
      setIsZenRevealed(false);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        clearZenTimer();
        setIsZenRevealed((prev) => !prev);
        return;
      }
      if (e.key === "Escape" && isZenRevealed && !isAnyMenuOpen) {
        clearZenTimer();
        setIsZenRevealed(false);
        return;
      }
      // 沉浸阅读时：翻页快捷键触发顶栏即时滑隐，保证视野沉浸
      if (
        e.key === "ArrowRight" ||
        e.key === "ArrowLeft" ||
        e.key === "PageDown" ||
        e.key === "PageUp" ||
        e.key === " " ||
        e.key === "[" ||
        e.key === "]"
      ) {
        if (!isAnyMenuOpen) {
          clearZenTimer();
          setIsZenRevealed(false);
        }
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      // 鼠标滑到顶部 0~40px 感应区即刻唤出
      if (e.clientY <= 40) {
        clearZenTimer();
        setIsZenRevealed(true);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      // 下滑阅读时自动收起顶栏（前提：鼠标未在感应区且无子浮层打开）
      if (e.deltaY > 15 && e.clientY > 40 && !isAnyMenuOpen) {
        clearZenTimer();
        setIsZenRevealed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("wheel", handleWheel);
      clearZenTimer();
    };
  }, [desktopTools, view, zenMode, isZenRevealed, isAnyMenuOpen]);

  const handleMouseEnter = () => {
    if (!desktopTools || !zenMode) return;
    clearZenTimer();
    setIsZenRevealed(true);
  };

  const handleMouseLeave = () => {
    if (!desktopTools || !zenMode || isAnyMenuOpen) return;
    clearZenTimer();
    zenHideTimerRef.current = setTimeout(() => {
      setIsZenRevealed(false);
    }, 2000);
  };

  const handleMinimize = useCallback(() => {
    if (!desktopChrome) return;
    try {
      void getCurrentWindow().minimize();
    } catch (e) {
      console.error("Failed to minimize", e);
    }
  }, [desktopChrome]);

  const handleToggleMaximize = useCallback(() => {
    if (!desktopChrome) return;
    if (isFullscreen || fullscreenBusy) return;
    try {
      void getCurrentWindow().toggleMaximize();
    } catch (e) {
      console.error("Failed to toggle maximize", e);
    }
  }, [desktopChrome, isFullscreen, fullscreenBusy]);

  const handleClose = useCallback(() => {
    if (!desktopChrome) return;
    try {
      void getCurrentWindow().close();
    } catch (e) {
      console.error("Failed to close window", e);
    }
  }, [desktopChrome]);

  // 非 Tauri 桌面环境：书架视图在 Web 端有 ShelfView 自身操作栏，静默不渲染
  if (!isTauriEnv() && view === "shelf") {
    return null;
  }

  // 沉浸隐藏判定：处于阅读模式且开启 zenMode，且无子菜单打开，且未主动唤出时隐藏
  const isZenHidden = desktopTools && view === "reader" && zenMode && !isAnyMenuOpen && !isZenRevealed;

  return (
    <>
      {/* 沉浸隐藏时的顶部微感应区（0~40px） */}
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
        className={`titlebar titlebar-${view}${isZenHidden ? " zen-hidden" : ""}${desktopTools && zenMode ? " is-floating" : ""}`}
        {...dragProps}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* 左侧：返回书架 + 书名与章节名 */}
        <div className="titlebar-left" {...dragProps}>
          {view === "reader" && onBackToShelf && (
            <button
              type="button"
              className="titlebar-btn-pill titlebar-back-btn"
              onClick={onBackToShelf}
              title="返回书架 (Esc)"
              aria-label="返回书架"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 12L6 8l4-4" />
              </svg>
              <span>书架</span>
            </button>
          )}

          {/* 目录与侧边栏核心入口 */}
          {view === "reader" && onToggleSidebar && (
            <button
              type="button"
              className={`titlebar-btn-pill titlebar-toc-btn${sidebarOpen ? " active" : ""}`}
              onClick={() => onToggleSidebar("left")}
              title="切换目录与书签侧边栏 (Ctrl+T)"
              aria-label="切换侧边栏"
              aria-expanded={sidebarOpen}
              data-testid="titlebar-toc-btn"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="2" y1="4" x2="14" y2="4" />
                <line x1="2" y1="8" x2="14" y2="8" />
                <line x1="2" y1="12" x2="10" y2="12" />
              </svg>
              <span>目录</span>
            </button>
          )}

          {view === "reader" ? (
            <div className="titlebar-book-meta" {...dragProps}>
              <span
                className="titlebar-app-title titlebar-book-title"
                {...dragProps}
                title={title}
              >
                {title || "EPUB 阅读器"}
              </span>
              {chapterTitle && (
                <>
                  <span className="titlebar-title-sep" {...dragProps}>·</span>
                  <span className="titlebar-chapter-title" {...dragProps} title={chapterTitle}>
                    {chapterTitle}
                  </span>
                </>
              )}
            </div>
          ) : (
            <span className="titlebar-app-title" {...dragProps} title={title}>
              {title || "EPUB 阅读器"}
            </span>
          )}
        </div>

        {/* 中央：拖拽区域 + 沉浸进度指示胶囊 */}
        <div className="titlebar-drag-area titlebar-middle" {...dragProps}>
          {view === "reader" && (progressPct !== undefined || (chapterIndex !== undefined && totalChapters !== undefined && totalChapters > 0)) && (
            <div
              className={`titlebar-progress-pill${onToggleSidebar ? " is-clickable" : ""}`}
              {...dragProps}
              onClick={() => onToggleSidebar?.("left")}
              role={onToggleSidebar ? "button" : undefined}
              title={`阅读进度：${Math.round(progressPct ?? 0)}% (点击切换章节目录)`}
            >
              {chapterIndex !== undefined && totalChapters !== undefined && totalChapters > 0 && (
                <span className="titlebar-chapter-badge" {...dragProps}>
                  第 {chapterIndex + 1}/{totalChapters} 章
                </span>
              )}
              {progressPct !== undefined && (
                <>
                  <div className="titlebar-progress-track" {...dragProps}>
                    <div
                      className="titlebar-progress-fill"
                      style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
                    />
                  </div>
                  <span className="titlebar-progress-text" {...dragProps}>
                    {Math.round(progressPct)}%
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* 右侧：操作区（目录抽屉、Aa 外观、搜索、书签、全屏、AI） + 窗口三联按键 */}
        <div className="titlebar-right">
          {view === "reader" && (
            <div className="titlebar-actions">
              {/* 侧边栏开关（综合目录/书签/笔记抽屉） */}
              {onToggleSidebar && (
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
                  title="查看所有书签 (Ctrl+Shift+B)"
                  aria-label="查看所有书签"
                  aria-expanded={bookmarksOpen === true}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}

              {/* 全屏沉浸模式切换 */}
              {desktopTools && onToggleFullscreen && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-fullscreen-btn${isFullscreen ? " active" : ""}`}
                  onClick={onToggleFullscreen}
                  disabled={fullscreenBusy}
                  title={isFullscreen ? "退出全屏 (F11 / Esc)" : "全屏沉浸阅读 (F11)"}
                  aria-label={isFullscreen ? "退出全屏" : "全屏阅读"}
                >
                  {isFullscreen ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 14h6v6m10-10h-6V4m0 6l7-7M3 21l7-7" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M15 3h6v6m-6 5l6 6M9 21H3v-6m0 0l6-6" />
                    </svg>
                  )}
                </button>
              )}

              {/* 沉浸/锁定常驻切换 */}
              {desktopTools && onToggleZenMode && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-pin-btn${!zenMode ? " active" : ""}`}
                  onClick={onToggleZenMode}
                  title={zenMode ? "顶栏当前为自动隐藏沉浸模式 (点击固定常驻)" : "顶栏当前已固定常驻 (点击开启自动隐藏沉浸模式)"}
                  aria-label={zenMode ? "固定常驻顶栏" : "开启自动隐藏沉浸"}
                  aria-pressed={!zenMode}
                >
                  <PinIcon size={14} pinned={!zenMode} />
                </button>
              )}

              {/* AI 助手 / 设置 */}
              {onToggleAssistant && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-assistant-btn${assistantOpen ? " active" : ""}`}
                  onClick={onToggleAssistant}
                  title="AI 助手"
                  aria-label="AI 助手"
                  aria-expanded={assistantOpen}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                </button>
              )}

              {/* 日志与问题诊断 */}
              {onToggleLog && (
                <button
                  type="button"
                  className={`titlebar-action-btn titlebar-log-btn${logOpen ? " active" : ""}`}
                  onClick={onToggleLog}
                  title="查看问题与诊断日志"
                  aria-label="查看问题与诊断日志"
                  aria-expanded={logOpen}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* 窗口三联按键（仅在 Tauri 桌面原生环境中渲染） */}
          {desktopChrome && (
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
                disabled={isFullscreen || fullscreenBusy}
                title={isFullscreen || fullscreenBusy ? "全屏模式下不可最大化" : (isMaximized ? "向下还原" : "最大化")}
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

/** PC 桌面端 Zen UI 别名导出，确保现代阅读器组件契约一致 */
export const ReaderHeaderBar = TitleBar;
