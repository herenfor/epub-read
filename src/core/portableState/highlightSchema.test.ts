import { describe, expect, it } from "vitest";
import { emptyOrganization } from "../../ui/libraryOrganization";
import { parsePortableStateV3 } from "./parser";
import { mergePortableState } from "./merge";
import { portableSchemaVersion, type NoteValue, type PortableStateV3 } from "./portable-state-types";

const device = "00000000-0000-4000-8000-000000000001";
const noteId = "00000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64);
const stamp = { deviceId: device, counter: 1 };
const note: NoteValue = {
  chapterPath: "c.xhtml", spineIndexHint: 0, textProfile: "visible-codepoints-no-whitespace-v1",
  startTextOffset: 0, endTextOffset: 3, startTextSnippet: "abc", endTextSnippet: "abc",
  selectedText: "abc", content: "note", createdAtMs: 1,
};
function state(value: NoteValue = note): PortableStateV3 {
  return { schemaVersion: 6, organization: emptyOrganization(), books: { [hash]: {
    metadata: { value: { title: "Book", creator: "", fileName: "book.epub", addedAtMs: 1 }, stamp },
    progress: { versions: [] }, bookmarks: {}, notes: { [noteId]: {
      versions: [{ stamp, clock: { [device]: 1 }, value, updatedAtMs: 1 }],
    } },
  } } };
}

describe("highlight schema compatibility", () => {
  it("requires v6 for pure highlights or either new field and preserves them on the wire", () => {
    for (const value of [{ ...note, content: "" }, { ...note, style: "underline" as const }, { ...note, color: "#aabbcc" as const }]) {
      const input = state(value);
      expect(portableSchemaVersion(input.books)).toBe(6);
      for (const old of [3, 4, 5]) expect(() => parsePortableStateV3({ ...input, schemaVersion: old })).toThrow();
      expect(parsePortableStateV3(JSON.parse(JSON.stringify(input))).books[hash].notes[noteId].versions[0].value).toEqual(value);
    }
    expect(parsePortableStateV3({ ...state(), schemaVersion: 8 }).schemaVersion).toBe(8);
  });

  it("keeps the v6 capability but carries nested organization data at v8", () => {
    const input = state({ ...note, content: "", style: "highlight", color: "yellow" });
    const old = state();
    const ordinary = old.books[hash].notes[noteId].versions[0];
    const concurrent = { ...old, books: { [hash]: { ...old.books[hash], notes: { [noteId]: {
      versions: [{ ...ordinary, stamp: { deviceId: noteId, counter: 1 }, clock: { [noteId]: 1 } }],
    } } } } };
    const merged = mergePortableState(input, concurrent);
    expect(merged.schemaVersion).toBe(8);
    expect(merged.books[hash].notes[noteId].versions).toHaveLength(2);
    expect(parsePortableStateV3(merged).schemaVersion).toBe(8);
    const deleted = { ...merged, books: { [hash]: { ...merged.books[hash], notes: {
      [noteId]: { versions: [], deleted: { deviceId: device, counter: 2 } },
    } } } };
    expect(portableSchemaVersion(deleted.books)).toBe(3);
    expect(parsePortableStateV3({ ...deleted, schemaVersion: 3 }).schemaVersion).toBe(3);
  });

  it("preserves the existing source-only version floors for ordinary notes", () => {
    const input = state();
    for (const [fileName, expected] of [["book.epub", 3], ["book.txt", 4], ["book.fb2", 5], ["book.mobi", 7], ["book.azw3", 7]] as const) {
      const books = { [hash]: { ...input.books[hash], metadata: { ...input.books[hash].metadata,
        value: { ...input.books[hash].metadata.value, fileName } } } };
      expect(portableSchemaVersion(books)).toBe(expected);
      expect(parsePortableStateV3({ ...input, books, schemaVersion: expected }).schemaVersion).toBe(expected);
    }
  });
});
