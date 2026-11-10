import { describe, expect, it } from "vitest";
import type { BookmarkValue, NoteValue, ProgressValue } from "../../core/portableState/portable-state-types";
import type { ImportCandidate, ReadestBookPreview } from "./readestConvert";
import { bookPayload, importRows, localImportBooks, selectionSummary, stageChunks, takesReadestPosition, type LocalImportBook } from "./readestImportModel";
import type { ReadestLibraryBook } from "./readestBackup";

const hash = (c: string) => c.repeat(32);
const book = (c: string, format = "EPUB", deleted = false): ReadestLibraryBook =>
  ({ hash: hash(c), format, title: `Book ${c}`, author: "", originalFilename: null, deleted });
const local = (id: string, digest: string, fileName = `${id}.epub`, progressPct: number | null = null): LocalImportBook =>
  ({ id, bookHash: id.repeat(64).slice(0, 64), title: id, fileName, partialMd5: hash(digest), targetToken: `t-${id}`, progressPct });
const candidate = <T,>(key: string, grade: ImportCandidate<T>["grade"], value: T | null): ImportCandidate<T> =>
  ({ sourceKey: key, grade, reasons: [], value, source: { cfi: "", text: `text of ${key}` } });
const locator = { locatorVersion: 1, chapterPath: "c.xhtml", spineIndexHint: 0, target: { kind: "chapter-start" } };
const progress = (pct: number) => candidate<ProgressValue>("p", "exact", { locator, progressPctHint: pct } as unknown as ProgressValue);

