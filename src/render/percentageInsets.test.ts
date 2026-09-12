import { describe, expect, it } from "vitest";
import { getReaderAutoBlockInsets } from "./paginator";
const base = { percentage: true, authoredSizing: false, float: "none", display: "block", position: "static", writingMode: "horizontal-tb",
  parentWidth: 1280, contentWidth: 640, marginLeft: 64, marginRight: 64, borderBoxExtra: 0 };
describe("symmetric percentage whitespace inside the reader measure", () => {
  it("keeps 5% on both sides of a centered 40rem measure", () => {
    expect(getReaderAutoBlockInsets(base)).toEqual({ left: 352, right: 352, maxWidth: 576 });
  });
  it("preserves narrow viewport percentages and respects content-box padding", () => {
    expect(getReaderAutoBlockInsets({ ...base, parentWidth: 500, marginLeft: 25, marginRight: 25 })).toEqual({ left: 25, right: 25, maxWidth: 450 });
    expect(getReaderAutoBlockInsets({ ...base, borderBoxExtra: 20 })?.maxWidth).toBe(556);
    expect(getReaderAutoBlockInsets({ ...base, contentWidth: 800 })).toEqual({ left: 280, right: 280, maxWidth: 720 });
  });
  it("makes a direct auto-width card match the same card inside a constrained link", () => {
    expect(getReaderAutoBlockInsets({ ...base, percentage: false, groupedBlockContent: true, marginLeft: 16, marginRight: 16 }))
      .toEqual({ left: 336, right: 336, maxWidth: 608 });
    expect(getReaderAutoBlockInsets({ ...base, percentage: false, groupedBlockContent: true, parentWidth: 500, marginLeft: 16, marginRight: 16 }))
      .toEqual({ left: 16, right: 16, maxWidth: 468 });
  });
  it("subtracts a one-sided grouping inset without moving the right edge past the measure", () => {
    expect(getReaderAutoBlockInsets({ ...base, percentage: false, groupedBlockContent: true, marginLeft: 28, marginRight: 0 }))
      .toEqual({ left: 348, right: 320, maxWidth: 612 });
    expect(getReaderAutoBlockInsets({ ...base, percentage: false, groupedBlockContent: true, marginLeft: 0, marginRight: 28, borderBoxExtra: 3 }))
      .toEqual({ left: 320, right: 348, maxWidth: 609 });
    expect(getReaderAutoBlockInsets({ ...base, percentage: false, groupedBlockContent: false, marginLeft: 28, marginRight: 0 })).toBeNull();
  });
  it("keeps author sizing, asymmetric positioning and unsafe layout on their existing paths", () => {
    expect(getReaderAutoBlockInsets({ ...base, percentage: false, groupedBlockContent: false })).toBeNull();
    for (const patch of [{ heading: true }, { authoredSizing: true }, { authoredSizing: undefined }, { percentage: undefined },
      { marginRight: 0 }, { marginLeft: -64 }, { marginLeft: 640, marginRight: 640 },
      { float: "right" }, { display: "inline" }, { position: "absolute" }, { writingMode: "vertical-rl" }, { parentWidth: NaN }]) {
      expect(getReaderAutoBlockInsets({ ...base, ...patch })).toBeNull();
    }
  });
});
