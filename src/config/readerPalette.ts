import type { Theme } from "../render/settings";

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
} as const satisfies Readonly<Record<Theme, ReaderPalette>>;
