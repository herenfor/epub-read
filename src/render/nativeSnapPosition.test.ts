import { describe, expect, it } from "vitest";
import {
  chooseNativeSwipeOwner,
  planPagedStep,
  readSnapPosition,
  visibleSnapColumnSampleX,
} from "./nativeSnapPosition";

const offsets = [0, 100, 200];
const at = (left: number) => readSnapPosition(offsets, left)!;

describe("native snap position core", () => {
  it("读最近屏：等距取下屏，端点允许 1px 误差，保留真实 left", () => {
    expect(at(150)).toMatchObject({ page: 1, left: 150, snapLeft: 100, aligned: false });
    expect(at(151)).toMatchObject({ page: 2, atEnd: false });
    expect(at(199.4)).toMatchObject({ page: 2, aligned: true, atEnd: true });
    expect(at(0.8)).toMatchObject({ page: 0, atStart: true });
    expect(readSnapPosition([], 0)).toBeNull();
    // 双页非整数起点。
    expect(readSnapPosition([0, 812.5, 1625], 1624.2)).toMatchObject({ page: 2, atEnd: true });
  });

  it("手势归属：按下与现在都在章边才交给 JS 跨章", () => {
    expect(chooseNativeSwipeOwner(at(200), at(200), 1)).toBe("js");
    // 本手势途中才到章尾：仍归原生，本手势不跨章。
    expect(chooseNativeSwipeOwner(at(100), at(200), 1)).toBe("native");
    expect(chooseNativeSwipeOwner(at(200), at(200), -1)).toBe("native");
    expect(chooseNativeSwipeOwner(at(0), at(0), -1)).toBe("js");
    // 一屏章：首尾同时成立，两个方向都可跨章。
    const single = readSnapPosition([0], 0)!;
    expect(chooseNativeSwipeOwner(single, single, 1)).toBe("js");
    expect(chooseNativeSwipeOwner(single, single, -1)).toBe("js");
  });

  it("旧正式页 0、视觉已在章尾：直接跨章，不写回 0/100", () => {
    expect(planPagedStep(offsets, at(200), 1, true)).toEqual({ kind: "chapter", direction: 1, fromPage: 2 });
    expect(planPagedStep(offsets, at(200), 1, false)).toEqual({ kind: "book-edge", page: 2 });
    expect(planPagedStep(offsets, at(0), -1, true)).toEqual({ kind: "chapter", direction: -1, fromPage: 0 });
  });

  it("末屏但未到物理章尾：独立命令只完成末屏", () => {
    expect(planPagedStep(offsets, at(151), 1, true)).toEqual({ kind: "page", page: 2, from: 151, to: 200 });
  });

  it("两屏之间的独立命令：从真实位置起步到下一屏", () => {
    expect(planPagedStep(offsets, at(149), 1, true)).toEqual({ kind: "page", page: 2, from: 149, to: 200 });
    expect(planPagedStep(offsets, at(149), -1, true)).toEqual({ kind: "page", page: 0, from: 149, to: 0 });
  });

  it("采样点落在视觉屏真实可见的正文列内", () => {
    const base = { contentOriginClientX: 20, viewportLeft: 0, viewportRight: 400, columnWidth: 360, columnStep: 400 };
    // 已对齐：第一列中心。
    expect(visibleSnapColumnSampleX({ ...base, position: at(100), columns: 1 })).toBe(200);
    // 视觉屏 1 已滑出 30px：取剩余可见部分的中心。
    const shifted = readSnapPosition([0, 400, 800], 430)!;
    expect(visibleSnapColumnSampleX({ ...base, position: shifted, columns: 1 })).toBe(175);
    // 完全不可见：不采样。
    expect(visibleSnapColumnSampleX({ ...base, viewportRight: 10, position: at(100), columns: 1 })).toBeNull();
  });
});
