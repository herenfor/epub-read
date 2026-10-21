import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ShelfEntry } from "./shelf";
import { emptyOrganization, type LibraryOrganization, type OrganizationCommand, type ShelfScope } from "./libraryOrganization";
import { ShelfView, type ShelfViewProps } from "./ShelfView";
import { addBooksCandidates, matchesAddBooksQuery } from "./ShelfFolderAddBooksDialog";
import { planImportIntoFolder } from "./importIntoFolder";
import { folderIdAtPhysicalPoint, partitionDroppedPaths } from "./shelfDrop";
import { createReactDomHarness } from "../test/reactDomHarness";

const DEVICE = "00000000-0000-4000-8000-00000000000a";
const FOLDER_A = "11111111-1111-4111-8111-111111111111";
const FOLDER_B = "22222222-2222-4222-8222-222222222222";
const FOLDER_GONE = "33333333-3333-4333-8333-333333333333";
const HASH_FILED = "a".repeat(64);
const HASH_LOOSE = "b".repeat(64);
const HASH_ELSEWHERE = "c".repeat(64);
const stamp = (counter: number) => ({ counter, deviceId: DEVICE });

function entry(id: string, hash: string, title: string): ShelfEntry {
  return {
    id, title, creator: "作者", fileName: `${title}.epub`, fileSize: 1024, coverMime: "",
    addedAtMs: 1, lastReadAtMs: 2, spineIndex: 0, page: 1, progressPct: 0,
    anchorIndex: null, anchorRatio: null, contentHash: hash, isNew: false,
  };
}

const filedBook = entry("id-filed", HASH_FILED, "资料里的书");
const looseBook = entry("id-loose", HASH_LOOSE, "未归类的书");
const elsewhereBook = entry("id-elsewhere", HASH_ELSEWHERE, "别处的书");

function organization(): LibraryOrganization {
  return {
    ...emptyOrganization(),
    folders: {
      [FOLDER_A]: { name: { value: "资料", stamp: stamp(1) } },
      [FOLDER_B]: { name: { value: "小说", stamp: stamp(2) } },
      [FOLDER_GONE]: { name: { value: "已解散", stamp: stamp(3) }, deleted: stamp(4) },
    },
    books: {
      [HASH_FILED]: { folderId: { value: FOLDER_A, stamp: stamp(5) } },
      [HASH_LOOSE]: { folderId: { value: FOLDER_GONE, stamp: stamp(6) } },
      [HASH_ELSEWHERE]: { folderId: { value: FOLDER_B, stamp: stamp(7) } },
    },
  };
}

describe("import into folder placement", () => {
  it("moves new and unclassified books, keeps books other folders hold", () => {
    const plan = planImportIntoFolder(organization(), FOLDER_A, [
      { contentHash: "d".repeat(64), isExisting: false },
      { contentHash: HASH_LOOSE, isExisting: true },
      { contentHash: HASH_ELSEWHERE, isExisting: true },
      { contentHash: HASH_FILED, isExisting: true },
      { contentHash: HASH_LOOSE, isExisting: true },
    ]);
    expect(plan).toEqual({ move: ["d".repeat(64), HASH_LOOSE], alreadyHere: 1, keptElsewhere: 1, targetMissing: false });
  });

  it("moves nothing into a dissolved or unknown folder", () => {
    const books = [{ contentHash: "d".repeat(64), isExisting: false }];
    expect(planImportIntoFolder(organization(), FOLDER_GONE, books).targetMissing).toBe(true);
    expect(planImportIntoFolder(organization(), "44444444-4444-4444-8444-444444444444", books).move).toEqual([]);
  });
});

describe("add existing books candidates", () => {
  it("lists books outside the folder, unclassified first, with their current folder", () => {
    const candidates = addBooksCandidates([elsewhereBook, filedBook, looseBook], organization(), FOLDER_A);
    expect(candidates.map((c) => [c.entry.id, c.folderName])).toEqual([
      [looseBook.id, null],
      [elsewhereBook.id, "小说"],
    ]);
    expect(candidates.filter((c) => matchesAddBooksQuery(c, " 别处 ")).map((c) => c.entry.id)).toEqual([elsewhereBook.id]);
    expect(candidates.filter((c) => matchesAddBooksQuery(c, "")).length).toBe(2);
  });
});

describe("native window drops", () => {
  it("splits EPUBs, fonts and other items (folders)", () => {
    expect(partitionDroppedPaths(["C:\\a.EPUB", "C:\\f.ttf", "C:\\Books", "C:\\x.txt"])).toEqual({
      epubs: ["C:\\a.EPUB"], fonts: ["C:\\f.ttf"], others: ["C:\\Books", "C:\\x.txt"],
    });
  });

  it("maps a physical drop point to the folder element under it", () => {
    const card = { dataset: { folderId: FOLDER_A } };
    const inner = { closest: (selector: string) => (selector === "[data-folder-id]" ? card : null) };
    const points: Array<[number, number]> = [];
    const doc = { elementFromPoint: (x: number, y: number) => { points.push([x, y]); return inner as unknown as Element; } };
    expect(folderIdAtPhysicalPoint({ x: 300, y: 150 }, 1.5, doc)).toBe(FOLDER_A);
    expect(points).toEqual([[200, 100]]);
    expect(folderIdAtPhysicalPoint({ x: 1, y: 1 }, 1, { elementFromPoint: () => null })).toBeNull();
  });
});

