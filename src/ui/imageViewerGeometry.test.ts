import { describe, expect, it } from "vitest";
import {
  clampImagePan,
  clampScale,
  computeFitScale,
  isAtFit,
  maxScaleForFit,
  nextDoubleTapScale,
  originalSizeScale,
  pointerDistance,
  pointerMidpoint,
  toViewerPoint,
  wheelZoomFactor,
  zoomAt,
  type ImageTransform,
} from "./imageViewerGeometry";

function screenOf(t: ImageTransform, imagePoint: { x: number; y: number }) {
  return { x: t.x + imagePoint.x * t.scale, y: t.y + imagePoint.y * t.scale };
}

describe("computeFitScale / maxScaleForFit", () => {
  it("取 min(宽比, 高比, 1)，不放大小于视口的图片", () => {
    expect(computeFitScale(1000, 500, 500, 500)).toBe(0.5);
    expect(computeFitScale(200, 100, 1000, 1000)).toBe(1);
    expect(computeFitScale(400, 100, 200, 200)).toBe(0.5);
  });

  it("无效测量/尺寸时回退 1", () => {
    expect(computeFitScale(0, 100, 500, 500)).toBe(1);
    expect(computeFitScale(100, 100, 0, 500)).toBe(1);
    expect(computeFitScale(Number.NaN, 100, 500, 500)).toBe(1);
  });

  it("上限至少 4 倍且让原始大小可达", () => {
    expect(maxScaleForFit(1)).toBe(4);
    expect(maxScaleForFit(0.25)).toBe(4);
    expect(maxScaleForFit(0.1)).toBe(10);
  });
});

describe("zoomAt 固定点", () => {
  it("缩放后手指下的图像点仍在同一屏幕位置", () => {
    const previous: ImageTransform = { scale: 1, x: 0, y: 0 };
    const focus = { x: 40, y: -20 };
    const imagePoint = { x: (focus.x - previous.x) / previous.scale, y: (focus.y - previous.y) / previous.scale };
    const next = zoomAt(previous, focus, focus, 2.5);
    expect(next.scale).toBe(2.5);
    expect(screenOf(next, imagePoint).x).toBeCloseTo(focus.x);
    expect(screenOf(next, imagePoint).y).toBeCloseTo(focus.y);
  });

  it("双指中点移动同时平移图片，而不是只按距离比例", () => {
    const previous: ImageTransform = { scale: 2, x: 10, y: -4 };
    const previousFocus = { x: 0, y: 0 };
    const nextFocus = { x: 30, y: 12 };
    const next = zoomAt(previous, previousFocus, nextFocus, 2);
    expect(next.x).toBeCloseTo(40);
    expect(next.y).toBeCloseTo(8);
  });
});

describe("clampImagePan", () => {
  it("缩回适配后居中", () => {
    const clamped = clampImagePan({ scale: 1, x: 123, y: -88 }, 400, 300, 400, 300);
    expect(clamped).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("放大后允许拖到边缘但不完全拖出窗口", () => {
    const clamped = clampImagePan({ scale: 2, x: 9999, y: -9999 }, 400, 300, 400, 300);
    expect(clamped.x).toBe(200);
    expect(clamped.y).toBe(-150);

    const inside = clampImagePan({ scale: 2, x: 40, y: -20 }, 400, 300, 400, 300);
    expect(inside).toEqual({ scale: 2, x: 40, y: -20 });
  });

  it("非有限平移值归零，非法比例回退适配下限", () => {
    const clamped = clampImagePan({ scale: 0, x: Number.NaN, y: 5 }, 400, 300, 400, 300);
    expect(clamped.scale).toBe(1);
    expect(clamped.x).toBe(0);
  });
});

describe("按钮/双击比例", () => {
  it("双击在适配与 2 倍之间切换", () => {
    expect(nextDoubleTapScale(1, 4)).toBe(2);
    // 已放大（非适配）时双击回到适配，而不是继续放大。
    expect(nextDoubleTapScale(1.5, 4)).toBe(1);
    expect(nextDoubleTapScale(2, 4)).toBe(1);
    expect(nextDoubleTapScale(1, 1.5)).toBe(1.5);
  });

  it("clampScale 约束在 [下限, 上限]", () => {
    expect(clampScale(0.2, 1, 8)).toBe(1);
    expect(clampScale(99, 1, 8)).toBe(8);
    expect(clampScale(Number.NaN, 1, 8)).toBe(1);
  });

  it("原始大小 = 1/fitScale，且不超过上限", () => {
    expect(originalSizeScale(0.25, 4)).toBe(4);
    expect(originalSizeScale(0.1, 4)).toBe(4);
    expect(originalSizeScale(0.25, 10)).toBe(4);
    expect(originalSizeScale(1, 4)).toBe(1);
  });

  it("isAtFit 识别适配态", () => {
    expect(isAtFit(1)).toBe(true);
    expect(isAtFit(1.005)).toBe(true);
    expect(isAtFit(1.2)).toBe(false);
  });
});

describe("指针与滚轮换算", () => {
  it("toViewerPoint 以可用区中心为原点", () => {
    const point = toViewerPoint(300, 250, { left: 100, top: 50, width: 400, height: 400 });
    expect(point).toEqual({ x: 0, y: 0 });
    expect(toViewerPoint(100, 50, { left: 100, top: 50, width: 400, height: 400 })).toEqual({ x: -200, y: -200 });
  });

  it("双指距离与中点", () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pointerMidpoint({ x: 0, y: 10 }, { x: 10, y: 30 })).toEqual({ x: 5, y: 20 });
  });

  it("滚轮向上放大、向下缩小且单步有界", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(100000)).toBe(0.5);
    expect(wheelZoomFactor(-100000)).toBe(2);
    expect(wheelZoomFactor(0)).toBe(1);
  });
});
