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

  it("keeps App on one foreground source of truth", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toContain('useState<ReaderForeground>({ kind: "none" })');
    expect(app).toContain("openReaderPanel(current, panel)");
    for (const legacySetter of [
      "setTocOpen", "setMenuOpen", "setBookmarkMenuOpen", "setSearchOpen",
      "setNotesOpen(", "setLogOpen(", "setFootnote(", "setSelectionContext(", "setNoteComposer(",
    ]) {
      expect(app).not.toContain(legacySetter);
    }
  });

  it("uses an application-wide backdrop while the note composer owns the foreground", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.note-composer-backdrop\s*\{[^}]*position:\s*fixed;/s);
  });
});
