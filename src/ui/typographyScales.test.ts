import { describe, expect, it } from "vitest";
import {
  FONT_SIZE_STOPS,
  FONT_WEIGHT_STOPS,
  LETTER_SPACING_STOPS,
  LINE_HEIGHT_STOPS,
  MARGIN_LEVEL_COUNT,
  SIDE_MARGIN_STOPS,
  autoMarginEstimate,
  marginLevelPosition,
  marginsForLevel,
  nearestMarginLevel,
  stopIndex,
  stopValue,
  withMarginSide,
} from "./typographyScales";

describe("typography slider stops", () => {
  it("keeps the old stepper values; the unset state is listed first", () => {
    expect(LINE_HEIGHT_STOPS[0]).toBeUndefined();
    expect(LINE_HEIGHT_STOPS.slice(1)).toEqual([1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.3, 2.4]);
    expect(FONT_WEIGHT_STOPS).toEqual([undefined, 300, 400, 500, 600, 700]);
    expect(LETTER_SPACING_STOPS.at(-1)).toBe(8);
    expect(SIDE_MARGIN_STOPS.slice(0, 3)).toEqual([undefined, 0, 4]);
    expect(FONT_SIZE_STOPS[0]).toBe(12);
    expect(FONT_SIZE_STOPS.at(-1)).toBe(32);
  });

  it("shows unset at its own stop and never turns it into a number by itself", () => {
    expect(stopIndex(LINE_HEIGHT_STOPS, undefined)).toBe(0);
    expect(stopValue(LINE_HEIGHT_STOPS, 0)).toBeUndefined();
    // An explicit 0 is a different stop from "follow the book".
    expect(stopIndex(LETTER_SPACING_STOPS, 0)).toBe(1);
    expect(stopValue(LETTER_SPACING_STOPS, 1)).toBe(0);
  });

  it("maps an off-grid saved value to the nearest stop", () => {
    expect(stopValue(FONT_SIZE_STOPS, stopIndex(FONT_SIZE_STOPS, 20.6))).toBe(21);
    expect(stopValue(LINE_HEIGHT_STOPS, stopIndex(LINE_HEIGHT_STOPS, 1.75))).toBe(1.7);
    expect(stopValue(FONT_SIZE_STOPS, 99)).toBe(32);
  });
});

describe("linked margin levels", () => {
  it("auto is level 0 and the old presets keep their place", () => {
    expect(marginLevelPosition({})).toEqual({ index: 0, exact: true });
    expect(marginLevelPosition(undefined)).toEqual({ index: 0, exact: true });
    expect(marginLevelPosition({ left: 20, right: 20, top: 20, bottom: 20 })).toEqual({ index: 3, exact: true });
    expect(marginLevelPosition({ left: 40, right: 40, top: 28, bottom: 28 })).toEqual({ index: 5, exact: true });
    expect(marginLevelPosition({ left: 64, right: 64, top: 36, bottom: 36 })).toEqual({ index: 7, exact: true });
    expect(MARGIN_LEVEL_COUNT).toBe(10);
  });

  it("fine-tuned sides show the nearest level without being rewritten", () => {
    expect(marginLevelPosition({ left: 44, right: 36, top: 10 })).toEqual({ index: 5, exact: false });
    expect(marginsForLevel(0)).toEqual({});
    expect(marginsForLevel(5)).toEqual({ left: 40, right: 40, top: 28, bottom: 28 });
  });

  it("sets or clears one side and keeps the others", () => {
    expect(withMarginSide({ left: 20, top: 8 }, "top", undefined)).toEqual({ left: 20 });
    expect(withMarginSide(undefined, "bottom", 12)).toEqual({ bottom: 12 });
  });

  it("finds where automatic margins land, so the slider can sit there", () => {
    expect(nearestMarginLevel(0)).toBe(1);
    expect(nearestMarginLevel(22)).toBe(3);
    expect(nearestMarginLevel(500)).toBe(9);
    // A phone page gets side margins, a wide one centres the text.
    expect(autoMarginEstimate({ fontSizePx: 18, scroll: false, viewportWidth: 390 }).left).toBeGreaterThan(0);
    expect(autoMarginEstimate({ fontSizePx: 18, scroll: false, viewportWidth: 1400 }).left).toBe(0);
    expect(autoMarginEstimate({ fontSizePx: 18, scroll: true, viewportWidth: 1400 }).right).toBe(16);
    expect(autoMarginEstimate({ fontSizePx: 18, scroll: false, viewportWidth: 1400, spread: { baseLeftPx: 61.6, baseRightPx: 70 } }))
      .toMatchObject({ left: 62, right: 70 });
  });
});
