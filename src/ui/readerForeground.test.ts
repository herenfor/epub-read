import { describe, expect, it } from "vitest";
import {
  closeReaderForeground,
  openNoteComposer,
  openReaderPanel,
  openReaderTransient,
  setMenuSubview,
  type ReaderForeground,
} from "./readerForeground";

const none: ReaderForeground = { kind: "none" };
const selection = {
  selectedText: "selected",
  rect: { left: 1, top: 2, right: 20, bottom: 30 },
  chapterPath: "chapter.xhtml",
  spineIndex: 0,
  startTextOffset: 0,
  endTextOffset: 8,
  startTextSnippet: "selected",
  endTextSnippet: "selected",
};
const footnote = {
  text: "note",
  rect: { left: 1, top: 2, right: 20, bottom: 30 },
  pinned: false,
};

describe("reader foreground transitions", () => {
  it("keeps ordinary panels strictly mutually exclusive", () => {
    const search = openReaderPanel(openReaderPanel(none, "toc"), "search");
    expect(search).toEqual({ kind: "panel", panel: "search" });
    expect(openReaderPanel(search, "bookmarks")).toEqual({ kind: "panel", panel: "bookmarks" });
    expect(openReaderPanel(search, "assistant")).toEqual({ kind: "panel", panel: "assistant" });
  });

  it("models fonts as the menu subview", () => {
    const menu = openReaderPanel(none, "menu");
    expect(setMenuSubview(menu, "fonts")).toEqual({ kind: "panel", panel: "menu", view: "fonts" });
  });

  it("replaces panels when a transient appears and keeps transients exclusive", () => {
    const selected = openReaderTransient(openReaderPanel(none, "notes"), "selection", selection);
    expect(selected.kind).toBe("transient");
    expect(openReaderTransient(selected, "footnote", footnote)).toEqual({
      kind: "transient", transient: "footnote", payload: footnote,
    });
  });

  it("gives the note composer modal ownership and rejects background opens", () => {
    const modal = openNoteComposer(none, { mode: "create", selection, spineIndex: 0 });
    expect(openReaderPanel(modal, "search")).toBe(modal);
    expect(openReaderTransient(modal, "footnote", footnote)).toBe(modal);
    expect(setMenuSubview(modal, "fonts")).toBe(modal);
    expect(closeReaderForeground()).toEqual({ kind: "none" });
  });
});
