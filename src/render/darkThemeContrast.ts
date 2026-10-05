export interface DarkThemeComputedStyle {
  color: string;
  backgroundColor: string;
  backgroundImage: string;
  opacity: string;
  display?: string;
  visibility?: string;
}

export interface DarkThemeStyleAdapter {
  getComputedStyle(element: Element): DarkThemeComputedStyle;
  setColor(element: Element, color: string): void;
  mark(element: Element): void;
}

export interface DarkThemeContrastOptions {
  theme: "dark" | "light" | "sepia" | "gray";
  adapter?: DarkThemeStyleAdapter;
  /**
   * 本轮用户自定义 CSS 是否明确声明了该元素的 color。
   * 由接线层识别规则来源，不从颜色值反推用户意图。
   */
  userOwnsColor?: (element: Element) => boolean;
}

export const DARK_THEME_FOREGROUND = { r: 212, g: 212, b: 212, a: 1 } as const;
export const DARK_THEME_CANDIDATE = "#1a1a1a";
export const DARK_THEME_MARKER = "data-reader-dark-contrast";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i;
const MODERN_RGB = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i;

function channel(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(255, parsed)) : null;
}

function alpha(value: string | undefined): number | null {
  if (value === undefined) return 1;
  const parsed = value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null;
}

/** Parse the computed RGB forms used by WebView2/Chromium, plus hex for tests. */
export function parseRgba(value: string): Rgba | null {
  const input = value.trim().toLowerCase();
  if (input === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([\da-f]{3,8})$/i.exec(input);
  if (hex) {
    const raw = hex[1];
    const expanded = raw.length <= 4 ? raw.split("").map((item) => item + item).join("") : raw;
    if (expanded.length !== 6 && expanded.length !== 8) return null;
    return {
      r: parseInt(expanded.slice(0, 2), 16),
      g: parseInt(expanded.slice(2, 4), 16),
      b: parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const match = RGB.exec(input) ?? MODERN_RGB.exec(input);
  if (!match) return null;
  const r = channel(match[1]);
  const g = channel(match[2]);
  const b = channel(match[3]);
  const a = alpha(match[4]);
  return r === null || g === null || b === null || a === null ? null : { r, g, b, a };
}

export function compositeRgba(foreground: Rgba, background: Rgba): Rgba {
  const outAlpha = foreground.a + background.a * (1 - foreground.a);
  if (outAlpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / outAlpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / outAlpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / outAlpha,
    a: outAlpha,
  };
}

function relativeLuminance(color: Rgba): number {
  const linear = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function defaultAdapter(doc: Document): DarkThemeStyleAdapter | null {
  const win = doc.defaultView;
  if (!win) return null;
  return {
    getComputedStyle: (element) => {
      const style = win.getComputedStyle(element);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        opacity: style.opacity,
        display: style.display,
        visibility: style.visibility,
      };
    },
    setColor: (element, color) => (element as HTMLElement).style.setProperty("color", color, ""),
    mark: (element) => element.setAttribute(DARK_THEME_MARKER, "1"),
  };
}

export const GRAY_THEME_FOREGROUND = { r: 212, g: 212, b: 216, a: 1 } as const;

function nearThemeForeground(color: Rgba, theme: "dark" | "gray" = "dark"): boolean {
  const target = theme === "gray" ? GRAY_THEME_FOREGROUND : DARK_THEME_FOREGROUND;
  return Math.max(
    Math.abs(color.r - target.r),
    Math.abs(color.g - target.g),
    Math.abs(color.b - target.b),
  ) <= 8;
}

function chooseDarkThemeTextRepair(input: {
  foreground: Rgba;
  background: Rgba;
  theme: "dark" | "gray";
  userOwnsColor: boolean;
}): string | null {
  const { foreground, background, theme, userOwnsColor } = input;
  if (userOwnsColor) return null;

  const current = contrastRatio(compositeRgba(foreground, background), background);
  if (current >= 4.5) return null;

  let candidate: string;
  if (nearThemeForeground(foreground, theme)) {
    // 保留已有方向：主题浅字落在作者浅色底上。
    candidate = DARK_THEME_CANDIDATE;
  } else {
    // 新方向仅处理不透明的黑/深灰正文，保留作者彩字/半透明装饰。
    const channels = [foreground.r, foreground.g, foreground.b];
    const neutral = Math.max(...channels) - Math.min(...channels) <= 12;
    if (!neutral || foreground.a < 1 || Math.max(...channels) > 128) return null;
    candidate = theme === "gray" ? "#d4d4d8" : "#d4d4d4";
  }

  const repaired = contrastRatio(parseRgba(candidate)!, background);
  return repaired >= 4.5 && repaired >= current + 1.5 ? candidate : null;
}

interface BackgroundState {
  color: Rgba;
  unsafe: boolean;
}

function hasUnsafeOpacity(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  const parsed = Number(normalized);
  return !Number.isFinite(parsed) || parsed < 1;
}

/** Read one element's background contribution without walking its ancestors. */
function extendBackground(parent: BackgroundState, style: DarkThemeComputedStyle): BackgroundState {
  const hasBackgroundImage = style.backgroundImage.trim() !== "none";
  const background = parseRgba(style.backgroundColor);
  const unsafe = parent.unsafe || hasBackgroundImage || hasUnsafeOpacity(style.opacity) || !background;
  return unsafe || !background
    ? { color: parent.color, unsafe: true }
    : { color: compositeRgba(background, parent.color), unsafe: false };
}

/** Apply conservative dark-theme contrast fixes once to one loaded chapter. */
export function applyDarkThemeContrast(doc: Document, options: DarkThemeContrastOptions): number {
  if (options.theme !== "dark" && options.theme !== "gray") return 0;
  const theme = options.theme;
  const adapter = options.adapter ?? defaultAdapter(doc);
  if (!adapter || !doc.body) return 0;
  let fixed = 0;

  // Compute the html/body ancestor baseline once. Descendants are then visited
  // top-down so a parent's inline fix is visible to inherited child styles.
  const ancestors: Element[] = [];
  for (let current = doc.body.parentElement; current; current = current.parentElement) ancestors.unshift(current);
  let rootBackground: BackgroundState = {
    color: { r: 255, g: 255, b: 255, a: 1 },
    unsafe: false,
  };
  for (const ancestor of ancestors) {
    const style = adapter.getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden") return 0;
    rootBackground = extendBackground(rootBackground, style);
  }

  const visit = (element: Element, inheritedBackground: BackgroundState): void => {
    const style = adapter.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return;
    const background = extendBackground(inheritedBackground, style);
    const foreground = parseRgba(style.color);
    if (!background.unsafe && (element.textContent ?? "").trim() !== "" && foreground) {
      const repaired = chooseDarkThemeTextRepair({
        foreground,
        background: background.color,
        theme,
        userOwnsColor: options.userOwnsColor?.(element) ?? false,
      });
      if (repaired !== null) {
        adapter.setColor(element, repaired);
        adapter.mark(element);
        fixed++;
      }
    }
    for (const child of Array.from(element.children)) visit(child, background);
  };

  visit(doc.body, rootBackground);
  return fixed;
}
