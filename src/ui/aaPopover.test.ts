import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AaPopover, THEME_PALETTES, lineHeightPresetId, type AaPopoverProps } from "./AaPopover";
import { createReactDomHarness } from "../test/reactDomHarness";

describe("Aa 单层紧凑面板", () => {
  const baseProps: AaPopoverProps = {
    fontSize: 18,
    onFontSizeChange: vi.fn(),
    onFontDec: vi.fn(),
    onFontInc: vi.fn(),
    theme: "sepia",
    onThemeChange: vi.fn(),
    customFontName: "思源宋体",
    onOpenFontSettings: vi.fn(),
    onOpenDisplaySettings: vi.fn(),
    lineHeight: 1.7,
    onLineHeightChange: vi.fn(),
    fontWeight: undefined,
    onFontWeightChange: vi.fn(),
    letterSpacingPx: undefined,
    onLetterSpacingChange: vi.fn(),
    wordSpacingPx: undefined,
    onWordSpacingChange: vi.fn(),
    onGapPxChange: vi.fn(),
    onSpreadGapModeChange: vi.fn(),
    onUiScaleChange: vi.fn(),
    pageMargins: { left: 40, right: 40, top: 28, bottom: 28 },
    onPageMarginsChange: vi.fn(),
    columnsPerView: 2,
    onColumnsChange: vi.fn(),
    readingMode: "paginated",
    onReadingModeChange: vi.fn(),
    turnAnimation: "none",
    onTurnAnimationChange: vi.fn(),
    forceHorizontal: false,
    onForceHorizontalChange: vi.fn(),
    onPageDirectionChange: vi.fn(),
    preloadNextChapter: true,
    onPreloadNextChapterChange: vi.fn(),
    onSeamlessChapterTurnChange: vi.fn(),
    customCss: "",
    onCustomCssChange: vi.fn(),
    onResetDefaults: vi.fn(),
    onToggleLog: vi.fn(),
    onOpenFile: vi.fn(),
    issueCount: 2,
    onClose: vi.fn(),
  };
  const html = (props: Partial<AaPopoverProps> = {}) => renderToStaticMarkup(createElement(AaPopover, { ...baseProps, ...props }));
  const page = (markup: string, which: "main" | "more") => {
    const pages = markup.split('class="aa-page"').slice(1);
    return pages[which === "main" ? 0 : 1];
  };

  it("主页一层放下常用项：主题、字体与字符滤镜入口、五个滑块、阅读方式", () => {
    const main = page(html(), "main");
    THEME_PALETTES.forEach((palette) => expect(main).toContain(palette.name));
    expect(main).toMatch(/aria-checked="true"[^>]*>羊皮纸</);
    expect(main).toContain("思源宋体");
    expect(main).toContain("字符与滤镜");
    for (const label of ["字号", "行高", "边距", "字间距", "正文字重"]) {
      expect(main).toMatch(new RegExp(`type="range"[^>]*aria-label="${label}"`));
    }
    expect(main).toMatch(/aa-segmented-btn active[^>]*>双页</);
    expect(main).toContain("更多设置");
    // No tabs and no steppers any more.
    expect(main).not.toContain("aa-tab-btn");
    expect(main).not.toContain("aa-stepper-capsule");
    expect(main).not.toContain("界面语言");
  });

  it("滑块显示档位名和数值，未设置显示跟随书籍或默认", () => {
    const main = page(html(), "main");
    expect(main).toContain("标准 1.7");
    expect(main).toContain("适中");
    expect(main).toMatch(/aria-label="字间距" aria-valuetext="跟随书籍"/);
    expect(page(html({ lineHeight: undefined }), "main")).toMatch(/aria-label="行高" aria-valuetext="跟随书籍"/);
    expect(page(html({ lineHeight: 1.9 }), "main")).toContain(">1.9<");
    expect(page(html({ pageMargins: {} }), "main")).toMatch(/aria-label="边距" aria-valuetext="自动"/);
    // Fine-tuned sides keep their values and read as fine-tuned.
    expect(page(html({ pageMargins: { left: 52, right: 30, top: 12 } }), "main")).toContain("微调");
  });

  it("更多设置收齐其余功能：四边距、词间距、中缝、翻页、显示、自定义 CSS、导入与日志", () => {
    const more = page(html(), "more");
    for (const label of ["上边距", "下边距", "左边距", "右边距", "词间距", "双栏中缝"]) {
      expect(more).toMatch(new RegExp(`type="range"[^>]*aria-label="${label}"`));
    }
    for (const text of ["翻页动画", "始终从左往右翻页", "高性能预读", "章节间连续滑动", "界面缩放", "强制竖排转横排", "简化界面动画", "自定义 CSS 样式注入", "导入书籍", "诊断日志 (2)", "恢复默认设置"]) {
      expect(more).toContain(text);
    }
    expect(more).toMatch(/aria-checked="true"[^>]*>无</);
  });

  it("双页回退单页时提示；中缝在非双页时注明只在双页生效", () => {
    expect(html({ effectiveColumns: 1 })).toContain("窗口较窄，暂以单页显示");
    expect(page(html({ columnsPerView: 1 }), "more")).toContain("双栏中缝只在双页时生效");
  });

  it("档位按内部 id 识别，不依赖界面文字", () => {
    expect(lineHeightPresetId(undefined)).toBeNull();
    expect(lineHeightPresetId(1.42)).toBe("compact");
    expect(lineHeightPresetId(2.0)).toBe("loose");
    expect(lineHeightPresetId(1.9)).toBeNull();
  });

  it("按住滑块：面板只留这一行并通知阅读器实时预览，松手恢复", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const onLivePreviewChange = vi.fn();
    try {
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange }));
      const dialog = dom.container.querySelector(".aa-popover") as HTMLElement;
      const slider = dom.container.querySelector('input[aria-label="行高"]') as HTMLElement;
      await dom.dispatch(slider, new dom.window.Event("pointerdown", { bubbles: true }));
      expect(dialog.getAttribute("data-slider-focus")).toBe("line-height");
      expect(slider.closest("[data-slider-row]")?.hasAttribute("data-slider-focused")).toBe(true);
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(true);
      await dom.dispatch(dom.window as unknown as Element, new dom.window.Event("pointerup"));
      expect(dialog.hasAttribute("data-slider-focus")).toBe(false);
      expect(slider.closest("[data-slider-row]")?.hasAttribute("data-slider-focused")).toBe(false);
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(false);
      // A tap on a button is not a drag.
      await dom.click(dom.container.querySelector(".aa-more-link")!);
      expect(onLivePreviewChange).toHaveBeenCalledTimes(2);
    } finally {
      await dom.dispose();
    }
  });

  it("关闭时若仍按着滑块，阅读器退出预览", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const onLivePreviewChange = vi.fn();
    try {
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange }));
      const slider = dom.container.querySelector('input[aria-label="字号"]') as HTMLElement;
      await dom.dispatch(slider, new dom.window.Event("pointerdown", { bubbles: true }));
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(true);
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange, open: false }));
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(false);
    } finally {
      await dom.dispose();
    }
  });
});
