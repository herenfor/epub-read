import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { ChapterPaginator } from "./paginator";
import { DEFAULT_SETTINGS } from "./settings";

/** 私有入口的测试门面：与既有 harness 一样用 prototype + call 执行真实实现。 */
const internals = ChapterPaginator.prototype as unknown as {
  setPage(this: unknown, page: number): void;
  recomputeScroll(this: unknown): void;
  syncScrollMetrics(this: unknown, capture: boolean): void;
  handleWheel(this: unknown, event: unknown): void;
  handleKey(this: unknown, event: unknown): void;
  scrollByDelta(this: unknown, deltaY: number): void;
  scrollByViewport(this: unknown, direction: 1 | -1): boolean;
  captureAnchor(this: unknown): void;
  navigateToSearchTarget(this: unknown, request: unknown): string;
  imageCandidate(this: unknown, target: Element): Element | null;
  renderScrollChapterEnd(this: unknown): void;
};

interface ScrollContext {
  lastState: unknown;
  metrics: { pageCount: number; currentPage: number };
  onWheelNavigate?: (dir: 1 | -1) => void;
  onKeyNavigate?: (dir: 1 | -1) => void;
  wheelAcc?: number;
  [key: string]: unknown;
}

/**
 * 滚动模式的入口/命令行为：这些路径必须只碰 scrollTop，不能走列步长或
 * 分页专用的二阶段补偿。
 */
function scrollContext(options: { height?: number; content?: number; currentPage?: number; pageCount?: number } = {}) {
  const viewer = {
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight: options.height ?? 600,
    clientWidth: 800,
    clientLeft: 0,
    scrollHeight: options.content ?? 5000,
    style: { setProperty() {}, getPropertyValue: () => "", getPropertyPriority: () => "" },
    getBoundingClientRect: () => ({ top: 100, left: 0, right: 800, bottom: 700, width: 800, height: 600 }),
    querySelectorAll: () => [],
  };
  const emit = vi.fn();
  const context = Object.create(ChapterPaginator.prototype) as ScrollContext;
  Object.assign(context, {
    disposed: false,
    _currentPath: "Text/chapter.xhtml",
    settings: { ...DEFAULT_SETTINGS, readingMode: "scroll" },
    viewer,
    contentDoc: {
      defaultView: { requestAnimationFrame: undefined, cancelAnimationFrame: undefined },
      createRange: () => ({ selectNodeContents() {}, getClientRects: () => [], getBoundingClientRect: () => ({ top: 0 }) }),
      getElementById: () => null,
    },
    iframe: { contentWindow: { location: { hash: "" } } },
    step: 0,
    pageWidth: 640,
    effectiveColumns: 1,
    leadingColumns: 0,
    scrollPageCount: options.pageCount ?? 9,
    lastScrollTop: 0,
    metrics: { pageCount: options.pageCount ?? 9, currentPage: options.currentPage ?? 0 },
    lastState: { status: "ready", pageCount: options.pageCount ?? 9, currentPage: options.currentPage ?? 0, empty: false },
    anchor: null,
    anchorPath: undefined,
    textIndex: null,
    searchHighlightTarget: null,
    // 与真实 emit 同样把最新状态写回 context，供 readyState 断言读取。
    emit(state: unknown) {
      context.lastState = state;
      emit(state);
    },
    captureAnchor() {},
    captureScrollAnchor() {},
    closeFootnoteForNavigation() {},
    clearSearchHighlightForDocument() {},
    rebuildTextIndexForCurrentDoc() {},
    applyScrollRestore() {},
    pendingFallbackPage: null,
    pendingAnchor: undefined,
    pendingStartAtEnd: false,
    pendingRestoreAnchor: null,
  });
  return { context, viewer, emit };
}

