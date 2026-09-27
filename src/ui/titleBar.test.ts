import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleBar } from "./TitleBar";

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
});
