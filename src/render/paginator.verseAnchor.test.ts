import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ChapterPaginator } from "./paginator";

// ER-0146: right of a <br>-broken verse line the caret is (p, index of <br>).
function pager(caret: (x: number, y: number) => { offsetNode: Node; offset: number } | null) {
  const { document } = parseHTML('<html><body><epub-viewer><p>Prose before.</p><p id="poem">Fury said<br>to a mouse,<br><br>That he met<br></p><p id="empty"></p></epub-viewer></body></html>');
  const doc = document as unknown as Document;
  const viewer = doc.querySelector("epub-viewer") as HTMLElement;
  Object.defineProperties(viewer, { clientWidth: { value: 600 }, clientHeight: { value: 800 }, scrollTop: { value: 0 } });
  viewer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 }) as DOMRect;
  for (const el of doc.querySelectorAll("p")) el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 20 }) as DOMRect;
  Object.assign(doc, { caretPositionFromPoint: caret, elementFromPoint: () => doc.getElementById("poem") });
  const p = Object.create(ChapterPaginator.prototype) as Record<string, any>;
  Object.assign(p, { contentDoc: doc, viewer, textIndex: null, settings: { readingMode: "scroll" } });
  return { p, doc };
}

describe("reading anchor on verse lines (ER-0146)", () => {
  it("turns a <br> boundary into a text offset instead of a legacy element anchor", () => {
    const { p, doc } = pager((_x, _y) => {
      const poem = doc.getElementById("poem")!;
      return { offsetNode: poem, offset: Array.from(poem.childNodes).findIndex((c) => c.nodeName === "BR") };
    });
    const anchor = p.getReadingAnchorAt(400)?.anchor;
    expect(anchor?.textOffset).toBe("Prose before.Fury said".replace(/\s/g, "").length);
    expect(anchor?.textSnippet).toMatch(/^toamouse/);
  });

  it("still refuses an empty paragraph or the viewer itself", () => {
    const empty = pager(() => null);
    const emptyDoc = empty.doc;
    Object.assign(emptyDoc, { caretPositionFromPoint: () => ({ offsetNode: emptyDoc.getElementById("empty")!, offset: 0 }) });
    expect(empty.p.getReadingAnchorAt(400)?.anchor.textOffset ?? null).toBeNull();
    const top = pager(() => null);
    Object.assign(top.doc, { caretPositionFromPoint: () => ({ offsetNode: top.doc.querySelector("epub-viewer")!, offset: 1 }) });
    expect(top.p.getReadingAnchorAt(400)?.anchor.textOffset ?? null).toBeNull();
  });
});
