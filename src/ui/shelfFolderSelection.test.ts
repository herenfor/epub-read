import { describe, expect, it } from "vitest";
import { sortShelfEntries, type ShelfEntry } from "./shelf";
import { folderSelectionState, selectableBookIds, sortShelfFolders, toggleFolderSelection } from "./shelfFolderSelection";

function book(id: string, title: string, extra: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    id, title, creator: "作者", fileName: `${id}.epub`, fileSize: 1, coverMime: "",
    addedAtMs: 0, lastReadAtMs: 0, spineIndex: 0, page: 0, progressPct: 0,
    anchorIndex: null, anchorRatio: null, isNew: false, ...extra,
  };
}

describe("folder batch selection", () => {
  const books = [book("a", "甲"), book("b", "乙"), book("c", "丙")];

  it("derives none / mixed / all from the selected books, and empty folders cannot be selected", () => {
    expect(folderSelectionState(books, new Set())).toBe("none");
    expect(folderSelectionState(books, new Set(["b"]))).toBe("mixed");
    expect(folderSelectionState(books, new Set(["a", "b", "c", "x"]))).toBe("all");
    expect(folderSelectionState([], new Set(["a"]))).toBe("empty");
  });

  it("a partly selected folder is completed; a fully selected one is cleared; other books stay", () => {
    const completed = toggleFolderSelection(books, new Set(["b", "loose"]));
    expect([...completed].sort()).toEqual(["a", "b", "c", "loose"]);
    expect([...toggleFolderSelection(books, completed)]).toEqual(["loose"]);
  });

  it("a book picked both alone and through its folder is counted once; folder books stay selectable", () => {
    const loose = book("loose", "散书");
    const ids = selectableBookIds([loose, books[0]], [books, []]);
    expect([...ids].sort()).toEqual(["a", "b", "c", "loose"]);
  });
});

describe("folder order and representative", () => {
  const old = book("old", "老书", { addedAtMs: 1, lastReadAtMs: 50, progressPct: 90 });
  const fresh = book("fresh", "新书", { addedAtMs: 9, lastReadAtMs: 10, progressPct: 5 });
  const mid = book("mid", "中间", { addedAtMs: 5, lastReadAtMs: 0, progressPct: 40 });
  const folders = [{ id: "f1", name: "乙夹" }, { id: "f2", name: "甲夹" }, { id: "f3", name: "空夹" }];
  const map = (sort: Parameters<typeof sortShelfEntries>[1]) => new Map([
    ["f1", sortShelfEntries([old, mid], sort)],
    ["f2", sortShelfEntries([fresh], sort)],
    ["f3", []],
  ]);

  it("title sorts folders by name", () => {
    expect(sortShelfFolders(folders, map("title"), "title").map((f) => f.id)).toEqual(["f1", "f2", "f3"].sort((a, b) =>
      folders.find((f) => f.id === a)!.name.localeCompare(folders.find((f) => f.id === b)!.name, "zh-Hans-CN")));
  });

  it("other sorts follow each folder's first book under the same sort, empty folders last", () => {
    // Recently added: f2's newest book (9) beats f1's (5, "mid" is f1's representative).
    expect(map("added").get("f1")![0].id).toBe("mid");
    expect(sortShelfFolders(folders, map("added"), "added").map((f) => f.id)).toEqual(["f2", "f1", "f3"]);
    // Progress: f1's representative becomes "old" (90%).
    expect(map("progress").get("f1")![0].id).toBe("old");
    expect(sortShelfFolders(folders, map("progress"), "progress").map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });
});
