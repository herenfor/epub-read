import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { ChapterPaginator } from "./paginator";
import { buildVisibleTextIndex } from "./textAnchor";

// ER-0145: TOC anchors of the laid-out chapter, by canonical text offset.
type Pager = Record<string, any>;
function pager(markup: string) {
  const { document } = parseHTML(`<html><body><epub-viewer id="epub-viewer">${markup}</epub-viewer></body></html>`);
  const doc = document as unknown as Document;
  const viewer = doc.getElementById("epub-viewer") as HTMLElement;
  const p = Object.create(ChapterPaginator.prototype) as Pager;
  const buildTextIndex = vi.fn(() => buildVisibleTextIndex(doc, viewer));
  Object.assign(p, {
    contentDoc: doc, viewer, disposed: false, textIndex: null, buildTextIndex,
    _currentPath: "OEBPS/part.html", settings: { readingMode: "paginated" }, metrics: { currentPage: 3 },
    lastState: { status: "ready", currentPage: 3, pageCount: 9, empty: false },
  });
  return { p, doc, buildTextIndex };
}

describe("paginator TOC anchor offsets (ER-0145)", () => {
  const markup = '<p>Front</p><a id="ch 1"></a><h2>One</h2><p>Body</p><h2 id="c2">Two</h2>';

  it("resolves encoded and plain fragments once per text index, and nothing for another chapter", () => {
    const { p, doc, buildTextIndex } = pager(markup);
    const byId = vi.spyOn(doc, "getElementById");
    expect(p.fragmentTextOffsets("OEBPS/part.html", ["ch%201", "#c2", "missing"])).toEqual([5, 12, null]);
    expect(buildTextIndex).toHaveBeenCalledTimes(1);
    const lookups = byId.mock.calls.length;
    expect(p.fragmentTextOffsets("OEBPS/part.html", ["c2", "ch%201"])).toEqual([12, 5]);
    expect(byId.mock.calls.length).toBe(lookups);
    expect(p.fragmentTextOffsets("OEBPS/other.html", ["c2"])).toBeNull();
    p.lastState = { status: "loading" };
    expect(p.fragmentTextOffsets("OEBPS/part.html", ["c2"])).toBeNull();
  });

  it("asks the paginated layout whether a fragment is on the shown screen", () => {
    const { p } = pager(markup);
    p.getWithinChapterFragmentPage = vi.fn((fragment: string) => ({ hash: fragment, page: fragment === "c2" ? 3 : 1 }));
    expect(p.fragmentOnCurrentPage("OEBPS/part.html", "c2")).toBe(true);
    expect(p.fragmentOnCurrentPage("OEBPS/part.html", "ch%201")).toBe(false);
    expect(p.fragmentOnCurrentPage("OEBPS/other.html", "c2")).toBe(false);
  });
});
