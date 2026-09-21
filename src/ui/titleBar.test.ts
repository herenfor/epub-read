import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleBar } from "./TitleBar";

async function readTitleBarStyles(): Promise<string> {
  // @ts-expect-error Node types in test
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("./titleBar.css", import.meta.url), "utf8");
}

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

  it("CSS 样式满足实心主题色与 Windows 关闭按钮规范", async () => {
    const css = await readTitleBarStyles();
    // 基础高度 36px
    expect(css).toMatch(/\.titlebar\s*\{[^}]*height:\s*36px;/s);
    // 主题色背景融入（非透明浮层）
    expect(css).toMatch(/\.titlebar\s*\{[^}]*background:\s*var\(--bg\);/s);
    // 拖拽区与控制键恢复交互
    expect(css).toMatch(/\.titlebar-drag-area\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/\.titlebar-controls\s*\{[^}]*pointer-events:\s*auto;/s);
    // 关闭按钮 hover 规范暗红与纯白文字
    expect(css).toMatch(/\.titlebar-close:hover\s*\{[^}]*background:\s*#c42b1c/s);
  });
});