describe("scroll mode commands", () => {
  it("moves about 0.9 viewport per page command and clamps at both ends", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    internals.setPage.call(context, 1);
    expect(viewer.scrollTop).toBe(540);
    internals.setPage.call(context, 2);
    expect(viewer.scrollTop).toBe(1080);
    internals.setPage.call(context, 0);
    expect(viewer.scrollTop).toBe(540);
    viewer.scrollTop = 0;
    internals.setPage.call(context, 0);
    expect(viewer.scrollTop).toBe(0);
  });

  it("uses the last viewport step to reach the real chapter end", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 1200, pageCount: 2, currentPage: 1 });
    viewer.scrollTop = 540;
    expect(internals.scrollByViewport.call(context, 1)).toBe(true);
    // 真实最大滚动位置 = 1200 - 600 = 600（不是 1080）。
    expect(viewer.scrollTop).toBe(600);
    // 已到真实章尾：再次向下没有移动。
    expect(internals.scrollByViewport.call(context, 1)).toBe(false);
    expect(viewer.scrollTop).toBe(600);
  });

  it("computes a progress page count from real content height, not column count", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    internals.recomputeScroll.call(context);
    expect(context.metrics).toEqual({ pageCount: 9, currentPage: 0 });
    viewer.scrollTop = 2200;
    internals.syncScrollMetrics.call(context, false);
    expect(context.metrics.pageCount).toBe(9);
    expect(context.metrics.currentPage).toBe(4);
    const state = context.lastState as { status: string; mode?: string; scrollProgress?: number };
    expect(state.status).toBe("ready");
    expect(state.mode).toBe("scroll");
    expect(state.scrollProgress).toBeCloseTo(2200 / 4400, 5);
  });

  it("does not accumulate wheel deltas into page turns while scrolling", () => {
    const { context, viewer } = scrollContext();
    const preventDefault = vi.fn();
    const navigate = vi.fn();
    context.onWheelNavigate = navigate;
    context.wheelAcc = 0;
    for (let i = 0; i < 10; i++) {
      internals.handleWheel.call(context, { deltaY: 100, preventDefault } as unknown as WheelEvent);
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(viewer.scrollTop).toBe(1000);
    expect(preventDefault).toHaveBeenCalledTimes(10);
  });

  it("keeps arrow keys native but routes PageUp/PageDown/space to viewport commands", () => {
    const { context } = scrollContext();
    const navigate = vi.fn();
    context.onKeyNavigate = navigate;
    const press = (key: string) => {
      const preventDefault = vi.fn();
      internals.handleKey.call(context, { key, preventDefault } as unknown as KeyboardEvent);
      return preventDefault;
    };
    expect(press("ArrowDown")).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(press("PageDown")).toHaveBeenCalled();
    expect(press(" ")).toHaveBeenCalled();
    expect(press("PageUp")).toHaveBeenCalled();
    expect(navigate.mock.calls.map((c) => c[0])).toEqual([1, 1, -1]);
  });

  it("locates an exact search hit by scrollTop instead of bailing on step<=0", () => {
    // 回归：滚动模式 step 恒为 0，旧守卫 `this.step <= 0` 让搜索/笔记定位永远
    // 返回 unresolved；修复后必须走 Range→scrollTop 的滚动定位路径。
    const { context, viewer } = scrollContext();
    const hit = { start: 0, end: 2, exactText: "甲乙" };
    context.textIndex = {
      codePoints: ["甲", "乙"],
      totalChars: 2,
      mediaUnits: 0,
      snippetAt: () => "甲乙",
      rangeForOffsets: () => ({
        getClientRects: () => [],
        getBoundingClientRect: () => ({ top: 0 }),
      }),
    };
    context.buildHighlightRanges = () => [{} as Range];
    context.resolveScrollTopForRange = () => 321;
    const status = internals.navigateToSearchTarget.call(context, {
      requestId: 9,
      kind: "search",
      textHits: [hit],
    });
    // jsdom 没有 CSS Custom Highlight，所以这里以 unsupported-highlight 收尾；
    // 关键是不能是 unresolved，且位置已经真的滚过去了。
    expect(status).toBe("unsupported-highlight");
    expect(viewer.scrollTop).toBe(321);
  });

  it("samples the first visible column in viewport coordinates, not content coordinates", () => {
    // 回归：采样点曾把 scrollLeft 加进 x，而 caretPositionFromPoint 用 iframe
    // 视口坐标——首屏 scrollLeft=0 时看着正常，一翻页锚点就永远采不到，
    // 阅读进度/跨模式定位全部退化为页码兜底。
    const points: Array<{ x: number; y: number }> = [];
    const viewer = {
      scrollTop: 0,
      scrollLeft: 1048,
      clientWidth: 1000,
      clientHeight: 600,
      clientLeft: 0,
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ paddingLeft: "10px" }) },
      },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600 }),
    };
    const context = Object.create(ChapterPaginator.prototype) as Record<string, unknown>;
    Object.assign(context, {
      disposed: false,
      _currentPath: "Text/chapter.xhtml",
      settings: { ...DEFAULT_SETTINGS, readingMode: "paginated", gapPx: 24, columnsPerView: 2 },
      viewer,
      contentDoc: {
        defaultView: { getComputedStyle: () => ({ paddingLeft: "10px" }) },
        body: {},
        documentElement: {},
        caretPositionFromPoint: (x: number, y: number) => {
          points.push({ x, y });
          return { offsetNode: { nodeType: 3, parentElement: null }, offset: 0 };
        },
        elementFromPoint: () => null,
      },
      step: 500,
      pageWidth: 500,
      effectiveColumns: 2,
      leadingColumns: 0,
      geometry: { columns: 2, columnWidth: 500, columnStep: 524, viewStep: 1048 },
      textIndex: {
        totalChars: 100,
        mediaUnits: 0,
        offsetForNode: () => 42,
        snippetAt: () => "甲乙",
      },
      anchor: null,
      anchorPath: undefined,
    });
    internals.captureAnchor.call(context);
    expect(points.length).toBeGreaterThan(0);
    // 第一可见列的半宽内缩：10(padding) + 500*0.5 = 260；绝不能再加 scrollLeft。
    expect(points[0].x).toBe(260);
    expect((context.anchor as { textOffset: number }).textOffset).toBe(42);
  });

  it("triggers chapter navigation when scrolling past bottom or top boundary in scroll mode", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    const preventDefault = vi.fn();
    const navigate = vi.fn();
    context.onWheelNavigate = navigate;
    context.scrollWheelAcc = 0;
    context.lastState = { status: "ready" };
    context.navLockUntil = 0;
    context.hasNextChapter = true;
    context.hasPrevChapter = true;

    // 1. 到达章末底部 (maxTop = 4400)
    viewer.scrollTop = 4400;
    internals.handleWheel.call(context, { deltaY: 250, preventDefault } as unknown as WheelEvent);
    expect(navigate).not.toHaveBeenCalled();
    // 再次累积越过 400 阈值
    internals.handleWheel.call(context, { deltaY: 200, preventDefault } as unknown as WheelEvent);
    expect(navigate).toHaveBeenCalledWith(1);
    expect(preventDefault).toHaveBeenCalled();

    // 2. 到达章首顶部 (scrollTop = 0)
    navigate.mockClear();
    preventDefault.mockClear();
    context.lockedReverseDir = 0;
    context.reverseLockUntil = 0;
    context.sameDirThrottleUntil = 0;
    viewer.scrollTop = 0;
    internals.handleWheel.call(context, { deltaY: -250, preventDefault } as unknown as WheelEvent);
    expect(navigate).not.toHaveBeenCalled();
    internals.handleWheel.call(context, { deltaY: -200, preventDefault } as unknown as WheelEvent);
    expect(navigate).toHaveBeenCalledWith(-1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("ignores wheel navigation events during loading or measuring state", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    const preventDefault = vi.fn();
    const navigate = vi.fn();
    context.onWheelNavigate = navigate;
    context.scrollWheelAcc = 0;
    context.hasNextChapter = true;
    viewer.scrollTop = 4400;

    context.lastState = { status: "loading" };
    internals.handleWheel.call(context, { deltaY: 800, preventDefault } as unknown as WheelEvent);
    expect(navigate).not.toHaveBeenCalled();

    context.lastState = { status: "measuring" };
    internals.handleWheel.call(context, { deltaY: 800, preventDefault } as unknown as WheelEvent);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("directional protection: blocks reverse bounce but allows same-direction scrolling", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    const preventDefault = vi.fn();
    const navigate = vi.fn();
    context.onWheelNavigate = navigate;
    context.scrollWheelAcc = 0;
    context.lastState = { status: "ready" };
    context.hasNextChapter = true;
    context.hasPrevChapter = true;

    // 模拟从下一章切回上一章：停在章末 (4400)，锁定反向（向下回弹 1）800ms
    viewer.scrollTop = 4400;
    context.lockedReverseDir = 1;
    context.reverseLockUntil = Date.now() + 800;

    // 向上滑动阅读或继续向上切章：反向锁不生效（单向保护）
    internals.handleWheel.call(context, { deltaY: -100, preventDefault } as unknown as WheelEvent);
    expect(navigate).not.toHaveBeenCalled(); // 尚未到章首，正常阅读滚动

    // 向下回弹滑轮被反向锁拦截
    internals.handleWheel.call(context, { deltaY: 800, preventDefault } as unknown as WheelEvent);
    expect(navigate).not.toHaveBeenCalled();
    expect(context.scrollWheelAcc).toBe(0);
  });

  it("scrollByDelta scrolls viewer scrollTop smoothly within bounds", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    viewer.scrollTop = 100;
    internals.scrollByDelta.call(context, 50);
    expect(viewer.scrollTop).toBe(150);
    internals.scrollByDelta.call(context, -80);
    expect(viewer.scrollTop).toBe(70);
    internals.scrollByDelta.call(context, -200);
    expect(viewer.scrollTop).toBe(0); // 夹紧在 0
  });

  it("scrolls viewer scrollTop crisply and immediately on delta", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    viewer.scrollTop = 200;
    internals.scrollByDelta.call(context, 120);
    expect(viewer.scrollTop).toBe(320);

    internals.scrollByViewport.call(context, 1);
    expect(viewer.scrollTop).toBe(860);
  });

  it("handles successive wheel inputs crisply without floating delay", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    viewer.scrollTop = 100;
    // 第一次输入：从 100 加 120 -> 立即干脆到位 220
    internals.scrollByDelta.call(context, 120);
    expect(viewer.scrollTop).toBe(220);

    // 第二次连续输入：立即干脆到位 340
    internals.scrollByDelta.call(context, 120);
    expect(viewer.scrollTop).toBe(340);

    // 第三次连续输入：立即干脆到位 460
    internals.scrollByDelta.call(context, 120);
    expect(viewer.scrollTop).toBe(460);

    // 第四次紧急反向向上拨动 -100：立即折返至 360，绝无拖尾滑动
    internals.scrollByDelta.call(context, -100);
    expect(viewer.scrollTop).toBe(360);
  });

  it("animates wheel scrolling smoothly with standard browser physics (immediate impulse, no slow start/stop)", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    viewer.scrollTop = 0;

    const rafQueue: Array<(now: number) => void> = [];
    let currentTime = 1000;
    const fakeRaf = (cb: (now: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };

    context.contentDoc = {
      defaultView: {
        requestAnimationFrame: fakeRaf,
        cancelAnimationFrame: vi.fn(),
      },
    };

    // User rolls 1 notch (Windows standard 3 lines = 84px)
    internals.scrollByDelta.call(context, 84);
    expect(rafQueue.length).toBe(1);
    expect(context.pendingWheelTarget).toBe(84);

    // Frame 1 (16.7ms later): should cover ~45-50% immediately, showing zero startup delay
    currentTime += 16.7;
    const step1 = rafQueue.shift()!;
    step1(currentTime);
    expect(viewer.scrollTop).toBeGreaterThan(30);
    expect(viewer.scrollTop).toBeLessThan(50);
    expect(rafQueue.length).toBe(1);

    // Frame 2 (33.4ms): covers ~70%
    currentTime += 16.7;
    const step2 = rafQueue.shift()!;
    step2(currentTime);
    expect(viewer.scrollTop).toBeGreaterThan(55);
    expect(viewer.scrollTop).toBeLessThan(70);

    // Step remaining frames until completion (less than 100ms total)
    let frames = 2;
    while (rafQueue.length > 0 && frames < 15) {
      currentTime += 16.7;
      const nextStep = rafQueue.shift()!;
      nextStep(currentTime);
      frames++;
    }

    // Snaps accurately to 84px within 6-7 frames (< 120ms), and animation loop cleans up
    expect(viewer.scrollTop).toBe(84);
    expect(context.pendingWheelTarget).toBeNull();
    expect(rafQueue.length).toBe(0);
    expect(frames).toBeLessThanOrEqual(8);
  });

  it("smoothly redirects animation when wheel is turned in reverse direction", () => {
    const { context, viewer } = scrollContext({ height: 600, content: 5000 });
    viewer.scrollTop = 100;

    const rafQueue: Array<(now: number) => void> = [];
    let currentTime = 1000;
    const fakeRaf = (cb: (now: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };

    context.contentDoc = {
      defaultView: {
        requestAnimationFrame: fakeRaf,
        cancelAnimationFrame: vi.fn(),
      },
    };

    // User scrolls down by 84px (target = 184)
    internals.scrollByDelta.call(context, 84);
    expect(context.pendingWheelTarget).toBe(184);

    // Advance 1 frame (scrollTop moves towards ~140)
    currentTime += 16.7;
    rafQueue.shift()!(currentTime);
    const midScrollTop = viewer.scrollTop;
    expect(midScrollTop).toBeGreaterThan(130);
    expect(midScrollTop).toBeLessThan(150);

    // User suddenly flicks wheel UP by -84px during animation
    internals.scrollByDelta.call(context, -84);
    // Target should immediately reverse from current position (midScrollTop - 84), NOT from old target!
    expect(context.pendingWheelTarget).toBeCloseTo(midScrollTop - 84, 1);

    // Advance next frame: scrollTop moves immediately UPWARDS
    currentTime += 16.7;
    rafQueue.shift()!(currentTime);
    expect(viewer.scrollTop).toBeLessThan(midScrollTop);
  });

  it("imageCandidate does not misfire on non-image elements or containers with images in subtree", () => {
    const context = Object.create(ChapterPaginator.prototype) as Record<string, unknown>;
    const { document: doc } = parseHTML("<!doctype html><html><body></body></html>");

    const container = doc.createElement("div");
    const p = doc.createElement("p");
    p.textContent = "一段正文内容";
    const img = doc.createElement("img");
    img.src = "foo.png";
    p.appendChild(img);
    container.appendChild(p);

    // 点击在段落或空白容器上：绝对不能因为子树含有 img 而匹配
    expect(internals.imageCandidate.call(context, container as unknown as Element)).toBeNull();
    expect(internals.imageCandidate.call(context, p as unknown as Element)).toBeNull();

    // 点击在真实 img 上：正确匹配
    expect(internals.imageCandidate.call(context, img as unknown as Element)).toBe(img);

    // 点击在 svg 包含的 image 上
    const svg = doc.createElement("svg");
    const svgImg = doc.createElement("image");
    svg.appendChild(svgImg);
    expect(internals.imageCandidate.call(context, svg as unknown as Element)).toBe(svgImg);

    // 点击在包裹图片的 a 链接内的元素上：通过 closest 找到 img
    const a = doc.createElement("a");
    const wrapperImg = doc.createElement("img");
    a.appendChild(wrapperImg);
    expect(internals.imageCandidate.call(context, wrapperImg as unknown as Element)).toBe(wrapperImg);
  });

  it("renders chapter end card and dispatches navigation on button click", () => {
    const { document: doc } = parseHTML("<!doctype html><html><body></body></html>");
    const viewer = doc.createElement("div");
    Object.defineProperty(viewer, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(viewer, "clientHeight", { value: 600, configurable: true });
    doc.body.appendChild(viewer);

    const navigate = vi.fn();
    const context = Object.create(ChapterPaginator.prototype) as Record<string, unknown>;
    Object.assign(context, {
      settings: { ...DEFAULT_SETTINGS, readingMode: "scroll" },
      contentDoc: doc,
      viewer,
      hasNextChapter: true,
      onWheelNavigate: navigate,
      scrollToEnd() {
        viewer.scrollTop = 400;
      },
      scrollMetrics() {
        return { contentHeight: 1000, viewportHeight: 600 };
      },
    });

    // 连续滚动模式：有下一章时不渲染切章按钮或切章卡片，保证章节无缝衔接
    internals.renderScrollChapterEnd.call(context);
    const endEl = viewer.querySelector('[data-reader="chapter-end"]');
    expect(endEl).toBeNull();

    // 最后一章：没有下一章时，渲染低调的“全书完”说明，且无切章按钮
    context.hasNextChapter = false;
    internals.renderScrollChapterEnd.call(context);
    const endElLast = viewer.querySelector('[data-reader="chapter-end"]');
    expect(endElLast).not.toBeNull();
    const dividerLast = endElLast?.querySelector(".chapter-end-divider");
    expect(dividerLast?.textContent).toBe("全书完");
    expect(endElLast?.querySelector(".chapter-end-next-btn")).toBeNull();
    expect(endElLast?.querySelector(".chapter-end-hint")?.textContent).toBe("已读完全部章节");
  });
});
describe("scroll mode C-53 toolbar centering", () => {
  it("滚动模式下顶层 toolbar 同样触发 C-53 零边距修复并写回居中", () => {
    const toolbarStyle = {
      marginLeft: "",
      marginRight: "",
      margin: "",
      _styles: {} as Record<string, { value: string; priority: string }>,
      setProperty(prop: string, val: string, pri = "") {
        this._styles[prop] = { value: val, priority: pri };
      },
      getPropertyValue(prop: string) {
        return this._styles[prop]?.value ?? "";
      },
      getPropertyPriority(prop: string) {
        return this._styles[prop]?.priority ?? "";
      },
      removeProperty(prop: string) {
        delete this._styles[prop];
      },
    };
    const toolbar = {
      nodeType: 1,
      localName: "div",
      classList: {
        contains: (cls: string) => cls === "toolbar" || cls === "reader-top",
      },
      hasAttribute: () => false,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      children: [],
      parentElement: null as any,
      style: toolbarStyle,
      getBoundingClientRect: () => ({ width: 500, height: 40, left: 0, right: 500, top: 0, bottom: 40 }),
    };
    const viewer = {
      clientWidth: 1200,
      classList: {
        contains: () => false,
      },
      children: [toolbar],
    };
    toolbar.parentElement = viewer;

    const doc = {
      styleSheets: [],
      defaultView: {
        getComputedStyle: (el: any) => {
          if (el === toolbar) {
            return {
              marginLeft: "0px",
              marginRight: "0px",
              float: "none",
              clear: "none",
              display: "block",
              position: "static",
              writingMode: "horizontal-tb",
              width: "500px",
              maxWidth: "none",
              boxSizing: "border-box",
              textAlign: "start",
              direction: "ltr",
            };
          }
          return {
            paddingLeft: "0px",
            paddingRight: "0px",
            writingMode: "horizontal-tb",
            clear: "none",
            float: "none",
          };
        },
      },
    };

    const context = {
      contentDoc: doc,
      viewer,
      settings: { fontSizePx: 16, gapPx: 40, readingMode: "scroll" },
      scrollMode: true,
      fitContentFixes: [],
      marginFixes: [] as any[],
      floatLayoutFixes: [] as any[],
      step: 0,
      disableReaderTopMarginRules: () => () => {},
    };

    (ChapterPaginator.prototype as any).applyBookMargins.call(context);

    expect(toolbar.setAttribute).toHaveBeenCalledWith("data-reader-margin-fixed", "1");
    expect(toolbar.style.getPropertyValue("margin-left")).toBe("auto");
    expect(toolbar.style.getPropertyPriority("margin-left")).toBe("important");
    expect(toolbar.style.getPropertyValue("margin-right")).toBe("auto");
    expect(toolbar.style.getPropertyPriority("margin-right")).toBe("important");
  });
});
