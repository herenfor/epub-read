import React, { useEffect, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./titleBar.css";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface TitleBarProps {
  view: "shelf" | "reader";
  title?: string;
}

export const TitleBar: React.FC<TitleBarProps> = ({ view, title }) => {
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
      data-tauri-drag-region={view === "shelf" ? "" : undefined}
    >
      <div
        className="titlebar-drag-area"
        data-tauri-drag-region={view === "shelf" ? "" : undefined}
      >
        {view === "shelf" && (
          <span className="titlebar-app-title" data-tauri-drag-region="">
            {title || "EPUB 阅读器"}
          </span>
        )}
      </div>
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
