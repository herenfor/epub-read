import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleBar } from "./TitleBar";

describe("CSD TitleBar 组件与样式契约", () => {
  it("非 Tauri 桌面环境静默不渲染", () => {
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
        onBackToShelf: () => {},
        onToggleBookmark: () => {},
      }));
      expect(htmlReader).toContain("titlebar-reader");
      expect(htmlReader).toContain("titlebar-controls");
      expect(htmlReader).toContain("titlebar-close");
      expect(htmlReader).toContain("Moby-Dick");
      expect(htmlReader).toContain("titlebar-back-btn");
      expect(htmlReader).toContain("titlebar-bookmark-btn");
      expect(htmlReader).toContain("data-tauri-drag-region");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
