import { describe, expect, it } from "vitest";
import {
  ContinuousChapterLayout,
  ChapterLoadGate,
  PendingScrollNavigation,
  buildSpacedChapterBoxes,
  continuousFrameBleed,
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

describe("continuous frame bleed", () => {
  it("keeps the iframe window covering the viewport while the host scroll runs ahead", () => {
    const layout = new ContinuousChapterLayout([{ key: "0:long.xhtml", height: 10000, measured: true }]);
    const V = 800;
    const bleed = 200;
    const [p] = layout.project(3000, V, 0, bleed);
    // iframe 高 V + 2*bleed，顶边在视口上方 bleed 处；内容不跳（inner = frame）。
    expect(p.frameOffset).toBe(2800);
    expect(p.innerScrollTop).toBe(2800);
    expect(p.frameScreenTop).toBe(-200);
    // 合成线程领先 JS 不超过 bleed 时，iframe 仍盖满 [0, V]。
    for (const lead of [-bleed, -120, 0, 120, bleed]) {
      const top = p.frameScreenTop - lead;
      expect(top).toBeLessThanOrEqual(0);
      expect(top + V + 2 * bleed).toBeGreaterThanOrEqual(V);
    }
  });

  it("clamps the window at chapter edges", () => {
    const layout = new ContinuousChapterLayout([{ key: "0:long.xhtml", height: 10000, measured: true }]);
    expect(layout.project(0, 800, 0, 200)[0].frameOffset).toBe(0);
    expect(layout.project(9200, 800, 0, 200)[0].frameOffset).toBe(10000 - 1200);
  });

  it("scales with the viewport within fixed bounds", () => {
    expect(continuousFrameBleed(0)).toBe(0);
    expect(continuousFrameBleed(300)).toBe(160);
    expect(continuousFrameBleed(800)).toBe(280);
    expect(continuousFrameBleed(2000)).toBe(400);
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

describe("ContinuousChapterLayout gap (B-154)", () => {
  it("只在两个正高度章节之间插入 gap，空章不制造额外空隙", () => {
    const extents: ChapterExtent[] = [
      { key: "empty-first", height: 0, measured: true },
      { key: "a", height: 100, measured: true },
      { key: "empty-middle", height: 0, measured: true },
      { key: "b", height: 80, measured: true },
      { key: "empty-last", height: 0, measured: true },
    ];
    const { boxes, totalHeight } = buildSpacedChapterBoxes(extents, 24);
    expect(boxes.map((box) => box.top)).toEqual([0, 0, 100, 124, 204]);
    // 书首空章、空章和书尾空章都不增加总高；正章节之间计算 24px gap。
    expect(totalHeight).toBe(204);
  });

  it("gap 内的点归到下个章节 offset 0，screenY 按实际章节 top 重算", () => {
    const layout = new ContinuousChapterLayout([
      { key: "a", height: 100, measured: true },
      { key: "b", height: 100, measured: true },
    ], 24);
    // documentY=110 落在 [100,124) 的 gap 内。
    expect(layout.pointAt(110)).toEqual({ key: "b", offset: 0 });
    const anchor = layout.anchorAt(100, 100, 10); // documentY=110
    expect(anchor).toEqual({ key: "b", offset: 0, screenY: 24 });
    expect(layout.boxes[1].top).toBe(124);
    expect(layout.totalHeight).toBe(224);
  });

  it("withMeasurements 保留 gap，重排后仍用同一布局表", () => {
    const before = new ContinuousChapterLayout([
      { key: "a", height: 100, measured: true },
      { key: "b", height: 100, measured: true },
    ], 24);
    const { layout: after, scrollTop } = before.withMeasurements(
      [{ key: "a", height: 200, measured: true }],
      { key: "b", offset: 0, screenY: 0 },
      600,
      0,
    );
    expect(after.gap).toBe(24);
    expect(after.boxes[1].top).toBe(224);
    // V=600 时旧/新总高都小于视口，位置按合法范围回到 0。
    expect(scrollTop).toBe(0);
  });
});

describe("PendingScrollNavigation (B-155)", () => {
  it("同书同布局代次才允许提交，旧票据/旧书不提交", () => {
    const pending = new PendingScrollNavigation<{ kind: string }>();
    const ticket = pending.begin(1, "0:a.xhtml", { kind: "anchor" });
    expect(pending.current()).toBe(ticket);
    expect(pending.canCommit(ticket, 1, 7, 7)).toBe(true);
    expect(pending.canCommit(ticket, 2, 7, 7)).toBe(false);
    expect(pending.canCommit(ticket, 1, 7, 8)).toBe(false);
    expect(pending.settle(ticket)).toBe(true);
    expect(pending.current()).toBeNull();
    expect(pending.settle(ticket)).toBe(false);
  });

  it("新票据取代旧票据，旧票据不能结算", () => {
    const pending = new PendingScrollNavigation<string>();
    const oldTicket = pending.begin(1, "0:a.xhtml", "old");
    const newTicket = pending.begin(1, "1:b.xhtml", "new");
    expect(pending.canCommit(oldTicket, 1, 0, 0)).toBe(false);
    expect(pending.settle(oldTicket)).toBe(false);
    expect(pending.settle(newTicket)).toBe(true);
  });
});
