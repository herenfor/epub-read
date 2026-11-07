import {
  HIGHLIGHT_COLOR_NAMES,
  highlightInk,
  isDarkReaderTheme,
  isHighlightColorName,
  themeHighlightInk,
} from "../config/readerPalette";
import type { Theme } from "./settings";

/**
 * Body highlights by style × color (ER-0108, contract ER-0106).
 *
 * Every group is one CSS Custom Highlight; nothing wraps body text, so layout
 * and pagination never change. Notes without style and color keep the old
 * `reader-notes` underline drawn by the theme sheet.
 */

export const NOTE_HIGHLIGHT_STYLES = ["highlight", "underline", "squiggly"] as const;
export type NoteHighlightStyle = (typeof NOTE_HIGHLIGHT_STYLES)[number];

/** Pre-highlight notes: the theme underline from buildThemeCss. */
export const LEGACY_NOTE_HIGHLIGHT_NAME = "reader-notes";
/** Search hits sit above every note group (see searchHighlight.ts). */
export const SEARCH_HIGHLIGHT_PRIORITY = 1_000_000;
export const NOTE_HIGHLIGHT_STYLE_ATTR = "note-highlights";

export interface NoteHighlightLook {
  readonly style: NoteHighlightStyle;
  /** Palette name or lowercase `#rrggbb`; null = the theme's note color. */
  readonly color: string | null;
}

export interface NoteHighlightGroup<T> {
  /** CSS highlight name, also the ::highlight() selector argument. */
  readonly name: string;
  /** null for the legacy group. */
  readonly look: NoteHighlightLook | null;
  /** Highlight.priority: fixed order so overlaps always resolve the same way. */
  readonly priority: number;
  readonly items: T[];
}

const HEX = /^#[0-9a-f]{6}$/i;

function isStyle(value: unknown): value is NoteHighlightStyle {
  return typeof value === "string" && (NOTE_HIGHLIGHT_STYLES as readonly string[]).includes(value);
}

function normalizeColor(value: unknown): string | null {
  if (isHighlightColorName(value)) return value;
  return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : null;
}

/**
 * Contract defaults: neither field → legacy (null); style only → theme color;
 * color only → "highlight". Unreadable values count as missing.
 */
export function resolveNoteHighlightLook(note: { style?: unknown; color?: unknown }): NoteHighlightLook | null {
  const style = isStyle(note.style) ? note.style : null;
  const color = normalizeColor(note.color);
  if (!style && !color) return null;
  return { style: style ?? "highlight", color };
}

export function noteHighlightName(look: NoteHighlightLook | null): string {
  if (!look) return LEGACY_NOTE_HIGHLIGHT_NAME;
  const color = look.color === null ? "theme" : look.color.replace("#", "");
  return `reader-hl-${look.style}-${color}`;
}

function colorRank(color: string | null): [number, string] {
  if (color === null) return [0, ""];
  const named = (HIGHLIGHT_COLOR_NAMES as readonly string[]).indexOf(color);
  return named >= 0 ? [1 + named, ""] : [1 + HIGHLIGHT_COLOR_NAMES.length, color];
}

function compareLooks(a: NoteHighlightLook | null, b: NoteHighlightLook | null): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const style = NOTE_HIGHLIGHT_STYLES.indexOf(a.style) - NOTE_HIGHLIGHT_STYLES.indexOf(b.style);
  if (style !== 0) return style;
  const [ra, ha] = colorRank(a.color);
  const [rb, hb] = colorRank(b.color);
  return ra !== rb ? ra - rb : ha < hb ? -1 : ha > hb ? 1 : 0;
}

/**
 * Groups notes by look. Priority order: legacy, then highlight < underline <
 * squiggly, and inside a style theme color, the five colors, then hex A→Z.
 * Groups only overlap on the same property within a style (or legacy vs a line
 * style), so a later style wins its own property and backgrounds still show.
 */
export function groupNoteHighlights<T extends { style?: unknown; color?: unknown }>(
  notes: readonly T[],
): NoteHighlightGroup<T>[] {
  const byName = new Map<string, { look: NoteHighlightLook | null; items: T[] }>();
  for (const note of notes) {
    const look = resolveNoteHighlightLook(note);
    const name = noteHighlightName(look);
    const group = byName.get(name);
    if (group) group.items.push(note);
    else byName.set(name, { look, items: [note] });
  }
  return [...byName.entries()]
    .sort(([, a], [, b]) => compareLooks(a.look, b.look))
    .map(([name, group], index) => ({ name, look: group.look, priority: index + 1, items: group.items }));
}

const LINE_RULES = "text-decoration-line: underline; text-underline-offset: 0.15em;";

/**
 * ::highlight rules for the groups on the page, for the current paper.
 * Only properties Custom Highlights paint (background-color, text-decoration).
 * Squiggly declares solid first so an engine that rejects wavy keeps a line.
 */
export function buildNoteHighlightCss(
  groups: readonly Pick<NoteHighlightGroup<unknown>, "name" | "look">[],
  theme: Theme,
): string {
  const dark = isDarkReaderTheme(theme);
  const rules: string[] = [];
  for (const { name, look } of groups) {
    if (!look) continue;
    const ink = (look.color === null ? null : highlightInk(look.color, dark)) ?? themeHighlightInk(theme);
    if (look.style === "highlight") {
      rules.push(`::highlight(${name}) { background-color: ${ink.background}; }`);
    } else if (look.style === "underline") {
      rules.push(
        `::highlight(${name}) { ${LINE_RULES} text-decoration-style: solid; text-decoration-thickness: 2px; text-decoration-color: ${ink.line}; }`,
      );
    } else {
      rules.push(
        `::highlight(${name}) { ${LINE_RULES} text-decoration-style: solid; text-decoration-style: wavy; text-decoration-thickness: 1.5px; text-decoration-color: ${ink.line}; }`,
      );
    }
  }
  return rules.join("\n");
}

/** The note-group sheet sits right after the theme sheet, before user CSS. */
export function writeNoteHighlightStyle(doc: Document, css: string): void {
  let el = doc.querySelector<HTMLStyleElement>(`style[data-reader="${NOTE_HIGHLIGHT_STYLE_ATTR}"]`);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement("style");
    el.setAttribute("data-reader", NOTE_HIGHLIGHT_STYLE_ATTR);
    const theme = doc.querySelector('style[data-reader="theme"]');
    if (theme?.parentNode) theme.parentNode.insertBefore(el, theme.nextSibling);
    else (doc.head ?? doc.documentElement).appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}
