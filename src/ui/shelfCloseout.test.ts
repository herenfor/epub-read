import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyOrganization, type LibraryOrganization } from "./libraryOrganization";
import { measureShelfGridGeometry, ShelfView, type ShelfViewProps } from "./ShelfView";
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

function makeProps(entries: ShelfEntry[], organization = emptyOrganization()): ShelfViewProps {
  return {
    entries,
    organization,
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

function rect(top: number, height: number, left = 0, width = 180): DOMRect {
  return {
    x: left, y: top, top, left, width, height,
    right: left + width, bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("书架最后收口：前缀所有权与缩放后字母定位", () => {
  it("文件夹前缀与书籍 grid 分离，虚拟占位只属于书籍窗口", async () => {
    const dom = createReactDomHarness();
    const baseOrganization = emptyOrganization();
    const organization = {
      ...baseOrganization,
      folders: {
        ...baseOrganization.folders,
        "f-history": {
          name: { value: "历史", stamp: { counter: 1, deviceId: "test" } },
        },
      },
    } as LibraryOrganization;
    try {
      await dom.render(createElement(ShelfView, makeProps([makeEntry("b1", "第一本")], organization)));
      const folderPrefix = dom.container.querySelector(".shelf-folder-prefix .shelf-folder-grid");
      const bookPrefix = dom.container.querySelector(".shelf-book-prefix .shelf-book-grid");
      expect(folderPrefix).not.toBeNull();
      expect(bookPrefix).not.toBeNull();
      expect(folderPrefix?.querySelector(".shelf-folder-card")).not.toBeNull();
      expect(folderPrefix?.querySelector(".shelf-card[data-book-id]")).toBeNull();
      expect(bookPrefix?.querySelector(".shelf-card[data-book-id]")).not.toBeNull();
    } finally {
      await dom.dispose();
    }
  });

  it("<40 本时字母跳转使用已测得的 zoom 还原布局坐标", async () => {
    const dom = createReactDomHarness();
    const win = (dom.container.ownerDocument.defaultView ?? globalThis) as Window & typeof globalThis;
    const originalRect = win.HTMLElement.prototype.getBoundingClientRect;
    const originalScrollTop = Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, "clientHeight");
    const originalGetComputedStyle = globalThis.getComputedStyle;
    const originalWindowGetComputedStyle = win.getComputedStyle;
    const originalRequestAnimationFrame = win.requestAnimationFrame;
    Object.defineProperty(win.HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement & { __scrollTop?: number }) { return this.__scrollTop ?? 0; },
      set(this: HTMLElement & { __scrollTop?: number }, value: number) { this.__scrollTop = value; },
    });
    Object.defineProperty(win.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return 800; },
    });

    win.HTMLElement.prototype.getBoundingClientRect = function getRect(this: HTMLElement) {
      if (this.classList.contains("shelf-view")) return rect(0, 800, 0, 400);
      if (this.classList.contains("shelf-book-prefix")) return rect(390, 60, 0, 400);
      if (this.classList.contains("shelf-card") && this.closest(".shelf-book-grid")) {
        const cards = Array.from(this.parentElement?.querySelectorAll(".shelf-card") ?? []);
        const index = cards.indexOf(this);
        const row = Math.floor(index / 2);
        return rect(450 + row * 240, 210, (index % 2) * 180, 180);
      }
      return rect(0, 0, 0, 0);
    };
    const fakeComputedStyle = ((el: Element) => {
      if (el.classList.contains("shelf-view")) return { zoom: "1.5" } as unknown as CSSStyleDeclaration;
      if (el.classList.contains("shelf-book-grid")) {
        return { gridTemplateColumns: "100px 100px", columnGap: "20px", rowGap: "20px", gap: "20px" } as unknown as CSSStyleDeclaration;
      }
      return { zoom: "1", gridTemplateColumns: "", rowGap: "0px", gap: "0px" } as unknown as CSSStyleDeclaration;
    }) as typeof globalThis.getComputedStyle;
    (globalThis as typeof globalThis & { getComputedStyle: typeof globalThis.getComputedStyle }).getComputedStyle = fakeComputedStyle;
    (win as Window & { getComputedStyle: typeof globalThis.getComputedStyle }).getComputedStyle = fakeComputedStyle;
    win.requestAnimationFrame = ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)) as typeof win.requestAnimationFrame;

    const entries = ["A书", "B书", "C书", "D书", "E书", "F书"].map((title, index) => makeEntry(`b${index}`, title));
    try {
      await dom.render(createElement(ShelfView, makeProps(entries)));
      await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, 80)));

      const sortSelect = dom.container.querySelector(".shelf-sort-select-zen") as HTMLSelectElement;
      const option = sortSelect.querySelector('option[value="title"]') as HTMLOptionElement | null;
      if (option) option.selected = true;
      const changeEvent = new (win as unknown as { Event: typeof Event }).Event("change", { bubbles: true });
      Object.defineProperty(changeEvent, "target", { value: { value: "title" } });
      await dom.run(() => { sortSelect.dispatchEvent(changeEvent); });
      await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, 80)));

      const rail = dom.container.querySelector(".shelf-az-rail");
      expect(rail).not.toBeNull();
      const directlyMeasured = measureShelfGridGeometry(dom.container.querySelector(".shelf-view") as HTMLElement);
      expect(directlyMeasured).toEqual({ columns: 2, rowStep: 160, contentTop: 260 });
      const letterC = Array.from(dom.container.querySelectorAll(".shelf-az-letter"))
        .find((button) => button.textContent?.trim() === "C");
      expect(letterC).not.toBeNull();

      const container = dom.container.querySelector(".shelf-view") as HTMLDivElement;
      Object.defineProperty(container, "scrollTo", { value: undefined, configurable: true });
      container.scrollTop = 0;
      await dom.click(letterC!);
      await dom.run(() => new Promise<void>((resolve) => setTimeout(resolve, 80)));
      // 屏幕坐标：prefix top=390 / zoom=1.5 -> layout 260；rowStep=(690-450)/1.5=160。
      // C 是 0 基索引 2，columns=2 -> 第二行 -> 260 + 160 = 420。
      expect(container.scrollTop).toBe(420);
    } finally {
      win.HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollTop) Object.defineProperty(win.HTMLElement.prototype, "scrollTop", originalScrollTop);
      else Reflect.deleteProperty(win.HTMLElement.prototype, "scrollTop");
      if (originalClientHeight) Object.defineProperty(win.HTMLElement.prototype, "clientHeight", originalClientHeight);
      else Reflect.deleteProperty(win.HTMLElement.prototype, "clientHeight");
      globalThis.getComputedStyle = originalGetComputedStyle;
      win.getComputedStyle = originalWindowGetComputedStyle;
      if (originalRequestAnimationFrame) win.requestAnimationFrame = originalRequestAnimationFrame;
      else delete (win as Partial<Window>).requestAnimationFrame;
      await dom.dispose();
    }
  });
});
