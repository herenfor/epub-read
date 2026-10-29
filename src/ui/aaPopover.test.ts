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
    customCss: "",
    onCustomCssChange: vi.fn(),
    onResetDefaults: vi.fn(),
    onToggleLog: vi.fn(),
    onOpenFile: vi.fn(),
    issueCount: 2,
    onClose: vi.fn(),
  };
  const html = (props: Partial<AaPopoverProps> = {}) => renderToStaticMarkup(createElement(AaPopover, { ...baseProps, ...props }));
  /** The Advanced group: everything after its toggle up to the reset button. */
  const advanced = (markup: string) => markup.slice(markup.indexOf("aa-group-toggle"), markup.indexOf("aa-reset-btn"));

  it("一页放下全部排版：主题、字体与字符滤镜、文字五条各占一行、版式与翻页，没有“更多设置”", () => {
    const main = html();
    THEME_PALETTES.forEach((palette) => expect(main).toContain(palette.name));
    expect(main).toMatch(/aria-checked="true"[^>]*>(?:<span[^>]*>Aa<\/span>)?<span[^>]*>羊皮纸</);
    expect(main).toContain("思源宋体");
    expect(main).toContain("字符与滤镜");
    for (const label of ["字号", "行高", "边距", "字间距", "正文字重"]) {
      expect(main).toMatch(new RegExp(`role="slider"[^>]*aria-label="${label}"`));
    }
    // Letter spacing and weight no longer share a row.
    expect(main).not.toContain("aa-half-rows");
    expect(main).toMatch(/aa-segmented-btn active[^>]*>双页</);
    for (const text of ["文字", "版式与翻页", "翻页动画", "始终从左往右翻页", "高级排版", "恢复默认设置", "导入书籍", "诊断日志 (2)"]) {
      expect(main).toContain(text);
    }
    expect(main).toMatch(/aria-checked="true"[^>]*>无</);
    // Moved to Settings, or the same setting already there.
    for (const text of ["更多设置", "界面缩放", "高性能预读", "章节间连续滑动", "简化界面动画", "界面语言"]) {
      expect(main).not.toContain(text);
    }
  });

  it("滑块显示档位名和数值，未设置显示跟随书籍或默认，并画成空心", () => {
    const main = html();
    expect(main).toContain("标准 1.7");
    expect(main).toContain("适中");
    expect(main).toMatch(/aria-label="字间距"[^>]*aria-valuetext="跟随书籍"[^>]*data-auto/);
    expect(main).not.toMatch(/aria-label="行高"[^>]*data-auto/);
    expect(html({ lineHeight: undefined })).toMatch(/aria-label="行高"[^>]*aria-valuetext="跟随书籍"/);
    expect(html({ lineHeight: 1.9 })).toContain(">1.9<");
    expect(html({ pageMargins: {} })).toMatch(/aria-label="边距"[^>]*aria-valuetext="自动"/);
    // Fine-tuned sides keep their values and read as fine-tuned.
    expect(html({ pageMargins: { left: 52, right: 30, top: 12 } })).toContain("微调");
  });

  it("高级排版就地展开：四边距、词间距、中缝、竖排转横排、自定义 CSS，默认收起", () => {
    const markup = html();
    const group = advanced(markup);
    expect(group).toContain('aria-expanded="false"');
    expect(group).toMatch(/<div class="aa-card" hidden="">/);
    for (const label of ["上边距", "下边距", "左边距", "右边距", "词间距", "双栏中缝"]) {
      expect(group).toMatch(new RegExp(`role="slider"[^>]*aria-label="${label}"`));
    }
    for (const text of ["强制竖排转横排", "自定义 CSS 样式注入"]) expect(group).toContain(text);
    // The closed "detailed" warm-up draws it open.
    expect(advanced(html({ open: false, paintWarm: "detailed" }))).toContain('aria-expanded="true"');
  });

  it("双页回退单页时提示；中缝在非双页时注明只在双页生效", () => {
    expect(html({ effectiveColumns: 1 })).toContain("窗口较窄，暂以单页显示");
    expect(advanced(html({ columnsPerView: 1 }))).toContain("双栏中缝只在双页时生效");
  });

  it("档位按内部 id 识别，不依赖界面文字", () => {
    expect(lineHeightPresetId(undefined)).toBeNull();
    expect(lineHeightPresetId(1.42)).toBe("compact");
    expect(lineHeightPresetId(2.0)).toBe("loose");
    expect(lineHeightPresetId(1.9)).toBeNull();
  });

  const pointer = (dom: ReturnType<typeof createReactDomHarness>, type: string, x: number, y: number, pointerType = "touch") =>
    Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerId: 7, pointerType, button: 0, clientX: x, clientY: y });

  it("横向拖过阈值才算拖动：面板只留这一行并实时预览，松手恢复", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const onLivePreviewChange = vi.fn();
    try {
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange }));
      const dialog = dom.container.querySelector(".aa-popover") as HTMLElement;
      const slider = dom.container.querySelector('[role="slider"][aria-label="行高"]') as HTMLElement;
      await dom.dispatch(slider, pointer(dom, "pointerdown", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 105, 11));
      // Inside the slop nothing happens yet.
      expect(dialog.hasAttribute("data-slider-focus")).toBe(false);
      await dom.dispatch(slider, pointer(dom, "pointermove", 130, 12));
      expect(dialog.getAttribute("data-slider-focus")).toBe("line-height");
      expect(slider.closest("[data-slider-row]")?.hasAttribute("data-slider-focused")).toBe(true);
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(true);
      await dom.dispatch(slider, pointer(dom, "pointerup", 130, 12));
      expect(dialog.hasAttribute("data-slider-focus")).toBe(false);
      expect(slider.closest("[data-slider-row]")?.hasAttribute("data-slider-focused")).toBe(false);
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(false);
    } finally {
      await dom.dispose();
    }
  });

  it("轻点或竖向滑过滑块不改值、不进入预览", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const onLivePreviewChange = vi.fn();
    const onLineHeightChange = vi.fn();
    try {
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange, onLineHeightChange }));
      const slider = dom.container.querySelector('[role="slider"][aria-label="行高"]') as HTMLElement;
      await dom.dispatch(slider, pointer(dom, "pointerdown", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointerup", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointerdown", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 104, 40));
      await dom.dispatch(slider, pointer(dom, "pointermove", 140, 60));
      expect(onLivePreviewChange).not.toHaveBeenCalled();
      expect(onLineHeightChange).not.toHaveBeenCalled();
    } finally {
      await dom.dispose();
    }
  });

  it("拖动中途关闭面板：不等抬手就收尾，残留属性清掉，之后的移动也不再改值", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const onLivePreviewChange = vi.fn();
    const onFontSizeChange = vi.fn();
    try {
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange, onFontSizeChange }));
      const dialog = dom.container.querySelector(".aa-popover") as HTMLElement;
      const slider = dom.container.querySelector('[role="slider"][aria-label="字号"]') as HTMLElement;
      dom.define(slider, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 220, height: 40, right: 220, bottom: 40 }) });
      await dom.dispatch(slider, pointer(dom, "pointerdown", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 120, 10));
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(true);
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange, onFontSizeChange, open: false }));
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(false);
      expect(dialog.hasAttribute("data-slider-focus")).toBe(false);
      expect(dom.container.querySelector("[data-slider-focused]")).toBeNull();
      onFontSizeChange.mockClear();
      await dom.dispatch(slider, pointer(dom, "pointermove", 200, 10));
      expect(onFontSizeChange).not.toHaveBeenCalled();
      // Reopen before the interrupted pointer ever sends its up event.
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange, onFontSizeChange, open: true }));
      await dom.dispatch(slider, pointer(dom, "pointerdown", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 120, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 180, 10));
      expect(onFontSizeChange).toHaveBeenCalled();
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(true);
    } finally {
      await dom.dispose();
    }
  });

  it.each(["blur", "hidden"])("中断补修：%s 后退出拖动，残留移动不改值，新手势可立即开始", async (reason) => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const onLivePreviewChange = vi.fn();
    const onFontSizeChange = vi.fn();
    try {
      await dom.render(createElement(AaPopover, { ...baseProps, onLivePreviewChange, onFontSizeChange }));
      const slider = dom.container.querySelector('[role="slider"][aria-label="字号"]') as HTMLElement;
      const dialog = dom.container.querySelector(".aa-popover")!;
      dom.rect(slider, { width: 220, height: 40 });
      await dom.dispatch(slider, pointer(dom, "pointerdown", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 120, 10));
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(true);
      await dom.run(() => {
        if (reason === "blur") dom.window.dispatchEvent(new dom.window.Event("blur"));
        else {
          dom.define(dom.window.document, "visibilityState", { value: "hidden" });
          dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
        }
      });
      expect(dialog.hasAttribute("data-slider-focus")).toBe(false);
      expect(slider.hasAttribute("data-dragging")).toBe(false);
      expect(onLivePreviewChange).toHaveBeenLastCalledWith(false);
      onFontSizeChange.mockClear();
      await dom.dispatch(slider, pointer(dom, "pointermove", 200, 10));
      expect(onFontSizeChange).not.toHaveBeenCalled();
      await dom.dispatch(slider, pointer(dom, "pointerdown", 100, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 120, 10));
      await dom.dispatch(slider, pointer(dom, "pointermove", 180, 10));
      expect(onFontSizeChange).toHaveBeenCalled();
    } finally {
      await dom.dispose();
    }
  });

  it("恢复默认后自定义 CSS 草稿跟着清空，不会再被一键写回", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    try {
      await dom.render(createElement(AaPopover, { ...baseProps, customCss: "body{color:red;}" }));
      await dom.click(dom.container.querySelector(".aa-group-toggle")!);
      expect(dom.container.querySelector(".aa-group-toggle")?.getAttribute("aria-expanded")).toBe("true");
      await dom.click(dom.container.querySelector(".aa-nav-row.is-disclosure")!);
      const textarea = () => dom.container.querySelector(".aa-css-textarea") as HTMLTextAreaElement;
      expect(textarea().value).toBe("body{color:red;}");
      await dom.render(createElement(AaPopover, { ...baseProps, customCss: "" }));
      expect(textarea().value).toBe("");
      expect(dom.container.querySelector(".aa-btn-save-css")).toBeNull();
    } finally {
      await dom.dispose();
    }
  });
});

