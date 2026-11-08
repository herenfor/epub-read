// Device-local highlight preferences (ER-0106): the last style and color used
// and the one custom color slot. Never part of note data, archives or sync.
import { useCallback, useState } from "react";
import { isNoteColor, isNoteStyle, normalizeNoteColor, type NoteColor, type NoteStyle } from "./notes";

const KEY = "epub-reader:highlight-preferences-v1";
const HEX = /^#[0-9a-f]{6}$/i;

export interface HighlightPreferences {
  style: NoteStyle;
  color: NoteColor;
  /** The custom color slot (#rrggbb, lowercase); null until the user sets it. */
  custom: string | null;
}

export const DEFAULT_HIGHLIGHT_PREFERENCES: HighlightPreferences = { style: "highlight", color: "yellow", custom: null };

/** Anything malformed falls back field by field; a missing store reads as defaults. */
export function parseHighlightPreferences(raw: string | null): HighlightPreferences {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
  } catch { /* defaults */ }
  return {
    style: isNoteStyle(value.style) ? value.style : DEFAULT_HIGHLIGHT_PREFERENCES.style,
    color: isNoteColor(value.color) ? normalizeNoteColor(value.color) as NoteColor : DEFAULT_HIGHLIGHT_PREFERENCES.color,
    custom: typeof value.custom === "string" && HEX.test(value.custom) ? value.custom.toLowerCase() : null,
  };
}

export function readHighlightPreferences(): HighlightPreferences {
  try {
    return parseHighlightPreferences(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_HIGHLIGHT_PREFERENCES;
  }
}

export function writeHighlightPreferences(preferences: HighlightPreferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(preferences));
  } catch { /* storage unavailable: keep for this session only */ }
}

export function useHighlightPreferences() {
  const [preferences, setPreferences] = useState(readHighlightPreferences);
  const update = useCallback((patch: Partial<HighlightPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      writeHighlightPreferences(next);
      return next;
    });
  }, []);
  return { highlightPreferences: preferences, updateHighlightPreferences: update };
}
