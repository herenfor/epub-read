/**
 * Share card contract (ER-0118): what goes on a card, the four looks, the
 * sizes (three fixed, one that grows with the text) and their fixed palettes. A card is an image, so its colours
 * never follow the app theme.
 */

export type ShareTemplate = "paper" | "cover" | "night" | "vertical";
export type ShareRatio = "3:4" | "1:1" | "9:16" | "long";

export const SHARE_TEMPLATES: readonly ShareTemplate[] = ["paper", "cover", "night", "vertical"];
export const SHARE_RATIOS: readonly ShareRatio[] = ["3:4", "1:1", "9:16", "long"];

/** Every card is exported 1080 px wide. */
export const SHARE_CARD_WIDTH = 1080;

/**
 * A long card (ER-0162) is as tall as its text needs, between these bounds;
 * past the upper bound the passage is cut like on a fixed card.
 */
export const SHARE_LONG_MIN_HEIGHT = 1080;
export const SHARE_LONG_MAX_HEIGHT = 12960;

/** The card's export size. For a long card this is its smallest size; shareCardHeight gives the real one. */
export function shareCardSize(ratio: ShareRatio): { width: number; height: number } {
  const height = ratio === "1:1" ? 1080 : ratio === "9:16" ? 1920 : ratio === "long" ? SHARE_LONG_MIN_HEIGHT : 1440;
  return { width: SHARE_CARD_WIDTH, height };
}

export interface ShareCardContent {
  /** The passage, already trimmed to the sentences the reader chose. */
  quote: string;
  /** The reader's own note on the passage; empty for a plain highlight. */
  note?: string;
  bookTitle: string;
  author?: string;
  chapter?: string;
  /** The highlight colour: a palette name (red, yellow, green, blue, violet) or #rrggbb. */
  accent?: string;
}

export interface ShareCardOptions {
  template: ShareTemplate;
  ratio: ShareRatio;
  showNote: boolean;
  showCover: boolean;
  showChapter: boolean;
  showBrand: boolean;
}

export const DEFAULT_SHARE_OPTIONS: ShareCardOptions = {
  template: "paper",
  ratio: "3:4",
  showNote: true,
  showCover: true,
  showChapter: true,
  showBrand: true,
};

export interface ShareCardPalette {
  bg: string;
  fg: string;
  muted: string;
  rule: string;
  /** The brand icon's square and its pages. */
  markBg: string;
  markFg: string;
  accent: string;
}

/** Highlight line colours from the ER-0106 palette (light pages, then dark pages). */
const ACCENT_LIGHT: Record<string, string> = {
  red: "#d64545", yellow: "#c29200", green: "#2f9e5b", blue: "#2f6fd6", violet: "#8b4fd6",
};
const ACCENT_DARK: Record<string, string> = {
  red: "#f28b8b", yellow: "#e3c04a", green: "#6fd49a", blue: "#8ab8ff", violet: "#c59bff",
};

/** A cover-tone card with no cover to sample from. */
export const FALLBACK_COVER_TONE = "#3b3a36";

const HEX = /^#[0-9a-f]{6}$/i;

/** The accent for a card: the highlight colour, lifted toward white on a dark card. */
export function resolveAccent(accent: string | undefined, dark: boolean): string {
  const key = accent?.trim().toLowerCase() ?? "";
  if (HEX.test(key)) return dark ? mixHex(key, "#ffffff", 0.35) : key;
  const table = dark ? ACCENT_DARK : ACCENT_LIGHT;
  return table[key] ?? table.yellow;
}

export function shareCardPalette(template: ShareTemplate, accent: string | undefined, coverTone?: string | null): ShareCardPalette {
  switch (template) {
    case "night":
      return { bg: "#18191b", fg: "#e7e3da", muted: "#8d8a83", rule: "rgba(231,227,218,0.12)", markBg: "#e7e3da", markFg: "#18191b", accent: resolveAccent(accent, true) };
    case "cover": {
      const tone = coverTone && HEX.test(coverTone) ? coverTone : FALLBACK_COVER_TONE;
      return { bg: tone, fg: "#f4f0e7", muted: "rgba(244,240,231,0.64)", rule: "rgba(244,240,231,0.18)", markBg: "#f4f0e7", markFg: tone, accent: "rgba(244,240,231,0.7)" };
    }
    case "vertical":
      return { bg: "#f2eee5", fg: "#2a2721", muted: "#8a8374", rule: "rgba(42,39,33,0.12)", markBg: "#2a2721", markFg: "#f2eee5", accent: resolveAccent(accent, false) };
    case "paper":
    default:
      return { bg: "#f6f2ea", fg: "#29261f", muted: "#877f71", rule: "rgba(41,38,31,0.12)", markBg: "#29261f", markFg: "#f6f2ea", accent: resolveAccent(accent, false) };
  }
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** True when the passage is written without Chinese, Japanese or Korean characters. */
export function isLatinText(text: string): boolean {
  return !CJK.test(text);
}

/** Vertical layout is offered for Chinese and Japanese passages only, and not on a long card. */
export function canUseVertical(quote: string, ratio?: ShareRatio): boolean {
  return ratio !== "long" && !isLatinText(quote);
}

export function mixHex(a: string, b: string, amountOfB: number): string {
  const pa = parseHex(a), pb = parseHex(b);
  const mix = pa.map((v, i) => Math.round(v + (pb[i] - v) * amountOfB));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
