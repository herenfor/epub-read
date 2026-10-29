import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_THEMES,
  clampThemeName,
  contrastRatio,
  customThemeKey,
  customThemeTokens,
  isCustomThemeKey,
  isDarkPaper,
  normalizeHexColor,
  parseCustomThemeKey,
  sanitizeCustomThemes,
  usableAccent,
} from "./customThemes";
import { isDarkReaderTheme, resolveReaderPalette } from "./readerPalette";
import { buildThemeCss } from "../render/readerTheme";

const green = { background: "#c7edcc", foreground: "#2b3a2e", accent: "#3f7d4e" };
const navy = { background: "#141b26", foreground: "#a9b8c9", accent: "#6ea8dc" };

describe("custom themes", () => {
  it("carries the three colors in the theme value, so an edit is a new value", () => {
    const key = customThemeKey(green);
    expect(key).toBe("c:c7edcc2b3a2e3f7d4e");
    expect(isCustomThemeKey(key)).toBe(true);
    expect(parseCustomThemeKey(key)).toEqual(green);
    expect(customThemeKey({ ...green, accent: "#000000" })).not.toBe(key);
    expect(isCustomThemeKey("c:xyz")).toBe(false);
    expect(isCustomThemeKey("sepia")).toBe(false);
    expect(normalizeHexColor("ABC123")).toBe("#abc123");
    expect(normalizeHexColor("#abc")).toBeNull();
  });

  it("keeps at most the limit of valid, uniquely identified themes from storage", () => {
    const many = Array.from({ length: MAX_CUSTOM_THEMES + 40 }, (_, i) => ({ id: `t${i}`, name: `主题${i}`, ...green }));
    expect(sanitizeCustomThemes(many)).toHaveLength(MAX_CUSTOM_THEMES);
    const mixed = sanitizeCustomThemes([
      { id: "a", name: "  好看的主题名字特别特别长的一个名字  ", ...green },
      { id: "a", name: "duplicate", ...green },
      { id: "BAD ID", name: "x", ...green },
      { id: "b", name: "x", ...green, accent: "red" },
      null,
      "text",
      { id: "c", name: 42, ...navy },
    ]);
    expect(mixed.map((theme) => theme.id)).toEqual(["a", "c"]);
    expect(mixed[0].name).toBe("好看的主题名字特别特别长");
    expect(mixed[1].name).toBe("");
    expect(sanitizeCustomThemes("not a list")).toEqual([]);
    expect(clampThemeName("😀".repeat(20))).toBe("😀".repeat(12));
  });

  it("decides darkness from the paper and gives dark papers the dark repairs", () => {
    expect(isDarkPaper(green.background)).toBe(false);
    expect(isDarkPaper(navy.background)).toBe(true);
    expect(isDarkReaderTheme(customThemeKey(navy))).toBe(true);
    expect(isDarkReaderTheme(customThemeKey(green))).toBe(false);
    const darkCss = buildThemeCss(customThemeKey(navy));
    expect(darkCss).toContain("body { color: #a9b8c9; background-color: #141b26; }");
    expect(darkCss).toContain("text-emphasis-color: #a9b8c9");
    expect(buildThemeCss(customThemeKey(green))).not.toContain("text-emphasis-color");
    expect(resolveReaderPalette(customThemeKey(green)).noteUnderline).toBe(green.accent);
  });

  it("moves an invisible accent toward the text color for interface marks", () => {
    const pale = { background: "#ffffff", foreground: "#1a1a1a", accent: "#fff5cc" };
    const accent = usableAccent(pale);
    expect(contrastRatio(accent, pale.background)).toBeGreaterThanOrEqual(3);
    expect(usableAccent(green)).toBe(green.accent);
    const tokens = customThemeTokens(navy);
    expect(tokens.root["--bg"]).toBe(navy.background);
    expect(tokens.root["--accent"]).toBe(navy.accent);
    expect(tokens.root["--accent-foreground"]).toBe("#111111");
    expect(Object.values(tokens.root).every((value) => !value.includes("NaN"))).toBe(true);
  });
});
