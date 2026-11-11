import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderContextMenu, type ReaderHighlightMenu } from "./ReaderContextMenu";
import type { HighlightTarget } from "./highlightModel";
import { TIP_HOVER_MS, TIP_LINGER_MS, TIP_PRESS_MS } from "./useMenuTip";
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
    const labels = () => [...dom.container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    try {
      await dom.render(menu("同一段话", "同一段话"));
      expect(labels()).not.toContain("复制原文");
      await dom.render(menu("没有原文"));
      expect(labels()).not.toContain("复制原文");
      await dom.render(menu("轉換後的文字", "转换后的文字"));
      expect(labels()).toContain("复制原文");
    } finally { await dom.dispose(); }
  });

  it("offers web search only when wired, closes the menu and passes the selected text", async () => {
    const dom = createReactDomHarness();
    const onWebSearch = vi.fn();
    const onClose = vi.fn();
    const menu = (search: boolean) => createElement(ReaderContextMenu, {
      selection: { text: "量子纠缠" }, position: { x: 50, y: 50 }, onClose, onAddNote: () => undefined,
      ...(search ? { onWebSearch } : {}),
    });
    const button = () => [...dom.container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "网页搜索");
    try {
      await dom.render(menu(false));
      expect(button()).toBeUndefined();
      await dom.render(menu(true));
      await dom.click(button()!);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onWebSearch).toHaveBeenCalledExactlyOnceWith("量子纠缠");
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
        await t.dom.click(t.button("删除高亮"));
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

    it("offers sharing in every state and passes the highlight it sits on", async () => {
      const onShare = vi.fn();
      const plain = createReactDomHarness();
      const labels = () => [...plain.container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
      try {
        await plain.render(createElement(ReaderContextMenu, {
          selection: { text: "原文片段" }, position: { x: 50, y: 50 }, onClose: () => undefined, onAddNote: () => undefined,
        }));
        expect(labels()).not.toContain("分享");
        await plain.render(createElement(ReaderContextMenu, {
          selection: { text: "原文片段" }, position: { x: 50, y: 50 }, onClose: () => undefined, onAddNote: () => undefined, onShare,
        }));
        expect(labels()).toContain("分享");
      } finally { await plain.dispose(); }

      const target = { id: "n", content: "笔记", style: "underline" as const, color: "green" as const };
      const t = setup(target);
      try {
        await t.dom.render(createElement(ReaderContextMenu, {
          selection: { text: "原文片段" }, position: { x: 50, y: 50 }, onClose: t.onClose, onAddNote: () => undefined, highlight: t.highlight, onShare,
        }));
        await t.dom.click(t.button("分享"));
        expect(t.onClose).toHaveBeenCalled();
        expect(onShare).toHaveBeenLastCalledWith(expect.objectContaining({ text: "原文片段" }), target);
      } finally { await t.dom.dispose(); }
    });
  });

  describe("icon buttons and their descriptions (ER-0166)", () => {
    afterEach(() => { vi.useRealTimers(); });

    const open = async (target: HighlightTarget | null = null) => {
      vi.useFakeTimers();
      const dom = createReactDomHarness();
      const onCopy = vi.fn();
      const highlight: ReaderHighlightMenu = {
        target, preferences: { style: "highlight", color: "yellow", custom: null },
        onHighlight: vi.fn(), onRestyle: vi.fn(), onSetCustomColor: vi.fn(), onEditNote: vi.fn(), onDelete: vi.fn(),
      };
      await dom.render(createElement(ReaderContextMenu, {
        selection: { text: "轉換後", originalText: "转换后" }, position: { x: 50, y: 50 },
        onClose: () => undefined, onAddNote: () => undefined, onCopy, onCopyOriginal: () => undefined, onShare: () => undefined, highlight,
      }));
      const button = (label: string) => [...dom.container.querySelectorAll("button")]
        .find((item) => item.getAttribute("aria-label") === label)!;
      const pointer = (label: string, type: string, pointerType: "mouse" | "touch") =>
        dom.dispatch(button(label), Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerType }));
      const wait = (ms: number) => dom.run(() => { vi.advanceTimersByTime(ms); });
      const tip = () => dom.container.querySelector(".sm-tip")?.textContent ?? null;
      return { dom, onCopy, highlight, button, pointer, wait, tip };
    };

    it("names every action by icon alone, so the menu is as wide in any language", async () => {
      const t = await open({ id: "n", content: "写过", style: "underline", color: "green" });
      try {
        const buttons = [...t.dom.container.querySelectorAll("button")];
        expect(buttons.map((item) => item.getAttribute("aria-label"))).toEqual([
          "红色", "黄色", "绿色", "蓝色", "紫色", "设置自定义颜色",
          "底色", "下划线", "波浪线",
          "编辑笔记", "复制", "复制原文", "分享", "删除高亮",
        ]);
        // No words on any button: only the empty custom slot's plus and the style letters.
        expect(buttons.map((item) => item.textContent).join("")).toBe("+AAA");
        expect(buttons.every((item) => !item.hasAttribute("title"))).toBe(true);
        expect(t.button("下划线").getAttribute("aria-checked")).toBe("true");
      } finally { await t.dom.dispose(); }
    });

    it("describes a button the mouse rests on, and the next one at once", async () => {
      const t = await open();
      try {
        await t.pointer("复制", "pointerover", "mouse");
        await t.wait(TIP_HOVER_MS - 50);
        expect(t.tip()).toBeNull();
        await t.wait(50);
        expect(t.tip()).toBe("复制");
        await t.pointer("复制", "pointerout", "mouse");
        expect(t.tip()).toBeNull();
        await t.pointer("复制原文", "pointerover", "mouse");
        expect(t.tip()).toBe("复制原文");
        await t.pointer("复制原文", "pointerdown", "mouse");
        expect(t.tip()).toBeNull();
        await t.dom.click(t.button("复制"));
        expect(t.onCopy).toHaveBeenCalledWith("轉換後");
      } finally { await t.dom.dispose(); }
    });

    it("describes a button under a held finger without running it; a tap still runs it", async () => {
      const t = await open();
      try {
        await t.pointer("复制", "pointerdown", "touch");
        await t.wait(TIP_PRESS_MS);
        expect(t.tip()).toBe("复制");
        await t.pointer("复制", "pointerup", "touch");
        // Lifting the finger moves the focus here; the button that had it must not clear this description.
        await t.pointer("分享", "focusout", "touch");
        expect(t.tip()).toBe("复制");
        await t.dom.click(t.button("复制"));
        expect(t.onCopy).not.toHaveBeenCalled();
        await t.wait(TIP_LINGER_MS);
        expect(t.tip()).toBeNull();

        await t.pointer("复制", "pointerdown", "touch");
        await t.wait(TIP_PRESS_MS - 100);
        await t.pointer("复制", "pointerup", "touch");
        await t.dom.click(t.button("复制"));
        expect(t.tip()).toBeNull();
        expect(t.onCopy).toHaveBeenCalledOnce();
      } finally { await t.dom.dispose(); }
    });
  });
});
