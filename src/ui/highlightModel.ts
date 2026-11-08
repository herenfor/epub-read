import type { CSSProperties } from "react";
import { NOTE_COLOR_NAMES, type NoteColor, type NoteStyle } from "./notes";

/** What the selection menu needs to know about the highlight under a selection. */
export interface HighlightTarget {
  id: string;
  style?: NoteStyle;
  color?: NoteColor;
  content: string;
}

interface AnchoredNote extends HighlightTarget {
  spineIndex: number;
  chapterPath: string;
  startTextOffset: number;
  endTextOffset: number;
}

/**
 * The highlight a selection lies entirely inside (ER-0106), compared by the
 * chapter text offsets the selection already carries; no hit testing. When
 * the selection also crosses the edge of any other highlight (partial or
 * multi-highlight), it is plain text and this returns null. Nested
 * highlights that all contain the selection: the narrowest one wins.
 */
export function highlightAtSelection<T extends AnchoredNote>(
  notes: readonly T[],
  selection: { chapterPath: string; startTextOffset: number; endTextOffset: number },
  spineIndex: number,
): T | null {
  let best: T | null = null;
  for (const note of notes) {
    if (note.chapterPath !== selection.chapterPath || note.spineIndex !== spineIndex) continue;
    const overlaps = note.startTextOffset < selection.endTextOffset && note.endTextOffset > selection.startTextOffset;
    if (!overlaps) continue;
    const contains = note.startTextOffset <= selection.startTextOffset && note.endTextOffset >= selection.endTextOffset;
    if (!contains) return null;
    if (!best || note.endTextOffset - note.startTextOffset < best.endTextOffset - best.startTextOffset) best = note;
  }
  return best;
}

/** Common colors offered by the custom color panel. */
export const CUSTOM_COLOR_PRESETS = ["#d9691f", "#e0457b", "#14a3a3", "#6b8e23", "#8d6e63", "#607d8b"] as const;

/** "#RGB", "rrggbb" and "#RRGGBB" typed by the user → "#rrggbb", or null. */
export function parseHexInput(input: string): string | null {
  const raw = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) return `#${[...raw].map((c) => c + c).join("")}`.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`.toLowerCase();
  return null;
}

/**
 * Class and inline variables that give a swatch, a style sample or a sidebar
 * bar its colors. Named colors take the paper-tone palette from CSS; a hex
 * color derives its line and fill there too. No color = legacy theme tone.
 */
export function highlightColorProps(color: NoteColor | undefined): { className: string; style?: CSSProperties } {
  if (!color) return { className: "hl-c-default" };
  if ((NOTE_COLOR_NAMES as readonly string[]).includes(color)) return { className: `hl-c-${color}` };
  return { className: "hl-c-hex", style: { "--hl-hex": color } as CSSProperties };
}
