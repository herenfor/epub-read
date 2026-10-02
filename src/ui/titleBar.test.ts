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
      expect(htmlReader).toContain("titlebar-sidebar-btn");
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
      const zenHtml = renderToStaticMarkup(createElement(TitleBar, { view: "reader", zenMode: true, onToggleZenMode: () => {}, onToggleFullscreen: () => {} }));
      expect(zenHtml).not.toContain("zen-hidden");
      expect(zenHtml).not.toContain("is-floating");
      expect(zenHtml).not.toContain("titlebar-pin-btn");
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

  it("左侧提供显著的 [目录] 按键与常驻固定 Pin 按钮", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const html = renderToStaticMarkup(createElement(TitleBar, {
        view: "reader",
        title: "Test Book",
        onBackToShelf: () => {},
        onToggleSidebar: () => {},
        onToggleZenMode: () => {},
        progressPct: 42,
        chapterIndex: 0,
        totalChapters: 10,
      }));
      expect(html).toContain("titlebar-toc-btn");
      expect(html).toContain("目录");
      expect(html).toContain("titlebar-pin-btn");
      expect(html).toContain("titlebar-progress-pill is-clickable");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
