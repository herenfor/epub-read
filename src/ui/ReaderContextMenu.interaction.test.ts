import { createElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReaderContextMenu, type ReaderHighlightMenu } from "./ReaderContextMenu";
import type { HighlightTarget } from "./highlightModel";
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

  describe("highlight actions", () => {
    const setup = (target: HighlightTarget | null, custom: string | null = null) => {
      const dom = createReactDomHarness();
      const highlight: ReaderHighlightMenu = {
        target, preferences: { style: "underline", color: "blue", custom },
        onHighlight: vi.fn(), onRestyle: vi.fn(), onSetCustomColor: vi.fn(), onEditNote: vi.fn(), onDelete: vi.fn(),
      };
      const onClose = vi.fn();
      const render = () => dom.render(createElement(ReaderContextMenu, {
        selection: { text: "原文片段" }, position: { x: 50, y: 50 }, onClose, onAddNote: () => undefined, highlight,
      }));
      const button = (label: string) => [...dom.container.querySelectorAll("button")]
        .find((item) => item.textContent === label || item.getAttribute("aria-label") === label)!;
      return { dom, highlight, onClose, render, button };
    };

    it("highlights in one tap with the last choice and offers colors and styles behind the chevron", async () => {
      const t = setup(null);
      try {
        await t.render();
        await t.dom.click(t.button("高亮"));
        expect(t.highlight.onHighlight).toHaveBeenLastCalledWith("underline", "blue");
        await t.dom.click(t.button("选择颜色和样式"));
        await t.dom.click(t.button("绿色"));
        expect(t.highlight.onHighlight).toHaveBeenLastCalledWith("underline", "green");
        await t.dom.click(t.button("波浪线"));
        expect(t.highlight.onHighlight).toHaveBeenLastCalledWith("squiggly", "blue");
        expect(t.button("添加笔记")).toBeTruthy();
      } finally { await t.dom.dispose(); }
    });

    it("on a highlight restyles in place, labels the note action and deletes in one step", async () => {
      const t = setup({ id: "n", content: "", style: undefined, color: undefined });
      try {
        await t.render();
        expect(t.button("添加笔记")).toBeTruthy();
        await t.dom.click(t.button("红色"));
        expect(t.highlight.onRestyle).toHaveBeenLastCalledWith(expect.objectContaining({ id: "n" }), { color: "red", style: "highlight" });
        await t.dom.click(t.button("下划线"));
        expect(t.highlight.onRestyle).toHaveBeenLastCalledWith(expect.objectContaining({ id: "n" }), { style: "underline" });
        expect(t.onClose).not.toHaveBeenCalled();
        await t.dom.click(t.button("删除"));
        expect(t.highlight.onDelete).toHaveBeenCalledOnce();
      } finally { await t.dom.dispose(); }
      const withNote = setup({ id: "m", content: "写过", style: "highlight", color: "green" });
      try {
        await withNote.render();
        expect(withNote.button("编辑笔记")).toBeTruthy();
        expect(withNote.button("绿色").getAttribute("aria-checked")).toBe("true");
      } finally { await withNote.dom.dispose(); }
    });

    it("sets the empty custom slot through the panel and resets a filled one by right click", async () => {
      const t = setup(null);
      try {
        await t.render();
        await t.dom.click(t.button("选择颜色和样式"));
        await t.dom.click(t.button("设置自定义颜色"));
        const input = t.dom.container.querySelector("input")!;
        expect(input.value).toBe("#d9691f");
        await t.dom.click(t.button("使用"));
        expect(t.highlight.onSetCustomColor).toHaveBeenCalledWith("#d9691f");
        expect(t.highlight.onHighlight).toHaveBeenLastCalledWith("underline", "#d9691f");
      } finally { await t.dom.dispose(); }
      const filled = setup({ id: "n", content: "", style: "highlight", color: "#14a3a3" }, "#14a3a3");
      try {
        await filled.render();
        const slot = filled.button("自定义颜色（长按或右键重设）");
        expect(slot.getAttribute("aria-checked")).toBe("true");
        await filled.dom.click(slot);
        expect(filled.highlight.onRestyle).toHaveBeenLastCalledWith(expect.objectContaining({ id: "n" }), { color: "#14a3a3", style: "highlight" });
        await filled.dom.dispatch(slot, new (filled.dom.window as unknown as typeof globalThis).Event("contextmenu", { bubbles: true, cancelable: true }));
        expect(filled.dom.container.querySelector("input")?.value).toBe("#14a3a3");
        await filled.dom.click(filled.button("取消"));
        expect(filled.dom.container.querySelector("input")).toBeNull();
      } finally { await filled.dom.dispose(); }
    });
  });
});
