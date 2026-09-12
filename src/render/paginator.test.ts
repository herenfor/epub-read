import { describe, expect, it } from "vitest";
import {
  ChapterPaginator,
  getBorderBoxWidth,
  hasComputedPercentageHorizontalMargin,
  getFragmentNavigation,
  getReaderTopFloatContainmentMargins,
  getReaderTopFloatLayoutMargins,
  getAuthoredPercentageWidth,
  getPercentageFloatGroupMembers,
  getSafePercentageFloatGroupMembers,
  getPercentageFloatGroupTargetWidths,
  isPercentageFloatGroupGeometryValid,
  hasAuthoredFullWidthIntentInRules,
  hasAuthoredHorizontalMargin,
  hasPercentageHorizontalMargin,
  hasPercentageHorizontalMarginInRules,
  hasTrailingManualPaddingWhitespace,
  hasVisibleInlineBox,
  isMediaOnlyFloatContent,
  isMediaOnlyFloatSubtree,
  hasAuthoredInlineWidth,
  isAutoLikeHorizontalMargin,
  shouldKeepCenteredAuthorMargins,
  hasAuthoredSizingIntent,
  isMeaningfulHorizontalMargin,
  isAuthorFullWidthValue,
  isPercentageMarginLayout,
  getReaderTopUaSymmetricInsetMaxWidth,
  isSymmetricHorizontalMargin,
  restoreInlineStyleProperty,
  shouldKeepSymmetricMarginsCentered,
  shouldKeepContainingBlockMarginsWhenBaseWouldOverflow,
  shouldApplyInlineBoxOverflowFix,
  shouldApplyBookMarginCompensation,
  shouldProbeAuthoredHorizontalMargin,
  shouldApplyTrailingFloatMarginFix,
  syncFragmentHash,
  isChapterMeasurementCurrent,
  resolveRestoredPage,
} from "./paginator";

const textNode = (text: string): Node =>
  ({ nodeType: 3, textContent: text }) as Node;

const elementNode = (tagName: string): Node =>
  ({ nodeType: 1, textContent: "", tagName }) as unknown as Node;

const elementWithChildren = (tagName: string, children: Node[]): Node =>
  ({ nodeType: 1, textContent: children.map((child) => child.textContent ?? "").join(""), tagName, childNodes: children }) as unknown as Node;

describe("content-anchor restore precedence", () => {
  it("text/legacy anchor wins over saved page and consumes that fallback before later reflow", () => {
    expect(
      resolveRestoredPage({ pageCount: 10, anchorCol: 3, fallbackPage: 8, currentPage: 0 })
    ).toEqual({ page: 3, consumeFallback: true });
    // The following image-only recompute has no pending fallback, so it keeps
    // its current anchor-resolved page instead of jumping back to page 8.
    expect(
      resolveRestoredPage({ pageCount: 10, anchorCol: null, fallbackPage: null, currentPage: 3 })
    ).toEqual({ page: 3, consumeFallback: false });
  });

  it("uses saved page only when both text and legacy anchors are invalid", () => {
    expect(
      resolveRestoredPage({ pageCount: 4, anchorCol: null, fallbackPage: 9, currentPage: 0 })
    ).toEqual({ page: 3, consumeFallback: true });
  });
});

describe("float shrink compensation", () => {
  it("float guard 只识别注释外的 inline width", () => {
    expect(hasAuthoredInlineWidth("/* width: 20em; */")).toBe(false);
    expect(hasAuthoredInlineWidth("/* width: 20em; */ width: 50%;")).toBe(true);
  });

  it("把只有图片和源码缩进空白的小型 float 视为正常媒体布局", () => {
    expect(
      isMediaOnlyFloatContent([
        textNode("\n    "),
        elementNode("IMG"),
        textNode("\n  "),
      ])
    ).toBe(true);
    expect(isMediaOnlyFloatContent([elementNode("svg")])).toBe(true);
  });

  it("不跳过含可见文字、其他行内容或空内容的 float", () => {
    expect(isMediaOnlyFloatContent([elementNode("IMG"), textNode("tomochan")])).toBe(false);
    expect(isMediaOnlyFloatContent([elementNode("SPAN")])).toBe(false);
    expect(isMediaOnlyFloatContent([textNode("  ")])).toBe(false);
  });

  it("末尾装饰 float 允许递归包裹层与注释，但可见文字否决", () => {
    expect(
      isMediaOnlyFloatSubtree([
        textNode("\n  "),
        elementWithChildren("div", [
          ({ nodeType: 8, textContent: " width: 20px; " } as unknown as Node),
          elementNode("img"),
        ]),
      ])
    ).toBe(true);
    expect(isMediaOnlyFloatSubtree([elementWithChildren("div", [elementNode("svg")])])).toBe(true);
    expect(isMediaOnlyFloatSubtree([elementWithChildren("div", [textNode("装饰")])])).toBe(false);
  });

  it("末尾媒体 float 事务门控要求跨列、单列收回、边界与兄弟不重叠", () => {
    const common = {
      float: "right",
      position: "static",
      mediaOnly: true,
      beforeColumns: [0, 1],
      afterColumns: [1],
      afterRects: [{ left: 510, right: 700, top: 420, bottom: 600, width: 190, height: 180 }],
      afterVisualRects: [{ left: 510, right: 700, top: 420, bottom: 600, width: 190, height: 180 }],
      previousVisualRects: [{ left: 20, right: 300, top: 100, bottom: 300, width: 280, height: 200 }],
      estimatedBeforeBottom: 700,
      contentBottom: 620,
      viewerLeft: 0,
      scrollLeft: 0,
      step: 500,
      pageWidth: 480,
    } as const;
    expect(shouldApplyTrailingFloatMarginFix(common)).toBe(true);
    expect(shouldApplyTrailingFloatMarginFix({ ...common, beforeColumns: [1] })).toBe(false);
    expect(shouldApplyTrailingFloatMarginFix({ ...common, afterColumns: [1, 2] })).toBe(false);
    expect(
      shouldApplyTrailingFloatMarginFix({
        ...common,
        afterVisualRects: [{ ...common.afterRects[0], bottom: 621 }],
      })
    ).toBe(false);
    expect(
      shouldApplyTrailingFloatMarginFix({
        ...common,
        previousVisualRects: [{ left: 520, right: 680, top: 500, bottom: 550, width: 160, height: 50 }],
      })
    ).toBe(false);
    // The candidate union may end at contentBottom, while first-fragment top
    // plus scrollHeight proves that its unfragmented content overflows.
    expect(
      shouldApplyTrailingFloatMarginFix({
        ...common,
        estimatedBeforeBottom: 754,
      })
    ).toBe(true);
    // A child image extending left/out of the column must veto the fix even
    // when the candidate's own rect is safe.
    expect(
      shouldApplyTrailingFloatMarginFix({
        ...common,
        afterVisualRects: [
          common.afterRects[0],
          { left: 490, right: 540, top: 430, bottom: 500, width: 50, height: 70 },
        ],
      })
    ).toBe(false);
    expect(shouldApplyTrailingFloatMarginFix({ ...common, scrollLeft: 250 })).toBe(true);
  });
});

describe("过期章节测量 token", () => {
  it("loadSeq、disposed、document 和 viewer 任一失配都禁止继续写布局", () => {
    const doc = {} as Document;
    const viewer = {} as HTMLElement;
    expect(
      isChapterMeasurementCurrent({
        disposed: false,
        loadSeq: 4,
        expectedLoadSeq: 4,
        contentDoc: doc,
        expectedDoc: doc,
        viewer,
        expectedViewer: viewer,
      })
    ).toBe(true);
    expect(
      isChapterMeasurementCurrent({
        disposed: false,
        loadSeq: 5,
        expectedLoadSeq: 4,
        contentDoc: doc,
        expectedDoc: doc,
        viewer,
        expectedViewer: viewer,
      })
    ).toBe(false);
    expect(
      isChapterMeasurementCurrent({
        disposed: false,
        loadSeq: 4,
        expectedLoadSeq: 4,
        contentDoc: {} as Document,
        expectedDoc: doc,
        viewer,
        expectedViewer: viewer,
      })
    ).toBe(false);
    expect(
      isChapterMeasurementCurrent({
        disposed: true,
        loadSeq: 4,
        expectedLoadSeq: 4,
        contentDoc: doc,
        expectedDoc: doc,
        viewer,
        expectedViewer: viewer,
      })
    ).toBe(false);
  });
});

