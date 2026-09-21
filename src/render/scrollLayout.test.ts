import { describe, expect, it } from "vitest";
import {
  nextWheelTarget,
  scrollByViewportCommand,
  scrollMaxTop,
  scrollProgressLabel,
  scrollRatio,
  scrollStepForViewport,
  scrollTopForRange,
  scrollTopForTarget,
  scrollViewForColumn,
  scrollViewerStyles,
  type ScrollMetrics,
} from "./scrollLayout";

const metrics = (contentHeight: number, viewportHeight: number): ScrollMetrics => ({
  contentHeight,
  viewportHeight,
});

describe("scroll geometry", () => {
  it("clamps the scroll range and never reports negative max", () => {
    expect(scrollMaxTop(metrics(5000, 600))).toBe(4400);
    expect(scrollMaxTop(metrics(400, 600))).toBe(0);
    // 非整数内容高度不向下取整，否则章尾会差几像素停不满。
    expect(scrollMaxTop(metrics(1000.4, 600))).toBe(401);
  });

  it("uses 0.9 viewport height per in-chapter command and stops at real boundaries", () => {
    expect(scrollStepForViewport(600)).toBe(540);
    expect(scrollStepForViewport(0)).toBe(0);
    expect(scrollByViewportCommand(1, metrics(5000, 600), 0)).toEqual({
      scrollTop: 540,
      atBoundary: false,
    });
    expect(scrollByViewportCommand(1, metrics(5000, 600), 4400)).toEqual({
      scrollTop: 4400,
      atBoundary: true,
    });
    expect(scrollByViewportCommand(-1, metrics(5000, 600), 100)).toEqual({
      scrollTop: 0,
      atBoundary: false,
    });
    expect(scrollByViewportCommand(-1, metrics(5000, 600), 0)).toEqual({
      scrollTop: 0,
      atBoundary: true,
    });
  });

  it("treats a chapter without vertical scroll range as already at its end", () => {
    expect(scrollByViewportCommand(1, metrics(600, 600), 0).atBoundary).toBe(true);
    expect(scrollRatio(metrics(600, 600), 0)).toBe(1);
    expect(scrollProgressLabel(metrics(600, 600), 0)).toBe("100%");
  });

  it("reports chapter progress from real scrollTop, not virtual page count", () => {
    expect(scrollRatio(metrics(5000, 600), 2200)).toBeCloseTo(0.5, 5);
    expect(scrollProgressLabel(metrics(5000, 600), 2200)).toBe("50%");
    expect(scrollProgressLabel(metrics(5000, 600), 99999)).toBe("100%");
    expect(scrollProgressLabel(metrics(5000, 600), -10)).toBe("0%");
  });
});

describe("scroll target origin", () => {
  it("converts range top into scrollTop without treating viewport rect.top as scrollTop", () => {
    // 目标在文档 y=1200，viewer 内容顶边在 y=800，当前 scrollTop=300：
    // 目标相对内容区 400px；希望停在顶端下方 16px → 300 + 400 - 16 = 684。
    expect(
      scrollTopForTarget({
        viewportTop: 800,
        targetTop: 1200,
        currentScrollTop: 300,
        desiredInset: 16,
        maxScrollTop: 4400,
      })
    ).toEqual({ scrollTop: 684, clamped: false });
  });

  it("clamps both directions and reports when the requested position was not reachable", () => {
    // 目标在可见区域上方（rect.top 小于 viewportTop），期望位置为负 → 夹到 0。
    expect(
      scrollTopForTarget({
        viewportTop: 800,
        targetTop: 700,
        currentScrollTop: 0,
        desiredInset: 16,
        maxScrollTop: 4400,
      })
    ).toEqual({ scrollTop: 0, clamped: true });
    expect(
      scrollTopForTarget({
        viewportTop: 800,
        targetTop: 9000,
        currentScrollTop: 100,
        desiredInset: 0,
        maxScrollTop: 4400,
      })
    ).toEqual({ scrollTop: 4400, clamped: true });
  });

  it("stops a trailing target at the maximum scroll position, not at the content end", () => {
    // 分页末屏可以停在内容终点；滚动若直接用该 y 会滚出正文。
    const resolved = scrollTopForRange({
      rangeTop: 4600,
      viewportTop: 0,
      currentScrollTop: 0,
      desiredInset: 0,
      metrics: metrics(5000, 600),
    });
    expect(resolved.scrollTop).toBe(4400);
    expect(resolved.clamped).toBe(true);
  });

  it("places the resolved target exactly desiredInset below the viewport top", () => {
    const viewportTop = 800;
    const desiredInset = 16;
    const resolved = scrollTopForRange({
      rangeTop: 1200,
      viewportTop,
      currentScrollTop: 300,
      desiredInset,
      metrics: metrics(5000, 600),
    });
    // 文档坐标 y=1200；应用 scrollTop 后目标相对可见区域顶端的偏移。
    const targetClientTopAfterScroll = 1200 - (resolved.scrollTop - 300);
    expect(targetClientTopAfterScroll - viewportTop).toBe(desiredInset);
  });
});

