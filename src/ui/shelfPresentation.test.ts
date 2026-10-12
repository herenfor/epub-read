import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization } from "./libraryOrganization";
import type { ShelfEntry } from "./shelf";
import { ShelfView, type ShelfViewProps } from "./ShelfView";

function book(id: string, overrides: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    id, title: `书${id}`, creator: "作者", fileName: `${id}.epub`, fileSize: 1024, coverMime: "image/jpeg",
    addedAtMs: 1, lastReadAtMs: 0, spineIndex: 0, page: 0, progressPct: 0,
    anchorIndex: null, anchorRatio: null, contentHash: id.repeat(8), isNew: false,
    ...overrides,
  };
}

async function mount(entries: ShelfEntry[]) {
  const dom = createReactDomHarness();
  const props: ShelfViewProps = {
    entries,
    organization: emptyOrganization(),
    busy: false,
    theme: "light",
    onThemeChange: () => {},
    onOpen: vi.fn(),
    onImport: () => {},
    onImportArchive: () => {},
    onExportArchive: () => {},
    onDelete: () => {},
    onDeleteMany: () => {},
    onApplyOrganization: async () => {},
  };
  await dom.render(createElement(ShelfView, props));
  const root = dom.container;
  return {
    dom,
    card: (id: string) => root.querySelector(`[data-book-id="${id}"]`) as HTMLElement | null,
    tab: (index: number) => root.querySelectorAll(".shelf-capsule-tab")[index] as HTMLElement,
    empty: () => root.querySelector(".shelf-empty"),
    emptyButtons: () => [...root.querySelectorAll(".shelf-empty-actions button")] as HTMLElement[],
  };
}

describe("shelf presentation", () => {
  it("card badge and status line follow the same reading status as the filters", async () => {
    const recent = Date.now();
    const shelf = await mount([
      book("done", { progressPct: 100, lastReadAtMs: recent, spineIndex: 9 }),
      book("half", { progressPct: 40, lastReadAtMs: recent, spineIndex: 3 }),
      // Opened (not new) but no progress yet: the filters call it unread.
      book("zero", { lastReadAtMs: recent }),
    ]);
    try {
      const badge = (id: string) => shelf.card(id)?.querySelector(".shelf-badge.reading") ?? null;
      const stat = (id: string) => shelf.card(id)?.querySelector(".shelf-read-stat");
      expect(badge("done")).toBeNull();
      expect(stat("done")?.textContent).toMatch(/^100%/);
      expect(badge("half")).not.toBeNull();
      expect(stat("half")?.textContent).toMatch(/^40%/);
      expect(badge("zero")).toBeNull();
      expect(stat("zero")?.classList.contains("unread")).toBe(true);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("a status filter with no match names the filter and clears it back to the full list", async () => {
    const shelf = await mount([book("a"), book("b")]);
    try {
      // Tabs: all, reading, unread, finished, favorites. Nothing is finished.
      await shelf.dom.click(shelf.tab(3));
      expect(shelf.card("a")).toBeNull();
      expect(shelf.empty()).not.toBeNull();
      const buttons = shelf.emptyButtons();
      // No query is active, so only the filter has a way back.
      expect(buttons).toHaveLength(1);
      await shelf.dom.click(buttons[0]);
      expect(shelf.empty()).toBeNull();
      expect(shelf.card("a")).not.toBeNull();
      expect(shelf.tab(0).classList.contains("active")).toBe(true);
    } finally {
      await shelf.dom.dispose();
    }
  });
});