async function renderShelf(scope: ShelfScope = { type: "root" }, externalDropFolderId: string | null = null) {
  const dom = createReactDomHarness();
  const commands: OrganizationCommand[] = [];
  const imports: Array<{ folderId: string; name: string } | "root"> = [];
  const contexts: Array<{ folderId: string; name: string } | null> = [];
  const props: ShelfViewProps = {
    entries: [filedBook, looseBook, elsewhereBook],
    organization: organization(),
    scope,
    busy: false,
    theme: "light",
    onThemeChange: () => {},
    onOpen: () => {},
    onImport: () => imports.push("root"),
    onImportIntoFolder: (target) => imports.push(target),
    onImportContextChange: (target) => contexts.push(target),
    externalDropFolderId,
    onImportArchive: () => {},
    onExportArchive: () => {},
    onDelete: () => {},
    onDeleteMany: () => {},
    onApplyOrganization: async (command) => { commands.push(command); },
  };
  await dom.render(createElement(ShelfView, props));
  const doc = dom.container.ownerDocument;
  const button = (selector: string, text: string): Element => {
    const match = Array.from(doc.querySelectorAll(selector)).find((el) => (el.textContent ?? "").includes(text));
    if (!match) throw new Error(`missing ${selector} with text ${text}`);
    return match as unknown as Element;
  };
  return { dom, doc, commands, imports, contexts, button };
}

describe("folder sheet: import new books and add existing ones", () => {
  it("imports into the open folder and reports it as the drop context", async () => {
    const shelf = await renderShelf();
    try {
      expect(shelf.contexts.at(-1)).toBeNull();
      await shelf.dom.click(shelf.dom.container.querySelector(`[data-folder-id="${FOLDER_A}"]`)!);
      expect(shelf.contexts.at(-1)).toEqual({ folderId: FOLDER_A, name: "资料" });
      await shelf.dom.click(shelf.button(".shelf-folder-modal-foot-btn", "导入新书"));
      expect(shelf.imports).toEqual([{ folderId: FOLDER_A, name: "资料" }]);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("adds chosen library books with one moveBooks command", async () => {
    const shelf = await renderShelf();
    try {
      await shelf.dom.click(shelf.dom.container.querySelector(`[data-folder-id="${FOLDER_A}"]`)!);
      await shelf.dom.click(shelf.button(".shelf-folder-modal-foot-btn", "从书库添加"));
      const dialog = shelf.doc.querySelector(".shelf-add-books-dialog")!;
      const rows = Array.from(dialog.querySelectorAll(".shelf-add-books-item"));
      expect(rows.map((row) => row.querySelector(".shelf-add-books-name")?.textContent)).toEqual(["未归类的书", "别处的书"]);
      const confirm = shelf.button(".shelf-add-books-dialog .shelf-confirm-primary", "添加");
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      await shelf.dom.click(shelf.button(".shelf-add-books-all", "全选"));
      expect(dialog.textContent).toContain("已在其他文件夹的书会移到这里");
      await shelf.dom.click(confirm);
      expect(shelf.commands).toEqual([
        { type: "moveBooks", contentHashes: [looseBook.id, elsewhereBook.id], folderId: FOLDER_A },
      ]);
      expect(shelf.doc.querySelector(".shelf-add-books-dialog")).toBeNull();
    } finally {
      await shelf.dom.dispose();
    }
  });
});

describe("folder view", () => {
  it("routes the top import button into the folder", async () => {
    const shelf = await renderShelf({ type: "folder", folderId: FOLDER_A });
    try {
      expect(shelf.contexts.at(-1)).toEqual({ folderId: FOLDER_A, name: "资料" });
      const main = shelf.dom.container.querySelector(".shelf-import-main, .shelf-btn-primary")!;
      expect(main.getAttribute("title")).toContain("资料");
      await shelf.dom.click(main);
      expect(shelf.imports).toEqual([{ folderId: FOLDER_A, name: "资料" }]);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("highlights the folder card under an OS file drag", async () => {
    const shelf = await renderShelf({ type: "root" }, FOLDER_B);
    try {
      const card = shelf.dom.container.querySelector(`.shelf-folder-card[data-folder-id="${FOLDER_B}"]`)!;
      expect(card.className).toContain("is-drop-target");
      expect(shelf.dom.container.querySelector(`.shelf-folder-card[data-folder-id="${FOLDER_A}"]`)!.className).not.toContain("is-drop-target");
    } finally {
      await shelf.dom.dispose();
    }
  });
});
