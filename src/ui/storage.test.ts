import { afterEach, describe, expect, it } from "vitest";
import { readSavedSettings, toSavedReaderSettings, writeSavedSettings } from "./storage";
import { DEFAULT_SETTINGS } from "../render/settings";

const originalStorage = globalThis.localStorage;

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalStorage,
  });
});

describe("saved reader settings", () => {
  it("round-trips advanced choices without retaining resolved fonts or session resources", () => {
    const values = installStorage();
    const settings = {
      ...DEFAULT_SETTINGS,
      theme: "sepia" as const,
      fontSizePx: 20,
      fontFamily: "Runtime resolved family",
      customFontName: "Imported family",
      fontSource: "imported" as const,
      customFontId: "font-id",
      forceFontOverride: true,
      customFonts: [{ family: "Imported family", url: "blob:session-font" }],
      customCss: "p { text-indent: 2em; }",
      lineHeight: 1.7,
      fontWeight: 500,
      letterSpacingPx: 0.2,
      wordSpacingPx: 0.3,
      forceHorizontal: true,
      preloadNextChapter: true,
      turnAnimation: "fade" as const,
      readingMode: "scroll" as const,
      pageMarginsPx: { left: 40, right: 40, top: 28, bottom: 28 },
      columnsPerView: 2 as const,
      gapPx: 32,
      spreadGapMode: "manual" as const,
    };
    writeSavedSettings(toSavedReaderSettings(settings, 1.15));
    expect(readSavedSettings()).toEqual({
      fontSizePx: 20, theme: "sepia", uiScale: 1.15,
      customFontName: "Imported family", fontSource: "imported", customFontId: "font-id",
      forceFontOverride: true,
      customCss: "p { text-indent: 2em; }", lineHeight: 1.7, fontWeight: 500,
      letterSpacingPx: 0.2, wordSpacingPx: 0.3,
      forceHorizontal: true, preloadNextChapter: true, turnAnimation: "fade", pageDirection: "book",
      readingMode: "scroll", pageMarginsPx: { left: 40, right: 40, top: 28, bottom: 28 },
      columnsPerView: 2, gapPx: 32, spreadGapMode: "manual",
    });
    expect(values.get("epub-reader:settings")).not.toContain("blob:");
    // Newly resolved runtime resources do not change the saved user choices.
    expect(toSavedReaderSettings({ ...settings, customFonts: [] }, 1.15))
      .toEqual(toSavedReaderSettings(settings, 1.15));
  });

  it("retains the previous normalization when optional legacy fields are absent", () => {
    expect(toSavedReaderSettings({ fontSizePx: 16, theme: "light", gapPx: 24 }, 1)).toMatchObject({
      forceHorizontal: false, preloadNextChapter: false, turnAnimation: "slide",
      readingMode: "paginated", columnsPerView: 1, spreadGapMode: "auto",
    });
  });

  it("保留 forceHorizontal，并兼容旧设置缺省字段", () => {
    const values = installStorage();
    values.set("epub-reader:settings", JSON.stringify({ theme: "dark" }));
    expect(readSavedSettings().forceHorizontal).toBeUndefined();

    writeSavedSettings({ theme: "dark", forceHorizontal: true });
    expect(readSavedSettings()).toMatchObject({ theme: "dark", forceHorizontal: true });
  });

  it("保留 preloadNextChapter，并兼容旧设置缺省字段", () => {
    const values = installStorage();
    values.set("epub-reader:settings", JSON.stringify({ theme: "dark" }));
    expect(readSavedSettings().preloadNextChapter).toBeUndefined();

    writeSavedSettings({ theme: "dark", preloadNextChapter: true });
    expect(readSavedSettings()).toMatchObject({ theme: "dark", preloadNextChapter: true });
  });
});
