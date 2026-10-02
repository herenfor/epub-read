import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyOrganization } from "./libraryOrganization";
import { chooseShelfMenuPlacement, ShelfView, type ShelfViewProps } from "./ShelfView";
import type { ShelfEntry } from "./shelf";
import { createReactDomHarness } from "../test/reactDomHarness";

function makeEntry(id: string, title: string): ShelfEntry {
  return {
    id,
    title,
    creator: "作者",
    fileName: `${title}.epub`,
    fileSize: 1024,
    coverMime: "image/jpeg",
    addedAtMs: 1000,
    lastReadAtMs: 0,
    spineIndex: 0,
    page: 0,
    progressPct: 0,
    anchorIndex: null,
    anchorRatio: null,
    contentHash: id.repeat(4),
    isNew: false,
  };
}

function makeProps(entries: ShelfEntry[]): ShelfViewProps {
  return {
    entries,
    organization: emptyOrganization(),
    busy: false,
    theme: "light",
    onThemeChange: () => {},
    onOpen: () => {},
    onImport: () => {},
    onImportArchive: () => {},
    onExportArchive: () => {},
    onDelete: () => {},
    onDeleteMany: () => {},
  };
}

function pointerEvent(win: Window, type: string, init: PointerEventInit): Event {
  const WindowEvent = (win as unknown as { Event: typeof Event }).Event;
  const event = new WindowEvent(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

describe("第三步补修：书架触摸长按与子菜单 Back", () => {
  it("列表操作菜单在底部空间不足时向上翻转", () => {
    expect(chooseShelfMenuPlacement({ top: 700, bottom: 750 }, 832, 127)).toBe("up");
    expect(chooseShelfMenuPlacement({ top: 300, bottom: 350 }, 832, 127)).toBe("down");
  });

  it("触摸长按进入现有选择模式，不启动拖拽或开书", async () => {
    const dom = createReactDomHarness();
    const opened = vi.fn();
    const props = { ...makeProps([makeEntry("b1", "第一本"), makeEntry("b2", "第二本")]), onOpen: opened };
    try {
      await dom.render(createElement(ShelfView, props));
      const card = dom.container.querySelector(".shelf-card") as HTMLElement;
      expect(card).not.toBeNull();
      const win = card.ownerDocument.defaultView as Window;
      await dom.run(() => {
        card.dispatchEvent(pointerEvent(win, "pointerdown", {
          button: 0,
          clientX: 100,
          clientY: 100,
          pointerType: "touch",
        }));
      });
      await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, 550)));
      expect(dom.container.querySelector(".shelf-view")?.classList.contains("selection-mode")).toBe(true);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      await dom.dispose();
    }
  });

  it("最高层书卡菜单先被同一个书架 Back 协调者关闭", async () => {
    const dom = createReactDomHarness();
    const backHandlers: Array<(() => boolean) | null> = [];
    const availability: boolean[] = [];
    const props = {
      ...makeProps([makeEntry("b1", "第一本")]),
      registerBackHandler: (handler: (() => boolean) | null) => { backHandlers.push(handler); },
      onBackAvailabilityChange: (active: boolean) => { availability.push(active); },
    };
    try {
      await dom.render(createElement(ShelfView, props));
      const more = dom.container.querySelector(".shelf-card-more-btn") as HTMLElement;
      expect(more).not.toBeNull();
      await dom.click(more);
      await dom.run(() => {});
      expect(availability.at(-1)).toBe(true);
      const handler = backHandlers.at(-1);
      expect(handler).toBeTypeOf("function");
      let consumed = false;
      await dom.run(() => { consumed = handler?.() === true; });
      expect(consumed).toBe(true);
      const menu = dom.container.querySelector(".shelf-card-pop-menu");
      expect(menu).not.toBeNull();
      expect(menu?.className).toContain("is-closing");
    } finally {
      await dom.dispose();
    }
  });
});