describe("right-aligned inline box overflow compensation", () => {
  const visibleBox = {
    backgroundColor: "rgb(255, 255, 255)",
    borderLeftStyle: "none",
    borderRightStyle: "none",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    paddingLeft: "2px",
    paddingRight: "2px",
  } as CSSStyleDeclaration;
  const plainInline = {
    ...visibleBox,
    backgroundColor: "rgba(0, 0, 0, 0)",
    paddingLeft: "0px",
    paddingRight: "0px",
  } as CSSStyleDeclaration;

  it("识别全角/NBSP 手工补齐空白，不把普通空格当作候选", () => {
    expect(hasTrailingManualPaddingWhitespace("故事\u3000")).toBe(true);
    expect(hasTrailingManualPaddingWhitespace("故事\u00a0")).toBe(true);
    expect(hasTrailingManualPaddingWhitespace("故事\u3000 ")).toBe(true);
    expect(hasTrailingManualPaddingWhitespace("故事 ")).toBe(false);
  });

  it("仅把 right 对齐、可见盒、实际越界且原子化后收回的 inline 盒命中", () => {
    expect(
      hasVisibleInlineBox(visibleBox) &&
        shouldApplyInlineBoxOverflowFix({
          display: "inline",
          trailingPaddingWhitespace: true,
          visibleBox: true,
          textAlign: "right",
          rectRight: 997,
          containerRight: 960,
          fixedRectRight: 960,
          fixedWidth: 249,
          containerWidth: 640,
        })
    ).toBe(true);
  });

  it("普通行内文字、无可见盒、非 right 对齐或未越界均不改", () => {
    expect(
      hasVisibleInlineBox(plainInline) &&
        shouldApplyInlineBoxOverflowFix({
          display: "inline",
          trailingPaddingWhitespace: true,
          visibleBox: false,
          textAlign: "right",
          rectRight: 997,
          containerRight: 960,
          fixedRectRight: 960,
          fixedWidth: 249,
          containerWidth: 640,
        })
    ).toBe(false);
    expect(
      shouldApplyInlineBoxOverflowFix({
        display: "inline",
        trailingPaddingWhitespace: false,
        visibleBox: true,
        textAlign: "right",
        rectRight: 997,
        containerRight: 960,
        fixedRectRight: 960,
        fixedWidth: 249,
        containerWidth: 640,
      })
    ).toBe(false);
    expect(
      shouldApplyInlineBoxOverflowFix({
        display: "inline",
        trailingPaddingWhitespace: true,
        visibleBox: true,
        textAlign: "end",
        rectRight: 997,
        containerRight: 960,
        fixedRectRight: 960,
        fixedWidth: 249,
        containerWidth: 640,
      })
    ).toBe(false);
    expect(
      shouldApplyInlineBoxOverflowFix({
        display: "inline",
        trailingPaddingWhitespace: true,
        visibleBox: true,
        textAlign: "left",
        rectRight: 997,
        containerRight: 960,
        fixedRectRight: 960,
        fixedWidth: 249,
        containerWidth: 640,
      })
    ).toBe(false);
    expect(
      shouldApplyInlineBoxOverflowFix({
        display: "inline",
        trailingPaddingWhitespace: true,
        visibleBox: true,
        textAlign: "right",
        rectRight: 960,
        containerRight: 960,
        fixedRectRight: 960,
        fixedWidth: 249,
        containerWidth: 640,
      })
    ).toBe(false);
  });

  it("原子化后仍越界或宽度超过包含块时回滚", () => {
    expect(
      shouldApplyInlineBoxOverflowFix({
        display: "inline",
        trailingPaddingWhitespace: true,
        visibleBox: true,
        textAlign: "right",
        rectRight: 997,
        containerRight: 960,
        fixedRectRight: 980,
        fixedWidth: 249,
        containerWidth: 640,
      })
    ).toBe(false);
    expect(
      shouldApplyInlineBoxOverflowFix({
        display: "inline",
        trailingPaddingWhitespace: true,
        visibleBox: true,
        textAlign: "right",
        rectRight: 997,
        containerRight: 960,
        fixedRectRight: 960,
        fixedWidth: 700,
        containerWidth: 640,
      })
    ).toBe(false);
  });
});

describe("inline box compensation lifecycle", () => {
  it("恢复时移除 measure 标记，使下一轮仍可重新评估", () => {
    const values = new Map<string, string>([["text-indent", "12px"]]);
    const priorities = new Map<string, string>([["text-indent", "important"]]);
    const removed: string[] = [];
    const style = {
      getPropertyValue: (property: string) => values.get(property) ?? "",
      getPropertyPriority: (property: string) => priorities.get(property) ?? "",
      setProperty: (property: string, value: string, priority = "") => {
        values.set(property, value);
        if (priority) priorities.set(property, priority);
        else priorities.delete(property);
      },
      removeProperty: (property: string) => {
        values.delete(property);
        priorities.delete(property);
        return "";
      },
    } as unknown as CSSStyleDeclaration;
    const el = {
      style,
      removeAttribute: (name: string) => removed.push(name),
    } as unknown as HTMLElement;
    type LifecycleHost = {
      inlineClipFixes: Array<{ el: HTMLElement; overflowX: { value: string; priority: string } }>;
      inlineBoxFixes: Array<{
        el: HTMLElement;
        display: { value: string; priority: string };
        textIndent: { value: string; priority: string };
      }>;
    };
    const restore = (
      ChapterPaginator.prototype as unknown as {
        restoreInlineBoxFixes: (this: LifecycleHost) => void;
      }
    ).restoreInlineBoxFixes;
    const host = {
      inlineClipFixes: [{ el, overflowX: { value: "visible", priority: "important" } }],
      inlineBoxFixes: [
        {
          el,
          display: { value: "", priority: "" },
          textIndent: { value: "12px", priority: "important" },
        },
      ],
    } satisfies LifecycleHost;

    restore.call(host);
    expect(host.inlineClipFixes).toHaveLength(0);
    expect(values.get("overflow-x")).toBe("visible");
    expect(priorities.get("overflow-x")).toBe("important");
    expect(removed).toEqual(["data-reader-inline-box-fixed"]);
    expect(host.inlineBoxFixes).toHaveLength(0);
    expect(values.get("text-indent")).toBe("12px");
    expect(priorities.get("text-indent")).toBe("important");

    // A subsequent measure can register the same element again because the
    // stale marker was removed, then cleanup remains idempotent.
    removed.length = 0;
    host.inlineBoxFixes.push({
      el,
      display: { value: "", priority: "" },
      textIndent: { value: "12px", priority: "important" },
    });
    restore.call(host);
    expect(removed).toEqual(["data-reader-inline-box-fixed"]);
    expect(host.inlineBoxFixes).toHaveLength(0);
  });
});

describe("percentage float group compensation lifecycle", () => {
  it("恢复 group 的 width/max-width/margins 优先级并清除 marker", () => {
    const values = new Map<string, string>([
      ["margin-left", "12px"],
      ["margin-right", "8px"],
      ["width", "20%"],
      ["max-width", "640px"],
    ]);
    const priorities = new Map<string, string>([
      ["margin-left", "important"],
      ["width", "important"],
    ]);
    const removed: string[] = [];
    const style = {
      getPropertyValue: (property: string) => values.get(property) ?? "",
      getPropertyPriority: (property: string) => priorities.get(property) ?? "",
      setProperty: (property: string, value: string, priority = "") => {
        values.set(property, value);
        if (priority) priorities.set(property, priority);
        else priorities.delete(property);
      },
      removeProperty: (property: string) => {
        values.delete(property);
        priorities.delete(property);
        return "";
      },
    } as unknown as CSSStyleDeclaration;
    const el = {
      style,
      removeAttribute: (name: string) => removed.push(name),
    } as unknown as HTMLElement;
    type LifecycleHost = {
      floatLayoutFixes: Array<{
        el: HTMLElement;
        left: { value: string; priority: string };
        right: { value: string; priority: string };
        width: { value: string; priority: string };
        maxWidth: { value: string; priority: string };
      }>;
    };
    const restore = (ChapterPaginator.prototype as unknown as {
      restoreFloatLayoutFixes: (this: LifecycleHost) => void;
    }).restoreFloatLayoutFixes;
    const host = {
      floatLayoutFixes: [{
        el,
        left: { value: "12px", priority: "important" },
        right: { value: "8px", priority: "" },
        width: { value: "20%", priority: "important" },
        maxWidth: { value: "640px", priority: "" },
      }],
    } satisfies LifecycleHost;
    restore.call(host);
    expect(removed).toEqual(["data-reader-float-layout-fixed"]);
    expect(host.floatLayoutFixes).toHaveLength(0);
    expect(values.get("margin-left")).toBe("12px");
    expect(priorities.get("margin-left")).toBe("important");
    expect(values.get("width")).toBe("20%");
    expect(priorities.get("width")).toBe("important");
    expect(values.get("max-width")).toBe("640px");
  });
});

