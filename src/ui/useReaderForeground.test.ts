import { createElement, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FootnotePayload, SelectionContextPayload } from "../render/paginator";
import { createReactDomHarness } from "../test/reactDomHarness";
import type { ReaderForeground } from "./readerForeground";
import {
  readerForegroundSurfaces,
  useReaderForeground,
  useReaderForegroundState,
  useReaderSidebar,
} from "./useReaderForeground";

type Commands = ReturnType<typeof useReaderForeground>;
type Sidebar = ReturnType<typeof useReaderSidebar>;
type Reader = { dismissFootnote(): void; clearTextSelection(): void };
type Api = {
  foreground: ReaderForeground;
  commands: Commands;
  sidebar: Sidebar;
  surfaces: ReturnType<typeof readerForegroundSurfaces>;
};

const selection: SelectionContextPayload = {
  selectedText: "selected", rect: { left: 1, top: 2, right: 20, bottom: 30 },
  chapterPath: "chapter.xhtml", startTextOffset: 0, endTextOffset: 8,
  startTextSnippet: "selected", endTextSnippet: "selected",
};
const footnote: FootnotePayload = { text: "note", rect: selection.rect, pinned: true };

type Options = { bookKey: string; phone: boolean; mobile: boolean; view: "shelf" | "reader"; unrelated: number };
function setup() {
  const dom = createReactDomHarness();
  const calls: string[] = [];
  const overlayHoverRef = { current: false };
  const dirty = { current: false };
  const readerRef: { current: Reader | null } = { current: null };
  let api!: Api;
  function Host(props: Options) {
    const [foreground, setForeground] = useReaderForegroundState();
    const foregroundRef = useRef<ReaderForeground>({ kind: "none" });
    foregroundRef.current = foreground;
    const commands = useReaderForeground({
      foregroundRef, setForeground, overlayHoverRef,
      reader: () => readerRef.current,
      beforeOpenComposer: () => { calls.push("lease"); },
      noteComposerDirtyRef: dirty,
    });
    const sidebar = useReaderSidebar({
      foreground, foregroundRef, setForeground, view: props.view,
      phoneChrome: props.phone, mobileChrome: props.mobile, sidebarBookKey: props.bookKey,
      openPanel: commands.openPanel, closeForeground: commands.closeForeground,
      requestCloseForeground: commands.requestCloseForeground,
    });
    api = { foreground, commands, sidebar, surfaces: readerForegroundSurfaces(foreground) };
    return createElement("div", { "data-kind": foreground.kind }, props.unrelated);
  }
  let options: Options = { bookKey: "book-a", phone: false, mobile: false, view: "reader", unrelated: 0 };
  return {
    dom, calls, overlayHoverRef, dirty, readerRef, current: () => api,
    async render(patch: Partial<Options> = {}) {
      options = { ...options, ...patch };
      await dom.render(createElement(Host, options));
    },
  };
}

