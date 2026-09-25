import { describe, expect, it } from "vitest";
import {
  ContinuousChapterLayout,
  ChapterLoadGate,
  continuousWheelPixels,
  type ChapterExtent,
} from "./continuousChapterLayout";

describe("continuousWheelPixels", () => {
  it("converts pixel, line, and page delta modes correctly", () => {
    // deltaMode 0: pixels
    expect(continuousWheelPixels(120, 0, 24, 600)).toBe(120);
    // deltaMode 1: lines
    expect(continuousWheelPixels(3, 1, 24, 600)).toBe(72);
    // deltaMode 2: pages
    expect(continuousWheelPixels(0.5, 2, 24, 600)).toBe(300);
  });
});

describe("ContinuousChapterLayout", () => {
  const extents: ChapterExtent[] = [
    { key: "0:c1.xhtml", height: 1000, measured: true },
    { key: "1:c2.xhtml", height: 500, measured: true },
  ];

  it("calculates boxes and totalHeight correctly", () => {
    const layout = new ContinuousChapterLayout(extents);
    expect(layout.totalHeight).toBe(1500);
    expect(layout.boxes).toEqual([
      { key: "0:c1.xhtml", index: 0, height: 1000, measured: true, top: 0, bottom: 1000 },
      { key: "1:c2.xhtml", index: 1, height: 500, measured: true, top: 1000, bottom: 1500 },
    ]);
  });

  it("projects coordinates correctly for H=[1000, 500], V=600, S=800", () => {
    const layout = new ContinuousChapterLayout(extents);
    const V = 600;
    const S = 800;
    const projections = layout.project(S, V, 0);

    expect(projections).toHaveLength(2);

    const [p0, p1] = projections;

    // Chapter 0: B=0, H=1000, S=800, V=600
    // I = clamp(800 - 0, 0, 1000 - 600 = 400) = 400
    // frameOffset = 400, innerScrollTop = 400
    // frameScreenTop = B + I - S = 0 + 400 - 800 = -400
    // Visible range in book: max(800, 0)=800 to min(1400, 1000)=1000 (length 200px)
    // clipTop = visibleStart - box.top - frameOffset = 800 - 0 - 400 = 400
    // clipBottom = visibleEnd - box.top - frameOffset = 1000 - 0 - 400 = 600
    // Visible strip inside iframe viewport is from y=400 to y=600 (height 200)
    // Relative to screen: frameScreenTop + clipTop = -400 + 400 = 0
    //                     frameScreenTop + clipBottom = -400 + 600 = 200
    // Thus Chapter 0 displays its last 200px from screen y=0 to y=200!
    expect(p0.box.key).toBe("0:c1.xhtml");
    expect(p0.frameOffset).toBe(400);
    expect(p0.innerScrollTop).toBe(400);
    expect(p0.frameScreenTop).toBe(-400);
    expect(p0.clipTop).toBe(400);
    expect(p0.clipBottom).toBe(600);
    expect(p0.visible).toBe(true);

    // Chapter 1: B=1000, H=500, S=800, V=600
    // I = clamp(800 - 1000 = -200, 0, max(0, 500 - 600 = -100) = 0) = 0
    // frameOffset = 0, innerScrollTop = 0
    // frameScreenTop = B + I - S = 1000 + 0 - 800 = 200
    // Visible range in book: max(800, 1000)=1000 to min(1400, 1500)=1400 (length 400px)
    // clipTop = 1000 - 1000 - 0 = 0
    // clipBottom = 1400 - 1000 - 0 = 400
    // Relative to screen: frameScreenTop + clipTop = 200 + 0 = 200
    //                     frameScreenTop + clipBottom = 200 + 400 = 600
    // Thus Chapter 1 displays its first 400px from screen y=200 to y=600!
    expect(p1.box.key).toBe("1:c2.xhtml");
    expect(p1.frameOffset).toBe(0);
    expect(p1.innerScrollTop).toBe(0);
    expect(p1.frameScreenTop).toBe(200);
    expect(p1.clipTop).toBe(0);
    expect(p1.clipBottom).toBe(400);
    expect(p1.visible).toBe(true);
  });

  it("maps document coordinates to chapters via pointAt and anchorAt", () => {
    const layout = new ContinuousChapterLayout([
      { key: "c0", height: 0, measured: true }, // Empty chapter
      { key: "c1", height: 500, measured: true },
      { key: "c2", height: 800, measured: true },
    ]);

    // Zero-height chapters are skipped
    expect(layout.pointAt(0)).toEqual({ key: "c1", offset: 0 });
    // Inside c1
    expect(layout.pointAt(250)).toEqual({ key: "c1", offset: 250 });
    // Seam between c1 and c2: exact seam belongs to following nonempty chapter
    expect(layout.pointAt(500)).toEqual({ key: "c2", offset: 0 });
    // Inside c2
    expect(layout.pointAt(700)).toEqual({ key: "c2", offset: 200 });
    // End of book: belongs to last nonempty chapter at full height
    expect(layout.pointAt(1300)).toEqual({ key: "c2", offset: 800 });
    expect(layout.pointAt(9999)).toEqual({ key: "c2", offset: 800 });

    // anchorAt
    const anchor = layout.anchorAt(400, 600, 100); // documentY = 500 -> c2 offset 0
    expect(anchor).toEqual({ key: "c2", offset: 0, screenY: 100 });
  });

  it("restores scrollTop from anchor without jumping via withMeasurements", () => {
    // Initial estimates: both chapters estimated at 600
    const initial = new ContinuousChapterLayout([
      { key: "c1", height: 600, measured: false },
      { key: "c2", height: 600, measured: false },
    ]);

    const V = 600;
    // Currently viewing c2 at screenY=120, offset=80
    // In initial layout, c2 starts at top=600.
    // documentY = 600 + 80 = 680, S = 680 - 120 = 560
    const currentS = 560;
    const anchor = initial.anchorAt(currentS, V, 120);
    expect(anchor).toEqual({ key: "c2", offset: 80, screenY: 120 });

    // c1 is measured to be 1000px (+400px above c2)
    const { layout: updated, scrollTop: newS } = initial.withMeasurements(
      [{ key: "c1", height: 1000, measured: true }],
      anchor,
      V,
      currentS
    );

    // In updated layout, c2 starts at 1000.
    // Desired documentY = 1000 + 80 = 1080.
    // ScreenY was 120, so newS = 1080 - 120 = 960 (exactly 560 + 400).
    expect(newS).toBe(960);
    // Verify that anchor point still appears at screenY=120
    const verified = updated.anchorAt(newS, V, 120);
    expect(verified).toEqual({ key: "c2", offset: 80, screenY: 120 });
  });

  it("filters out chapters outside overscan", () => {
    const layout = new ContinuousChapterLayout([
      { key: "c0", height: 1000, measured: true },
      { key: "c1", height: 1000, measured: true },
      { key: "c2", height: 1000, measured: true },
      { key: "c3", height: 1000, measured: true },
    ]);

    // Viewport [1200, 1800], overscan=300 -> window [900, 2100]
    // c0: [0, 1000) intersects [900, 2100] (at 900-1000)
    // c1: [1000, 2000) intersects [900, 2100]
    // c2: [2000, 3000) intersects [900, 2100] (at 2000-2100)
    // c3: [3000, 4000) does not intersect
    const proj = layout.project(1200, 600, 300);
    const keys = proj.map((p) => p.box.key);
    expect(keys).toEqual(["c0", "c1", "c2"]);
  });
});

describe("ChapterLoadGate", () => {
  it("manages loading tickets with deduplication and stale rejection", () => {
    const gate = new ChapterLoadGate();

    // Begin load for c1
    const t1 = gate.begin("c1");
    expect(t1).not.toBeNull();
    expect(t1?.key).toBe("c1");

    // Second request while first is in-flight returns null
    expect(gate.begin("c1")).toBeNull();

    // Other chapters can begin
    const t2 = gate.begin("c2");
    expect(t2).not.toBeNull();

    // Cancellation allows restarting
    gate.cancel("c1");
    expect(gate.isCurrent(t1!)).toBe(false);

    const t1New = gate.begin("c1");
    expect(t1New).not.toBeNull();
    expect(t1New?.requestId).not.toBe(t1?.requestId);

    // Old ticket cannot finish
    expect(gate.finish(t1!)).toBe(false);
    // New ticket can finish
    expect(gate.finish(t1New!)).toBe(true);

    // Reset clears everything
    gate.reset();
    expect(gate.isCurrent(t2!)).toBe(false);
  });
});