describe("fragment navigation", () => {
  it("解码目标 id，跳过空 fragment，并保留无法解码的原始值", () => {
    expect(getFragmentNavigation("#target%201")).toEqual({
      hash: "#target%201",
      anchor: "target 1",
    });
    expect(getFragmentNavigation("#target%23part")).toEqual({
      hash: "#target%23part",
      anchor: "target#part",
    });
    expect(getFragmentNavigation("#bad%2")).toEqual({
      hash: "#bad%2",
      anchor: "bad%2",
    });
    expect(getFragmentNavigation("#")).toBeNull();
    expect(getFragmentNavigation("chapter.xhtml#target")).toBeNull();
  });

  it("安全同步 iframe hash，并忽略空值和不可访问的 location", () => {
    let hash = "";
    let writes = 0;
    const win = {
      location: {
        get hash() {
          return hash;
        },
        set hash(value: string) {
          writes += 1;
          hash = value;
        },
      },
    } as unknown as Window;

    syncFragmentHash(win, "#target%201");
    expect(hash).toBe("#target%201");
    expect(writes).toBe(1);
    syncFragmentHash(win, "#target%201");
    expect(writes).toBe(1);
    syncFragmentHash(win, "");
    expect(hash).toBe("");
    expect(writes).toBe(2);
    syncFragmentHash(win, "#");
    expect(writes).toBe(2);

    const inaccessible = {
      get location(): Location {
        throw new Error("iframe already unloaded");
      },
    } as unknown as Window;
    expect(() => syncFragmentHash(inaccessible, "#target2")).not.toThrow();
  });
});

describe("same-chapter direct navigation", () => {
  type Harness = {
    navigateWithinCurrentChapter: (options: {
      fragment?: string;
      readingAnchor?: {
        index: number;
        ratio: number;
        anchorTextOffset: number | null;
        anchorTextSnippet: string | null;
      } | null;
      fallbackPage?: number | null;
      toStart?: boolean;
    }) => boolean;
  };

  it("restores a saved page without measuring or changing the iframe document", () => {
    const navigate = (ChapterPaginator.prototype as unknown as Harness).navigateWithinCurrentChapter;
    const commit = (ChapterPaginator.prototype as unknown as { commitWithinChapterPage: (page: number, candidate: unknown) => void }).commitWithinChapterPage;
    let measureCalls = 0;
    let recomputeCalls = 0;
    const viewer = { scrollLeft: 200 } as unknown as HTMLElement;
    const context = {
      disposed: false,
      _currentPath: "Text/chapter.xhtml",
      viewer,
      contentDoc: {},
      step: 100,
      metrics: { pageCount: 5, currentPage: 2 },
      lastState: { status: "ready", pageCount: 5, currentPage: 2, empty: false },
      anchor: { index: 4, ratio: 0.5, textOffset: null, textSnippet: null, charsRead: 0, totalChars: 0 },
      anchorPath: "Text/chapter.xhtml",
      iframe: { contentWindow: { location: { hash: "#old" } } },
      measure() { measureCalls += 1; },
      recompute() { recomputeCalls += 1; },
      emit() {},
      captureAnchor() {},
      commitWithinChapterPage: commit,
    };
    const ok = navigate.call(context, { fallbackPage: 3 });
    expect(ok).toBe(true);
    expect(context.metrics.currentPage).toBe(3);
    expect(viewer.scrollLeft).toBe(300);
    expect(measureCalls).toBe(0);
    expect(recomputeCalls).toBe(0);
  });

  it("does not mutate the current position when an anchor and page fallback are both invalid", () => {
    const navigate = (ChapterPaginator.prototype as unknown as Harness).navigateWithinCurrentChapter;
    const currentAnchor = {
      index: 4,
      ratio: 0.5,
      textOffset: null,
      textSnippet: null,
      charsRead: 0,
      totalChars: 0,
    };
    const context = {
      disposed: false,
      _currentPath: "Text/chapter.xhtml",
      viewer: { scrollLeft: 200 } as unknown as HTMLElement,
      contentDoc: {},
      step: 100,
      metrics: { pageCount: 5, currentPage: 2 },
      lastState: { status: "ready", pageCount: 5, currentPage: 2, empty: false },
      anchor: { ...currentAnchor },
      anchorPath: "Text/chapter.xhtml",
      iframe: { contentWindow: { location: { hash: "#old" } } },
      resolveAnchorCol: () => null,
      emit() {},
      captureAnchor() {},
      commitWithinChapterPage: (ChapterPaginator.prototype as unknown as { commitWithinChapterPage: (page: number, candidate: unknown) => void }).commitWithinChapterPage,
    };
    const before = { ...context.anchor };
    const ok = navigate.call(context, {
      readingAnchor: {
        index: 99,
        ratio: 0.5,
        anchorTextOffset: null,
        anchorTextSnippet: null,
      },
      fallbackPage: null,
    });
    expect(ok).toBe(false);
    expect(context.metrics.currentPage).toBe(2);
    expect(context.viewer.scrollLeft).toBe(200);
    expect(context.anchor).toEqual(before);
    expect(context.iframe.contentWindow.location.hash).toBe("#old");
  });

  it("uses a resolved text/legacy column before the saved page and does not measure", () => {
    const navigate = (ChapterPaginator.prototype as unknown as Harness).navigateWithinCurrentChapter;
    let measureCalls = 0;
    const context = {
      disposed: false,
      _currentPath: "Text/chapter.xhtml",
      viewer: { scrollLeft: 0 } as unknown as HTMLElement,
      contentDoc: {},
      step: 100,
      metrics: { pageCount: 5, currentPage: 0 },
      lastState: { status: "ready", pageCount: 5, currentPage: 0, empty: false },
      anchor: null,
      anchorPath: undefined,
      iframe: { contentWindow: { location: { hash: "#old" } } },
      resolveAnchorCol: () => ({ col: 2, source: "text" as const }),
      measure() { measureCalls += 1; },
      emit() {},
      captureAnchor() {},
      commitWithinChapterPage: (ChapterPaginator.prototype as unknown as { commitWithinChapterPage: (page: number, candidate: unknown) => void }).commitWithinChapterPage,
    };
    const ok = navigate.call(context, {
      readingAnchor: {
        index: -1,
        ratio: 0,
        anchorTextOffset: 12,
        anchorTextSnippet: "正文",
      },
      fallbackPage: 4,
    });
    expect(ok).toBe(true);
    expect(context.metrics.currentPage).toBe(2);
    expect(context.viewer.scrollLeft).toBe(200);
    expect(context.iframe.contentWindow.location.hash).toBe("");
    expect(measureCalls).toBe(0);
  });

  it("synchronizes :target only after a valid same-chapter fragment preflight", () => {
    const navigate = (ChapterPaginator.prototype as unknown as Harness).navigateWithinCurrentChapter;
    const context = {
      disposed: false,
      _currentPath: "Text/chapter.xhtml",
      viewer: { scrollLeft: 0 } as unknown as HTMLElement,
      contentDoc: {
        getElementById: (id: string) =>
          id === "target" ? { getBoundingClientRect: () => ({ left: 120 }) } : null,
      },
      step: 100,
      metrics: { pageCount: 4, currentPage: 0 },
      lastState: { status: "ready", pageCount: 4, currentPage: 0, empty: false },
      anchor: null,
      anchorPath: undefined,
      iframe: { contentWindow: { location: { hash: "#old" } } },
      captureAnchor() {},
      emit() {},
      commitWithinChapterPage: (ChapterPaginator.prototype as unknown as { commitWithinChapterPage: (page: number, candidate: unknown) => void }).commitWithinChapterPage,
      getWithinChapterFragmentPage: (ChapterPaginator.prototype as unknown as { getWithinChapterFragmentPage: (fragment: string) => unknown }).getWithinChapterFragmentPage,
    };
    expect(navigate.call(context, { fragment: "target" })).toBe(true);
    expect(context.metrics.currentPage).toBe(1);
    expect(context.viewer.scrollLeft).toBe(100);
    expect(context.iframe.contentWindow.location.hash).toBe("#target");
    expect(navigate.call(context, { fragment: "missing" })).toBe(false);
    expect(context.metrics.currentPage).toBe(1);
    expect(context.iframe.contentWindow.location.hash).toBe("#target");
  });

  it("restores the live anchor and hash when anchor resolution throws", () => {
    const navigate = (ChapterPaginator.prototype as unknown as Harness).navigateWithinCurrentChapter;
    const oldAnchor = {
      index: 2,
      ratio: 0.5,
      textOffset: 8,
      textSnippet: "旧文",
      charsRead: 8,
      totalChars: 20,
    };
    const context = {
      disposed: false,
      _currentPath: "Text/chapter.xhtml",
      viewer: { scrollLeft: 200 } as unknown as HTMLElement,
      contentDoc: {},
      step: 100,
      metrics: { pageCount: 4, currentPage: 2 },
      lastState: { status: "ready", pageCount: 4, currentPage: 2, empty: false },
      anchor: { ...oldAnchor },
      anchorPath: "Text/chapter.xhtml",
      iframe: { contentWindow: { location: { hash: "#old" } } },
      resolveAnchorCol: () => {
        throw new Error("Range failed");
      },
      emit() {},
      captureAnchor() {},
      commitWithinChapterPage: (ChapterPaginator.prototype as unknown as { commitWithinChapterPage: (page: number, candidate: unknown) => void }).commitWithinChapterPage,
    };
    expect(
      navigate.call(context, {
        readingAnchor: {
          index: 1,
          ratio: 0.5,
          anchorTextOffset: 12,
          anchorTextSnippet: "新文",
        },
        fallbackPage: 1,
      })
    ).toBe(false);
    expect(context.metrics.currentPage).toBe(2);
    expect(context.viewer.scrollLeft).toBe(200);
    expect(context.anchor).toEqual(oldAnchor);
    expect(context.anchorPath).toBe("Text/chapter.xhtml");
    expect(context.iframe.contentWindow.location.hash).toBe("#old");
  });
});

