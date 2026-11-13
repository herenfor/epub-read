import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { clearDocumentSelection, isSelectAllShortcut, resetRootScrollOffsets, restorePagedViewerScroll } from "./selectionGuard";

function event(target: EventTarget, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: "a", ctrlKey: true, metaKey: false, target, ...overrides } as KeyboardEvent;
}

describe("selection keyboard guard", () => {
  it("blocks Ctrl/Cmd+A but not ordinary A or other modifiers", () => {
    const { document } = parseHTML("<html><body><p>正文</p></body></html>");
    const target = document.querySelector("p")!;
    expect(isSelectAllShortcut(event(target))).toBe(true);
    expect(isSelectAllShortcut(event(target, { key: "A", ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isSelectAllShortcut(event(target, { key: "b" }))).toBe(false);
    expect(isSelectAllShortcut(event(target, { ctrlKey: false, metaKey: false }))).toBe(false);
  });

  it("allows shortcuts in input/textarea and contenteditable descendants", () => {
    const { document } = parseHTML(
      '<html><body><input id="i"><textarea id="t"></textarea><div contenteditable="true"><span id="child">text</span></div></body></html>'
    );
    expect(isSelectAllShortcut(event(document.querySelector("#i")!))).toBe(false);
    expect(isSelectAllShortcut(event(document.querySelector("#t")!))).toBe(false);
    expect(isSelectAllShortcut(event(document.querySelector("#child")!))).toBe(false);
  });

  it("removes every range from the supplied document selection", () => {
    const removeAllRanges = vi.fn();
    clearDocumentSelection({ getSelection: () => ({ removeAllRanges }) } as unknown as Document);
    expect(removeAllRanges).toHaveBeenCalledOnce();
    clearDocumentSelection(null);
  });

  it("resets non-zero documentElement, body, and window scroll offsets", () => {
    const scrollTo = vi.fn();
    const doc = {
      documentElement: { scrollLeft: 12, scrollTop: 0 },
      body: { scrollLeft: 324.5, scrollTop: 4 },
      defaultView: { scrollX: 10, scrollY: 0, scrollTo },
    } as unknown as Document;

    expect(resetRootScrollOffsets(doc)).toBe(true);
    expect(doc.documentElement.scrollLeft).toBe(0);
    expect(doc.body.scrollLeft).toBe(0);
    expect(doc.body.scrollTop).toBe(0);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(resetRootScrollOffsets({ documentElement: { scrollLeft: 0.2, scrollTop: 0 }, body: { scrollLeft: 0, scrollTop: 0 } } as unknown as Document)).toBe(false);
  });

  it("restores drifted paged viewer scrollLeft in both LTR and RTL progression", () => {
    const ltrViewer = { scrollLeft: 7276 };
    expect(restorePagedViewerScroll(ltrViewer, 6912, "ltr")).toBe(true);
    expect(ltrViewer.scrollLeft).toBe(6912);
    expect(restorePagedViewerScroll(ltrViewer, 6912.3, "ltr")).toBe(false);

    const rtlViewer = { scrollLeft: -1500 };
    expect(restorePagedViewerScroll(rtlViewer, 1152, "rtl")).toBe(true);
    expect(rtlViewer.scrollLeft).toBe(-1152);
    expect(restorePagedViewerScroll(rtlViewer, null, "ltr")).toBe(false);
  });
});
