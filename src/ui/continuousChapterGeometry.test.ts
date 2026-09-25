import { describe, expect, it } from "vitest";
import { canCommitContinuousChapterHeight } from "./continuousChapterGeometry";

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
