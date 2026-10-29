import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ShelfEntry } from "./shelf";
import { emptyOrganization, type LibraryOrganization } from "./libraryOrganization";
import { ShelfView, type ShelfViewProps } from "./ShelfView";
import { createReactDomHarness } from "../test/reactDomHarness";

const DEVICE = "00000000-0000-4000-8000-00000000000a";
const FOLDER = "11111111-1111-4111-8111-111111111111";

function entry(id: string, title: string, creator: string): ShelfEntry {
  return {
    id, title, creator, fileName: `${title}.epub`, fileSize: 1024, coverMime: "image/jpeg",
    addedAtMs: 1, lastReadAtMs: 1, spineIndex: 0, page: 1, progressPct: 10,
    anchorIndex: null, anchorRatio: null, contentHash: id.padEnd(64, "0"), isNew: false,
  };
}

const inFolder = [entry("a1", "山间旅店", "林秋"), entry("a2", "海边来信", "周远")];
const loose = [entry("b1", "城南旧事", "林海音")];

function organization(): LibraryOrganization {
  const stamp = (counter: number) => ({ counter, deviceId: DEVICE });
  return {
    ...emptyOrganization(),
    folders: { [FOLDER]: { name: { value: "小说", stamp: stamp(1) } } },
    books: Object.fromEntries(inFolder.map((book, i) => [
      book.contentHash!, { folderId: { value: FOLDER, stamp: stamp(2 + i) } },
    ])),
  };
}

const props: ShelfViewProps = {
  entries: [...inFolder, ...loose], organization: organization(), scope: { type: "root" }, busy: false, theme: "light",
  onThemeChange: () => {}, onOpen: () => {}, onImport: () => {}, onImportArchive: () => {},
  onExportArchive: () => {}, onDelete: () => {}, onDeleteMany: () => {}, onApplyOrganization: async () => {},
};

afterEach(() => { vi.unstubAllGlobals(); });

it("按文件夹显示时，搜索也能找到文件夹里的书（书名和作者），文件夹本身仍按名称匹配", async () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
  const dom = createReactDomHarness();
  const cards = () => [...dom.container.querySelectorAll(".shelf-card[data-book-id] .shelf-card-title")].map((el) => el.textContent);
  const folders = () => dom.container.querySelectorAll(`[data-folder-id="${FOLDER}"]`).length;
  const search = async (text: string) => {
    const input = dom.container.querySelector(".shelf-quick-filter-input") as HTMLInputElement;
    // React picks a value change up from focus + key events when it saw no DOM at load (as here).
    // That fallback is the old IE one, which also hooks attachEvent.
    Object.assign(input, { attachEvent() {}, detachEvent() {} });
    await dom.dispatch(input, new dom.window.Event("focusin", { bubbles: true }));
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
    await dom.dispatch(input, new dom.window.Event("keyup", { bubbles: true }));
  };
  try {
    await dom.render(createElement(ShelfView, props));
    expect(cards()).toEqual(["城南旧事"]);
    expect(folders()).toBe(1);

    await search("山间");
    expect(cards()).toEqual(["山间旅店"]);
    expect(folders()).toBe(0);

    await search("周远");
    expect(cards()).toEqual(["海边来信"]);

    await search("林");
    expect([...cards()].sort()).toEqual(["城南旧事", "山间旅店"]);

    await search("小说");
    expect(cards()).toEqual([]);
    expect(folders()).toBe(1);

    await search("");
    expect(cards()).toEqual(["城南旧事"]);
  } finally {
    await dom.dispose();
  }
});
