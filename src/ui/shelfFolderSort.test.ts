import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ShelfEntry } from "./shelf";
import { emptyOrganization, type LibraryOrganization, type ShelfScope } from "./libraryOrganization";
import { ShelfView, type ShelfViewProps } from "./ShelfView";
import { createReactDomHarness } from "../test/reactDomHarness";

const DEVICE = "00000000-0000-4000-8000-00000000000a";
const FOLDER = "11111111-1111-4111-8111-111111111111";

function entry(id: string, title: string, lastReadAtMs: number): ShelfEntry {
  return {
    id, title, creator: "作者", fileName: `${title}.epub`, fileSize: 1024, coverMime: "image/jpeg",
    addedAtMs: 1, lastReadAtMs, spineIndex: 0, page: 1, progressPct: 10,
    anchorIndex: null, anchorRatio: null, contentHash: id.padEnd(64, "0"), isNew: false,
  };
}

// 最近阅读与书名两种排序给出相反的顺序。
const inFolder = [entry("a1", "甲", 1), entry("a2", "乙", 3)];
const loose = [entry("b1", "丙", 4), entry("b2", "丁", 5)];

function organization(): LibraryOrganization {
  const stamp = (counter: number) => ({ counter, deviceId: DEVICE });
  return {
    ...emptyOrganization(),
    folders: { [FOLDER]: { name: { value: "资料", stamp: stamp(1) } } },
    books: Object.fromEntries(inFolder.map((book, i) => [
      book.contentHash!, { folderId: { value: FOLDER, stamp: stamp(2 + i) } },
    ])),
  };
}

function props(scope: ShelfScope): ShelfViewProps {
  return {
    entries: [...inFolder, ...loose], organization: organization(), scope, busy: false, theme: "light",
    onThemeChange: () => {}, onOpen: () => {}, onImport: () => {}, onImportArchive: () => {},
    onExportArchive: () => {}, onDelete: () => {}, onDeleteMany: () => {}, onApplyOrganization: async () => {},
  };
}

function stubStorage(store = new Map<string, string>()): Map<string, string> {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  });
  return store;
}

afterEach(() => { vi.unstubAllGlobals(); });

type Harness = ReturnType<typeof createReactDomHarness>;

const cardTitles = (root: ParentNode) =>
  [...root.querySelectorAll(".shelf-card[data-book-id] .shelf-card-title")].map((el) => el.textContent);

async function pickSort(dom: Harness, root: ParentNode, label: string): Promise<void> {
  await dom.click(root.querySelector(".shelf-select-btn")!);
  const option = [...root.querySelectorAll(".shelf-select-option")].find((el) => el.textContent === label);
  await dom.click(option!);
}

it("文件夹内排序只改文件夹（弹窗与全页共用、本机记住），根层顺序和已选书不变", async () => {
  const store = stubStorage();
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(ShelfView, props({ type: "root" })));
    expect(cardTitles(dom.container)).toEqual(["丁", "丙"]);

    // 弹窗初次跟随书架的“最近阅读”。
    await dom.click(dom.container.querySelector(`[data-folder-id="${FOLDER}"]`)!);
    const modal = dom.container.querySelector(".shelf-folder-modal")!;
    expect(cardTitles(modal)).toEqual(["乙", "甲"]);
    await pickSort(dom, modal.querySelector(".shelf-folder-modal-sort")!, "排序：书名排序");
    expect(cardTitles(modal)).toEqual(["甲", "乙"]);
    expect(store.get("epub_shelf_folder_sort")).toBe("title");
    const root = [...dom.container.querySelectorAll(".shelf-card[data-book-id]")]
      .filter((card) => !card.closest(".shelf-folder-modal"));
    expect(root.map((card) => card.querySelector(".shelf-card-title")?.textContent)).toEqual(["丁", "丙"]);
  } finally {
    await dom.dispose();
  }

  // 全页文件夹沿用记住的选择；在这里改排序不丢已选的书，回根层仍按书架排序。
  stubStorage(store);
  const page = createReactDomHarness();
  try {
    await page.render(createElement(ShelfView, props({ type: "folder", folderId: FOLDER })));
    expect(cardTitles(page.container)).toEqual(["甲", "乙"]);
    await page.click(page.container.querySelector("[data-testid='shelf-batch-select-btn']")!);
    await page.click(page.container.querySelector(`[data-book-id="a2"]`)!);
    expect(page.container.querySelector(`[data-book-id="a2"]`)!.classList.contains("selected")).toBe(true);
    await pickSort(page, page.container.querySelector(".shelf-nav-rail-right")!, "排序：最近阅读");
    expect(cardTitles(page.container)).toEqual(["乙", "甲"]);
    expect(page.container.querySelector(`[data-book-id="a2"]`)!.classList.contains("selected")).toBe(true);
    expect(store.get("epub_shelf_folder_sort")).toBe("recent");

    await page.render(createElement(ShelfView, props({ type: "root" })));
    await pickSort(page, page.container.querySelector(".shelf-nav-rail-right")!, "排序：书名排序");
    expect(cardTitles(page.container)).toEqual(["丙", "丁"]);
    expect(store.get("epub_shelf_folder_sort")).toBe("recent");
  } finally {
    await page.dispose();
  }
});
