import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { tapRegions, TAP_REGION_LABEL_KEYS } from "./localization/catalogs/tapRegions";
import { ReaderTapRegionsPanel, type ReaderTapRegionsLabels } from "./ReaderTapRegionsPanel";
import {
  computeTapRegionGeometry,
  DEFAULT_READER_TAP_PREFERENCES,
  edgeTurnRegionOf,
  parseReaderTapPreferences,
  serializeReaderTapPreferences,
  setTapRegionMode,
  setTapRegionPercent,
  tapRegionAction,
  tapRegionAt,
  type ReaderTapPreferences,
  type TapRegionGeometry,
} from "./readerTapRegions";

const labels = Object.fromEntries(Object.entries(TAP_REGION_LABEL_KEYS)
  .map(([field, key]) => [field, tapRegions.zh[key]])) as unknown as ReaderTapRegionsLabels;

function expectNoOverlap(geometry: TapRegionGeometry) {
  expect(geometry.left.start).toBe(0);
  expect(geometry.center.start).toBeCloseTo(geometry.left.width);
  expect(geometry.right.start).toBeCloseTo(geometry.center.start + geometry.center.width);
  expect(geometry.right.start + geometry.right.width).toBeCloseTo(geometry.availableWidth);
  expect(geometry.center.width).toBeGreaterThanOrEqual(geometry.availableWidth * 0.3 - 1e-9);
}

describe("tap region geometry", () => {
  it("keeps today's clamp(44px, 5%, 80px) by default and narrows only to keep the centre", () => {
    expect(computeTapRegionGeometry(400, { mode: "default" }).left.width).toBe(44);
    expect(computeTapRegionGeometry(1200, { mode: "default" }).right.width).toBe(60);
    const wide = computeTapRegionGeometry(2560, { mode: "default" });
    expect([wide.left.width, wide.right.width, wide.narrowed]).toEqual([80, 80, false]);
    // Arrow stays centred in the default band, exactly where the stylesheet put it.
    expect(wide.left.arrowCenter).toBe(40);

    const narrow = computeTapRegionGeometry(100, { mode: "default" });
    expect(narrow.narrowed).toBe(true);
    expect(narrow.left.width).toBeCloseTo(35);
    for (const width of [100, 125, 400, 1200, 2560]) expectNoOverlap(computeTapRegionGeometry(width, { mode: "default" }));
  });

  it("uses explicit ratios without the 80px cap, 0 as off, and a seeded split on mode switch", () => {
    const custom = computeTapRegionGeometry(2000, { mode: "custom", custom: { left: 35, right: 0 } });
    expect(custom.left.width).toBe(700);
    expect(custom.right).toMatchObject({ start: 2000, width: 0 });
    expect(custom.center.width).toBe(1300);
    // A widened band keeps its arrow at the default outer spot.
    expect(custom.left.arrowCenter).toBe(40);
    expectNoOverlap(custom);
    expect(tapRegionAt(custom, 699)).toBe("left");
    expect(tapRegionAt(custom, 700)).toBe("center");
    expect(tapRegionAt(custom, 1999)).toBe("center");
    expect(edgeTurnRegionOf(custom, "right")).toEqual({ width: 0, arrowCenter: 0 });
    expect(edgeTurnRegionOf(computeTapRegionGeometry(0, { mode: "default" }), "left")).toBeUndefined();

    const shown = computeTapRegionGeometry(400, { mode: "default" });
    const switched = setTapRegionMode({ mode: "default" }, "custom", shown);
    expect(switched).toEqual({ mode: "custom", custom: { left: 11, right: 11 } });
    const edited = setTapRegionPercent(switched, "right", 90, shown);
    expect(edited.custom).toEqual({ left: 11, right: 35 });
    // Back to default remembers the split for the next custom switch.
    expect(setTapRegionMode(setTapRegionMode(edited, "default", shown), "custom", shown)).toEqual(edited);
  });

  it("restores damaged or missing preferences to the defaults", () => {
    expect(parseReaderTapPreferences(null)).toEqual(DEFAULT_READER_TAP_PREFERENCES);
    expect(parseReaderTapPreferences("{oops")).toEqual(DEFAULT_READER_TAP_PREFERENCES);
    const prefs = parseReaderTapPreferences(JSON.stringify({
      pc: { mode: "custom", custom: { left: 12.4, right: 99 } },
      touch: { mode: "custom", custom: { left: "x", right: 3 } },
      touchLeftTapForward: "yes",
    }));
    expect(prefs).toEqual({
      pc: { mode: "custom", custom: { left: 12, right: 35 } },
      touch: { mode: "default" },
      touchLeftTapForward: false,
      showTapHint: false,
    });
    expect(parseReaderTapPreferences(serializeReaderTapPreferences(prefs))).toEqual(prefs);
    expect(parseReaderTapPreferences(JSON.stringify({ showTapHint: true })).showTapHint).toBe(true);
  });
});

