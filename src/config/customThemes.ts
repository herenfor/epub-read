/**
 * User themes: three chosen colors (paper, text, accent) and a name. Every
 * other reader and interface color is derived here, so a theme can never be
 * half defined. Color data only: no DOM, storage or UI dependency.
 */

export interface CustomThemeColors {
  background: string;
  foreground: string;
  accent: string;
}

export interface CustomTheme extends CustomThemeColors {
  id: string;
  name: string;
}

/** Hard limits, also applied to whatever storage hands back. */
export const MAX_CUSTOM_THEMES = 6;
export const MAX_CUSTOM_THEME_NAME = 12;

/**
 * What the reader receives for a user theme: the colors themselves, so an
 * edit is a new theme value and every "theme changed?" check sees it.
 */
export type CustomThemeKey = `c:${string}`;

const HEX = /^#[0-9a-f]{6}$/;
const KEY = /^c:([0-9a-f]{6})([0-9a-f]{6})([0-9a-f]{6})$/;
const ID = /^[a-z0-9]{1,16}$/;

/** "#ABC123" / "abc123" → "#abc123"; anything else → null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX.test(hex) ? hex : null;
}

export function customThemeKey(colors: CustomThemeColors): CustomThemeKey {
  return `c:${colors.background.slice(1)}${colors.foreground.slice(1)}${colors.accent.slice(1)}`;
}

export function isCustomThemeKey(value: unknown): value is CustomThemeKey {
  return typeof value === "string" && KEY.test(value);
}

export function parseCustomThemeKey(value: string): CustomThemeColors | null {
  const match = KEY.exec(value);
  return match ? { background: `#${match[1]}`, foreground: `#${match[2]}`, accent: `#${match[3]}` } : null;
}

/** Trim and cut by characters (not UTF-16 units), so a name never ends in half an emoji. */
export function clampThemeName(name: string): string {
  return Array.from(name.trim()).slice(0, MAX_CUSTOM_THEME_NAME).join("");
}

/**
 * Keep at most MAX_CUSTOM_THEMES valid, uniquely identified themes, in order.
 * Invalid entries are dropped rather than repaired.
 */
export function sanitizeCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const themes: CustomTheme[] = [];
  for (const raw of value) {
    if (themes.length >= MAX_CUSTOM_THEMES) break;
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" && ID.test(entry.id) ? entry.id : null;
    const background = normalizeHexColor(entry.background);
    const foreground = normalizeHexColor(entry.foreground);
    const accent = normalizeHexColor(entry.accent);
    if (!id || seen.has(id) || !background || !foreground || !accent) continue;
    seen.add(id);
    themes.push({ id, name: typeof entry.name === "string" ? clampThemeName(entry.name) : "", background, foreground, accent });
  }
  return themes;
}

export function newCustomThemeId(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  for (;;) {
    const id = Math.floor(random() * 36 ** 8).toString(36).padStart(8, "0").slice(0, 8);
    if (!used.has(id)) return id;
  }
}

