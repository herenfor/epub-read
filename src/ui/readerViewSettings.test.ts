import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../render/settings";
import { effectiveReaderSettings, sameRenderingSettings } from "./ReaderView";

describe("reader effective settings", () => {
  it("固定版式不注入强制横排，可重排正文保留开关", () => {
    const forced = { ...DEFAULT_SETTINGS, forceHorizontal: true };
    expect(effectiveReaderSettings(forced, false)).toBe(forced);
    expect(effectiveReaderSettings(forced, true)).toMatchObject({
      gapPx: 0,
      forceHorizontal: false,
    });
    expect(effectiveReaderSettings(forced, true)).not.toBe(forced);
  });

  it("预加载开关不是活动章节的布局身份", () => {
    const normal = { ...DEFAULT_SETTINGS, fontSizePx: 18, preloadNextChapter: false };
    expect(sameRenderingSettings(normal, { ...normal, preloadNextChapter: true })).toBe(true);
    expect(sameRenderingSettings(normal, { ...normal, fontSizePx: 19 })).toBe(false);
    expect(sameRenderingSettings(normal, { ...normal, txtIndent: true })).toBe(false);
  });
});
