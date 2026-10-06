import { sanitizeTextProjectionPreferences } from "../../render/textProjection/preferences";
import {
  DEFAULT_TEXT_PROJECTION_PREFERENCES,
  type TextProjectionPreferences,
} from "../../render/textProjection/types";

export const TEXT_PROJECTION_STORAGE_KEY = "epub-reader.text-projection.v1";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadTextProjectionPreferences(): TextProjectionPreferences {
  const store = storage();
  if (!store) return { ...DEFAULT_TEXT_PROJECTION_PREFERENCES, rules: [] };
  try {
    const raw = store.getItem(TEXT_PROJECTION_STORAGE_KEY);
    return raw === null
      ? { ...DEFAULT_TEXT_PROJECTION_PREFERENCES, rules: [] }
      : sanitizeTextProjectionPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TEXT_PROJECTION_PREFERENCES, rules: [] };
  }
}

export function saveTextProjectionPreferences(preferences: TextProjectionPreferences): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(TEXT_PROJECTION_STORAGE_KEY, JSON.stringify(sanitizeTextProjectionPreferences(preferences)));
  } catch {
    // Local preference persistence is best-effort only.
  }
}
