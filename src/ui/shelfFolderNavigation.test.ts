import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ShelfEntry } from "./shelf";
import { emptyOrganization, type LibraryOrganization, type ShelfScope } from "./libraryOrganization";
import { ShelfView, type ShelfViewProps } from "./ShelfView";
import { createReactDomHarness } from "../test/reactDomHarness";

const DEVICE = "00000000-0000-4000-8000-00000000000a";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const stamp = (counter: number) => ({ counter, deviceId: DEVICE });

function entry(id: string, title: string): ShelfEntry {
  return {
    id, title, creator: "作者", fileName: `${title}.epub`, fileSize: 1024, coverMime: "",
    addedAtMs: 1, lastReadAtMs: 2, spineIndex: 0, page: 1, progressPct: 0,
    anchorIndex: null, anchorRatio: null, contentHash: id.repeat(64).slice(0, 64), isNew: false,
  };
}

const a1 = entry("a1", "系列直属");
const b1 = entry("b1", "2024 里的书");
const c1 = entry("c1", "二月里的书");
const loose = entry("r1", "根层散书");

const folders: LibraryOrganization["folders"] = {
  [A]: { name: { value: "系列", stamp: stamp(1) }, parentId: { value: null, stamp: stamp(2) } },
  [B]: { name: { value: "2024", stamp: stamp(3) }, parentId: { value: A, stamp: stamp(4) } },
  [C]: { name: { value: "二月", stamp: stamp(5) }, parentId: { value: B, stamp: stamp(6) } },
  [D]: { name: { value: "上旬", stamp: stamp(7) }, parentId: { value: C, stamp: stamp(8) } },
  [E]: { name: { value: "第一周", stamp: stamp(9) }, parentId: { value: D, stamp: stamp(10) } },
};

function organization(extraFolders: LibraryOrganization["folders"] = {}): LibraryOrganization {
  return {
    ...emptyOrganization(),
    folders: { ...folders, ...extraFolders },
    books: {
      [a1.contentHash!]: { folderId: { value: A, stamp: stamp(11) } },
      [b1.contentHash!]: { folderId: { value: B, stamp: stamp(12) } },
      [c1.contentHash!]: { folderId: { value: C, stamp: stamp(13) } },
    },
  };
}

async function render(scope?: ShelfScope, overrides: Partial<ShelfViewProps> = {}) {
  const dom = createReactDomHarness();
  const props: ShelfViewProps = {
    entries: [a1, b1, c1, loose],
    organization: organization(),
    ...(scope ? { scope } : {}),
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
    ...overrides,
  };
  await dom.render(createElement(ShelfView, props));
  const card = (id: string) => dom.container.querySelector(`[data-folder-id="${id}"]`) as HTMLElement | null;
  return { dom, card };
}

describe("nested shelf navigation", () => {
  it("opens a folder in place, lists only direct children/books, and walks back up", async () => {
    const shelf = await render();
    try {
      const aCard = shelf.card(A)!;
      expect(aCard.querySelector(".shelf-card-creator")?.textContent).toBe("共 3 本 · 1 个子文件夹");
      expect(shelf.dom.container.querySelector(`[data-book-id="${b1.id}"]`)).toBeNull();

      await shelf.dom.click(aCard);
      expect(shelf.dom.container.querySelector(".shelf-folder-path-bar")).not.toBeNull();
      expect(shelf.dom.container.querySelector(".shelf-folder-path-here")?.textContent).toBe("系列");
      expect(shelf.dom.container.querySelector(`[data-book-id="${a1.id}"]`)).not.toBeNull();
      expect(shelf.dom.container.querySelector(`[data-book-id="${b1.id}"]`)).toBeNull();
      expect(shelf.card(B)).not.toBeNull();
      expect(shelf.card(C)).toBeNull();

      await shelf.dom.click(shelf.card(B)!);
      expect([...shelf.dom.container.querySelectorAll(".shelf-folder-path-crumb, .shelf-folder-path-here")]
        .map((node) => node.textContent)).toEqual(["书架", "系列", "2024"]);

      await shelf.dom.click(shelf.dom.container.querySelector(".shelf-folder-path-back")!);
      expect(shelf.dom.container.querySelector(".shelf-folder-path-here")?.textContent).toBe("系列");
      await shelf.dom.click(shelf.dom.container.querySelector(".shelf-folder-path-back")!);
      expect(shelf.dom.container.querySelector(".shelf-folder-path-bar")).toBeNull();
      expect(shelf.card(A)).not.toBeNull();
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("keeps child folders visible when the current folder has no direct books", async () => {
    const org = organization();
    const shelf = await render({ type: "folder", folderId: A }, {
      organization: {
        ...org,
        books: { [b1.contentHash!]: { folderId: { value: B, stamp: stamp(12) } } },
      },
    });
    try {
      expect(shelf.card(B)).not.toBeNull();
      expect(shelf.dom.container.textContent).not.toContain("文件夹为空");
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("blocks a sixth level and explains why", async () => {
    const shelf = await render({ type: "folder", folderId: E });
    try {
      expect(shelf.dom.container.querySelector(".shelf-folder-path-here")?.textContent).toBe("第一周");
      const hint = shelf.dom.container.querySelector(".shelf-folder-level-hint");
      expect(hint?.textContent).toContain("第五层");
      const newChild = [...shelf.dom.container.querySelectorAll<HTMLButtonElement>(".shelf-folder-path-action")]
        .find((button) => button.textContent?.includes("新建子文件夹"));
      expect(newChild?.disabled).toBe(true);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("batch-selects and exports descendants of a folder by unique content hash", async () => {
    const onExportBooks = vi.fn();
    const shelf = await render(undefined, { onExportBooks });
    try {
      await shelf.dom.click(shelf.dom.container.querySelector("[data-testid='shelf-batch-select-btn']")!);
      await shelf.dom.click(shelf.card(A)!);
      expect(shelf.card(A)!.classList.contains("selected")).toBe(true);
      const exportButton = [...shelf.dom.container.querySelectorAll<HTMLButtonElement>(".shelf-batch-action-btn")]
        .find((button) => button.textContent?.includes("导出书籍"));
      await shelf.dom.click(exportButton!);
      expect(onExportBooks).toHaveBeenCalledTimes(1);
      expect(onExportBooks.mock.calls[0][0].map((book: ShelfEntry) => book.id).sort()).toEqual(["a1", "b1", "c1"]);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("labels every unavailable move-folder position", async () => {
    const shelf = await render();
    try {
      await shelf.dom.click(shelf.card(A)!.querySelector(".shelf-card-more-btn")!);
      const move = [...shelf.dom.container.ownerDocument.querySelectorAll<HTMLButtonElement>(".shelf-action-item")]
        .find((button) => button.textContent === "移动到…");
      await shelf.dom.click(move!);
      const dialog = shelf.dom.container.querySelector(".shelf-move-dialog")!;
      expect(dialog.textContent).toContain("移动文件夹「系列」");
      const reasons = [...dialog.querySelectorAll(".shelf-move-why")].map((node) => node.textContent);
      expect(reasons).toEqual(expect.arrayContaining(["已经在这里", "就是它自己", "在它自己里面"]));
      expect(dialog.querySelector(".shelf-move-new-btn")?.textContent).toContain("在选中的位置里新建文件夹");
    } finally {
      await shelf.dom.dispose();
    }
  });
});
