import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { ChapterFillIndex, LeadingColumnGap, canRetainLeadingColumn, chapterFillEntries, chapterLeafLayout } from "./chapterFill";
import { createSpreadGeometry, createSpreadLayout, laneForColumn, spreadForColumn, visibleColumnInterval, visibleLeafRange } from "./pagedSpread";
import { buildVisibleTextIndex } from "./textAnchor";
import type { Book } from "../core/types";
import { parseOpf } from "../core/opf";
import { ChapterPaginator } from "./paginator";
import { JOIN_MIN_LEAVES, canJoinChapters } from "../ui/chapterJoin";

describe("cross-chapter fill core", () => {
  it("withholds exact counts while fonts or image dimensions are still pending", () => {
    const context = {
      isDisplayReady: true, spreadLayout: createSpreadLayout(createSpreadGeometry(800, 40, 2), { first: 0, last: 2 }),
      scrollMode: false, verticalMode: null, fixedLayout: false,
      chapterFill: { leadingBlankColumns: 0 }, leadingColumnSupported: true,
      contentDoc: { fonts: { status: "loading" }, images: [{ complete: true }] },
    };
    const read = Object.getOwnPropertyDescriptor(ChapterPaginator.prototype, "contentLeafLayout")!.get!;
    expect(read.call(context)).toBeNull();
    context.contentDoc.fonts.status = "loaded";
    context.contentDoc.images[0].complete = false;
    expect(read.call(context)).toBeNull();
    context.contentDoc.images[0].complete = true;
    expect(read.call(context)).toMatchObject({ contentLeafCount: 3, joinable: true });
  });
  it("keeps the reader blank out of leaf numbers, bookmark lanes and exact content counts", () => {
    const geometry = createSpreadGeometry(800, 40, 2);
    const layout = createSpreadLayout(geometry, { first: 1, last: 3 }, 1);
    expect(layout.pageCount).toBe(2);
    expect(visibleLeafRange(layout, 0)).toEqual({ first: 1, last: 1, total: 3 });
    expect(visibleLeafRange(layout, 1)).toEqual({ first: 2, last: 3, total: 3 });
    expect(visibleColumnInterval(layout, 0, 0)).toBeNull();
    expect(laneForColumn(layout, 1)).toBe(1);
    expect(spreadForColumn(layout, 2)).toBe(1);
    expect(chapterLeafLayout(layout)).toEqual({ contentLeafCount: 3, leadingBlankColumns: 1, authoredLeadingColumns: 0 });
    // Author-created blank columns between occupied columns remain in the count.
    expect(chapterLeafLayout(createSpreadLayout(geometry, { first: 2, last: 5 }))).toEqual({
      contentLeafCount: 4, leadingBlankColumns: 0, authoredLeadingColumns: 2,
    });
    expect(canRetainLeadingColumn({ first: 2, last: 3 })).toBe(false);
    expect(chapterLeafLayout(createSpreadLayout(geometry, null, 1)).contentLeafCount).toBe(0);
  });

  it("waits for the exact prefix, pairs A3 B3 C2 consistently, and freezes each entry decision", () => {
    const index = new ChapterFillIndex("layout-a", [0, 1, 2].map(chapter => ({ chapter })));
    index.record("layout-a", 1, { contentLeafCount: 3, joinable: true });
    const entryBeforeCounts = index.placement(1);
    expect(entryBeforeCounts).toMatchObject({ known: false, leadingBlankColumns: 0 });
    index.record("layout-a", 0, { contentLeafCount: 3, joinable: true });
    index.record("layout-a", 2, { contentLeafCount: 2, joinable: true });
    expect([0, 1, 2].map(chapter => index.placement(chapter).leadingBlankColumns)).toEqual([0, 1, 0]);
    const reverseOrder = new ChapterFillIndex("layout-a", [0, 1, 2].map(chapter => ({ chapter })));
    for (const [chapter, contentLeafCount] of [[2, 2], [0, 3], [1, 3]]) {
      reverseOrder.record("layout-a", chapter, { contentLeafCount, joinable: true });
    }
    expect(reverseOrder.placement(1)).toEqual(index.placement(1));
    expect(entryBeforeCounts).toMatchObject({ known: false, leadingBlankColumns: 0 });
    expect(index.nextUnmeasured()).toBeNull();
    expect(index.record("stale-layout", 0, { contentLeafCount: 8, joinable: true })).toBe(false);
    expect(index.placement(1).leadingBlankColumns).toBe(1);
  });

  it("resets at image/author/unsupported boundaries without requiring unknown earlier chapters", () => {
    const index = new ChapterFillIndex("layout", [{ chapter: 0 }, { chapter: 1, isolated: true }, { chapter: 2 }, { chapter: 3 }]);
    index.record("layout", 2, { contentLeafCount: 3, joinable: true });
    index.record("layout", 3, { contentLeafCount: 1, joinable: true });
    expect(index.placement(2)).toMatchObject({ known: true, leadingBlankColumns: 0 });
    expect(index.placement(3).leadingBlankColumns).toBe(JOIN_MIN_LEAVES === 1 ? 1 : 0);
    index.record("layout", 2, { contentLeafCount: 3, joinable: false });
    expect(index.placement(3).leadingBlankColumns).toBe(0);
    const nextLayout = new ChapterFillIndex("new-size", [{ chapter: 2 }, { chapter: 3 }]);
    expect(nextLayout.placement(3).known).toBe(false);
    expect(nextLayout.record("layout", 2, { contentLeafCount: 3, joinable: true })).toBe(false);
  });

  it.each([
    { counts: [2, 1, 3], shifted: [0, 0, 1] },
    { counts: [1, 1, 3], shifted: [0, 1, 0] },
  ])("keeps prefix and join capability consistent for $counts", ({ counts, shifted }) => {
    const index = new ChapterFillIndex("layout", counts.map((_, chapter) => ({ chapter })));
    counts.forEach((contentLeafCount, chapter) => index.record("layout", chapter, { contentLeafCount, joinable: true }));
    const leading = counts.map((_, chapter) => index.placement(chapter).leadingBlankColumns);
    expect(leading).toEqual(JOIN_MIN_LEAVES === 1 ? shifted : [0, 0, 0]);
    expect(canJoinChapters(
      { leading: leading[1], contentLeafCount: counts[1], pageCount: 1, joinable: true },
      { leading: leading[2], contentLeafCount: counts[2], pageCount: 2, joinable: true },
    )).toBe(JOIN_MIN_LEAVES === 1 && leading[2] === 1);
  });

  it("does not insert a DOM child or shift canonical/legacy indices, and preserves an author pseudo-element", () => {
    const { document } = parseHTML('<html><head></head><body><div id="epub-viewer"><p>Original first text</p><p>Second paragraph</p></div></body></html>');
    const viewer = document.getElementById("epub-viewer") as unknown as HTMLElement;
    let before = "none";
    (document.defaultView as any).getComputedStyle = () => ({ content: before });
    const original = buildVisibleTextIndex(document as unknown as Document, viewer);
    const first = viewer.firstElementChild!;
    const gap = new LeadingColumnGap();
    expect(gap.apply(viewer)).toBe(true);
    const shifted = buildVisibleTextIndex(document as unknown as Document, viewer);
    expect(shifted.text).toBe(original.text);
    expect(shifted.elementIndex(first)).toBe(original.elementIndex(first));
    expect(first.matches(":first-child")).toBe(true);
    gap.dispose();
    expect(document.head.querySelector('[data-reader="leading-column"]')).toBeNull();
    before = '"authored"';
    expect(gap.apply(viewer)).toBe(false);
  });

  it("isolates explicit spine page-side requests and omits non-linear entries", () => {
    const { document } = parseHTML('<package version="3.0"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b" properties="page-spread-left"/></spine></package>');
    expect(parseOpf(document as any).spine[1].properties).toEqual(["page-spread-left"]);
    const book = { fixedLayout: false, spine: [
      { idref: "a", linear: true }, { idref: "b", linear: true, properties: ["page-spread-left"] },
      { idref: "note", linear: false }, { idref: "image", linear: true },
    ] } as Book;
    expect(chapterFillEntries(book, new Set([3]))).toEqual([
      { chapter: 0, isolated: false }, { chapter: 1, isolated: true }, { chapter: 3, isolated: true },
    ]);
  });
});
