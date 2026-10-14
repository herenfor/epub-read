import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { looksLikeVerticalBook, withVerticalFallback } from "./verticalFallback";

const book = (language: string, pageProgression?: "ltr" | "rtl", fixedLayout = false) =>
  ({ fixedLayout, pageProgression, metadata: { language } });

describe("vertical fallback (A10s)", () => {
  it("treats right-to-left reflowable CJK books as vertical", () => {
    for (const language of ["ja", "ja-JP", "zh-TW", "zh_Hant", "ZH", "ko", "jpn"]) {
      expect(looksLikeVerticalBook(book(language, "rtl"))).toBe(true);
    }
  });

  it("leaves horizontal right-to-left scripts, left-to-right and fixed-layout books alone", () => {
    expect(looksLikeVerticalBook(book("ar", "rtl"))).toBe(false);
    expect(looksLikeVerticalBook(book("he", "rtl"))).toBe(false);
    expect(looksLikeVerticalBook(book("ja", "ltr"))).toBe(false);
    expect(looksLikeVerticalBook(book("zh"))).toBe(false);
    expect(looksLikeVerticalBook(book("ja", "rtl", true))).toBe(false);
    expect(looksLikeVerticalBook(book("", "rtl"))).toBe(false);
  });

  it("only turns forceHorizontal on and keeps the same object otherwise", () => {
    const settings = { ...DEFAULT_SETTINGS, forceHorizontal: false };
    expect(withVerticalFallback(settings, book("ja", "rtl"))).toEqual({ ...settings, forceHorizontal: true });
    expect(withVerticalFallback(settings, book("en", "ltr"))).toBe(settings);
    expect(withVerticalFallback(settings, null)).toBe(settings);
    const forced = { ...settings, forceHorizontal: true };
    expect(withVerticalFallback(forced, book("ja", "rtl"))).toBe(forced);
  });
});
