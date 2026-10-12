import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleBar, ReaderHeaderBar } from "./TitleBar";
import { createReactDomHarness } from "../test/reactDomHarness";

describe("Reader Integrated HeaderBar & Desktop Flow (Packet 3)", () => {
  it("导出 ReaderHeaderBar 别名组件契约，确保与 TitleBar 一致", () => {
    expect(ReaderHeaderBar).toBe(TitleBar);
  });

  it("正确渲染一体化顶栏进度胶囊、章节指示与百分比", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const html = renderToStaticMarkup(
        createElement(TitleBar, {
          view: "reader",
          title: "三体",
          chapterTitle: "科学边界",
          progressPct: 42.6,
          chapterIndex: 2,
          totalChapters: 36,
          onBackToShelf: () => {},
          onToggleSidebar: () => {},
          onToggleAppearance: () => {},
          onOpenSearch: () => {},
        })
      );

      // 左侧返回书架与书名·章节名
      expect(html).toContain("titlebar-back-btn");
      expect(html).toContain("三体");
      expect(html).toContain("科学边界");

      // 中央进度指示胶囊
      expect(html).toContain("titlebar-progress-pill");
      expect(html).toContain("第 3/36 章");
      expect(html).toContain("titlebar-progress-track");
      expect(html).toContain("titlebar-progress-fill");
      expect(html).toContain("43%"); // 四舍五入为 43%
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("支持渲染全屏沉浸切换按钮与 AI 助手按键", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const onToggleFullscreen = vi.fn();
      const onToggleAssistant = vi.fn();

      const html = renderToStaticMarkup(
        createElement(TitleBar, {
          view: "reader",
          title: "百年孤独",
          chapterTitle: "第一章",
          isFullscreen: true,
          onToggleFullscreen,
          assistantOpen: false,
          onToggleAssistant,
        })
      );

      // 全屏按钮
      expect(html).toContain("titlebar-fullscreen-btn");
      expect(html).toContain("active"); // isFullscreen 为 true 时具备 active 类
      expect(html).toContain("退出全屏");

      // AI 助手按键
      expect(html).toContain("titlebar-assistant-btn");
      expect(html).toContain("AI 助手");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("全屏 Zen Mode 沉浸隐藏与 40px 感应边缘契约", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      // 沉浸模式在无子弹层打开时隐藏顶栏并渲染顶部感应区
      const htmlHidden = renderToStaticMarkup(
        createElement(TitleBar, {
          view: "reader",
          title: "Zen Reading",
          zenMode: true,
          isFullscreen: true,
          onBackToShelf: () => {},
        })
      );

      expect(htmlHidden).toContain("zen-hidden");
      expect(htmlHidden).toContain("is-floating");
      expect(htmlHidden).toContain("titlebar-zen-sensor");

      // 菜单打开时保持顶栏常驻，不渲染感应区
      const htmlRevealed = renderToStaticMarkup(
        createElement(TitleBar, {
          view: "reader",
          title: "Zen Reading",
          zenMode: true,
          isFullscreen: true,
          searchOpen: true,
          onBackToShelf: () => {},
        })
      );

      expect(htmlRevealed).not.toContain("zen-hidden");
      expect(htmlRevealed).not.toContain("titlebar-zen-sensor");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("书签列表下拉按键提供快捷键提示 (Ctrl+Shift+B)", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const html = renderToStaticMarkup(
        createElement(TitleBar, {
          view: "reader",
          title: "追忆似水年华",
          chapterTitle: "在斯万家那边",
          onOpenBookmarks: () => {},
        })
      );

      expect(html).toContain("titlebar-bookmark-list-btn");
      expect(html).toContain("Ctrl+Shift+B");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("普通窗口模式下开启 Zen Mode 同样支持浮动 HUD 与 40px 顶部感应呼出", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    try {
      const htmlWindowZen = renderToStaticMarkup(
        createElement(TitleBar, {
          view: "reader",
          title: "Window Zen Reading",
          zenMode: true,
          isFullscreen: false,
          onBackToShelf: () => {},
        })
      );
      expect(htmlWindowZen).toContain("zen-hidden");
      expect(htmlWindowZen).toContain("is-floating");
      expect(htmlWindowZen).toContain("titlebar-zen-sensor");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("desktop titlebar auto-hide lifecycle", () => {
  async function setup() {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    const render = (appearanceOpen = false) => dom.render(createElement(TitleBar, {
      view: "reader", zenMode: true, appearanceOpen, onToggleAppearance: () => {},
    }));
    await render();
    const header = () => dom.container.querySelector("header")!;
    const event = (type: string, relatedTarget: EventTarget) => {
      const next = new window.Event(type, { bubbles: true });
      Object.defineProperty(next, "relatedTarget", { value: relatedTarget });
      return next;
    };
    const enter = () => dom.dispatch(header(), event("mouseover", document.body));
    const leave = () => dom.dispatch(header(), event("mouseout", document.body));
    const advance = (ms: number) => dom.run(() => { vi.advanceTimersByTime(ms); });
    const hidden = () => header().classList.contains("zen-hidden");
    const dispose = async () => { await dom.dispose(); vi.useRealTimers(); };
    return { dom, render, header, event, enter, leave, advance, hidden, dispose };
  }

  it("retains the one-second hide deadline when reveal and leave share a React update", async () => {
    const h = await setup();
    try {
      await h.dom.run(() => {
        h.header().dispatchEvent(h.event("mouseover", document.body));
        h.header().dispatchEvent(h.event("mouseout", document.body));
      });
      expect(h.hidden()).toBe(false);
      await h.advance(999);
      expect(h.hidden()).toBe(false);
      await h.advance(1);
      expect(h.hidden()).toBe(true);
    } finally { await h.dispose(); }
  });

  it("restarts hiding after a menu closes with the pointer already away", async () => {
    const h = await setup();
    try {
      await h.enter();
      await h.render(true);
      await h.leave();
      await h.advance(2000);
      expect(h.hidden()).toBe(false);
      await h.render(false);
      await h.advance(999);
      expect(h.hidden()).toBe(false);
      await h.advance(1);
      expect(h.hidden()).toBe(true);
    } finally { await h.dispose(); }
  });

  it("cancels hiding on pointer reentry and starts a fresh second on the next leave", async () => {
    const h = await setup();
    try {
      await h.enter();
      await h.leave();
      await h.advance(600);
      await h.enter();
      await h.advance(2000);
      expect(h.hidden()).toBe(false);
      await h.leave();
      await h.advance(999);
      expect(h.hidden()).toBe(false);
      await h.advance(1);
      expect(h.hidden()).toBe(true);
    } finally { await h.dispose(); }
  });

  it("keeps Alt's explicit hide action even while the pointer is over the header", async () => {
    const h = await setup();
    try {
      await h.enter();
      expect(h.hidden()).toBe(false);
      await h.dom.run(() => {
        const event = new window.Event("keydown", { bubbles: true });
        Object.defineProperty(event, "key", { value: "Alt" });
        window.dispatchEvent(event);
      });
      expect(h.hidden()).toBe(true);
    } finally { await h.dispose(); }
  });
});
