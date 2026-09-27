import { describe, expect, it } from "vitest";
import { canCommitContinuousChapterHeight, classifyChapterMeasurement } from "./continuousChapterGeometry";

describe("canCommitContinuousChapterHeight", () => {
  it("拒绝容器尚未参与布局时测到的 0 高度", () => {
    expect(canCommitContinuousChapterHeight({ height: 0, laidOut: false })).toBe(false);
  });

  it("拒绝容器不可见时测到的正高度（布局不可信）", () => {
    expect(canCommitContinuousChapterHeight({ height: 1828, laidOut: false })).toBe(false);
  });

  it("拒绝已布局但内容为空的 0 高度，保留估算高度等待重测", () => {
    expect(canCommitContinuousChapterHeight({ height: 0, laidOut: true })).toBe(false);
  });

  it("拒绝负数与非法数值", () => {
    expect(canCommitContinuousChapterHeight({ height: -1, laidOut: true })).toBe(false);
    expect(canCommitContinuousChapterHeight({ height: Number.NaN, laidOut: true })).toBe(false);
    expect(canCommitContinuousChapterHeight({ height: Number.POSITIVE_INFINITY, laidOut: true })).toBe(false);
  });

  it("接受已布局章节的真实正高度", () => {
    expect(canCommitContinuousChapterHeight({ height: 1828, laidOut: true })).toBe(true);
    expect(canCommitContinuousChapterHeight({ height: 1, laidOut: true })).toBe(true);
  });
});

describe("classifyChapterMeasurement (B-151)", () => {
  it("未 display-ready 或容器未布局时保持 pending，零高度不能提交", () => {
    expect(classifyChapterMeasurement({
      displayReady: false,
      viewportLaidOut: true,
      contentHeight: 0,
    })).toEqual({ kind: "pending" });
    expect(classifyChapterMeasurement({
      displayReady: true,
      viewportLaidOut: false,
      contentHeight: 0,
    })).toEqual({ kind: "pending" });
    expect(classifyChapterMeasurement({
      displayReady: true,
      viewportLaidOut: true,
      contentHeight: -1,
    })).toEqual({ kind: "pending" });
    expect(classifyChapterMeasurement({
      displayReady: true,
      viewportLaidOut: true,
      contentHeight: Number.NaN,
    })).toEqual({ kind: "pending" });
  });

  it("已布局且 display-ready 的零高度是 empty，不是 pending", () => {
    expect(classifyChapterMeasurement({
      displayReady: true,
      viewportLaidOut: true,
      contentHeight: 0,
    })).toEqual({ kind: "empty", height: 0 });
  });

  it("有真实内容时返回 content.height", () => {
    expect(classifyChapterMeasurement({
      displayReady: true,
      viewportLaidOut: true,
      contentHeight: 1828,
    })).toEqual({ kind: "content", height: 1828 });
  });
});