describe("tap region actions", () => {
  it("maps the left band forward only on touch with the option on", () => {
    const on = { touchLeftTapForward: true };
    const off = { touchLeftTapForward: false };
    expect(tapRegionAction("left", "touch", off)).toBe(-1);
    expect(tapRegionAction("left", "touch", on)).toBe(1);
    expect(tapRegionAction("right", "touch", on)).toBe(1);
    expect(tapRegionAction("left", "pc", on)).toBe(-1);
    expect(tapRegionAction("right", "pc", off)).toBe(1);
  });

  it("mirrors forward to the left in a right-to-left book; the back-side option then covers the right", () => {
    const on = { touchLeftTapForward: true };
    const off = { touchLeftTapForward: false };
    expect(tapRegionAction("left", "pc", off, "rtl")).toBe(1);
    expect(tapRegionAction("right", "pc", on, "rtl")).toBe(-1);
    expect(tapRegionAction("right", "touch", off, "rtl")).toBe(-1);
    expect(tapRegionAction("right", "touch", on, "rtl")).toBe(1);
    expect(tapRegionAction("left", "touch", on, "rtl")).toBe(1);
  });
});

describe("tap region panel", () => {
  it("draws the preview from the reader geometry and edits only the current device", async () => {
    const dom = createReactDomHarness();
    const onChange = vi.fn();
    const value: ReaderTapPreferences = {
      pc: { mode: "default" },
      touch: { mode: "custom", custom: { left: 0, right: 20 } },
      touchLeftTapForward: true,
      showTapHint: false,
    };
    const render = (device: "pc" | "touch", width: number) => dom.render(createElement(ReaderTapRegionsPanel, {
      device, value, onChange, availableWidth: width, availableHeight: 800, labels,
    }));
    try {
      await render("touch", 400);
      const band = (side: string) => dom.container.querySelector(`.tap-regions-band.is-${side}`) as HTMLElement | null;
      expect(band("left")).toBeNull();
      expect(dom.container.querySelector(".tap-regions-off-tag.is-left")?.textContent).toBe("关闭");
      expect(band("right")?.style.left).toBe("80%");
      expect(band("right")?.style.width).toBe("20%");
      expect(dom.container.textContent).toContain("左侧点击也下一页");
      expect(dom.container.querySelectorAll('input[type="range"]')).toHaveLength(2);

      await render("pc", 1200);
      expect(band("left")?.style.width).toBe("5%");
      expect(dom.container.textContent).not.toContain("左侧点击也下一页");
      expect(dom.container.querySelector('input[type="range"]')).toBeNull();
      const customButton = [...dom.container.querySelectorAll(".aa-segmented-btn")]
        .find((button) => button.textContent === "自定义")!;
      await dom.click(customButton);
      expect(onChange).toHaveBeenLastCalledWith({ ...value, pc: { mode: "custom", custom: { left: 5, right: 5 } } });
    } finally { await dom.dispose(); }
  });
});
