import { describe, expect, it } from "vitest";
import {
  clientXToColumnX,
  columnForContentPoint,
  commitSpreadPosition,
  createSpreadGeometry,
  createSpreadLayout,
  occupiedColumns,
  PagedViewportPort,
  planSpreadTurn,
  presentationPatch,
  readingPresentation,
  spreadColumnStyles,
  spreadForColumn,
  spreadStart,
  visibleColumnInterval,
  visibleLeafRange,
} from "./pagedSpread";

describe("pagedSpread core", () => {
  describe("readingPresentation and presentationPatch", () => {
    it("maps preferences to presentation choice and back", () => {
      expect(readingPresentation({})).toBe("single");
      expect(readingPresentation({ readingMode: "paginated", columnsPerView: 1 })).toBe("single");
      expect(readingPresentation({ readingMode: "paginated", columnsPerView: 2 })).toBe("spread");
      expect(readingPresentation({ readingMode: "scroll", columnsPerView: 2 })).toBe("scroll");
      expect(readingPresentation({ readingMode: "scroll" })).toBe("scroll");

      expect(presentationPatch("single")).toEqual({ readingMode: "paginated", columnsPerView: 1 });
      expect(presentationPatch("spread")).toEqual({ readingMode: "paginated", columnsPerView: 2 });
      expect(presentationPatch("scroll")).toEqual({ readingMode: "scroll" });
    });
  });

  describe("createSpreadGeometry and styles", () => {
    it("respects the 280px minimum column width threshold for 1 vs 2 columns", () => {
      // (583 - 24) / 2 = 279.5 < 280 => fallback to 1 column
      const g1 = createSpreadGeometry(583, 24, 2);
      expect(g1.columns).toBe(1);
      expect(g1.columnWidth).toBe(583);
      expect(g1.columnStep).toBe(607);
      expect(g1.spreadStep).toBe(607);

      // (584 - 24) / 2 = 280 >= 280 => 2 columns
      const g2 = createSpreadGeometry(584, 24, 2);
      expect(g2.columns).toBe(2);
      expect(g2.columnWidth).toBe(280);
      expect(g2.columnStep).toBe(304);
      expect(g2.spreadStep).toBe(608);
    });

    it("handles non-integer viewport widths without loss of precision", () => {
      const g = createSpreadGeometry(1000.5, 24, 2);
      expect(g.columns).toBe(2);
      expect(g.columnWidth).toBe(488.25);
      expect(g.columnStep).toBe(512.25);
      expect(g.spreadStep).toBe(1024.5);
    });

    it("handles zero gap properly", () => {
      const g = createSpreadGeometry(800, 0, 2);
      expect(g.columns).toBe(2);
      expect(g.columnWidth).toBe(400);
      expect(g.columnStep).toBe(400);
      expect(g.spreadStep).toBe(800);
    });

    it("outputs column-count directly, never auto column-count", () => {
      const g2 = createSpreadGeometry(1000, 24, 2);
      expect(spreadColumnStyles(g2)).toEqual({
        "column-count": "2",
        "column-width": "auto",
        "column-gap": "24px",
        "column-fill": "auto",
      });
      const g1 = createSpreadGeometry(1000, 24, 1);
      expect(spreadColumnStyles(g1)).toEqual({
        "column-count": "1",
        "column-width": "auto",
        "column-gap": "24px",
        "column-fill": "auto",
      });
    });
  });

  describe("clientXToColumnX and columnForContentPoint", () => {
    it("subtracts originClientX and adds scrollLeft", () => {
      // originClientX = 100, scrollLeft = 512, clientX = 150 => 150 - 100 + 512 = 562
      expect(clientXToColumnX(150, 100, 512)).toBe(562);
    });

    it("finds physical column by columnStep floor", () => {
      const g = createSpreadGeometry(1000, 24, 2); // columnStep = 512
      expect(columnForContentPoint(0, g)).toBe(0);
      expect(columnForContentPoint(511.9, g)).toBe(0);
      expect(columnForContentPoint(512, g)).toBe(1);
      expect(columnForContentPoint(1023.9, g)).toBe(1);
      expect(columnForContentPoint(1024, g)).toBe(2);
    });
  });

  describe("occupiedColumns and leading columns offset", () => {
    it("captures content starting at a leading column offset", () => {
      const g = createSpreadGeometry(1000, 24, 2); // columnStep = 512
      // A heading with page-break-before pushes first content into column 1
      const fragments = [
        { left: 520, right: 800 },
        { left: 1050, right: 1500 },
      ];
      const occupied = occupiedColumns(fragments, g);
      expect(occupied).toEqual({ first: 1, last: 2 });
    });

    it("ignores zero or negative width fragments", () => {
      const g = createSpreadGeometry(1000, 24, 2);
      const occupied = occupiedColumns(
        [
          { left: 100, right: 100 },
          { left: 200, right: 150 },
        ],
        g,
      );
      expect(occupied).toBeNull();
    });

    it("does not increment column when fragment right touches next column boundary exactly", () => {
      const g = createSpreadGeometry(1000, 24, 2); // columnStep = 512
      const fragments = [{ left: 10, right: 512 }];
      const occupied = occupiedColumns(fragments, g);
      expect(occupied).toEqual({ first: 0, last: 0 });
    });
  });

  describe("5 columns = 3 spreads, tail spacer, and shared offset", () => {
    const g = createSpreadGeometry(1000, 24, 2); // W=1000, gap=24, CW=488, CS=512, spreadStep=1024

    it("calculates 3 spreads for 5 columns and guarantees requiredScrollWidth", () => {
      // 5 columns: physical columns 0, 1, 2, 3, 4
      const layout = createSpreadLayout(g, { first: 0, last: 4 });
      expect(layout.pageCount).toBe(3);
      expect(layout.firstColumn).toBe(0);
      expect(layout.lastColumn).toBe(4);
      expect(layout.empty).toBe(false);

      // spread 0: cols 0, 1, start = 0
      expect(spreadForColumn(layout, 0)).toBe(0);
      expect(spreadForColumn(layout, 1)).toBe(0);
      expect(spreadStart(layout, 0)).toBe(0);

      // spread 1: cols 2, 3, start = 1024
      expect(spreadForColumn(layout, 2)).toBe(1);
      expect(spreadForColumn(layout, 3)).toBe(1);
      expect(spreadStart(layout, 1)).toBe(1024);

      // spread 2: col 4, start = 2048
      expect(spreadForColumn(layout, 4)).toBe(2);
      expect(spreadStart(layout, 2)).toBe(2048);

      // requiredScrollWidth = lastStart + viewportWidth = 2048 + 1000 = 3048
      expect(layout.requiredScrollWidth).toBe(3048);
    });

    it("shares leadingColumns offset across spreadForColumn, spreadStart, and intervals", () => {
      // Content starts at column 1 and ends at column 5 (5 columns total)
      const layout = createSpreadLayout(g, { first: 1, last: 5 });
      expect(layout.pageCount).toBe(3);
      expect(layout.firstColumn).toBe(1);
      expect(layout.lastColumn).toBe(5);

      // spread 0: physical cols 1, 2. Start = 1 * 512 = 512
      expect(spreadForColumn(layout, 1)).toBe(0);
      expect(spreadForColumn(layout, 2)).toBe(0);
      expect(spreadStart(layout, 0)).toBe(512);

      // spread 1: physical cols 3, 4. Start = (1 + 2) * 512 = 1536
      expect(spreadForColumn(layout, 3)).toBe(1);
      expect(spreadForColumn(layout, 4)).toBe(1);
      expect(spreadStart(layout, 1)).toBe(1536);

      // spread 2: physical col 5. Start = (1 + 4) * 512 = 2560
      expect(spreadForColumn(layout, 5)).toBe(2);
      expect(spreadStart(layout, 2)).toBe(2560);

      // requiredScrollWidth = 2560 + 1000 = 3560
      expect(layout.requiredScrollWidth).toBe(3560);
    });

    it("derives visibleLeafRange for [1|2], [3|4], and [5|blank]", () => {
      const layout = createSpreadLayout(g, { first: 0, last: 4 });
      expect(visibleLeafRange(layout, 0)).toEqual({ first: 1, last: 2, total: 5 });
      expect(visibleLeafRange(layout, 1)).toEqual({ first: 3, last: 4, total: 5 });
      expect(visibleLeafRange(layout, 2)).toEqual({ first: 5, last: 5, total: 5 });
    });

    it("returns visibleColumnInterval for lane 0 and lane 1, returning null when lane is empty", () => {
      const layout = createSpreadLayout(g, { first: 0, last: 4 });
      // spread 1: lane 0 is col 2, lane 1 is col 3
      expect(visibleColumnInterval(layout, 1, 0)).toEqual({
        physicalColumn: 2,
        screenLeft: 0,
        screenRight: 488,
      });
      expect(visibleColumnInterval(layout, 1, 1)).toEqual({
        physicalColumn: 3,
        screenLeft: 512,
        screenRight: 1000,
      });

      // spread 2: lane 0 is col 4, lane 1 has no content
      expect(visibleColumnInterval(layout, 2, 0)).toEqual({
        physicalColumn: 4,
        screenLeft: 0,
        screenRight: 488,
      });
      expect(visibleColumnInterval(layout, 2, 1)).toBeNull();
    });

    it("plans spread turn across pages and chapter boundaries", () => {
      const layout = createSpreadLayout(g, { first: 0, last: 4 });
      expect(planSpreadTurn(layout, 0, 1)).toEqual({ kind: "page", page: 1 });
      expect(planSpreadTurn(layout, 1, 1)).toEqual({ kind: "page", page: 2 });
      expect(planSpreadTurn(layout, 2, 1)).toEqual({ kind: "chapter-boundary", direction: 1 });
      expect(planSpreadTurn(layout, 0, -1)).toEqual({ kind: "chapter-boundary", direction: -1 });
    });
  });

  describe("commitSpreadPosition and PagedViewportPort", () => {
    const g = createSpreadGeometry(1000, 24, 2);
    const layout = createSpreadLayout(g, { first: 0, last: 4 }); // 3 spreads, lastStart = 2048, requiredScrollWidth = 3048

    it("ensures scroll width and writes target scrollLeft successfully", () => {
      let scrollWidth = 1000;
      let scrollLeft = 0;
      const port: PagedViewportPort = {
        ensureScrollWidth: (w) => {
          scrollWidth = Math.max(scrollWidth, w);
        },
        readScrollWidth: () => scrollWidth,
        readClientWidth: () => 1000,
        readScrollLeft: () => scrollLeft,
        writeScrollLeft: (v) => {
          scrollLeft = Math.min(v, scrollWidth - 1000);
        },
      };

      const result = commitSpreadPosition(port, layout, 2);
      expect(result).toEqual({ ok: true, page: 2, scrollLeft: 2048 });
      expect(scrollWidth).toBe(3048);
      expect(scrollLeft).toBe(2048);
    });

    it("fails cleanly and restores previous scrollLeft when target is unreachable", () => {
      let scrollLeft = 500;
      const port: PagedViewportPort = {
        ensureScrollWidth: () => {
          // Simulator of broken spacer that fails to expand scrollWidth
        },
        readScrollWidth: () => 1500, // max scrollLeft = 500
        readClientWidth: () => 1000,
        readScrollLeft: () => scrollLeft,
        writeScrollLeft: (v) => {
          scrollLeft = Math.min(v, 1500 - 1000);
        },
      };

      const result = commitSpreadPosition(port, layout, 2); // target is 2048 > 1500 - 1000 + 1
      expect(result).toEqual({ ok: false, reason: "unreachable" });
      expect(scrollLeft).toBe(500); // restored
    });
  });
});
