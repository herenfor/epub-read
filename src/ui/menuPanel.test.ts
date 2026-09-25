import { describe, expect, it } from "vitest";
import {
  forceHorizontalModeDescription,
  isCustomCssDraftDirty,
  preloadNextChapterModeDescription,
} from "./MenuPanel";

describe("custom CSS draft commit", () => {
  it("仅在草稿与已保存值不同才允许保存，并支持清空", () => {
    expect(isCustomCssDraftDirty("body { color: red; }", "body { color: red; }")).toBe(false);
    expect(isCustomCssDraftDirty("body { color: blue; }", "body { color: red; }")).toBe(true);
    expect(isCustomCssDraftDirty("", "body { color: red; }")).toBe(true);
    expect(isCustomCssDraftDirty("", "")).toBe(false);
  });
});

describe("force horizontal menu", () => {
  it("明确显示关闭时跟随书籍、开启时竖排转横排", () => {
    expect(forceHorizontalModeDescription(false)).toBe("跟随书籍");
    expect(forceHorizontalModeDescription(true)).toBe("竖排转横排");
  });
});

describe("preload next chapter menu", () => {
  it("明确显示关闭、开启和上层禁用时的说明", () => {
    expect(preloadNextChapterModeDescription(false)).toBe("按需加载");
    expect(preloadNextChapterModeDescription(true)).toBe("预先准备相邻章节");
    expect(preloadNextChapterModeDescription(true, true)).toBe("当前不可用");
  });
});
