import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CUSTOM_THEMES, customThemeKey } from "../config/customThemes";
import type { Theme } from "../render/settings";
import { createReactDomHarness } from "../test/reactDomHarness";
import { readCustomThemes, useCustomThemes, type CustomThemeControls } from "./useCustomThemes";

describe("custom theme store", () => {
  const memory = new Map<string, string>();
  beforeEach(() => {
    memory.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => { memory.set(key, value); },
        removeItem: (key: string) => { memory.delete(key); },
      },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function mount(initial: Theme) {
    const dom = createReactDomHarness();
    const changes: Array<[Theme, { animate?: boolean } | undefined]> = [];
    const box: { controls: CustomThemeControls | null; theme: Theme } = { controls: null, theme: initial };
    function Host() {
      const [theme, setTheme] = useState<Theme>(initial);
      box.theme = theme;
      box.controls = useCustomThemes(theme, (next, options) => { changes.push([next, options]); setTheme(next); }, (n) => `我的主题 ${n}`);
      return null;
    }
    await dom.render(createElement(Host));
    return { dom, changes, box };
  }

  it("creates from the colors on screen, stops at the limit and survives a reload", async () => {
    const { dom, changes, box } = await mount("sepia");
    try {
      let id: string | null = null;
      await dom.run(() => { id = box.controls!.create(); });
      expect(id).not.toBeNull();
      const created = box.controls!.themes[0];
      expect(created).toMatchObject({ name: "我的主题 1", background: "#f4ecd8", foreground: "#3b2f1e", accent: "#8a5a2b" });
      expect(changes.at(-1)).toEqual([customThemeKey(created), { animate: false }]);
      expect(box.controls!.activeId).toBe(created.id);
      for (let i = 1; i < MAX_CUSTOM_THEMES; i++) await dom.run(() => { box.controls!.create(); });
      expect(box.controls!.themes).toHaveLength(MAX_CUSTOM_THEMES);
      expect(box.controls!.canCreate).toBe(false);
      await dom.run(() => { id = box.controls!.create(); });
      expect(id).toBeNull();
      expect(readCustomThemes().themes).toHaveLength(MAX_CUSTOM_THEMES);
    } finally {
      await dom.dispose();
    }
  });

  it("applies edits of the theme on screen without the transition, and falls back when it is deleted", async () => {
    const { dom, changes, box } = await mount("dark");
    try {
      await dom.run(() => { box.controls!.create(); });
      const id = box.controls!.activeId!;
      await dom.run(() => { box.controls!.setColors(id, { background: "#141b26", foreground: "#a9b8c9", accent: "#6ea8dc" }); });
      expect(box.theme).toBe("c:141b26a9b8c96ea8dc");
      expect(changes.at(-1)?.[1]).toEqual({ animate: false });
      await dom.run(() => { box.controls!.rename(id, "夜读 "); });
      expect(box.controls!.themes[0].name).toBe("夜读 ");
      await dom.run(() => { box.controls!.remove(id); });
      expect(box.controls!.themes).toHaveLength(0);
      expect(box.theme).toBe("dark");
    } finally {
      await dom.dispose();
    }
  });
});
