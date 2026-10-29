import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleBar } from "./TitleBar";
import { clearAppBuildSession, setAppBuildSession } from "../config/appBuildSession";

beforeEach(() => {
  setAppBuildSession({
    source: "desktop",
    buildInfo: { version: "0.2.7", edition: "core", protocolVersion: 1, target: "x86_64-pc-windows-msvc", profile: "debug", debug: true },
  });
});

afterEach(() => clearAppBuildSession());

describe("CSD TitleBar 组件与样式契约（Zen UI Packet A）", () => {
  it("非 Tauri 桌面环境书架视图静默不渲染", () => {
    vi.stubGlobal("window", {});
    try {
      const html = renderToStaticMarkup(createElement(TitleBar, { view: "shelf" }));
      expect(html).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Tauri 桌面环境正确渲染结构、拖拽区域与三联控制按键", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const htmlShelf = renderToStaticMarkup(createElement(TitleBar, { view: "shelf", title: "我的书架" }));
      expect(htmlShelf).toContain("titlebar-shelf");
      expect(htmlShelf).toContain("我的书架");
      expect(htmlShelf).toContain("titlebar-minimize");
      expect(htmlShelf).toContain("titlebar-maximize");
      expect(htmlShelf).toContain("titlebar-close");
      expect(htmlShelf).toContain("data-tauri-drag-region");

      const htmlReader = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        title: "Moby-Dick",
        chapterTitle: "Chapter 1",
        onBackToShelf: () => {},
        onToggleBookmark: () => {},
        onToggleSidebar: () => {},
        onToggleAppearance: () => {},
        onOpenSearch: () => {},
      }));
      expect(htmlReader).toContain("titlebar-reader");
      expect(htmlReader).toContain("titlebar-controls");
      expect(htmlReader).toContain("titlebar-close");
      expect(htmlReader).toContain("Moby-Dick");
      expect(htmlReader).toContain("Chapter 1");
      expect(htmlReader).toContain("titlebar-back-btn");
      // One entry to the sidebar: the "目录" button on the left.
      expect(htmlReader).toContain("titlebar-toc-btn");
      expect(htmlReader).not.toContain("titlebar-sidebar-btn");
      expect(htmlReader).toContain("titlebar-appearance-btn");
      expect(htmlReader).toContain("titlebar-search-btn");
      expect(htmlReader).toContain("titlebar-bookmark-btn");
      expect(htmlReader).toContain("data-tauri-drag-region");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Android mobile shell 隐藏桌面窗口控制与拖拽区", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    setAppBuildSession({
      source: "desktop",
      buildInfo: {
        version: "0.2.7",
        edition: "core",
        protocolVersion: 1,
        target: "aarch64-linux-android",
        profile: "debug",
        debug: true,
      },
    });
    try {
      const html = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        title: "Moby-Dick",
        onBackToShelf: () => {},
      }));
      expect(html).toContain("titlebar-reader");
      expect(html).not.toContain("titlebar-controls");
      expect(html).not.toContain("titlebar-minimize");
      expect(html).not.toContain("titlebar-maximize");
      expect(html).not.toContain("titlebar-close");
      expect(html).not.toContain("data-tauri-drag-region");
      const zenHtml = renderToStaticMarkup(createElement(TitleBar, { view: "reader", zenMode: true, onToggleFullscreen: () => {} }));
      expect(zenHtml).not.toContain("zen-hidden");
      expect(zenHtml).not.toContain("is-floating");
      // Browser fullscreen/Zen tools remain available without native window chrome.
      setAppBuildSession({ source: "browser", edition: "core", debug: true });
      vi.stubGlobal("window", {});
      const webHtml = renderToStaticMarkup(createElement(TitleBar, { view: "reader", onToggleFullscreen: () => {} }));
      expect(webHtml).toContain("titlebar-fullscreen-btn");
      expect(webHtml).not.toContain("titlebar-controls");
    } finally {
      clearAppBuildSession();
      vi.unstubAllGlobals();
    }
  });

  it("沉浸模式（Zen Mode）在无菜单打开时增加 zen-hidden 样式", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const htmlZen = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        title: "Zen Reading",
        zenMode: true,
        onBackToShelf: () => {},
      }));
      expect(htmlZen).toContain("zen-hidden");
      expect(htmlZen).toContain("titlebar-zen-sensor");

      // 当有浮层或侧边栏打开时，沉浸隐藏自动失效，保持顶栏可见
      const htmlWithMenu = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        title: "Zen Reading",
        zenMode: true,
        appearanceOpen: true,
        onBackToShelf: () => {},
      }));
      expect(htmlWithMenu).not.toContain("zen-hidden");
      expect(htmlWithMenu).not.toContain("titlebar-zen-sensor");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("左侧提供显著的 [目录] 按键；顶栏图钉与设置里的“自动隐藏”是同一个开关", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const html = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        title: "Test Book",
        onBackToShelf: () => {},
        onToggleSidebar: () => {},
        progressPct: 42,
        chapterIndex: 0,
        totalChapters: 10,
      }));
      expect(html).toContain("titlebar-toc-btn");
      expect(html).toContain("目录");
      // Without the toggle wired (phones) there is no pin.
      expect(html).not.toContain("titlebar-pin-btn");
      expect(html).toContain("titlebar-progress-pill");
      expect(html).not.toContain("is-clickable");
      const pinned = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader", title: "Test Book", onBackToShelf: () => {}, zenMode: false, onToggleZenMode: () => {},
      }));
      expect(pinned).toMatch(/titlebar-pin-btn active"[^>]*aria-pressed="true"/);
      const autoHide = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader", title: "Test Book", onBackToShelf: () => {}, zenMode: true, onToggleZenMode: () => {},
      }));
      expect(autoHide).toMatch(/titlebar-pin-btn"[^>]*aria-pressed="false"/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("阅读进度胶囊只做展示，拖动它也能移动窗口", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const html = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        title: "Progress Capsule",
        onBackToShelf: () => {},
        onToggleSidebar: () => {},
        progressPct: 42,
        chapterIndex: 0,
        totalChapters: 10,
      }));
      expect(html).not.toMatch(/<button[^>]*titlebar-progress-pill/);
      const pill = html.match(/<div[^>]*titlebar-progress-pill[^>]*>/);
      expect(pill).not.toBeNull();
      expect(pill![0]).toContain("data-tauri-drag-region");
      expect(html).toContain('titlebar-drag-area titlebar-middle" data-tauri-drag-region');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("进度胶囊写目录章名；单本书显示书名 · 作者；两本以上才显示标签条", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const tabs = (n: number) => ({
        tabs: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `书${i}` })),
        activeId: "b0", max: 5, recent: [], onSelect: () => {}, onClose: () => {}, onOpenNew: () => {}, onPickFromShelf: () => {},
      });
      const props = {
        view: "reader" as const,
        title: "诡屋 01",
        author: "雨穴",
        chapterTitle: "第三章 记忆中的平面图",
        progressPct: 48,
        chapterIndex: 8,
        totalChapters: 10,
      };
      const single = renderToStaticMarkup(createElement(TitleBar, { ...props, readerTabs: tabs(1) }));
      expect(single).not.toContain("titlebar-reader-tabs");
      expect(single).toContain("titlebar-author");
      expect(single).toContain("雨穴");
      expect(single).toMatch(/titlebar-chapter-badge is-name[^>]*>第三章 记忆中的平面图</);
      expect(single).not.toContain("第 9/10 章");
      expect(single).toContain("48%");

      const many = renderToStaticMarkup(createElement(TitleBar, { ...props, readerTabs: tabs(2) }));
      expect(many).toContain("titlebar-reader-tabs");
      expect(many).toContain('aria-label="新开一本"');
      // At the limit the + button is off and says why.
      const full = renderToStaticMarkup(createElement(TitleBar, { ...props, readerTabs: tabs(5) }));
      expect(full).toMatch(/titlebar-reader-tabs-new"[^>]*aria-label="最多同时开 5 本，先关掉一本"[^>]*disabled/);

      // Without a contents name the capsule keeps the chapter count.
      const unnamed = renderToStaticMarkup(createElement(TitleBar, { ...props, chapterTitle: "" }));
      expect(unnamed).toContain("第 9/10 章");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("触屏顶栏：书名下一行写章名，不写作者", () => {
    vi.stubGlobal("window", {});
    try {
      const html = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        mobileCompact: true,
        title: "诡屋 01",
        author: "雨穴",
        chapterTitle: "第一章 诡异的住家",
        progressPct: 10,
      }));
      expect(html).toContain("titlebar-book-meta is-stacked");
      expect(html).toContain("第一章 诡异的住家");
      expect(html).not.toContain("雨穴");
      expect(html).not.toContain("titlebar-progress-pill");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
