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

      const htmlReader = renderToStaticMarkup(createElement(TitleBar, { view: "reader", title: "Moby-Dick" }));
      expect(htmlReader).toContain("titlebar-reader");
      expect(htmlReader).toContain("titlebar-controls");
      expect(htmlReader).toContain("titlebar-close");
      // 阅读器视图不渲染 data-tauri-drag-region，防止 Tauri/WebView2 在系统层面拦截鼠标悬停与顶部感应
      expect(htmlReader).not.toContain("data-tauri-drag-region");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("CSS 样式满足无边框沉浸契约与 Windows 关闭按钮规范", async () => {
    const css = await readTitleBarStyles();
    // 基础高度 36px
    expect(css).toMatch(/\.titlebar\s*\{[^}]*height:\s*36px;/s);
    // 书架视图透明融入
    expect(css).toMatch(/\.titlebar-shelf\s*\{[^}]*background:\s*transparent;/s);
    // 阅读器视图通顶浮层与事件穿透
    expect(css).toMatch(/\.titlebar-reader\s*\{[^}]*position:\s*fixed;[^}]*pointer-events:\s*none;/s);
    // 阅读器视图拖拽区必须完全穿透，避免遮挡顶部工具栏感应区
    expect(css).toMatch(/\.titlebar-reader \.titlebar-drag-area\s*\{[^}]*pointer-events:\s*none;/s);
    // 控制键恢复交互
    expect(css).toMatch(/\.titlebar-controls\s*\{[^}]*pointer-events:\s*auto;/s);
    // 关闭按钮 hover 规范暗红与纯白文字
    expect(css).toMatch(/\.titlebar-close:hover\s*\{[^}]*background:\s*#c42b1c/s);
  });
});
