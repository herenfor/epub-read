import type { EdgeTurnDirection } from "./edgeTurnFeedback";

/**
 * Left/right tap-to-turn regions of the paged reader.
 *
 * One geometry feeds both the real EdgeTurnZone bands and the settings
 * preview, so what the preview shows is what a tap hits. Physical side
 * (left/right) and the executed turn (prev/next) are separate: "left also
 * turns forward" only changes the action, never where the band sits.
 * Device-local preference; storage and sync stay with the host.
 */

/** Physical side of the reading viewport, independent of what a tap does there. */
export type TapRegionSide = "left" | "right";
/** Which profile applies: desktop pointer or touch-first UI. */
export type TapRegionDevice = "pc" | "touch";
export type TapRegionMode = "default" | "custom";

/** Mirrors `.edge-turn-zone` in styles.css: clamp(44px, 5%, 80px). */
export const DEFAULT_TAP_REGION_MIN_PX = 44;
export const DEFAULT_TAP_REGION_RATIO = 0.05;
export const DEFAULT_TAP_REGION_MAX_PX = 80;
/** Mirrors `.edge-turn-arrow` width in styles.css. */
export const EDGE_TURN_ARROW_WIDTH_PX = 36;
/** Custom size per side, in whole percent of the available reading width; 0 turns the side off. */
export const TAP_REGION_MAX_PERCENT = 35;
/**
 * A15: both side bands leave the top strip free (the bookmark ribbons hang
 * there), so a tap in it is a centre tap. On touch the outer top squares of
 * the same height are the invisible bookmark corners (the left one only acts
 * on a two-page spread; the host decides).
 */
export const TAP_REGION_TOP_INSET_PX = 56;
export const BOOKMARK_CORNER_PX = 56;
/** The central content area never drops below this share, in any mode. */
export const TAP_REGION_MIN_CENTER_RATIO = 0.3;

export interface TapRegionSplit {
  left: number;
  right: number;
}

export interface TapRegionProfile {
  mode: TapRegionMode;
  /** Last custom split; kept while the profile is back in default mode. */
  custom?: TapRegionSplit;
}

export interface ReaderTapPreferences {
  pc: TapRegionProfile;
  touch: TapRegionProfile;
  /** Touch only: a tap in the left region also turns forward. */
  touchLeftTapForward: boolean;
}

export const DEFAULT_TAP_REGION_PROFILE: TapRegionProfile = { mode: "default" };
export const DEFAULT_READER_TAP_PREFERENCES: ReaderTapPreferences = {
  pc: DEFAULT_TAP_REGION_PROFILE,
  touch: DEFAULT_TAP_REGION_PROFILE,
  touchLeftTapForward: false,
};

export interface TapRegionBand {
  /** Offset from the left edge of the available reading width, CSS px. */
  start: number;
  width: number;
}

export interface TapRegionSideGeometry extends TapRegionBand {
  /** Arrow centre from this side's outer edge: today's spot, kept inside narrow bands. */
  arrowCenter: number;
}

export interface TapRegionGeometry {
  availableWidth: number;
  /** "custom" only when the profile carries a split. */
  mode: TapRegionMode;
  left: TapRegionSideGeometry;
  center: TapRegionBand;
  right: TapRegionSideGeometry;
  /** The default size shrank so the centre keeps its minimum share. */
  narrowed: boolean;
}

function usableWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? width : 0;
}

function defaultSideWidth(width: number): number {
  return Math.min(DEFAULT_TAP_REGION_MAX_PX, Math.max(DEFAULT_TAP_REGION_MIN_PX, width * DEFAULT_TAP_REGION_RATIO));
}

export function clampTapRegionPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(TAP_REGION_MAX_PERCENT, Math.max(0, Math.round(value)));
}

/**
 * `availableWidth` is the box that hosts the zones (the paged reader or the
 * image spread), not the device screen or the outer window.
 */
export function computeTapRegionGeometry(availableWidth: number, profile: TapRegionProfile): TapRegionGeometry {
  const width = usableWidth(availableWidth);
  const sideLimit = width * (1 - TAP_REGION_MIN_CENTER_RATIO) / 2;
  const preferred = defaultSideWidth(width);
  const fallback = Math.min(preferred, sideLimit);
  const custom = profile.mode === "custom" ? profile.custom : undefined;
  // Explicit ratios are not capped at the default 80px.
  const left = custom ? Math.min(sideLimit, width * custom.left / 100) : fallback;
  const right = custom ? Math.min(sideLimit, width * custom.right / 100) : fallback;
  const arrowCenter = (band: number) => band > 0
    ? Math.max(EDGE_TURN_ARROW_WIDTH_PX / 2, Math.min(band, fallback) / 2)
    : 0;
  return {
    availableWidth: width,
    mode: custom ? "custom" : "default",
    left: { start: 0, width: left, arrowCenter: arrowCenter(left) },
    center: { start: left, width: width - left - right },
    right: { start: width - right, width: right, arrowCenter: arrowCenter(right) },
    narrowed: !custom && preferred > sideLimit,
  };
}

export interface EdgeTurnRegion {
  width: number;
  arrowCenter: number;
}