describe("reader foreground host extraction", () => {
  it("uses retained commands with the live reader and preserves lease/cleanup ordering", async () => {
    const t = setup();
    try {
      await t.render();
      const retained = t.current().commands;
      t.readerRef.current = {
        dismissFootnote: () => {
          expect(t.overlayHoverRef.current).toBe(false);
          t.calls.push("dismiss");
        },
        clearTextSelection: () => { t.calls.push("clear"); },
      };
      await t.dom.run(() => retained.openTransient("footnote", footnote));
      expect(t.current().surfaces.footnote).toBe(footnote);
      t.overlayHoverRef.current = true;
      await t.dom.run(() => retained.openTransient("selection", selection));
      expect(t.calls).toEqual(["dismiss"]);
      await t.dom.run(() => retained.openPanel("search"));
      expect(t.calls).toEqual(["dismiss", "clear"]);
      expect(t.current().surfaces.selectionContext).toBeNull();
      await t.dom.run(() => retained.openTransient("footnote", footnote));
      t.overlayHoverRef.current = true;
      await t.dom.run(() => retained.openComposer({ mode: "create", selection, spineIndex: 0 }));
      expect(t.calls.slice(-2)).toEqual(["lease", "dismiss"]);
      expect(t.current().surfaces.noteComposer?.mode).toBe("create");
      await t.render({ unrelated: 1 });
      for (const key of Object.keys(retained) as Array<keyof Commands>) {
        expect(t.current().commands[key]).toBe(retained[key]);
      }
    } finally { await t.dom.dispose(); }
  });

  it("keeps queued modal ownership, dirty confirmation and Aa sub-page back behavior", async () => {
    const t = setup();
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
    try {
      await t.render();
      await t.dom.run(() => {
        t.current().commands.openComposer({ mode: "create", selection, spineIndex: 0 });
        t.current().commands.openPanel("search");
        t.current().commands.showMenuSubview("fonts");
      });
      expect(t.current().foreground.kind).toBe("modal");
      t.dirty.current = true;
      await t.dom.run(() => t.current().sidebar.requestCloseCurrentSurface());
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(t.current().foreground.kind).toBe("modal");
      confirm.mockReturnValue(true);
      await t.dom.run(() => t.current().sidebar.requestCloseCurrentSurface());
      expect(t.current().foreground.kind).toBe("none");

      await t.dom.run(() => t.current().commands.showMenuSubview("extras"));
      await t.dom.run(() => t.current().sidebar.requestCloseCurrentSurface());
      expect(t.current().foreground).toEqual({ kind: "panel", panel: "menu", view: "main" });
      await t.dom.run(() => t.current().sidebar.requestCloseCurrentSurface());
      expect(t.current().foreground.kind).toBe("none");
      expect(confirm).toHaveBeenCalledTimes(2);
      await t.dom.run(() => {
        t.current().commands.openPanel("search");
        t.current().commands.openPanel("toc");
        t.current().commands.closePanel("search");
      });
      expect(t.current().foreground).toEqual({ kind: "panel", panel: "toc" });
    } finally { await t.dom.dispose(); }
  });

  it("preserves docking across resize and keeps independent per-book tab memories", async () => {
    const t = setup();
    try {
      await t.render();
      const memoryA = t.current().sidebar.sidebarNavigationMemory;
      memoryA.scrollTop.toc = 120;
      memoryA.scrollTop.bookmarks = 40;
      await t.dom.run(() => t.current().sidebar.handleToggleSidebar());
      await t.dom.run(() => t.current().sidebar.handleSidebarTabChange("notes"));
      expect(t.current().sidebar.activeSidebarTab).toBe("notes");
      await t.dom.run(() => t.current().sidebar.handleSidebarModeChange("docked"));
      expect(t.current().foreground.kind).toBe("none");
      expect(t.current().sidebar.isDockedSidebar).toBe(true);
      await t.dom.run(() => t.current().sidebar.handleOpenBookmarks());
      expect(t.current().sidebar.sidebarSide).toBe("right");
      expect(t.current().sidebar.activeSidebarTab).toBe("bookmarks");
      await t.render({ phone: true, mobile: true });
      expect(t.current().sidebar.effectiveSidebarMode).toBe("overlay");
      expect(t.current().sidebar.isSidebarOpen).toBe(false);
      await t.dom.run(() => t.current().sidebar.handleToggleSidebar("right"));
      await t.dom.run(() => t.current().sidebar.requestCloseCurrentSurface());
      expect(t.current().sidebar.isSidebarOpen).toBe(false);
      await t.render({ phone: false, mobile: false });
      expect(t.current().sidebar.isDockedSidebar).toBe(true);

      await t.render({ bookKey: "book-b" });
      expect(t.current().sidebar.sidebarNavigationMemory).not.toBe(memoryA);
      expect(t.current().sidebar.sidebarNavigationMemory.scrollTop).toEqual({});
      await t.render({ bookKey: "book-a" });
      expect(t.current().sidebar.sidebarNavigationMemory).toBe(memoryA);
      expect(memoryA.scrollTop).toEqual({ toc: 120, bookmarks: 40 });
      await t.dom.run(() => t.current().commands.openPanel("search"));
      expect(t.current().sidebar.isDockedSearch).toBe(true);
      await t.render({ mobile: true });
      expect(t.current().sidebar.isDockedSearch).toBe(false);
      await t.render({ view: "shelf" });
      expect(t.current().sidebar.isSidebarOpen).toBe(false);
    } finally { await t.dom.dispose(); }
  });
});