describe("internal link history notification", () => {
  const handleLinkClick = (
    ChapterPaginator.prototype as unknown as {
      handleLinkClick: (this: unknown, event: Event) => void;
    }
  ).handleLinkClick;

  function invoke(href: string, targetExists = true) {
    const before: string[] = [];
    const navigated: string[] = [];
    const external: string[] = [];
    const jumped: string[] = [];
    let settled = 0;
    const link = {
      getAttribute: (name: string) => (name === "href" ? href : null),
      classList: { contains: () => false },
      querySelector: () => null,
      closest: (selector: string) => (selector === "a" ? link : null),
    } as unknown as HTMLAnchorElement;
    const event = {
      target: link,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as Event;
    const context = {
      iframe: { contentWindow: { location: { hash: "" } } },
      contentDoc: {
        getElementById: () => (targetExists ? { getBoundingClientRect: () => ({ left: 0 }) } : null),
      },
      viewer: { scrollLeft: 0 },
      step: 1,
      metrics: { pageCount: 3, currentPage: 1 },
      lastState: { status: "ready", pageCount: 3, currentPage: 1, empty: false },
      _currentPath: "Text/chapter.xhtml",
      navigateWithinCurrentChapter: (ChapterPaginator.prototype as unknown as { navigateWithinCurrentChapter: (options: unknown) => boolean }).navigateWithinCurrentChapter,
      getWithinChapterFragmentPage: (ChapterPaginator.prototype as unknown as { getWithinChapterFragmentPage: (fragment: string) => unknown }).getWithinChapterFragmentPage,
      commitWithinChapterPage: (ChapterPaginator.prototype as unknown as { commitWithinChapterPage: (page: number, candidate: unknown) => void }).commitWithinChapterPage,
      captureAnchor() {},
      emit() {},
      onBeforeInternalNavigate: (value: string) => {
        // App 的真实回调会以 Book/spine 校验跨章目标；保留这个边界
        // harness 以确保 paginator 传递的是解析后的 href，而不是裸点击值。
        if (value === "chapter0000.xhtml#top" || value === "Text/chapter.xhtml#target%201" || value === "Text/chapter.xhtml" || value.startsWith("#")) before.push(value);
      },
      onNavigate: (value: string) => navigated.push(value),
      onExternalLink: (value: string) => external.push(value),
      jumpToAnchor: (value: string) => jumped.push(value),
      onInternalNavigationSettled: () => {
        settled += 1;
      },
    };
    handleLinkClick.call(context, event);
    return { before, navigated, external, jumped, settled };
  }

  it("跨章与同章 fragment 各通知一次，外部链接不通知", () => {
    expect(invoke("../chapter0000.xhtml#top")).toMatchObject({
      before: ["chapter0000.xhtml#top"],
      navigated: ["chapter0000.xhtml#top"],
      jumped: [],
      external: [],
    });
    expect(invoke("#target%201")).toMatchObject({
      before: ["#target%201"],
      navigated: [],
      jumped: ["target 1"],
      external: [],
      settled: 1,
    });
    expect(invoke("chapter.xhtml#target%201")).toMatchObject({
      before: ["Text/chapter.xhtml#target%201"],
      navigated: [],
      jumped: [],
      external: [],
      settled: 1,
    });
    expect(invoke("chapter.xhtml")).toMatchObject({
      before: ["Text/chapter.xhtml"],
      navigated: [],
      jumped: [],
      external: [],
      settled: 1,
    });
    expect(invoke("missing.xhtml#target")).toMatchObject({
      before: [],
      navigated: ["Text/missing.xhtml#target"],
    });
    expect(invoke("#missing", false)).toMatchObject({
      before: [],
      navigated: [],
      jumped: [],
      settled: 0,
      external: [],
    });
    expect(invoke("https://example.com")).toMatchObject({
      before: [],
      navigated: [],
      jumped: [],
      external: ["https://example.com"],
    });
  });
});

describe("book margin layout", () => {
  describe("percentage float group containment", () => {
    const entry = (overrides: Partial<Parameters<typeof getPercentageFloatGroupMembers>[0][number]> = {}) => ({
      eligible: true,
      readerTop: true,
      float: "left",
      clear: "none",
      percentageWidth: 20,
      ...overrides,
    });

    it("跳过 20*5、50*2 和 33.333*3 的整行同向 float", () => {
      expect(getPercentageFloatGroupMembers([
        entry(), entry(), entry(), entry(), entry(),
      ])).toEqual([true, true, true, true, true]);
      expect(getPercentageFloatGroupMembers([
        entry({ percentageWidth: 50 }), entry({ percentageWidth: 50 }),
      ])).toEqual([true, true]);
      expect(getPercentageFloatGroupMembers([
        entry({ percentageWidth: 33.333 }), entry({ percentageWidth: 33.333 }), entry({ percentageWidth: 33.333 }),
      ])).toEqual([true, true, true]);
    });

    it("只豁免连续整行组；单个/不满整行/混合方向或 clear 不豁免", () => {
      expect(getPercentageFloatGroupMembers([entry({ percentageWidth: 70 })])).toEqual([false]);
      expect(getPercentageFloatGroupMembers([entry(), entry()])).toEqual([false, false]);
      expect(getPercentageFloatGroupMembers([
        entry(), entry({ percentageWidth: 20, float: "right" }),
      ])).toEqual([false, false]);
      expect(getPercentageFloatGroupMembers([
        entry(), entry({ percentageWidth: 20, clear: "both" }), entry(), entry(), entry(), entry(),
      ])).toEqual([false, false, false, false, false, false]);
      expect(getPercentageFloatGroupMembers([
        entry(), entry({ percentageWidth: null }), entry(), entry(), entry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getPercentageFloatGroupMembers([
        entry(), entry({ percentageWidth: undefined }), entry(), entry(), entry(),
      ])).toEqual([false, false, false, false, false]);
    });

    it("混合 px/% 或普通块打断时不组成组", () => {
      expect(getPercentageFloatGroupMembers([
        entry(), entry({ percentageWidth: null }), entry(), entry(), entry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getPercentageFloatGroupMembers([
        entry(), entry({ eligible: false }), entry(), entry(), entry(),
      ])).toEqual([false, false, false, false, false]);
    });

    const safeEntry = (overrides: Partial<Parameters<typeof getPercentageFloatGroupMembers>[0][number]> = {}) => ({
      ...entry(),
      marginLeft: "0px",
      marginRight: "0px",
      position: "static",
      writingMode: "horizontal-tb",
      direction: "ltr",
      authorFullWidthIntent: false,
      percentageMargin: false,
      ...overrides,
    });

    it("阶段2只接受安全的静态水平零 margin 完整组", () => {
      expect(getSafePercentageFloatGroupMembers([
        safeEntry(), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([true, true, true, true, true]);
      expect(getSafePercentageFloatGroupMembers([
        safeEntry({ marginRight: "1px" }), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getSafePercentageFloatGroupMembers([
        safeEntry({ marginRight: "20%" }), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getSafePercentageFloatGroupMembers([
        safeEntry({ percentageMargin: undefined }), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getSafePercentageFloatGroupMembers([
        safeEntry({ marginRight: "-1px" }), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getSafePercentageFloatGroupMembers([
        safeEntry({ position: "absolute" }), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getSafePercentageFloatGroupMembers([
        safeEntry({ direction: "rtl" }), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([false, false, false, false, false]);
      expect(getSafePercentageFloatGroupMembers([
        safeEntry({ authorFullWidthIntent: true }), safeEntry(), safeEntry(), safeEntry(), safeEntry(),
      ])).toEqual([false, false, false, false, false]);
    });

    it("阶段2将完整组按 min(百分比包含块, 百分比40rem) 限宽", () => {
      expect(getPercentageFloatGroupTargetWidths([20, 20, 20, 20, 20], 1264, 640))
        .toEqual([128, 128, 128, 128, 128]);
      expect(getPercentageFloatGroupTargetWidths([50, 50], 500, 640))
        .toEqual([250, 250]);
      expect(getPercentageFloatGroupTargetWidths([33.333, 33.333, 33.333], 1264, 640)?.[0])
        .toBeCloseTo(213.3312, 4);
      expect(getPercentageFloatGroupTargetWidths([20, 20], 1264, 640)).toBeNull();
    });

    it("组级几何门拒绝拆行、跨列和 padding/border 造成的版心越界", () => {
      const row = [
        [{ left: 312, right: 440, top: 10, width: 128 }],
        [{ left: 440, right: 568, top: 10, width: 128 }],
        [{ left: 568, right: 696, top: 10, width: 128 }],
        [{ left: 696, right: 824, top: 10, width: 128 }],
        [{ left: 824, right: 952, top: 10, width: 128 }],
      ];
      const base = {
        rects: row,
        viewerLeft: 0,
        scrollLeft: 0,
        step: 1264,
        parentWidth: 1264,
        contentWidth: 640,
      } as const;
      expect(isPercentageFloatGroupGeometryValid(base)).toBe(true);
      expect(isPercentageFloatGroupGeometryValid({
        ...base,
        rects: row.map((rect, index) => index === 4 ? [{ ...rect[0], top: 20 }] : rect),
      })).toBe(false);
      expect(isPercentageFloatGroupGeometryValid({
        ...base,
        rects: row.map((rect, index) => index === 4 ? [{ ...rect[0], right: 962, width: 130 }] : rect),
      })).toBe(false);
      expect(isPercentageFloatGroupGeometryValid({
        ...base,
        rects: row.map((rect, index) => index === 4 ? [{ ...rect[0], left: 1264, right: 1392 }] : rect),
      })).toBe(false);
    });
  });

  describe("authored percentage float width", () => {
    it("优先接受最终 Typed OM 百分比，缺失时按 CSSOM 级联回退", () => {
      const typed = {
        computedStyleMap: () => ({ get: () => ({ toString: () => "20%" }) }),
        style: { getPropertyValue: () => "" },
      } as unknown as Element;
      expect(getAuthoredPercentageWidth(typed, { styleSheets: [] } as unknown as Document)).toBe(20);

      const widthRule = {
        type: 1,
        selectorText: ".opacity",
        style: { getPropertyValue: (property: string) => property === "width" ? "20%" : "", getPropertyPriority: () => "" },
      } as unknown as CSSRule;
      const el = {
        matches: (selector: string) => selector === ".opacity",
        style: { getPropertyValue: () => "" },
      } as unknown as Element;
      expect(getAuthoredPercentageWidth(el, {
        styleSheets: [{ ownerNode: null, cssRules: [widthRule] }],
      } as unknown as Document)).toBe(20);
    });

    it("Typed OM 的最终 px 值不得回退为早期 CSSOM 百分比", () => {
      const el = {
        computedStyleMap: () => ({ get: () => ({ toString: () => "30px" }) }),
        style: { getPropertyValue: () => "" },
      } as unknown as Element;
      const widthRule = {
        type: 1,
        selectorText: ".opacity",
        style: { getPropertyValue: () => "20%", getPropertyPriority: () => "" },
      } as unknown as CSSRule;
      expect(getAuthoredPercentageWidth(el, {
        styleSheets: [{ ownerNode: null, cssRules: [widthRule] }],
      } as unknown as Document)).toBeNull();
    });

    it("Typed OM 没有 width 值时才允许回退 CSSOM", () => {
      const el = {
        computedStyleMap: () => ({ get: () => undefined }),
        matches: (selector: string) => selector === ".opacity",
        style: { getPropertyValue: () => "" },
      } as unknown as Element;
      const widthRule = {
        type: 1,
        selectorText: ".opacity",
        style: { getPropertyValue: () => "20%", getPropertyPriority: () => "" },
      } as unknown as CSSRule;
      expect(getAuthoredPercentageWidth(el, {
        styleSheets: [{ ownerNode: null, cssRules: [widthRule] }],
      } as unknown as Document)).toBe(20);
    });

    it("CSSOM 回退尊重 important 与简单特异性覆盖", () => {
      const rule = (selectorText: string, value: string, priority = "") => ({
        type: 1,
        selectorText,
        style: {
          getPropertyValue: (property: string) => property === "width" ? value : "",
          getPropertyPriority: () => priority,
        },
      } as unknown as CSSRule);
      const el = {
        matches: (selector: string) => selector === ".opacity" || selector === "div.opacity",
        style: { getPropertyValue: () => "20%", getPropertyPriority: () => "" },
      } as unknown as Element;
      expect(getAuthoredPercentageWidth(el, {
        styleSheets: [{ ownerNode: null, cssRules: [rule(".opacity", "30px", "important")] }],
      } as unknown as Document)).toBeNull();
      const stylesheetOnlyEl = {
        matches: (selector: string) => selector === ".opacity" || selector === "div.opacity",
        style: { getPropertyValue: () => "", getPropertyPriority: () => "" },
      } as unknown as Element;
      expect(getAuthoredPercentageWidth(stylesheetOnlyEl, {
        styleSheets: [{ ownerNode: null, cssRules: [rule("div.opacity", "30px"), rule(".opacity", "20%")] }],
      } as unknown as Document)).toBeNull();
    });

    it("inline important 百分比在不可读 stylesheet 下仍可确认", () => {
      const el = {
        style: { getPropertyValue: () => "20%", getPropertyPriority: () => "important" },
      } as unknown as Element;
      const blocked = {
        ownerNode: null,
        get cssRules(): CSSRuleList { throw new Error("SecurityError"); },
      } as unknown as CSSStyleSheet;
      expect(getAuthoredPercentageWidth(el, { styleSheets: [blocked] } as unknown as Document)).toBe(20);
    });

    it("reader overrides 中有匹配 width 时旧 CSSOM 回退保守为 unknown", () => {
      const rule = (selectorText: string, value: string) => ({
        type: 1,
        selectorText,
        style: { getPropertyValue: () => value, getPropertyPriority: () => "" },
      } as unknown as CSSRule);
      const el = {
        matches: (selector: string) => selector === ".opacity",
        style: { getPropertyValue: () => "" },
      } as unknown as Element;
      const readerSheet = {
        ownerNode: { getAttribute: (name: string) => name === "data-reader" ? "overrides" : null },
        cssRules: [rule(".opacity", "30px")],
      };
      const authorSheet = { ownerNode: null, cssRules: [rule(".opacity", "20%")] };
      expect(getAuthoredPercentageWidth(el, {
        styleSheets: [authorSheet, readerSheet],
      } as unknown as Document)).toBeUndefined();
    });

    it("复杂伪类选择器不能由旧 CSSOM 特异性猜测", () => {
      const rule = {
        type: 1,
        selectorText: ".opacity:is(.a, .b)",
        style: { getPropertyValue: () => "20%", getPropertyPriority: () => "" },
      } as unknown as CSSRule;
      const el = {
        matches: (selector: string) => selector === ".opacity:is(.a, .b)",
        style: { getPropertyValue: () => "" },
      } as unknown as Element;
      expect(getAuthoredPercentageWidth(el, {
        styleSheets: [{ ownerNode: null, cssRules: [rule] }],
      } as unknown as Document)).toBeUndefined();
    });

    it("未知 CSSOM 不得把 float 误判为可豁免组", () => {
      const el = { style: { getPropertyValue: () => "" } } as unknown as Element;
      const blocked = {
        ownerNode: null,
        get cssRules(): CSSRuleList { throw new Error("SecurityError"); },
      } as unknown as CSSStyleSheet;
      expect(getAuthoredPercentageWidth(el, { styleSheets: [blocked] } as unknown as Document)).toBeUndefined();
    });

    it("CSSOM 回退选择最终获胜声明，而不是任意早期百分比规则", () => {
      const rule = (value: string, order: number) => ({
        type: 1,
        selectorText: ".opacity",
        style: {
          getPropertyValue: (property: string) => property === "width" ? value : "",
          getPropertyPriority: () => "",
        },
        order,
      } as unknown as CSSRule);
      const el = {
        matches: (selector: string) => selector === ".opacity",
        style: { getPropertyValue: () => "", getPropertyPriority: () => "" },
      } as unknown as Element;
      expect(getAuthoredPercentageWidth(el, {
        styleSheets: [{ ownerNode: null, cssRules: [rule("20%", 1), rule("30px", 2)] }],
      } as unknown as Document)).toBeNull();
    });
  });

  it("只把明确 width/min-width 全宽或 viewport 表达式视为作者突破意图", () => {
    expect(isAuthorFullWidthValue("100%", "width")).toBe(true);
    expect(isAuthorFullWidthValue("100%", "min-width")).toBe(true);
    expect(isAuthorFullWidthValue("100%", "max-width")).toBe(false);
    expect(isAuthorFullWidthValue("none", "max-width")).toBe(false);
    expect(isAuthorFullWidthValue("min(100%, 80px)", "width")).toBe(false);
    expect(isAuthorFullWidthValue("calc(100% + 2rem)", "width")).toBe(true);
    expect(isAuthorFullWidthValue("calc(100vw - 2rem)", "width")).toBe(true);
  });

  it("排除阅读器注入 stylesheet，并只读取当前生效的 media 条件", () => {
    const widthRule = {
      type: 1,
      selectorText: ".fr",
      style: { getPropertyValue: (property: string) => (property === "width" ? "100%" : "") },
    } as unknown as CSSRule;
    const injectedSheet = {
      ownerNode: { getAttribute: () => "overrides" },
      cssRules: [widthRule],
    } as unknown as CSSStyleSheet;
    const authorSheet = { ownerNode: null, cssRules: [widthRule] } as unknown as CSSStyleSheet;
    const el = { matches: (selector: string) => selector === ".fr" } as unknown as HTMLElement;
    const baseWindow = {
      matchMedia: () => ({ matches: false }),
      CSS: { supports: () => false },
    } as unknown as Window;
    const doc = (sheets: CSSStyleSheet[], win = baseWindow) =>
      ({ styleSheets: sheets, defaultView: win }) as unknown as Document;

    expect(hasAuthoredFullWidthIntentInRules(doc([injectedSheet]), el)).toBe(false);
    expect(hasAuthoredFullWidthIntentInRules(doc([authorSheet]), el)).toBe(true);

    const mediaRule = {
      type: 4,
      media: { mediaText: "(min-width: 900px)" },
      cssRules: [widthRule],
    } as unknown as CSSRule;
    expect(
      hasAuthoredFullWidthIntentInRules(
        doc([{ ownerNode: null, cssRules: [mediaRule] } as unknown as CSSStyleSheet]),
        el
      )
    ).toBe(false);
    expect(
      hasAuthoredFullWidthIntentInRules(
        doc(
          [{ ownerNode: null, cssRules: [mediaRule] } as unknown as CSSStyleSheet],
          { ...baseWindow, matchMedia: () => ({ matches: true }) } as unknown as Window
        ),
        el
      )
    ).toBe(true);
    expect(
      hasAuthoredFullWidthIntentInRules(
        doc(
          [{ ownerNode: null, cssRules: [mediaRule] } as unknown as CSSStyleSheet],
          { CSS: {} } as unknown as Window
        ),
        el
      )
    ).toBeUndefined();
  });

  const floatContainment = (
    overrides: Partial<Parameters<typeof getReaderTopFloatContainmentMargins>[0]> = {}
  ) =>
    getReaderTopFloatContainmentMargins({
      readerTop: true,
      float: "right",
      fullpage: false,
      parentWidth: 1280,
      width: 80,
      contentWidth: 640,
      marginLeft: "0px",
      marginRight: "0px",
      authorFullWidthIntent: false,
      ...overrides,
    });

  it("把宽视口的 right/left 顶层 float 内缩到 40rem 版心边缘", () => {
    expect(floatContainment()).toEqual({ left: 0, right: 320 });
    expect(floatContainment({ float: "left" })).toEqual({ left: 320, right: 0 });
  });

  const floatLayout = (
    overrides: Partial<Parameters<typeof getReaderTopFloatLayoutMargins>[0]> = {}
  ) =>
    getReaderTopFloatLayoutMargins({
      readerTop: true,
      float: "right",
      fullpage: false,
      parentWidth: 1280,
      width: 80,
      contentWidth: 640,
      marginLeft: "0px",
      marginRight: "0px",
      authorFullWidthIntent: false,
      authoredHorizontalMargin: false,
      percentageMargin: false,
      position: "static",
      writingMode: "horizontal-tb",
      direction: "ltr",
      ...overrides,
    });

  it("单项 float 保留作者另一侧 margin，并把浮动侧投影到版心", () => {
    expect(floatLayout({ marginRight: "32px", authoredHorizontalMargin: true })).toEqual({
      left: 0,
      right: 352,
    });
    expect(floatLayout({ float: "left", marginLeft: "12px", authoredHorizontalMargin: true })).toEqual({
      left: 332,
      right: 0,
    });
  });

  it("复杂 float 只保留原始布局，不允许进入普通块补偿", () => {
    expect(floatLayout({ percentageMargin: true, marginRight: "32px", authoredHorizontalMargin: true })).toBeNull();
    expect(floatLayout({ percentageMargin: undefined, marginRight: "32px", authoredHorizontalMargin: undefined })).toBeNull();
    expect(floatLayout({ marginRight: "-8px", authoredHorizontalMargin: true })).toBeNull();
    expect(floatLayout({ position: "absolute" })).toBeNull();
    expect(floatLayout({ position: "fixed" })).toBeNull();
    expect(floatLayout({ writingMode: "vertical-rl" })).toBeNull();
    expect(floatLayout({ direction: "rtl" })).toBeNull();
    expect(floatLayout({ authorFullWidthIntent: true })).toBeNull();
    expect(floatLayout({ width: 641 })).toBeNull();
  });

  it("横排包含块内的竖排引文仍按物理 right float 收进版心", () => {
    expect(floatLayout({ writingMode: "vertical-rl", parentWritingMode: "horizontal-tb", width: 24,
      marginRight: "38.4px", authoredHorizontalMargin: true })).toEqual({ left: 0, right: 358.4 });
    expect(floatLayout({ writingMode: "vertical-rl", parentWritingMode: "vertical-rl" })).toBeNull();
  });

  it("无 margin 的顶层 float 仍复用 C-31 版心投影", () => {
    expect(floatLayout()).toEqual({ left: 0, right: 320 });
    expect(floatLayout({ float: "left" })).toEqual({ left: 320, right: 0 });
    expect(floatLayout({ parentWidth: 500 })).toEqual({ left: 0, right: 0 });
  });

  it("窄于版心的容器不额外写入 margin", () => {
    expect(floatContainment({ parentWidth: 500 })).toEqual({ left: 0, right: 0 });
  });

  it("作者已有水平 margin、全页布局或过宽盒子时保守跳过", () => {
    expect(floatContainment({ marginRight: "8px" })).toBeNull();
    expect(floatContainment({ fullpage: true })).toBeNull();
    expect(floatContainment({ width: 641 })).toBeNull();
    expect(floatContainment({ authorFullWidthIntent: true })).toBeNull();
    expect(floatContainment({ readerTop: false })).toBeNull();
  });

  it("用 border-box 宽度识别带 padding/border 的 auto 居中盒", () => {
    expect(
      getBorderBoxWidth({
        width: "446px",
        boxSizing: "content-box",
        paddingLeft: "8px",
        paddingRight: "8px",
        borderLeftWidth: "1px",
        borderRightWidth: "1px",
      })
    ).toBe(464);
    expect(
      getBorderBoxWidth({
        width: "464px",
        boxSizing: "border-box",
        paddingLeft: "8px",
        paddingRight: "8px",
        borderLeftWidth: "1px",
        borderRightWidth: "1px",
      })
    ).toBe(464);
  });

  it("hr 的 1px 双侧边框计入版心宽度，避免被误判为书籍不对称 margin", () => {
    const width = getBorderBoxWidth({
      width: "640px",
      boxSizing: "content-box",
      paddingLeft: "0px",
      paddingRight: "0px",
      borderLeftWidth: "1px",
      borderRightWidth: "1px",
    });
    expect(width).toBe(642);
    expect((1280 - width) / 2).toBe(319);
  });

  it("正值且相等的书籍水平 margin 是双侧留白，不应被解释成单向缩进", () => {
    expect(isSymmetricHorizontalMargin("16px", "16px")).toBe(true);
    expect(isSymmetricHorizontalMargin("16px", "16.3px")).toBe(true);
    expect(isSymmetricHorizontalMargin("16px", "17px")).toBe(false);
    expect(isSymmetricHorizontalMargin("16px", "0px")).toBe(false);
    expect(isSymmetricHorizontalMargin("-16px", "-16px")).toBe(false);
    expect(isSymmetricHorizontalMargin("auto", "auto")).toBe(false);
  });

  it("把 reader-top 的 UA 对称 inset 转成居中的有效宽度", () => {
    const base = {
      readerTop: true,
      authoredHorizontalMargin: false as const,
      float: "none",
      fullpage: false,
      percentageMargin: false,
      parentWidth: 1264,
      borderBoxWidth: 640,
      cssWidth: 640,
      boxSizing: "content-box",
      marginLeft: "40px",
      marginRight: "40px",
    };

    // 40rem 正文版心保留 UA blockquote 两侧各 40px 后，应为约 560px，
    // 最终仍由 reader-top auto margin 居中，而不是走 C-04 单侧右移。
    expect(getReaderTopUaSymmetricInsetMaxWidth(base)).toBe(560);

    // 窄视口必须收敛到包含块内，不得产生负 max-width 或横向溢出。
    expect(
      getReaderTopUaSymmetricInsetMaxWidth({
        ...base,
        parentWidth: 280,
        borderBoxWidth: 280,
        cssWidth: 280,
      })
    ).toBe(200);

    expect(
      getReaderTopUaSymmetricInsetMaxWidth({ ...base, authoredHorizontalMargin: true })
    ).toBeNull();
    expect(getReaderTopUaSymmetricInsetMaxWidth({ ...base, readerTop: false })).toBeNull();
    expect(getReaderTopUaSymmetricInsetMaxWidth({ ...base, float: "left" })).toBeNull();
    expect(getReaderTopUaSymmetricInsetMaxWidth({ ...base, fullpage: true })).toBeNull();
    expect(getReaderTopUaSymmetricInsetMaxWidth({ ...base, percentageMargin: true })).toBeNull();
    expect(
      getReaderTopUaSymmetricInsetMaxWidth({ ...base, marginRight: "41px" })
    ).toBeNull();
    expect(
      getReaderTopUaSymmetricInsetMaxWidth({ ...base, marginLeft: "0px" })
    ).toBeNull();
  });

  it("只让 intrinsic-size 盒保留正对称 margin 居中，普通目录标题继续走 C-04", () => {
    // 侦探少年目录标题：width:auto + margin:.75em，旧版 C-04 会把标题
    // 放在正文版心左缘再缩进 24px；不能因左右数值相等就吞掉这个缩进。
    expect(shouldKeepSymmetricMarginsCentered("24px", "24px", false)).toBe(false);

    // C-18 的原始目标：fit/max-content 灰框的 margin:1em 是双侧留白，
    // 经 intrinsic-size 补偿后仍应保持 reader auto 居中。
    expect(shouldKeepSymmetricMarginsCentered("16px", "16px", true)).toBe(true);
  });

  it("C-40 仅让无 sizing intent 的居中普通块保留自然版心居中", () => {
    const centered = {
      readerTop: true,
      float: "none",
      writingMode: "horizontal-tb",
      fullpage: false,
      intrinsicSize: false,
      percentageMargin: false,
      authoredHorizontalMargin: true as const,
      authoredSizingIntent: false as const,
      textAlign: "center",
      marginLeft: "24px",
      marginRight: "24px",
    };
    expect(shouldKeepCenteredAuthorMargins(centered)).toBe(true);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, textAlign: "left" })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, authoredSizingIntent: true })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, authoredSizingIntent: undefined })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, authoredHorizontalMargin: false })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, marginRight: "25px" })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, marginLeft: "-24px", marginRight: "-24px" })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, percentageMargin: true })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, float: "right" })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, intrinsicSize: true })).toBe(false);
    expect(shouldKeepCenteredAuthorMargins({ ...centered, fullpage: true })).toBe(false);
  });

  it("作者 sizing intent 只在可读的 width/min/max 声明中确认为 true，阅读器默认 max-width 不计入", () => {
    const el = {
      style: { getPropertyValue: (property: string) => property === "width" ? "" : "" },
      getAttribute: (name: string) => name === "style" ? "" : null,
      hasAttribute: () => false,
      matches: (selector: string) => selector === ".target",
    } as unknown as HTMLElement;
    const authorWidth = {
      type: 1,
      selectorText: ".target",
      style: { getPropertyValue: (property: string) => property === "width" ? "20em" : "" },
    } as unknown as CSSRule;
    const doc = {
      defaultView: null,
      styleSheets: [{ ownerNode: null, cssRules: [authorWidth] }],
    } as unknown as Document;
    expect(hasAuthoredSizingIntent(doc, el)).toBe(true);
    const keyframes = {
      type: 7,
      cssRules: [{ type: 8, style: { getPropertyValue: () => "20em" } }],
    } as unknown as CSSRule;
    expect(
      hasAuthoredSizingIntent({ defaultView: null, styleSheets: [{ ownerNode: null, cssRules: [keyframes] }] } as unknown as Document, el)
    ).toBe(false);
    for (const property of ["min-width", "max-width"]) {
      const sizedRule = {
        type: 1,
        selectorText: ".target",
        style: { getPropertyValue: (name: string) => name === property ? "12em" : "" },
      } as unknown as CSSRule;
      expect(
        hasAuthoredSizingIntent({
          defaultView: null,
          styleSheets: [{ ownerNode: null, cssRules: [sizedRule] }],
        } as unknown as Document, el)
      ).toBe(true);
    }
    expect(hasAuthoredSizingIntent({ defaultView: null, styleSheets: [] } as unknown as Document, el)).toBe(false);
    const unreadable = {
      defaultView: null,
      styleSheets: [{ ownerNode: null, get cssRules(): CSSRuleList { throw new Error("SecurityError"); } }],
    } as unknown as Document;
    expect(hasAuthoredSizingIntent(unreadable, el)).toBeUndefined();
    const readerOwner = {
      hasAttribute: (name: string) => name === "data-reader",
      getAttribute: (name: string) => name === "data-reader" ? "overrides" : null,
    } as unknown as Element;
    const readerDefault = {
      type: 1,
      selectorText: ":where(#epub-viewer .reader-top)",
      style: { getPropertyValue: (property: string) => property === "max-width" ? "40rem" : "" },
    } as unknown as CSSRule;
    expect(
      hasAuthoredSizingIntent({ defaultView: null, styleSheets: [{ ownerNode: readerOwner, cssRules: [readerDefault] }] } as unknown as Document, el)
    ).toBe(false);
    const readerCustom = {
      type: 1,
      selectorText: ".target",
      style: { getPropertyValue: (property: string) => property === "width" ? "20em" : "" },
    } as unknown as CSSRule;
    expect(
      hasAuthoredSizingIntent({ defaultView: null, styleSheets: [{ ownerNode: readerOwner, cssRules: [readerCustom] }] } as unknown as Document, el)
    ).toBeUndefined();
  });

  it("固定宽度的显式对称 margin 不冒充 auto 居中，解析后的 auto margin 仍保持居中", () => {
    expect(
      isAutoLikeHorizontalMargin({
        parentWidth: 1280,
        width: 480,
        marginLeft: 16,
        marginRight: 16,
      })
    ).toBe(false);
    expect(
      isAutoLikeHorizontalMargin({
        parentWidth: 1280,
        width: 480,
        marginLeft: 400,
        marginRight: 400,
      })
    ).toBe(true);
  });

  it("把作者的百分比水平 margin 作为包含块布局，而不是版心内缩进", () => {
    expect(
      hasPercentageHorizontalMargin({ margin: "0 0 0 35%", marginLeft: "", marginRight: "" })
    ).toBe(true);
    expect(
      hasPercentageHorizontalMargin({ margin: "5% 0", marginLeft: "", marginRight: "" })
    ).toBe(false);
    expect(isPercentageMarginLayout(true, "448px", "0px")).toBe(true);
    expect(isPercentageMarginLayout(true, "0px", "0px")).toBe(false);
    expect(isPercentageMarginLayout(false, "448px", "0px")).toBe(false);
  });

  it("临时解除 reader auto margin 后，Typed OM 以最终获胜值识别百分比和 calc", () => {
    const typed = (left: string, right = "0px"): Element =>
      ({
        computedStyleMap: () =>
          new Map([
            ["margin-left", { toString: () => left }],
            ["margin-right", { toString: () => right }],
          ]),
      }) as unknown as Element;

    expect(hasComputedPercentageHorizontalMargin(typed("70%"))).toBe(true);
    expect(hasComputedPercentageHorizontalMargin(typed("calc(70% - 1em)"))).toBe(true);
    expect(hasComputedPercentageHorizontalMargin(typed("32px", "24px"))).toBe(false);
    expect(hasComputedPercentageHorizontalMargin({} as Element)).toBeUndefined();
  });

  it("不可读外链样式表不阻断 CSSOM 回退，且不把不完整扫描当成否定结论", () => {
    const percentageRule = {
      selectorText: ".percent",
      style: { margin: "", marginLeft: "70%", marginRight: "" },
    } as unknown as CSSRule;
    const blockedSheet = {
      get cssRules(): CSSRuleList {
        throw new Error("SecurityError");
      },
    } as unknown as CSSStyleSheet;
    const readableSheet = { cssRules: [percentageRule] } as unknown as CSSStyleSheet;
    const doc = { styleSheets: [blockedSheet, readableSheet] } as unknown as Document;
    const matching = {
      matches: (selector: string) => selector === ".percent",
    } as unknown as Element;
    const nonMatching = { matches: () => false } as unknown as Element;

    expect(hasPercentageHorizontalMarginInRules(doc, matching)).toBe(true);
    expect(hasPercentageHorizontalMarginInRules(doc, nonMatching)).toBeUndefined();
  });

  it("只把注释外的 inline 水平 margin 视为作者意图", () => {
    const inline = (styleText: string) =>
      ({ getAttribute: () => styleText, matches: () => false }) as unknown as HTMLElement;

    expect(hasAuthoredHorizontalMargin({ styleSheets: [] } as unknown as Document, inline("font-size:.875em"))).toBe(false);
    expect(hasAuthoredHorizontalMargin({ styleSheets: [] } as unknown as Document, inline("margin: 1em"))).toBe(true);
    expect(hasAuthoredHorizontalMargin({ styleSheets: [] } as unknown as Document, inline("margin-inline-start: 2em"))).toBe(true);
    expect(hasAuthoredHorizontalMargin({ styleSheets: [] } as unknown as Document, inline("/* margin-left: 40px */ font-size:.875em"))).toBe(false);
  });

  it("只扫描当前匹配且生效的规则，并对未知 CSSOM 保守返回 undefined", () => {
    const styleRule = (selector: string, declarations: Record<string, string>) =>
      ({
        type: 1,
        selectorText: selector,
        style: { getPropertyValue: (property: string) => declarations[property] ?? "" },
      }) as unknown as CSSRule;
    const el = {
      getAttribute: () => "",
      matches: (selector: string) => selector === ".target",
    } as unknown as HTMLElement;
    const doc = (rules: CSSRule[], win?: Window) =>
      ({
        styleSheets: [{ ownerNode: null, cssRules: rules }],
        defaultView: win,
      }) as unknown as Document;

    expect(hasAuthoredHorizontalMargin(doc([styleRule(".target", { "margin-left": "2em" })]), el)).toBe(true);
    expect(hasAuthoredHorizontalMargin(doc([styleRule(".other", { margin: "1em" })]), el)).toBe(false);
    expect(
      hasAuthoredHorizontalMargin(
        doc(
          [{
            type: 4,
            media: { mediaText: "(min-width: 900px)" },
            cssRules: [styleRule(".target", { "margin-inline": "1em" })],
          } as unknown as CSSRule],
          { matchMedia: () => ({ matches: true }) } as unknown as Window
        ),
        el
      )
    ).toBe(true);
    expect(
      hasAuthoredHorizontalMargin(
        doc(
          [{
            type: 12,
            conditionText: "(display: grid)",
            cssRules: [styleRule(".target", { "margin-right": "1em" })],
          } as unknown as CSSRule],
          { CSS: { supports: () => false } } as unknown as Window
        ),
        el
      )
    ).toBe(false);
    expect(
      hasAuthoredHorizontalMargin(
        doc(
          [{ type: 23, cssRules: [styleRule(".target", { margin: "1em" })] } as unknown as CSSRule],
          {} as Window
        ),
        el
      )
    ).toBeUndefined();
    expect(
      hasAuthoredHorizontalMargin(
        {
          styleSheets: [{
            get cssRules(): CSSRuleList { throw new Error("SecurityError"); },
          }],
        } as unknown as Document,
        el
      )
    ).toBeUndefined();
  });

  it("reader stylesheet 在移除 L3 auto margin 后仍承认用户的显式 margin", () => {
    const el = {
      getAttribute: () => "",
      matches: (selector: string) => selector === ".target",
    } as unknown as HTMLElement;
    const userMargin = {
      type: 1,
      selectorText: ".target",
      style: { getPropertyValue: (property: string) => property === "margin-inline-end" ? "3em" : "" },
    } as unknown as CSSRule;
    const doc = {
      styleSheets: [{ ownerNode: { getAttribute: () => "overrides" }, cssRules: [userMargin] }],
    } as unknown as Document;
    expect(hasAuthoredHorizontalMargin(doc, el)).toBe(true);
  });

  it("C-04 只跳过已知没有作者水平 margin 的 UA 默认值", () => {
    expect(shouldApplyBookMarginCompensation(false)).toBe(false);
    expect(shouldApplyBookMarginCompensation(true)).toBe(true);
    expect(shouldApplyBookMarginCompensation(undefined)).toBe(true);
  });

  it("只有能进入 C-04 的 nonzero/未知 margin 才需要来源探测", () => {
    expect(isMeaningfulHorizontalMargin("")).toBe(false);
    expect(isMeaningfulHorizontalMargin("auto")).toBe(false);
    expect(isMeaningfulHorizontalMargin("0px")).toBe(false);
    expect(isMeaningfulHorizontalMargin("0%")).toBe(false);
    expect(isMeaningfulHorizontalMargin("40px")).toBe(true);
    expect(isMeaningfulHorizontalMargin("calc(var(--indent) * 1px)")).toBe(true);
  });

  it("C-16 百分比 margin 直接返回，不触发 C-37 的 CSSOM 来源探测", () => {
    expect(shouldProbeAuthoredHorizontalMargin(undefined, "0px", "auto")).toBe(false);
    expect(shouldProbeAuthoredHorizontalMargin(undefined, "40px", "0px")).toBe(true);
    expect(shouldProbeAuthoredHorizontalMargin(true, "448px", "0px")).toBe(false);
  });

  it("只在作者原位可容纳、叠加版心才越列时保留未知来源的水平 margin", () => {
    // C-04 的普通 2em 缩进仍可在正文版心内放下。
    expect(
      shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
        parentWidth: 1280,
        width: 640,
        marginLeft: 32,
        marginRight: 0,
      })
    ).toBe(false);
    // 赤月目录：70% + 1.5em 原位可放下，但再加 base 会越出列。
    expect(
      shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
        parentWidth: 1280,
        width: 96,
        marginLeft: 896,
        marginRight: 24,
      })
    ).toBe(true);
    // 作者原位本就越列，不替作者重写为“安全布局”。
    expect(
      shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
        parentWidth: 1280,
        width: 300,
        marginLeft: 1000,
        marginRight: 24,
      })
    ).toBe(false);
    // 作者只写 left:28px、right:auto 时，computed right 是 612px 的剩余值；
    // 原位刚好填满包含块，不能把它误判成页面相对 margin。
    expect(
      shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
        parentWidth: 1280,
        width: 640,
        marginLeft: 28,
        marginRight: 612,
      })
    ).toBe(false);
    // auto 的已分配余量也不能被误认为作者的百分比布局。
    expect(
      shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
        parentWidth: 1280,
        width: 640,
        marginLeft: 320,
        marginRight: 320,
      })
    ).toBe(false);
  });

  it("恢复被二阶段布局覆盖的 inline 值及 !important 优先级", () => {
    const values = new Map<string, string>([
      ["margin-left", "35%"],
      ["max-width", "none"],
    ]);
    const priorities = new Map<string, string>([["margin-left", "important"]]);
    const style = {
      getPropertyValue: (property: string) => values.get(property) ?? "",
      getPropertyPriority: (property: string) => priorities.get(property) ?? "",
      setProperty: (property: string, value: string, priority = "") => {
        values.set(property, value);
        if (priority) priorities.set(property, priority);
        else priorities.delete(property);
      },
      removeProperty: (property: string) => {
        values.delete(property);
        priorities.delete(property);
        return "";
      },
    } as unknown as CSSStyleDeclaration;

    restoreInlineStyleProperty(style, "margin-left", { value: "35%", priority: "important" });
    restoreInlineStyleProperty(style, "max-width", { value: "", priority: "" });

    expect(style.getPropertyValue("margin-left")).toBe("35%");
    expect(style.getPropertyPriority("margin-left")).toBe("important");
    expect(style.getPropertyValue("max-width")).toBe("");
  });
});
