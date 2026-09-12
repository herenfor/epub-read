import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { ReaderContextMenu } from "./ReaderContextMenu";
import { createReactDomHarness } from "../test/reactDomHarness";

describe("selection menu handoff", () => {
  it("closes the selection menu before opening the note composer in one React batch", async () => {
    const dom = createReactDomHarness();
    function ReaderSurfaces() {
      const [surface, setSurface] = useState("selection");
      return surface === "selection"
        ? createElement(ReaderContextMenu, {
            selection: { text: "原文片段" }, position: { x: 50, y: 50 },
            onClose: () => setSurface("none"),
            onAddNote: () => setSurface("composer"),
          })
        : createElement("div", { role: "status" }, surface);
    }
    try {
      await dom.render(createElement(ReaderSurfaces));
      await dom.click(dom.container.querySelectorAll("button")[1]);
      expect(dom.container.textContent).toBe("composer");
    } finally { await dom.dispose(); }
  });
});
