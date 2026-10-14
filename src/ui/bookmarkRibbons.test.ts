import { describe, expect, it } from "vitest";
import {
  bookmarkButtonAction,
  isEditableTarget,
  pageRibbonLeft,
  screenBookmarkIds,
  type ScreenBookmarks,
} from "./bookmarkRibbons";

const page = (lane: 0 | 1, ids: string[]) => ({ lane, side: lane === 0 ? "left" : "right", spineIndex: 3, ids } as const);

describe("A15 bookmark button rules", () => {
  it("always opens the page tiles in a spread and adds to the first page only when the spread has none", () => {
    const empty: ScreenBookmarks = { kind: "paged", columns: 2, pages: [page(0, []), page(1, [])] };
    expect(bookmarkButtonAction(empty)).toEqual({ kind: "pages", addFirst: true });
    const marked: ScreenBookmarks = { kind: "paged", columns: 2, pages: [page(0, []), page(1, ["b"])] };
    expect(bookmarkButtonAction(marked)).toEqual({ kind: "pages", addFirst: false });
    // The last spread without a second page is still a spread.
    expect(bookmarkButtonAction({ kind: "paged", columns: 2, pages: [page(0, [])] })).toEqual({ kind: "pages", addFirst: true });
  });

  it("toggles in single page and scroll: add when none, remove everything on screen otherwise", () => {
    expect(bookmarkButtonAction({ kind: "paged", columns: 1, pages: [page(0, [])] })).toEqual({ kind: "add" });
    expect(bookmarkButtonAction({ kind: "paged", columns: 1, pages: [page(0, ["a", "b"])] }))
      .toEqual({ kind: "remove", ids: ["a", "b"] });
    expect(bookmarkButtonAction({ kind: "scroll", columns: 1, pages: [page(0, ["c"])] }))
      .toEqual({ kind: "remove", ids: ["c"] });
    expect(bookmarkButtonAction(null)).toEqual({ kind: "add" });
    expect(screenBookmarkIds({ kind: "paged", columns: 2, pages: [page(0, ["a"]), page(1, ["b"])] })).toEqual(["a", "b"]);
  });

  it("hangs the ribbon 14px inside the page's outer edge", () => {
    expect(pageRibbonLeft("left", 100)).toBe(114);
    expect(pageRibbonLeft("right", 1000)).toBe(972);
  });

  it("leaves Ctrl+Z to editable fields", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT", type: "search" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT", type: "checkbox" } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
