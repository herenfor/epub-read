import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ChapterPaginator } from "./paginator";
import { createSpreadGeometry, createSpreadLayout } from "./pagedSpread";
import { buildVisibleTextIndex } from "./textAnchor";

function fixture(firstHit: "blank" | "left" | "only-blank" = "blank", imagePage = false) {
  const { document } = parseHTML('<html><body><epub-viewer><p id="left">左页</p><p id="blank"></p><p id="right">右页</p><img></epub-viewer></body></html>');
  const doc = document as unknown as Document;
  const viewer = doc.querySelector("epub-viewer") as HTMLElement;
  const left = doc.getElementById("left")!;
  const right = doc.getElementById("right")!;
  const blank = doc.getElementById("blank")!;
  const img = doc.querySelector("img")!;
  const rect = (x: number) => ({ left: x, right: x + 480, top: 70, width: 480, height: 24 });
  for (const [el, x] of [[left, 50], [right, 650], [blank, 650], [img, 650]] as const) {
    el.getBoundingClientRect = () => rect(x) as DOMRect;
  }
  const index = buildVisibleTextIndex(doc, viewer);
  Object.defineProperties(viewer, {
    clientWidth: { value: 1200 }, clientHeight: { value: 750 },
    clientLeft: { value: 0 }, clientTop: { value: 0 }, scrollLeft: { value: 4800, writable: true },
  });
  viewer.getBoundingClientRect = () => ({ ...rect(0), top: 0, width: 1200 }) as DOMRect;
  Object.defineProperty(doc, "defaultView", { value: {
    getComputedStyle: () => ({ paddingLeft: "50px", paddingTop: "35px", fontSize: "16px", lineHeight: "24px" }),
  } });
  Object.assign(doc, {
    caretRangeFromPoint: (_x: number, y: number) => ({
      startContainer: imagePage || firstHit === "only-blank" || (y < 60 && firstHit === "blank")
        ? blank : y < 60 ? left.firstChild : right.firstChild,
      startOffset: 0,
    }),
    elementFromPoint: () => blank,
    createRange: () => {
      let start: Node;
      return {
        setStart: (node: Node) => { start = node; }, setEnd: () => {},
        getClientRects: () => [start.parentElement!.getBoundingClientRect()],
      };
    },
  });
  const geometry = createSpreadGeometry(1080, 120, 2);
  const p = Object.create(ChapterPaginator.prototype) as Record<string, any>;
  const mediaAnchor = { index: 0, signature: "picture", ratio: 0.5 };
  Object.assign(p, {
    contentDoc: doc, viewer, textIndex: index, settings: { fontSizePx: 16, readingMode: "paginated" },
    metrics: { currentPage: 4 }, flowProgression: "ltr", leadingColumns: 0, step: 600,
    spreadLayout: createSpreadLayout(geometry, { first: 0, last: 13 }), spreadGeometry: geometry,
    bookmarkSpreadCache: new Map(),
    visualSpreadOrigin: () => ({ contentLeft: 50, rtl: false, present: [true, true], geometry }),
    visibleMediaAt: () => imagePage ? { element: img, anchor: mediaAnchor } : null,
    resolveMediaAnchorElement: () => img,
  });
  return { p, mediaAnchor };
}

describe("bookmark lane capture", () => {
  it("skips an empty first line and captures a repeatably resolvable right-page bookmark", () => {
    const { p } = fixture();
    const captured = p.captureLaneAnchor(1);
    expect(captured?.anchor.textOffset).toBe(2);
    expect(captured?.text).toBe("右页");
    const bookmark = { id: "right-bookmark", page: 4, anchorTextOffset: captured?.anchor.textOffset,
      anchorTextSnippet: captured?.anchor.textSnippet };
    expect(p.resolveBookmarkPlacement(bookmark)).toEqual({ page: 4, lane: 1 });
    expect(p.captureLaneAnchor(1)?.anchor).toEqual(captured.anchor);
  });

  it("rejects a caret snapped to the other page and never saves a blank-only legacy fallback", () => {
    const { p } = fixture("left");
    expect(p.captureLaneAnchor(1)?.anchor.textOffset).toBe(2);
    expect(fixture("only-blank").p.captureLaneAnchor(1)).toBeNull();
  });

  it("keeps the right page's media identity when the chapter has no text at the sample point", () => {
    const { p, mediaAnchor } = fixture("blank", true);
    const captured = p.captureLaneAnchor(1);
    expect(captured?.anchor.mediaAnchor).toEqual(mediaAnchor);
    expect(p.resolveBookmarkPlacement({ mediaAnchor: captured.anchor.mediaAnchor })).toEqual({ page: 4, lane: 1 });
  });
});