describe("Aa 自定义主题", () => {
  const base: AaPopoverProps = {
    fontSize: 18, onFontSizeChange: vi.fn(), onFontDec: vi.fn(), onFontInc: vi.fn(),
    theme: "c:c7edcc2b3a2e3f7d4e", onThemeChange: vi.fn(),
    onOpenFontSettings: vi.fn(), onLineHeightChange: vi.fn(), onClose: vi.fn(),
  };
  const controls = (count: number) => ({
    themes: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, name: i === 0 ? "护眼绿" : "", background: "#c7edcc", foreground: "#2b3a2e", accent: "#3f7d4e" })),
    activeId: "t0",
    canCreate: count < 6,
    select: vi.fn(), create: vi.fn(() => "new"), setColors: vi.fn(), rename: vi.fn(), remove: vi.fn(),
  });

  it("自定义主题排在内置主题后面；选中的带编辑笔；满 6 个时“新建”不可点", () => {
    const full = renderToStaticMarkup(createElement(AaPopover, { ...base, customThemes: controls(6) }));
    expect(full).toContain("ui-theme-cards is-row");
    expect(full.match(/class="ui-theme-card-edit"/g)).toHaveLength(1);
    expect(full).toContain("护眼绿");
    expect(full).toContain("我的主题 2");
    expect(full).toMatch(/<button type="button" class="ui-theme-card is-new" disabled=""[^>]*title="最多 6 个自定义主题"/);
    const roomy = renderToStaticMarkup(createElement(AaPopover, { ...base, customThemes: controls(2) }));
    expect(roomy).not.toMatch(/ui-theme-card is-new" disabled/);
  });

  it("点编辑笔在面板里换成编辑页，改色立即提交，返回回到主页", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const custom = controls(2);
    try {
      await dom.render(createElement(AaPopover, { ...base, customThemes: custom }));
      await dom.click(dom.container.querySelector(".ui-theme-card-edit")!);
      expect(dom.container.querySelector(".aa-main-body")).toBeNull();
      expect(dom.container.querySelector(".aa-subpage-title")?.textContent).toBe("编辑主题");
      expect((dom.container.querySelector(".cte-name") as HTMLInputElement).value).toBe("护眼绿");
      await dom.click(dom.container.querySelector('.cte-swatch[aria-label="#141b26"]')!);
      expect(custom.setColors).toHaveBeenCalledWith("t0", { background: "#141b26", foreground: "#2b3a2e", accent: "#3f7d4e" });
      await dom.click(dom.container.querySelector(".aa-back-btn")!);
      expect(dom.container.querySelector(".aa-main-body")).not.toBeNull();
    } finally {
      await dom.dispose();
    }
  });

  it("删除要点两次", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    const custom = controls(1);
    try {
      await dom.render(createElement(AaPopover, { ...base, customThemes: custom }));
      await dom.click(dom.container.querySelector(".ui-theme-card-edit")!);
      const remove = dom.container.querySelector(".cte-delete")!;
      await dom.click(remove);
      expect(custom.remove).not.toHaveBeenCalled();
      expect(remove.textContent).toBe("再点一次删除");
      await dom.click(remove);
      expect(custom.remove).toHaveBeenCalledWith("t0");
    } finally {
      await dom.dispose();
    }
  });
});
