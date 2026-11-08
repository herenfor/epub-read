import type { BuiltinTheme, Theme } from "../render/settings";
import { customReaderPalette, isDarkPaper, mixHex, parseCustomThemeKey, rgba } from "./customThemes";

interface ReaderPalette {
  background: string;
  foreground: string;
  /** Application text may differ from book text, especially on paper surfaces. */
  uiForeground: string;
  previewBorder: string;
  /** Only dark themes override author TOC links. */
  tocLink?: string;
  noteUnderline: string;
  searchBackground: string;
  searchForeground: string;
}

/** Color data only: safe for rendering code without any UI or DOM dependency. */
export const READER_PALETTES = {
  light: {
    background: "#ffffff",
    foreground: "#1a1a1a",
    uiForeground: "#1a1a1a",
    previewBorder: "#e2e8f0",
    noteUnderline: "#b06a00",
    searchBackground: "rgba(255, 196, 0, 0.42)",
    searchForeground: "#111111",
  },
  sepia: {
    background: "#f4ecd8",
    foreground: "#3b2f1e",
    uiForeground: "#3c332a",
    previewBorder: "#e8dac0",
    noteUnderline: "#9b6a00",
    searchBackground: "rgba(211, 151, 0, 0.42)",
    searchForeground: "#111111",
  },
  gray: {
    background: "#2d2d30",
    foreground: "#d4d4d8",
    uiForeground: "#d4d4d8",
    previewBorder: "#3e3e42",
    tocLink: "#818cf8",
    noteUnderline: "#6cb2ff",
    searchBackground: "rgba(255, 213, 79, 0.45)",
    searchForeground: "#111111",
  },
  dark: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    uiForeground: "#d4d4d4",
    previewBorder: "#27272a",
    tocLink: "#6cb2ff",
    noteUnderline: "#6cb2ff",
    searchBackground: "rgba(255, 213, 79, 0.45)",
    searchForeground: "#111111",
  },
} as const satisfies Readonly<Record<BuiltinTheme, ReaderPalette>>;

export function isBuiltinTheme(theme: unknown): theme is BuiltinTheme {
  return typeof theme === "string" && Object.prototype.hasOwnProperty.call(READER_PALETTES, theme);
}

/** Reader colors of any theme; an unreadable user theme falls back to white. */
export function resolveReaderPalette(theme: Theme): ReaderPalette {
  if (isBuiltinTheme(theme)) return READER_PALETTES[theme];
  const colors = parseCustomThemeKey(theme);
  return colors ? customReaderPalette(colors) : READER_PALETTES.light;
}

/** Dark themes get the dark-paper repairs (emphasis marks, TOC links, contrast fixes). */
export function isDarkReaderTheme(theme: Theme): boolean {
  if (theme === "dark" || theme === "gray") return true;
  if (isBuiltinTheme(theme)) return false;
  const colors = parseCustomThemeKey(theme);
  return colors ? isDarkPaper(colors.background) : false;
}

/** The five highlight color names (same order as the notes data contract, ER-0106). */
export const HIGHLIGHT_COLOR_NAMES = ["red", "yellow", "green", "blue", "violet"] as const;
export type HighlightColorName = (typeof HIGHLIGHT_COLOR_NAMES)[number];

/** Background for the "highlight" style, line for "underline" and "squiggly". */
export interface HighlightInk {
  readonly background: string;
  readonly line: string;
}

/** ER-0106 frozen colors: one set for light paper, one for dark paper. */
export const HIGHLIGHT_PALETTES = {
  light: {
    red: { background: "rgba(239, 68, 68, 0.26)", line: "#d64545" },
    yellow: { background: "rgba(250, 204, 21, 0.40)", line: "#c29200" },
    green: { background: "rgba(34, 197, 94, 0.26)", line: "#2f9e5b" },
    blue: { background: "rgba(59, 130, 246, 0.24)", line: "#2f6fd6" },
    violet: { background: "rgba(168, 85, 247, 0.24)", line: "#8b4fd6" },
  },
  dark: {
    red: { background: "rgba(248, 113, 113, 0.30)", line: "#f28b8b" },
    yellow: { background: "rgba(250, 204, 21, 0.26)", line: "#e3c04a" },
    green: { background: "rgba(74, 222, 128, 0.22)", line: "#6fd49a" },
    blue: { background: "rgba(96, 165, 250, 0.28)", line: "#8ab8ff" },
    violet: { background: "rgba(192, 132, 252, 0.28)", line: "#c59bff" },
  },
} as const satisfies Record<"light" | "dark", Record<HighlightColorName, HighlightInk>>;

const HIGHLIGHT_HEX = /^#[0-9a-f]{6}$/i;

export function isHighlightColorName(value: unknown): value is HighlightColorName {
  return typeof value === "string" && (HIGHLIGHT_COLOR_NAMES as readonly string[]).includes(value);
}

/**
 * Ink for a stored highlight color: a palette name or `#rrggbb` (custom or imported).
 * Light paper uses the hex as the line and at 28% as the background; dark paper
 * first mixes it 65:35 with white, then uses that at 30%. Unknown values return null.
 */
export function highlightInk(color: string, darkPaper: boolean): HighlightInk | null {
  if (isHighlightColorName(color)) return HIGHLIGHT_PALETTES[darkPaper ? "dark" : "light"][color];
  if (!HIGHLIGHT_HEX.test(color)) return null;
  const hex = color.toLowerCase();
  if (!darkPaper) return { background: rgba(hex, 0.28), line: hex };
  const lifted = mixHex(hex, "#ffffff", 0.35);
  return { background: rgba(lifted, 0.3), line: lifted };
}

/** A style without a color uses the theme's note color unchanged as the line. */
export function themeHighlightInk(theme: Theme): HighlightInk {
  const line = resolveReaderPalette(theme).noteUnderline;
  return { background: rgba(line, isDarkReaderTheme(theme) ? 0.3 : 0.28), line };
}
