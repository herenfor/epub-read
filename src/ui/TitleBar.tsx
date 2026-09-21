import React, { useEffect, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./titleBar.css";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface TitleBarProps {
  view: "shelf" | "reader";
  title?: string;
  onBackToShelf?: () => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onOpenBookmarks?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  view,
  title,
  onBackToShelf,
  isBookmarked,
  onToggleBookmark,
  onOpenBookmarks,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);

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

  // 非 Tauri 桌面环境（如纯 Web 预览）完全不渲染顶栏
  if (!isTauriEnv()) {
    return null;
  }

  return (
    <header
      className={`titlebar titlebar-${view}`}
      data-tauri-drag-region=""
    >
      <div className="titlebar-drag-area" data-tauri-drag-region="">
        {view === "reader" && onBackToShelf && (
          <button
            type="button"
            className="titlebar-back-btn"
            onClick={onBackToShelf}
            title="返回书架"
            aria-label="返回书架"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 12L6 8l4-4" />
            </svg>
            <span>书架</span>
          </button>
        )}
        <span
          className={`titlebar-app-title${view === "reader" ? " titlebar-book-title" : ""}`}
          data-tauri-drag-region=""
          title={title}
        >
          {title || "EPUB 阅读器"}
        </span>
      </div>
      {view === "reader" && onToggleBookmark && (
        <div className="titlebar-actions">
          <button
            type="button"
            className={`titlebar-action-btn titlebar-bookmark-btn${isBookmarked ? " active" : ""}`}
            onClick={onToggleBookmark}
            title={isBookmarked ? "移除当前页书签" : "添加当前页书签"}
            aria-label={isBookmarked ? "移除当前页书签" : "添加当前页书签"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isBookmarked ? "#f43f5e" : "none"} stroke={isBookmarked ? "#f43f5e" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {onOpenBookmarks && (
            <button
              type="button"
              className="titlebar-action-btn titlebar-bookmark-list-btn"
              onClick={onOpenBookmarks}
              title="查看所有书签"
              aria-label="查看所有书签"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          )}
        </div>
      )}
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
    </header>
  );
};
