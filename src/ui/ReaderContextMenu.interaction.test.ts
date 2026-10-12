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

  it("offers copying the original only when the shown text differs from it", async () => {
    const dom = createReactDomHarness();
    const menu = (text: string, originalText?: string) => createElement(ReaderContextMenu, {
      selection: { text, originalText }, position: { x: 50, y: 50 },
      onClose: () => undefined, onAddNote: () => undefined, onCopyOriginal: () => undefined,
    });
    const labels = () => [...dom.container.querySelectorAll("button")].map((button) => button.textContent);
    try {
      await dom.render(menu("同一段话", "同一段话"));
      expect(labels()).not.toContain("复制原文");
      await dom.render(menu("没有原文"));
      expect(labels()).not.toContain("复制原文");
      await dom.render(menu("轉換後的文字", "转换后的文字"));
      expect(labels()).toContain("复制原文");
    } finally { await dom.dispose(); }
  });
});