describe("column to position entry point", () => {
  it("maps every column to column 0 in scroll mode", () => {
    expect(
      scrollViewForColumn({ physicalColumn: 7, desiredInset: 16, ratio: 0.25 })
    ).toEqual({
      textOffset: null,
      textSnippet: null,
      legacyIndex: -1,
      physicalColumn: 0,
      desiredInset: 16,
      ratio: 0.25,
    });
  });

  it("normalizes ratio and unusable insets", () => {
    expect(scrollViewForColumn({ physicalColumn: 0, desiredInset: Number.NaN, ratio: 3 })).toMatchObject({
      desiredInset: 0,
      ratio: 1,
    });
  });
});

describe("scroll viewer styles", () => {
  it("makes the viewer the only vertical scroller and removes column layout", () => {
    const map = new Map(scrollViewerStyles(776));
    expect(map.get("overflow-y")).toBe("auto");
    expect(map.get("overflow-x")).toBe("hidden");
    expect(map.get("scrollbar-width")).toBe("none");
    expect(map.get("-ms-overflow-style")).toBe("none");
    expect(map.get("column-width")).toBe("auto");
    expect(map.get("column-gap")).toBe("0px");
    // 固定可见高度是滚动的先决条件：注入 CSS 里 html/body 已固定。
    expect(map.get("height")).toBe("776px");
    expect(map.get("max-height")).toBe("776px");
    // 不写宽度：viewer 占满可用宽，正文版心由 L3 的 max-width 居中控制。
    expect(map.has("width")).toBe(false);
  });

  it("adds explicit horizontal page margins as viewer padding", () => {
    const map = new Map(scrollViewerStyles(600, 24));
    expect(map.get("height")).toBe("600px");
    expect(map.get("padding-left")).toBe("24px");
    expect(map.get("padding-right")).toBe("24px");
  });

  it("falls back to 100% height when no usable viewport height is known", () => {
    const map = new Map(scrollViewerStyles(0));
    expect(map.get("height")).toBe("100%");
  });
});

describe("nextWheelTarget", () => {
  it("starts from current position when pending is null or undefined", () => {
    expect(nextWheelTarget(100, null, 120, 2000)).toBe(220);
    expect(nextWheelTarget(100, undefined, 120, 2000)).toBe(220);
    expect(nextWheelTarget(100, null, -50, 2000)).toBe(50);
  });

  it("accumulates on pending target when inputs are in the same direction", () => {
    // Current is at 130, pending target was 220, incoming delta is 120
    expect(nextWheelTarget(130, 220, 120, 2000)).toBe(340);
    // Again: current at 150, pending was 340, delta 120 -> 460
    expect(nextWheelTarget(150, 340, 120, 2000)).toBe(460);
  });

  it("immediately reverses from current visible position when input direction reverses", () => {
    // Current is at 150, pending was 460 (moving down), incoming delta is -100 (moving up)
    expect(nextWheelTarget(150, 460, -100, 2000)).toBe(50);
    // Conversely: current at 400, pending was 200 (moving up), incoming delta is +100 (moving down)
    expect(nextWheelTarget(400, 200, 100, 2000)).toBe(500);
  });

  it("clamps target within [0, maxTop]", () => {
    expect(nextWheelTarget(10, null, -50, 1000)).toBe(0);
    expect(nextWheelTarget(950, null, 100, 1000)).toBe(1000);
    expect(nextWheelTarget(900, 980, 50, 1000)).toBe(1000);
  });
});
