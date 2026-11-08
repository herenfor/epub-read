import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_PALETTES, READER_PALETTES, highlightInk } from "../config/readerPalette";
import { customThemeKey } from "../config/customThemes";
import { NOTE_COLOR_NAMES, NOTE_STYLES } from "../ui/notes";
import {
  buildNoteHighlightCss,
  groupNoteHighlights,
  LEGACY_NOTE_HIGHLIGHT_NAME,
  NOTE_HIGHLIGHT_STYLES,
  resolveNoteHighlightLook,
  writeNoteHighlightStyle,
} from "./noteHighlights";
import { buildThemeCss } from "./readerTheme";
import type { BuiltinTheme } from "./settings";

const THEMES: BuiltinTheme[] = ["light", "sepia", "gray", "dark"];
const DARK = new Set<BuiltinTheme>(["gray", "dark"]);

function rule(css: string, name: string): string {
  return new RegExp(`::highlight\\(${name}\\) \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("note highlight looks (ER-0106 defaults)", () => {
  it("matches the data contract's style and color sets", () => {
    expect([...NOTE_HIGHLIGHT_STYLES]).toEqual([...NOTE_STYLES]);
    expect([...HIGHLIGHT_COLOR_NAMES]).toEqual([...NOTE_COLOR_NAMES]);
  });

  it("keeps legacy notes, fills a missing color or style, and ignores bad values", () => {
    expect(resolveNoteHighlightLook({})).toBeNull();
    expect(resolveNoteHighlightLook({ style: "bold", color: "pink" })).toBeNull();
    expect(resolveNoteHighlightLook({ style: "squiggly" })).toEqual({ style: "squiggly", color: null });
    expect(resolveNoteHighlightLook({ color: "green" })).toEqual({ style: "highlight", color: "green" });
    expect(resolveNoteHighlightLook({ style: "underline", color: "#AABBCC" })).toEqual({
      style: "underline",
      color: "#aabbcc",
    });
  });

  it("groups by style × color with a fixed priority order", () => {
    const notes = [
      { id: "a", style: "squiggly", color: "red" },
      { id: "b", color: "#00ff00" },
      { id: "c" },
      { id: "d", style: "highlight", color: "yellow" },
      { id: "e", style: "highlight", color: "red" },
      { id: "f", style: "squiggly", color: "red" },
      { id: "g", style: "underline" },
      { id: "h", style: "highlight", color: "#00FF00" },
    ];
    const groups = groupNoteHighlights(notes);
    expect(groups.map((g) => [g.name, g.priority, g.items.map((n) => n.id).join("")])).toEqual([
      [LEGACY_NOTE_HIGHLIGHT_NAME, 1, "c"],
      ["reader-hl-highlight-red", 2, "e"],
      ["reader-hl-highlight-yellow", 3, "d"],
      ["reader-hl-highlight-00ff00", 4, "bh"],
      ["reader-hl-underline-theme", 5, "g"],
      ["reader-hl-squiggly-red", 6, "af"],
    ]);
    // Input order does not change the order.
    expect(groupNoteHighlights([...notes].reverse()).map((g) => g.name)).toEqual(groups.map((g) => g.name));
  });
});

describe("note highlight CSS", () => {
  const allLooks = groupNoteHighlights(
    NOTE_HIGHLIGHT_STYLES.flatMap((style) => HIGHLIGHT_COLOR_NAMES.map((color) => ({ style, color }))),
  );

  it.each(THEMES)("draws 5 colors × 3 styles with the contract colors in %s", (theme) => {
    const css = buildNoteHighlightCss(allLooks, theme);
    const palette = HIGHLIGHT_PALETTES[DARK.has(theme) ? "dark" : "light"];
    for (const color of HIGHLIGHT_COLOR_NAMES) {
      expect(rule(css, `reader-hl-highlight-${color}`)).toBe(` background-color: ${palette[color].background}; `);
      const underline = rule(css, `reader-hl-underline-${color}`);
      expect(underline).toContain("text-decoration-style: solid;");
      expect(underline).not.toContain("wavy");
      expect(underline).toContain(`text-decoration-color: ${palette[color].line};`);
      const squiggly = rule(css, `reader-hl-squiggly-${color}`);
      expect(squiggly).toMatch(/text-decoration-style: solid; text-decoration-style: wavy;/);
      expect(squiggly).toContain(`text-decoration-color: ${palette[color].line};`);
    }
    // Only paint properties Custom Highlights support; no layout properties.
    expect(css).not.toMatch(/padding|margin|border|outline|font|display/);
  });

  it("derives custom hex ink for light and dark paper", () => {
    expect(highlightInk("#3366CC", false)).toEqual({ background: "rgba(51, 102, 204, 0.28)", line: "#3366cc" });
    // 65:35 with white: 0x33 → 122 (#7a), 0x66 → 156 (#9c), 0xcc → 222 (#de).
    expect(highlightInk("#3366cc", true)).toEqual({ background: "rgba(122, 156, 222, 0.3)", line: "#7a9cde" });
    const groups = groupNoteHighlights([{ style: "highlight", color: "#3366cc" }, { style: "underline", color: "#3366cc" }]);
    expect(rule(buildNoteHighlightCss(groups, "sepia"), "reader-hl-highlight-3366cc")).toContain("rgba(51, 102, 204, 0.28)");
    expect(rule(buildNoteHighlightCss(groups, "gray"), "reader-hl-underline-3366cc")).toContain("#7a9cde");
  });

  it("uses the theme note color for a style without color, custom themes by paper tone", () => {
    const groups = groupNoteHighlights([{ style: "underline" }, { style: "highlight" }]);
    expect(rule(buildNoteHighlightCss(groups, "dark"), "reader-hl-underline-theme")).toContain(
      `text-decoration-color: ${READER_PALETTES.dark.noteUnderline};`,
    );
    const night = customThemeKey({ background: "#101820", foreground: "#e0e0e0", accent: "#ff8800" });
    expect(rule(buildNoteHighlightCss(groupNoteHighlights([{ color: "blue" }]), night), "reader-hl-highlight-blue")).toContain(
      HIGHLIGHT_PALETTES.dark.blue.background,
    );
  });

  it("leaves the legacy underline to the unchanged theme sheet", () => {
    const groups = groupNoteHighlights([{}]);
    expect(buildNoteHighlightCss(groups, "light")).toBe("");
    for (const theme of THEMES) {
      const legacy = rule(buildThemeCss(theme), LEGACY_NOTE_HIGHLIGHT_NAME);
      expect(legacy).toContain("text-decoration-style: solid;");
      expect(legacy).toContain(`text-decoration-color: ${READER_PALETTES[theme].noteUnderline};`);
      expect(legacy).not.toContain("background");
    }
  });

  it.each(THEMES)("keeps search hits distinct from yellow highlights in %s", (theme) => {
    const search = rule(buildThemeCss(theme), "reader-search-hit");
    const yellow = HIGHLIGHT_PALETTES[DARK.has(theme) ? "dark" : "light"].yellow;
    expect(search).toContain(`background-color: ${READER_PALETTES[theme].searchBackground};`);
    expect(search).not.toContain(yellow.background);
    expect(search).toContain("text-decoration-line: underline;");
    expect(search).toContain(`text-decoration-color: ${READER_PALETTES[theme].searchForeground};`);
  });

  it("places the group sheet after the theme sheet and removes it when empty", () => {
    const { document } = parseHTML(
      '<html><head><style data-reader="theme"></style><style data-reader="user-css"></style></head><body></body></html>',
    );
    writeNoteHighlightStyle(document, "::highlight(x) { background-color: red; }");
    const order = [...document.querySelectorAll("style")].map((s) => s.getAttribute("data-reader"));
    expect(order).toEqual(["theme", "note-highlights", "user-css"]);
    writeNoteHighlightStyle(document, "");
    expect(document.querySelector('style[data-reader="note-highlights"]')).toBeNull();
  });
});
