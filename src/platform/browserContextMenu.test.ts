import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { ChapterPaginator } from "../render/paginator";
import { installBrowserContextMenuPolicy } from "./browserContextMenu";

describe("native context menu whitelist", () => {
  it("allows editing menus while custom menus still receive their events", () => {
    const { document: doc, window: win } = parseHTML(`<html><body>
      <input id="text"><input id="search" type="search"><input id="disabled" disabled>
      <input id="range" type="range"><input id="color" type="color">
      <textarea id="css"></textarea><div contenteditable="true"><span id="edit">text</span>
      <span id="locked" contenteditable="false">locked</span></div>
      <button id="book">book</button><div id="blank"></div>
    </body></html>`);
    const uninstall = installBrowserContextMenuPolicy(doc);
    let opened = 0;
    doc.getElementById("book")!.addEventListener("contextmenu", () => { opened++; });
    const dispatch = (id: string) => {
      const event = new win.Event("contextmenu", { bubbles: true, cancelable: true });
      doc.getElementById(id)!.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      for (const id of ["text", "search", "css", "edit"]) expect(dispatch(id), id).toBe(false);
      for (const id of ["disabled", "range", "color", "locked", "book", "blank"]) expect(dispatch(id), id).toBe(true);
      expect(opened).toBe(1);
      uninstall();
      expect(dispatch("blank")).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("also blocks the browser menu on iframe whitespace outside the text viewer", () => {
    const { document: doc, window: win } = parseHTML('<html><body><div id="epub-viewer"></div></body></html>');
    const paginator = { contentDoc: doc, viewer: doc.getElementById("epub-viewer") };
    const handle = (ChapterPaginator.prototype as unknown as { handleContextMenu(event: MouseEvent): void }).handleContextMenu;
    doc.addEventListener("contextmenu", (event) => handle.call(paginator, event as MouseEvent));
    const event = new win.Event("contextmenu", { bubbles: true, cancelable: true });
    doc.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
