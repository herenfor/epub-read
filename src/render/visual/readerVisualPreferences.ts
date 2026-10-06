/**
 * FX-1 device-local display preferences.
 *
 * This is intentionally separate from ReaderSettings: changing it must not
 * reload a chapter, repaginate text, or rebuild search indexes. The object
 * shape is the frozen reader-visual contract consumed by FX-2 as well.
 */
export type ColorAssistKind = "off" | "protan" | "deutan" | "tritan";

export interface ReaderVisualPreferences {
  enabled: boolean;
  invert: boolean;
  grayscale: number; // 0..1
  saturation: number; // 0..2
  sharpen: number; // 0..1
  dim: number; // 0..0.8, independent black overlay
  colorAssist: { kind: ColorAssistKind; strength: number }; // 0..1
}

/** Mounted viewport-sized book surfaces only; never layout/motion containers. */
export interface ReaderPaintHandle {
  update(preferences: ReaderVisualPreferences, compareOriginal: boolean): void;
  dispose(): void;
}

export const DEFAULT_VISUAL_PREFERENCES: ReaderVisualPreferences = {
  enabled: false,
  invert: false,
  grayscale: 0,
  saturation: 1,
  sharpen: 0,
  dim: 0,
  colorAssist: { kind: "off", strength: 0.5 },
};

export const VISUAL_PREFERENCES_STORAGE_KEY = "epub-reader.visual.v1";

const COLOR_ASSIST_KINDS: readonly ColorAssistKind[] = ["off", "protan", "deutan", "tritan"];
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

function finiteOrDefault(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, minimum, maximum)
    : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function colorAssistKindOrDefault(value: unknown): ColorAssistKind {
  return typeof value === "string" && COLOR_ASSIST_KINDS.includes(value as ColorAssistKind)
    ? value as ColorAssistKind
    : DEFAULT_VISUAL_PREFERENCES.colorAssist.kind;
}

/**
 * Read-boundary sanitizer. Only persisted/external values pass through it;
 * ordinary paint updates do not repeat validation in the render loop.
 */
export function normalizeVisualPreferences(value: unknown): ReaderVisualPreferences {
  const source = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const assistSource = typeof source.colorAssist === "object" && source.colorAssist !== null
    ? source.colorAssist as Record<string, unknown>
    : {};
  return {
    enabled: booleanOrDefault(source.enabled, DEFAULT_VISUAL_PREFERENCES.enabled),
    invert: booleanOrDefault(source.invert, DEFAULT_VISUAL_PREFERENCES.invert),
    grayscale: finiteOrDefault(source.grayscale, DEFAULT_VISUAL_PREFERENCES.grayscale, 0, 1),
    saturation: finiteOrDefault(source.saturation, DEFAULT_VISUAL_PREFERENCES.saturation, 0, 2),
    sharpen: finiteOrDefault(source.sharpen, DEFAULT_VISUAL_PREFERENCES.sharpen, 0, 1),
    dim: finiteOrDefault(source.dim, DEFAULT_VISUAL_PREFERENCES.dim, 0, 0.8),
    colorAssist: {
      kind: colorAssistKindOrDefault(assistSource.kind),
      strength: finiteOrDefault(
        assistSource.strength,
        DEFAULT_VISUAL_PREFERENCES.colorAssist.strength,
        0,
        1,
      ),
    },
  };
}

type PreferencesStorage = Pick<Storage, "getItem" | "setItem">;

function localVisualPreferencesStorage(): PreferencesStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads the device-local key. Old, partial, or corrupt local input falls back field by field. */
export function loadVisualPreferences(
  storage?: PreferencesStorage | null,
): ReaderVisualPreferences {
  const target = storage === undefined ? localVisualPreferencesStorage() : storage;
  if (!target) return normalizeVisualPreferences(DEFAULT_VISUAL_PREFERENCES);
  try {
    const raw = target.getItem(VISUAL_PREFERENCES_STORAGE_KEY);
    return raw ? normalizeVisualPreferences(JSON.parse(raw) as unknown) : normalizeVisualPreferences(DEFAULT_VISUAL_PREFERENCES);
  } catch {
    return normalizeVisualPreferences(DEFAULT_VISUAL_PREFERENCES);
  }
}

/** Stores the normalized device-local value; storage failures are non-fatal. */
export function saveVisualPreferences(
  preferences: ReaderVisualPreferences,
  storage?: PreferencesStorage | null,
): void {
  const target = storage === undefined ? localVisualPreferencesStorage() : storage;
  if (!target) return;
  try {
    target.setItem(VISUAL_PREFERENCES_STORAGE_KEY, JSON.stringify(normalizeVisualPreferences(preferences)));
  } catch {
    /* localStorage may be unavailable (private mode / native webview policy). */
  }
}

/** Reset all FX-1 controls while preserving the FX-2-owned slot value. */
export function resetVisualFilterPreferences(
  current: ReaderVisualPreferences,
): ReaderVisualPreferences {
  return {
    ...DEFAULT_VISUAL_PREFERENCES,
    colorAssist: { ...current.colorAssist },
  };
}
