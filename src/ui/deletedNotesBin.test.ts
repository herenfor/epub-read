import { describe, expect, it } from "vitest";
import { DELETED_NOTES_PER_BOOK, withDeletedNote, withoutDeletedNote } from "./deletedNotesBin";
import type { ReaderNote } from "./notes";

const note = (id: string): ReaderNote => ({
  id, spineIndex: 0, chapterPath: "c1.xhtml", startTextOffset: 0, endTextOffset: 4,
  startTextSnippet: "abcd", endTextSnippet: "abcd", selectedText: "abcd", content: "",
  createdAtMs: 1, updatedAtMs: 1,
});

describe("recently deleted notes", () => {
  it("keeps the newest ten per book, newest first", () => {
    let bin = {};
    for (let i = 0; i < DELETED_NOTES_PER_BOOK + 3; i++) bin = withDeletedNote(bin, "book", note(`n${i}`), i);
    const ids = (bin as Record<string, { note: ReaderNote }[]>).book.map((item) => item.note.id);
    expect(ids).toHaveLength(DELETED_NOTES_PER_BOOK);
    expect(ids[0]).toBe("n12");
    expect(ids.at(-1)).toBe("n3");
  });

  it("keeps books apart and drops a book's entry when its last note is restored", () => {
    let bin = withDeletedNote({}, "a", note("x"), 1);
    bin = withDeletedNote(bin, "b", note("y"), 2);
    expect(Object.keys(bin)).toEqual(["a", "b"]);
    const same = withoutDeletedNote(bin, "a", "missing");
    expect(same).toBe(bin);
    bin = withoutDeletedNote(bin, "a", "x");
    expect(Object.keys(bin)).toEqual(["b"]);
  });

  it("forgets the books untouched longest once too many are remembered", () => {
    let bin = {};
    for (let i = 0; i < 45; i++) bin = withDeletedNote(bin, `book${i}`, note("n"), i);
    const books = Object.keys(bin);
    expect(books).toHaveLength(40);
    expect(books[0]).toBe("book5");
    expect(books.at(-1)).toBe("book44");
  });
});