describe("Readest import model", () => {
  it("offers classification-only migration for an existing non-EPUB", () => {
    const source = { ...book("1", "TXT"), folderPath: ["Root", "Text"] };
    expect(importRows([source], [local("x", "1", "book.txt")], [])[0]).toMatchObject({
      kind: "existing", selected: true, records: false, folderPath: ["Root", "Text"],
    });
  });

  it("keeps only shelf books the native side could sample", () => {
    const books = localImportBooks(
      [{ id: "a", contentHash: "ha", title: "A", fileName: "a.epub" }, { id: "b", contentHash: "hb", title: "B", fileName: "b.epub" }],
      [
        { bookHash: "ha", partialMd5: hash("1"), targetToken: "t", progress: { versions: [], display: { value: { progressPctHint: 40 } } as never, conflict: false } },
        { bookHash: "hb", errorCode: "source-unavailable" },
      ],
    );
    expect(books).toEqual([expect.objectContaining({ id: "a", progressPct: 40 })]);
  });

  it("sorts every Readest book into new, already here, or not importable with a reason", () => {
    const rows = importRows(
      [book("1"), book("2"), book("3", "PDF"), book("4"), book("5", "EPUB", true), book("6", "MOBI"), book("7", "MOBI")],
      [local("x", "2"), local("y", "7", "y.mobi")],
      [
        { readestHash: hash("1"), fileName: "One.epub", bytes: 10 },
        { readestHash: hash("2"), fileName: "Two.epub", bytes: 20 },
        { readestHash: hash("6"), fileName: "Six.mobi", bytes: 30 },
      ],
    );
    // A deleted Readest book is not offered at all.
    expect(rows.map((row) => [row.readestHash[0], row.kind, row.reason ?? null, row.records, row.selected])).toEqual([
      ["1", "new", null, true, true],
      // Other formats come over as books; their records cannot be converted.
      ["6", "new", null, false, true],
      // The same file is already on the shelf: its copy in the source is not imported again.
      ["2", "existing", null, true, true],
      ["3", "unavailable", "unsupported-format", false, false],
      ["4", "unavailable", "no-file", false, false],
      ["7", "unavailable", "shelved-no-records", false, false],
    ]);
    expect(rows[2].local?.id).toBe("x");
    expect(selectionSummary(rows)).toEqual({ newBooks: 2, existing: 1, bytes: 40 });
  });

  it("stages new books in bounded chunks and never drops an oversized one", () => {
    const rows = importRows(
      ["1", "2", "3", "4"].map((c) => book(c)), [],
      ["1", "2", "3", "4"].map((c, index) => ({ readestHash: hash(c), fileName: `${c}.epub`, bytes: index === 2 ? 500 : 100 })),
    );
    expect(stageChunks(rows, 8, 250).map((chunk) => chunk.map((row) => row.readestHash[0]))).toEqual([["1", "2"], ["3"], ["4"]]);
    expect(stageChunks(rows, 3, 10_000).map((chunk) => chunk.length)).toEqual([3, 1]);
  });

  it("applies the reading-position rule only when both sides have a position", () => {
    expect(takesReadestPosition("local", 5, null)).toBe(true);
    expect(takesReadestPosition("local", 90, 10)).toBe(false);
    expect(takesReadestPosition("readest", 5, 90)).toBe(true);
    expect(takesReadestPosition("farther", 50, 40)).toBe(true);
    expect(takesReadestPosition("farther", 40, 40)).toBe(false);
  });

  it("sends everything that was placed and lists what was not", () => {
    const preview: ReadestBookPreview = {
      progress: progress(30),
      bookmarks: [candidate<BookmarkValue>("b1", "exact", { text: "b" } as BookmarkValue), candidate<BookmarkValue>("b2", "unresolved", null)],
      notes: [candidate<NoteValue>("n1", "approximate", { content: "n" } as NoteValue), candidate<NoteValue>("n2", "unsupported", null)],
    };
    const ahead = bookPayload(hash("1"), "Book", local("x", "1", "x.epub", 60), preview, "farther");
    expect(ahead.payload).toMatchObject({ readestHash: hash("1"), targetToken: "t-x", bookmarks: [{ sourceKey: "b1" }], notes: [{ sourceKey: "n1" }] });
    // The local position is further along, so Readest's is not sent.
    expect(ahead.payload).not.toHaveProperty("progress");
    expect(ahead.records).toBe(2);
    expect(ahead.unplaced).toEqual([
      { title: "Book", kind: "bookmark", text: "text of b2", cfi: "", reason: "outside-text" },
      { title: "Book", kind: "note", text: "text of n2", cfi: "", reason: "outside-text" },
    ]);
    const taken = bookPayload(hash("1"), "Book", local("x", "1", "x.epub", 60), preview, "readest");
    expect(taken.payload?.progress).toEqual({ locator, progressPctHint: 30 });

    const lost: ReadestBookPreview = { progress: candidate<ProgressValue>("p", "unresolved", null), bookmarks: [], notes: [] };
    expect(bookPayload(hash("1"), "Book", local("x", "1"), lost, "farther")).toEqual({
      payload: null, records: 0, approximate: [], unplaced: [{ title: "Book", kind: "progress", text: "text of p", cfi: "", reason: "outside-text" }],
    });
  });
});

it("preserves unplaced raw note data and reports approximate records without dropping their payload", () => {
  const missing = candidate<NoteValue>("raw", "unresolved", null);
  missing.reasons = ["chapter-missing"];
  missing.source = { cfi: "epubcfi(/6/99!/4)", text: "原文", content: "笔记正文", style: "underline", color: "red", createdAtMs: 123 };
  const approximate = candidate<NoteValue>("placed", "approximate", { content: "保留笔记" } as NoteValue);
  approximate.reasons = ["cfi-only"];
  const result = bookPayload(hash("1"), "Book", local("x", "1"), { progress: null, bookmarks: [], notes: [missing, approximate] }, "local");
  expect(result.payload?.notes).toHaveLength(1);
  expect(result.unplaced[0]).toMatchObject({ ...missing.source, reason: "chapter-missing" });
  expect(result.approximate).toEqual([{ title: "Book", kind: "note", reasons: ["cfi-only"] }]);
});
