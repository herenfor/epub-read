import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AaPopover, THEME_PALETTES, type AaPopoverProps } from "./AaPopover";

describe("Zen UI AaPopover 组件与交互契约（Packet B）", () => {
  const baseProps: AaPopoverProps = {
    fontSize: 18,
    onFontSizeChange: vi.fn(),
    onFontDec: vi.fn(),
    onFontInc: vi.fn(),
    theme: "sepia",
    onThemeChange: vi.fn(),
    customFontName: "思源宋体",
    onOpenFontSettings: vi.fn(),
    lineHeight: 1.7,
    onLineHeightChange: vi.fn(),
    pageMargins: { left: 40, right: 40, top: 28, bottom: 28 },
    onPageMarginsChange: vi.fn(),
    columnsPerView: 2,
    onColumnsChange: vi.fn(),
    readingMode: "paginated",
    onReadingModeChange: vi.fn(),
    instantTurn: true,
    onInstantTurnChange: vi.fn(),
    forceHorizontal: false,
    onForceHorizontalChange: vi.fn(),
    preloadNextChapter: true,
    onPreloadNextChapterChange: vi.fn(),
    customCss: "",
    onCustomCssChange: vi.fn(),
    onResetDefaults: vi.fn(),
    onToggleLog: vi.fn(),
    issueCount: 2,
    onClose: vi.fn(),
  };

  it("正确渲染 4 款主题预设色块并选中当前主题", () => {
    const html = renderToStaticMarkup(createElement(AaPopover, baseProps));
    expect(html).toContain("aa-theme-card");
    THEME_PALETTES.forEach((palette) => {
      expect(html).toContain(palette.name);
    });
    // sepia 为当前选中的主题
    expect(html).toContain("羊皮纸");
    expect(html).toContain("active");
  });

  it("字号步进模块显示当前字号以及大/小 A 按键", () => {
    const html = renderToStaticMarkup(createElement(AaPopover, baseProps));
    expect(html).toContain("18px");
    expect(html).toContain("小 A");
    expect(html).toContain("大 A");
    expect(html).toContain("aa-stepper-capsule");
  });

  it("字体卡片展示当前字体家族名称并支持触发字体管理", () => {
    const html = renderToStaticMarkup(createElement(AaPopover, baseProps));
    expect(html).toContain("思源宋体");
    expect(html).toContain("aa-font-trigger");
  });

  it("行高、边距、排版（单页/双页/滚动）分段控制器正确选中当前状态", () => {
    const html = renderToStaticMarkup(createElement(AaPopover, baseProps));
    // 唯一排版选项：单页 | 双页 | 滚动
    expect(html).toContain("单页");
    expect(html).toContain("双页");
    expect(html).toContain("滚动");
    // 双页选中 (baseProps: columnsPerView=2, readingMode=paginated)
    expect(html).toMatch(/aa-segmented-btn active[^>]*>双页</);
    // 行高标准选中
    expect(html).toContain("标准");
    // 边距适中选中
    expect(html).toContain("适中");
    // 极速瞬翻
    expect(html).toContain("极速瞬翻 (0ms)");
  });

  it("当选中双页且窗口较窄回退单页时显示提示文案", () => {
    const html = renderToStaticMarkup(
      createElement(AaPopover, {
        ...baseProps,
        columnsPerView: 2,
        effectiveColumns: 1,
      })
    );
    expect(html).toContain("窗口较窄，暂以单页显示");
  });

  it("包含更多高级设置折叠开关", () => {
    const html = renderToStaticMarkup(createElement(AaPopover, baseProps));
    expect(html).toContain("更多高级设置");
    expect(html).toContain("aa-advanced-toggle");
  });
});