/** EdgeTurnZone `region` prop; undefined before the box is measured keeps the stylesheet default. */
export function edgeTurnRegionOf(geometry: TapRegionGeometry, side: TapRegionSide): EdgeTurnRegion | undefined {
  if (geometry.availableWidth <= 0) return undefined;
  const band = side === "left" ? geometry.left : geometry.right;
  return { width: band.width, arrowCenter: band.arrowCenter };
}

/**
 * `x` (and `y`) are measured from the left (top) edge of the same box the
 * geometry was computed for. Without `y` the top strip is not considered.
 */
export function tapRegionAt(
  geometry: TapRegionGeometry, x: number, y?: number,
): TapRegionSide | "center" | "corner-left" | "corner-right" | null {
  if (!Number.isFinite(x) || x < 0 || x >= geometry.availableWidth) return null;
  if (y !== undefined && Number.isFinite(y) && y >= 0 && y < TAP_REGION_TOP_INSET_PX) {
    if (x >= geometry.availableWidth - BOOKMARK_CORNER_PX) return "corner-right";
    return x < BOOKMARK_CORNER_PX ? "corner-left" : "center";
  }
  if (x < geometry.left.width) return "left";
  if (geometry.right.width > 0 && x >= geometry.right.start) return "right";
  return "center";
}

/** Turn executed by a tap on `side`. PC ignores the touch-only left-forward option. */
export type PageProgression = "ltr" | "rtl";

/**
 * Forward is the right side, or the left side in a right-to-left book.
 * `touchLeftTapForward` means "the back side also goes forward": in a
 * right-to-left book that back side is the right one.
 */
export function tapRegionAction(
  side: TapRegionSide,
  device: TapRegionDevice,
  preferences: Pick<ReaderTapPreferences, "touchLeftTapForward">,
  progression: PageProgression = "ltr",
): EdgeTurnDirection {
  if (side === (progression === "rtl" ? "left" : "right")) return 1;
  return device === "touch" && preferences.touchLeftTapForward ? 1 : -1;
}

export function tapRegionProfileFor(preferences: ReaderTapPreferences, device: TapRegionDevice): TapRegionProfile {
  return device === "touch" ? preferences.touch : preferences.pc;
}

export function withTapRegionProfile(
  preferences: ReaderTapPreferences,
  device: TapRegionDevice,
  profile: TapRegionProfile,
): ReaderTapPreferences {
  return device === "touch" ? { ...preferences, touch: profile } : { ...preferences, pc: profile };
}

/** Rounded whole percent of what `geometry` shows, for seeding a custom split without a jump. */
export function tapRegionSplitOf(geometry: TapRegionGeometry): TapRegionSplit {
  const percent = (band: number) => geometry.availableWidth > 0
    ? clampTapRegionPercent(band / geometry.availableWidth * 100) ?? 0
    : DEFAULT_TAP_REGION_RATIO * 100;
  return { left: percent(geometry.left.width), right: percent(geometry.right.width) };
}

/** Switching to custom reuses the remembered split, else starts from what is shown now. */
export function setTapRegionMode(profile: TapRegionProfile, mode: TapRegionMode, shown: TapRegionGeometry): TapRegionProfile {
  if (mode === "default") return profile.custom ? { mode, custom: profile.custom } : { mode };
  return { mode, custom: profile.custom ?? tapRegionSplitOf(shown) };
}

export function setTapRegionPercent(
  profile: TapRegionProfile,
  side: TapRegionSide,
  percent: number,
  shown: TapRegionGeometry,
): TapRegionProfile {
  const base = profile.custom ?? tapRegionSplitOf(shown);
  const value = clampTapRegionPercent(percent) ?? base[side];
  return { mode: "custom", custom: { ...base, [side]: value } };
}

function normalizeProfile(raw: unknown): TapRegionProfile {
  if (!raw || typeof raw !== "object") return DEFAULT_TAP_REGION_PROFILE;
  const source = raw as { mode?: unknown; custom?: { left?: unknown; right?: unknown } | null };
  const left = clampTapRegionPercent(source.custom?.left);
  const right = clampTapRegionPercent(source.custom?.right);
  const custom = left !== null && right !== null ? { left, right } : undefined;
  if (source.mode === "custom" && custom) return { mode: "custom", custom };
  return custom ? { mode: "default", custom } : DEFAULT_TAP_REGION_PROFILE;
}

/** Missing or damaged fields fall back to the defaults (existing users stay on "default"). */
export function normalizeReaderTapPreferences(raw: unknown): ReaderTapPreferences {
  if (!raw || typeof raw !== "object") return DEFAULT_READER_TAP_PREFERENCES;
  const source = raw as Partial<Record<keyof ReaderTapPreferences, unknown>>;
  return {
    pc: normalizeProfile(source.pc),
    touch: normalizeProfile(source.touch),
    touchLeftTapForward: source.touchLeftTapForward === true,
  };
}

export function parseReaderTapPreferences(text: string | null | undefined): ReaderTapPreferences {
  if (!text) return DEFAULT_READER_TAP_PREFERENCES;
  try {
    return normalizeReaderTapPreferences(JSON.parse(text));
  } catch {
    return DEFAULT_READER_TAP_PREFERENCES;
  }
}

export function serializeReaderTapPreferences(preferences: ReaderTapPreferences): string {
  return JSON.stringify(normalizeReaderTapPreferences(preferences));
}
