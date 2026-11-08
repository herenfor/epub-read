import { describe, expect, it } from "vitest";
import type { BookmarkValue, NoteValue } from "../../core/portableState/portable-state-types";
import type { ImportCandidate } from "./readestConvert";
import { bookReview, commitPlan, localImportBooks, matchRows, type LocalImportBook } from "./readestImportModel";
import type { ReadestLibraryBook } from "./readestBackup";

const md5 = (c: string) => c.repeat(32);
const book = (hash: string, extra: Partial<ReadestLibraryBook> = {}): ReadestLibraryBook =>
  ({ hash, format: "EPUB", title: `R${hash[0]}`, author: "", originalFilename: null, deleted: false, ...extra });
const local = (id: string, digest: string, progressPct: number | null = null): LocalImportBook =>
  ({ id, bookHash: id.repeat(64), title: `L${id}`, fileName: `${id}.epub`, partialMd5: digest, targetToken: `t-${id}`, progressPct });
const candidate = <T>(grade: ImportCandidate<T>["grade"], value: T | null, key = "k"): ImportCandidate<T> =>
  ({ sourceKey: `readest:${md5("a")}:${key}`, grade, reasons: [], value, source: { cfi: "epubcfi(/6/2!/4)", text: "原文" } });

describe("Readest import model", () => {
  it("auto-chooses only a unique digest match and keeps failed local rows out", () => {
    const locals = localImportBooks(
      [{ id: "x", contentHash: "x".repeat(64), title: "X", fileName: "x.epub" }, { id: "y", contentHash: "y".repeat(64), title: "Y", fileName: "y.epub" }],
      [
        { bookHash: "x".repeat(64), partialMd5: md5("a"), targetToken: "tx", progress: { versions: [], display: null, conflict: false } },
        { bookHash: "y".repeat(64), errorCode: "source-unavailable" },
      ],
    );
    expect(locals.map((b) => [b.id, b.progressPct])).toEqual([["x", null]]);
    const rows = matchRows(
      [book(md5("b")), book(md5("a")), book(md5("c")), book(md5("d"), { format: "PDF" }), book(md5("e"), { deleted: true })],
      [...locals, local("p", md5("c")), local("q", md5("c"))],
    );
    expect(rows.map((r) => [r.readestHash[0], r.status, r.chosen, r.selected])).toEqual([
      ["a", "matched", "x", true],
      ["c", "ambiguous", null, false],
      ["b", "unmatched", null, false],
      ["d", "unsupported-format", null, false],
      ["e", "deleted", null, false],
    ]);
  });

  it("commits only ticked, placed values, keeps a local position unless asked, and enforces limits", () => {
    const row = matchRows([book(md5("a"))], [local("x", md5("a"), 52)])[0];
    const locator = { locatorVersion: 1, chapterPath: "c.xhtml", spineIndexHint: 0, target: { kind: "chapter-start" } } as const;
    const review = bookReview(row, local("x", md5("a"), 52), {
      progress: candidate("exact", { locator, progressPctHint: 41 }, "progress"),
      bookmarks: [candidate("exact", { locator, text: "书签", createdAtMs: 1 }, "b1"), candidate<BookmarkValue>("unresolved", null, "b2")],
      notes: [candidate<NoteValue>("unsupported", null, "n1")],
    });
    expect(review.progress?.selected).toBe(false);
    const plan = commitPlan([review]);
    expect(plan).toEqual({
      ok: true,
      records: 1,
      notChosen: 3,
      books: [{ bookHash: "x".repeat(64), readestHash: md5("a"), targetToken: "t-x", bookmarks: [{ sourceKey: `readest:${md5("a")}:b1`, value: { locator, text: "书签", createdAtMs: 1 } }], notes: [] }],
    });
    // No "progress" key at all when the local position is kept (null is rejected natively).
    expect(plan.ok && "progress" in plan.books[0]).toBe(false);
    const withProgress = commitPlan([{ ...review, progress: { ...review.progress!, selected: true } }]);
    expect(withProgress.ok && withProgress.books[0].progress).toEqual({ locator, progressPctHint: 41 });
    expect(commitPlan([{ ...review, selected: false }])).toEqual({ ok: false, reason: "nothing-selected", records: 0 });
    const many = Array.from({ length: 129 }, (_, i) => ({ ...review, readestHash: String(i) }));
    expect(commitPlan(many)).toMatchObject({ ok: false, reason: "too-many-books" });
  });
});
