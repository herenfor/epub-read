import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyOrganization } from "./libraryOrganization";
import { ShelfView, type ShelfViewProps } from "./ShelfView";
import type { ShelfEntry } from "./shelf";
import { createReactDomHarness } from "../test/reactDomHarness";
import { MENU_CLOSE_MS } from "./menuMotion";

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
    onApplyOrganization: async () => {},
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
  it("文件夹范围先回到书架根层，菜单和选择模式仍先消费 Back", async () => {
    const dom = createReactDomHarness();
    let back: (() => boolean) | null = null;
    const availability: boolean[] = [];
    const organization = {
      ...emptyOrganization(),
      folders: { f1: { name: { value: "测试文件夹", stamp: { counter: 1, deviceId: "test" } } } },
    };
    try {
      await dom.render(createElement(ShelfView, {
        ...makeProps([makeEntry("b1", "第一本")]),
        organization,
        registerBackHandler: (handler: (() => boolean) | null) => { back = handler; },
        onBackAvailabilityChange: (active: boolean) => { availability.push(active); },
      }));
      await dom.click(dom.container.querySelector(".shelf-folder-dropdown-btn") as HTMLElement);
      const folder = [...dom.container.querySelectorAll(".shelf-folder-menu-item")]
        .find((item) => item.textContent?.includes("测试文件夹")) as HTMLElement;
      await dom.click(folder);
      expect(dom.container.querySelector(".shelf-folder-active-bar")).not.toBeNull();
      expect(availability.at(-1)).toBe(true);
      await dom.click(dom.container.querySelector(".shelf-manage-toggle-btn") as HTMLElement);
      await dom.run(() => { expect(back?.()).toBe(true); });
      await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, MENU_CLOSE_MS + 20)));
      expect(dom.container.querySelector(".shelf-view.selection-mode")).toBeNull();
      expect(dom.container.querySelector(".shelf-folder-active-bar")).not.toBeNull();
      await dom.run(() => { expect(back?.()).toBe(true); });
      expect(dom.container.querySelector(".shelf-folder-active-bar")).toBeNull();
      expect(availability.at(-1)).toBe(false);
      await dom.run(() => { expect(back?.()).toBe(false); });
    } finally {
      await dom.dispose();
    }
  });

  it("触屏设置页：Back 先回到设置首页，再次 Back 才关闭设置", async () => {
    const dom = createReactDomHarness();
    let back: (() => boolean) | null = null;
    try {
      await dom.render(createElement(ShelfView, {
        ...makeProps([makeEntry("b1", "第一本")]),
        compact: true,
        touchUi: true,
        registerBackHandler: (handler: (() => boolean) | null) => { back = handler; },
      }));
      await dom.click(dom.container.querySelector('.shelf-normal-bar-mobile [aria-label="设置"]') as HTMLElement);
      const row = [...dom.container.querySelectorAll(".shelf-settings-row")]
        .find((item) => item.textContent?.includes("数据与备份")) as HTMLElement;
      await dom.click(row);
      // 设置首页一直在叠层底部，分类页压在其上；离场中的分类页不算当前页。
      const topPage = () => dom.container.querySelector(".shelf-settings-sheet.is-pushed:not(.is-leaving) h2")?.textContent;
      expect(topPage()).toBe("数据与备份");
      await dom.run(() => { expect(back?.()).toBe(true); });
      expect(topPage()).toBeUndefined();
      expect(dom.container.querySelector(".shelf-settings-sheet h2")?.textContent).toBe("设置");
      await dom.run(() => { expect(back?.()).toBe(true); });
      expect(dom.container.querySelector(".shelf-settings-layer")?.className).toContain("is-closing");
      await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, MENU_CLOSE_MS + 20)));
      expect(dom.container.querySelector(".shelf-settings-layer")).toBeNull();
      await dom.run(() => { expect(back?.()).toBe(false); });
    } finally {
      await dom.dispose();
    }
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

  it("多选状态再次触摸长按启动拖书，并在拖动中阻止页面滚动", async () => {
    const dom = createReactDomHarness();
    const props = makeProps([makeEntry("b1", "第一本"), makeEntry("b2", "第二本")]);
    try {
      await dom.render(createElement(ShelfView, props));
      const card = () => dom.container.querySelector('[data-book-id="b1"]') as HTMLElement;
      const win = card().ownerDocument.defaultView as Window;
      const longPress = async () => {
        await dom.run(() => {
          card().dispatchEvent(pointerEvent(win, "pointerdown", {
            button: 0, clientX: 100, clientY: 100, pointerType: "touch",
          }));
        });
        await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, 550)));
      };
      await longPress();
      await dom.run(() => { win.dispatchEvent(pointerEvent(win, "pointerup", { clientX: 100, clientY: 100 })); });
      expect(dom.container.querySelector(".shelf-view")?.classList.contains("selection-mode")).toBe(true);
      expect(dom.container.querySelector(".shelf-drag-ghost")).toBeNull();

      await longPress();
      expect(card().classList.contains("is-dragging")).toBe(true);
      expect(dom.container.querySelector(".shelf-drag-ghost")).not.toBeNull();
      const WindowEvent = (win as unknown as { Event: typeof Event }).Event;
      const move = new WindowEvent("touchmove", { bubbles: true, cancelable: true });
      win.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);

      await dom.run(() => { win.dispatchEvent(pointerEvent(win, "pointerup", { clientX: 100, clientY: 100 })); });
      expect(dom.container.querySelector(".shelf-drag-ghost")).toBeNull();
      expect(dom.container.querySelector(".shelf-view")?.classList.contains("selection-mode")).toBe(true);
      const idle = new WindowEvent("touchmove", { bubbles: true, cancelable: true });
      win.dispatchEvent(idle);
      expect(idle.defaultPrevented).toBe(false);
    } finally {
      await dom.dispose();
    }
  });

  it("触摸拖书时顶部浮出全部文件夹落点，松手后收起", async () => {
    const dom = createReactDomHarness();
    const organization = {
      ...emptyOrganization(),
      folders: { f1: { name: { value: "轻小说", stamp: { counter: 1, deviceId: "test" } } } },
    };
    try {
      dom.matchMedia((q) => q.includes("coarse"));
      await dom.render(createElement(ShelfView, {
        ...makeProps([makeEntry("b1", "第一本"), makeEntry("b2", "第二本")]),
        organization,
        compact: true,
      }));
      const card = () => dom.container.querySelector('[data-book-id="b1"]') as HTMLElement;
      const win = card().ownerDocument.defaultView as Window;
      const longPress = async () => {
        await dom.run(() => {
          card().dispatchEvent(pointerEvent(win, "pointerdown", {
            button: 0, clientX: 100, clientY: 100, pointerType: "touch",
          }));
        });
        await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, 550)));
      };
      await longPress();
      await dom.run(() => { win.dispatchEvent(pointerEvent(win, "pointerup", { clientX: 100, clientY: 100 })); });
      expect(dom.container.querySelector(".shelf-drag-folder-strip")).toBeNull();

      await longPress();
      const chip = dom.container.querySelector('.shelf-drag-folder-strip [data-shelf-target="folder"]');
      expect(chip?.getAttribute("data-folder-id")).toBe("f1");
      expect(chip?.textContent).toContain("轻小说");

      await dom.run(() => { win.dispatchEvent(pointerEvent(win, "pointerup", { clientX: 100, clientY: 100 })); });
      expect(dom.container.querySelector(".shelf-drag-folder-strip")).toBeNull();
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
      // 前一用例的触屏 matchMedia 可能仍在；返回协调与呈现外壳无关，两种外壳都算。
      const menu = dom.container.ownerDocument.querySelector(".shelf-action-popover, .shelf-action-sheet");
      expect(menu).not.toBeNull();
      expect(menu?.className).toContain("is-closing");
    } finally {
      await dom.dispose();
    }
  });

  it("UI-2: 移动端紧凑模式简化重复入口、提供独立搜索行、分类单下拉与目录摘要", async () => {
    const dom = createReactDomHarness();
    const organization = {
      ...emptyOrganization(),
      folders: { f1: { name: { value: "名著", stamp: { counter: 1, deviceId: "test" } } } },
    };
    try {
      await dom.render(createElement(ShelfView, {
        ...makeProps([makeEntry("b1", "爱丽丝漫游仙境")]),
        compact: true,
        organization,
      }));

      // 1. 移动端顶栏与搜索行
      expect(dom.container.querySelector(".shelf-normal-bar-mobile")).not.toBeNull();
      expect(dom.container.querySelector(".shelf-view-toggle-group")).toBeNull();
      const searchInput = dom.container.querySelector(".shelf-search-row input") as HTMLInputElement;
      expect(searchInput).not.toBeNull();
      expect(searchInput.placeholder).toBe("搜书名或作者");

      // 2. 分类单下拉替代平铺胶囊
      expect(dom.container.querySelector(".shelf-capsule-tabs")).toBeNull();
      const catBtn = dom.container.querySelector(".shelf-category-dropdown-btn") as HTMLButtonElement;
      expect(catBtn).not.toBeNull();
      expect(catBtn.textContent).toContain("全部");

      // 点击展开分类菜单
      await dom.click(catBtn);
      const catMenu = dom.container.querySelector(".shelf-category-popover-menu");
      expect(catMenu).not.toBeNull();
      const catItems = dom.container.querySelectorAll(".shelf-category-menu-item");
      expect(catItems.length).toBe(5);

      // 3. 文件夹下拉：默认排法“按文件夹”在最上，平铺的“全部书籍”其次，再列各文件夹
      const folderBtn = dom.container.querySelector(".shelf-folder-dropdown-btn") as HTMLButtonElement;
      expect(folderBtn).not.toBeNull();
      expect(folderBtn.textContent).toContain("按文件夹");
      await dom.click(folderBtn);
      const menuItems = [...dom.container.querySelectorAll(".shelf-folder-menu-item")].map((item) => item.textContent ?? "");
      expect(menuItems[0]).toContain("按文件夹");
      expect(menuItems[1]).toContain("全部书籍");
      expect(menuItems[2]).toContain("名著");
      await dom.click(folderBtn);

      // 根层默认展开文件夹卡片；收起后摘要栏仍在，可再展开
      expect(dom.container.querySelector(".shelf-folder-summary-rail.expanded")).not.toBeNull();
      expect(dom.container.querySelector(".shelf-folder-card")).not.toBeNull();
      const toggle = dom.container.querySelector(".shelf-folder-summary-toggle-btn") as HTMLButtonElement;
      await dom.click(toggle);
      expect(dom.container.querySelector(".shelf-folder-card")).toBeNull();
      expect(dom.container.querySelector(".shelf-folder-summary-rail:not(.expanded)")).not.toBeNull();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await dom.click(toggle);
      expect(dom.container.querySelector(".shelf-folder-card")).not.toBeNull();

      // 4. 外部右轨移除
      expect(dom.container.querySelector(".shelf-nav-rail-right")).toBeNull();

      // 5. 视图、排序、密度在“筛选与排序”底部面板；批量选择在触屏上用长按，设置里不再重复
      await dom.click(dom.container.querySelector(".shelf-search-row .shelf-filter-btn") as HTMLElement);
      const sheet = dom.container.querySelector(".shelf-filter-layer.is-sheet");
      expect(sheet).not.toBeNull();
      expect(sheet?.textContent).toContain("视图模式");
      expect(sheet?.textContent).toContain("排列方式");
      expect(sheet?.textContent).toContain("排布密度");
      await dom.click(dom.container.querySelector(".shelf-filter-done") as HTMLElement);
      const moreBtn = dom.container.querySelector(".shelf-mobile-more-btn") as HTMLButtonElement;
      await dom.click(moreBtn);
      const settings = dom.container.querySelector(".shelf-settings-layer");
      expect(settings).not.toBeNull();
      expect(settings?.textContent).not.toContain("批量选择");
    } finally {
      await dom.dispose();
    }
  });

  it("手机列表的占位行不跨列，固定布局不会凭空多出被隐去的列", async () => {
    const store = new Map([["epub_shelf_view_mode", "list"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(ShelfView, {
        ...makeProps([makeEntry("b1", "爱丽丝漫游仙境"), makeEntry("b2", "小王子")]),
        compact: true,
      }));
      const spacers = [...dom.container.querySelectorAll(".shelf-table tbody tr[aria-hidden='true'] > td")];
      expect(spacers.length).toBeGreaterThan(0);
      for (const cell of spacers) expect(cell.getAttribute("colspan")).toBeNull();
      expect(dom.container.querySelectorAll(".shelf-table tbody tr[data-shelf-target='book']").length).toBe(2);
    } finally {
      await dom.dispose();
      vi.unstubAllGlobals();
    }
  });
});