// ---- color math ----

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** Linear mix from a to b (t = 0 → a). */
export function mixHex(a: string, b: string, t: number): string {
  const x = channels(a);
  const y = channels(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Dark when white text would read better on the paper than black text. */
export function isDarkPaper(background: string): boolean {
  return relativeLuminance(background) < 0.179;
}

function rgba(hex: string, alpha: number): string {
  return `rgba(${channels(hex).join(", ")}, ${alpha})`;
}

/**
 * The accent as interface marks use it: the chosen color, moved toward the
 * text color only as far as needed to stay visible on the paper (3:1).
 */
export function usableAccent(colors: CustomThemeColors): string {
  for (let step = 0; step <= 10; step++) {
    const candidate = mixHex(colors.accent, colors.foreground, step / 10);
    if (contrastRatio(candidate, colors.background) >= 3) return candidate;
  }
  return colors.foreground;
}

/** Reader colors, in the shape of READER_PALETTES entries. */
export function customReaderPalette(colors: CustomThemeColors) {
  const dark = isDarkPaper(colors.background);
  const accent = usableAccent(colors);
  return {
    background: colors.background,
    foreground: colors.foreground,
    uiForeground: colors.foreground,
    previewBorder: mixHex(colors.background, colors.foreground, 0.12),
    tocLink: dark ? accent : undefined,
    noteUnderline: accent,
    searchBackground: dark ? "rgba(255, 213, 79, 0.45)" : "rgba(255, 196, 0, 0.42)",
    searchForeground: "#111111",
  };
}

/** The interface variables a built-in theme sets in styles.css, derived for a user theme. */
export function customThemeTokens(colors: CustomThemeColors): { root: Record<string, string>; app: Record<string, string> } {
  const { background: bg, foreground: fg } = colors;
  const dark = isDarkPaper(bg);
  const accent = usableAccent(colors);
  const panelBg = dark ? mixHex(bg, "#000000", 0.15) : mixHex(bg, fg, 0.04);
  return {
    root: {
      "--bg": bg,
      "--fg": fg,
      "--panel-bg": panelBg,
      "--panel-border": mixHex(bg, fg, dark ? 0.18 : 0.14),
      "--panel-surface": dark ? mixHex(bg, "#000000", 0.18) : mixHex(bg, fg, 0.05),
      "--panel-card": dark ? mixHex(bg, fg, 0.07) : mixHex(bg, "#ffffff", 0.55),
      "--accent": accent,
      "--btn-hover": mixHex(panelBg, fg, 0.08),
      "--error": dark ? "#ff8a80" : "#b3261e",
      "--muted": mixHex(fg, bg, 0.4),
      "--menu-surface": `color-mix(in srgb, var(--accent) ${dark ? 12 : 7}%, var(--panel-bg))`,
      "--menu-surface-hover": `color-mix(in srgb, var(--accent) ${dark ? 20 : 12}%, var(--panel-bg))`,
      "--menu-surface-border": `color-mix(in srgb, var(--accent) ${dark ? 30 : 22}%, var(--panel-border))`,
      "--accent-foreground": contrastRatio(accent, "#ffffff") >= 3 ? "#ffffff" : "#111111",
      "--scroll-thumb": dark ? "rgba(255, 255, 255, 0.28)" : rgba(fg, 0.25),
      "--scroll-thumb-hover": dark ? "rgba(255, 255, 255, 0.5)" : rgba(fg, 0.45),
      "--shelf-card-bg": dark ? mixHex(bg, fg, 0.05) : mixHex(bg, "#ffffff", 0.5),
      "--shelf-card-border": dark ? "rgba(255, 255, 255, 0.08)" : rgba(fg, 0.1),
      "--shelf-card-shadow": dark ? "0 1px 4px rgba(0, 0, 0, 0.35)" : "0 1px 4px rgba(0, 0, 0, 0.06)",
      "--shelf-card-hover-shadow": dark
        ? "0 10px 24px -2px rgba(0, 0, 0, 0.55), 0 3px 8px -1px rgba(0, 0, 0, 0.3)"
        : "0 10px 22px -2px rgba(0, 0, 0, 0.14), 0 3px 6px -1px rgba(0, 0, 0, 0.06)",
      "--shelf-input-bg": dark ? "rgba(255, 255, 255, 0.06)" : rgba(fg, 0.05),
      "--shelf-badge-bg": rgba(dark ? "#000000" : fg, 0.72),
    },
    app: {
      "--btn-tint": rgba(accent, dark ? 0.16 : 0.13),
      "--btn-tint-hover": rgba(accent, dark ? 0.3 : 0.26),
    },
  };
}

/** Starting points in the editor; picking one copies its colors (and name, for a fresh theme). */
export const CUSTOM_THEME_PRESETS: ReadonlyArray<{ id: string; nameKey: string } & CustomThemeColors> = [
  { id: "light", nameKey: "aa.theme.light", background: "#ffffff", foreground: "#1a1a1a", accent: "#2b5b9e" },
  { id: "sepia", nameKey: "aa.theme.sepia", background: "#f4ecd8", foreground: "#3b2f1e", accent: "#8a5a2b" },
  { id: "eye", nameKey: "aa.customTheme.preset.eye", background: "#c7edcc", foreground: "#2b3a2e", accent: "#3f7d4e" },
  { id: "ink", nameKey: "aa.customTheme.preset.ink", background: "#ffffff", foreground: "#000000", accent: "#000000" },
  { id: "gray", nameKey: "aa.theme.gray", background: "#2d2d30", foreground: "#d4d4d8", accent: "#818cf8" },
  { id: "dark", nameKey: "aa.theme.dark", background: "#1e1e1e", foreground: "#d4d4d4", accent: "#6ea8dc" },
  { id: "navy", nameKey: "aa.customTheme.preset.navy", background: "#141b26", foreground: "#a9b8c9", accent: "#6ea8dc" },
];

export const CUSTOM_THEME_SWATCHES: Readonly<Record<keyof CustomThemeColors, readonly string[]>> = {
  background: ["#ffffff", "#f7f4ee", "#f4ecd8", "#c7edcc", "#e6edf5", "#f6e7e4", "#2d2d30", "#1e1e1e", "#141b26", "#000000"],
  foreground: ["#1a1a1a", "#3b2f1e", "#2b3a2e", "#34404f", "#000000", "#d4d4d4", "#c9bfae", "#a9b8c9", "#ffffff"],
  accent: ["#2b5b9e", "#8a5a2b", "#3f7d4e", "#b4552d", "#7c5cc4", "#c2416b", "#6ea8dc", "#818cf8", "#000000"],
};
