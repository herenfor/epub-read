import { PAGE_GAP_MAX_PX, type PageMarginsPx } from "../render/pageLayout";

/**
 * Slider stops for each typography setting, left to right. A slider moves
 * by index, so every position is a value the old steppers could also reach.
 * `undefined` is the unset state: "follow the book" for type settings,
 * "auto" for margins and the spread gap. It sits at the far left, so a
 * slider can always return to it and never writes it as a number.
 */
export type SettingStops = readonly (number | undefined)[];

function range(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  for (let i = 0; min + i * step <= max + 1e-9; i += 1) {
    values.push(Math.round((min + i * step) * 100) / 100);
  }
  return values;
}

export const FONT_SIZE_MIN_PX = 12;
export const FONT_SIZE_MAX_PX = 32;
export const FONT_SIZE_STOPS: SettingStops = range(FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, 1);
export const LINE_HEIGHT_STOPS: SettingStops = [undefined, ...range(1.2, 2.4, 0.1)];
export const FONT_WEIGHT_STOPS: SettingStops = [undefined, 300, 400, 500, 600, 700];
export const LETTER_SPACING_STOPS: SettingStops = [undefined, ...range(0, 8, 1)];
export const WORD_SPACING_STOPS: SettingStops = [undefined, ...range(0, 16, 2)];
/** One page side; the old stepper moved 4px at a time up to 120px. */
export const SIDE_MARGIN_STOPS: SettingStops = [undefined, ...range(0, 120, 4)];
export const SPREAD_GAP_STOPS: SettingStops = [undefined, ...range(0, PAGE_GAP_MAX_PX, 4)];

/** Index of the stop shown for a value: the unset stop, or the nearest number. */
export function stopIndex(stops: SettingStops, value: number | undefined): number {
  if (value === undefined) {
    const unset = stops.indexOf(undefined);
    return unset >= 0 ? unset : 0;
  }
  let best = -1;
  let bestDistance = Infinity;
  stops.forEach((stop, index) => {
    if (stop === undefined) return;
    const distance = Math.abs(stop - value);
    if (distance < bestDistance - 1e-9) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

export function stopValue(stops: SettingStops, index: number): number | undefined {
  return stops[Math.max(0, Math.min(stops.length - 1, Math.round(index)))];
}

/**
 * The linked margin slider: one level sets all four sides. The old presets
 * (narrow, medium, wide) are levels 3, 5 and 7, so they keep their names.
 */
export const MARGIN_LEVELS: ReadonlyArray<{
  side: number;
  edge: number;
  preset?: "narrow" | "medium" | "wide";
}> = [
  { side: 8, edge: 12 },
  { side: 14, edge: 16 },
  { side: 20, edge: 20, preset: "narrow" },
  { side: 30, edge: 24 },
  { side: 40, edge: 28, preset: "medium" },
  { side: 52, edge: 32 },
  { side: 64, edge: 36, preset: "wide" },
  { side: 80, edge: 42 },
  { side: 96, edge: 48 },
];

/** Slider positions of the linked margin: 0 is auto, then each level. */
export const MARGIN_LEVEL_COUNT = MARGIN_LEVELS.length + 1;

export interface MarginLevelPosition {
  index: number;
  /** False when the four sides do not match a level (fine-tuned in More). */
  exact: boolean;
}

export function marginLevelPosition(margins: PageMarginsPx | undefined): MarginLevelPosition {
  const sides = margins ?? {};
  if (Object.keys(sides).length === 0) return { index: 0, exact: true };
  const exactIndex = MARGIN_LEVELS.findIndex((level) =>
    sides.left === level.side && sides.right === level.side &&
    sides.top === level.edge && sides.bottom === level.edge);
  if (exactIndex >= 0) return { index: exactIndex + 1, exact: true };
  // Fine-tuned sides: show the level nearest to their left/right average.
  const horizontal = [sides.left, sides.right].filter((value): value is number => value !== undefined);
  const reference = horizontal.length > 0
    ? horizontal.reduce((sum, value) => sum + value, 0) / horizontal.length
    : MARGIN_LEVELS[0].side;
  let nearest = 0;
  MARGIN_LEVELS.forEach((level, index) => {
    if (Math.abs(level.side - reference) < Math.abs(MARGIN_LEVELS[nearest].side - reference)) nearest = index;
  });
  return { index: nearest + 1, exact: false };
}

export function marginsForLevel(index: number): PageMarginsPx {
  const level = MARGIN_LEVELS[Math.round(index) - 1];
  if (!level) return {};
  return { left: level.side, right: level.side, top: level.edge, bottom: level.edge };
}

/** One side set or cleared, the others kept. */
export function withMarginSide(
  margins: PageMarginsPx | undefined,
  side: keyof PageMarginsPx,
  value: number | undefined,
): PageMarginsPx {
  const next: PageMarginsPx = { ...(margins ?? {}) };
  if (value === undefined) delete next[side];
  else next[side] = value;
  return next;
}

export function clampFontSize(value: number): number {
  return Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, value));
}
