import { describe, expect, test } from "vitest";
import { emptyOrganization } from "../../ui/libraryOrganization";
import { annotationFromInitialStamp, legacyLocatorFromReadingFields, upgradeLegacyLocator, versionFromInitialStamp } from "./legacy";
import { maximumPortableStateReceivedCounter, mergePortableBook, mergeRegister } from "./merge";
import { parseLocator, parseNoteValue, parsePortableStateV3, tryParsePortableStateV3 } from "./parser";
import { writeObserved } from "./portable-register-core";
import type { BookmarkValue, PortableStateV3, ProgressValue } from "./portable-state-types";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);
const stamp = (deviceId: string, counter: number) => ({ deviceId, counter });

const locator = {
  locatorVersion: 1 as const,
  chapterPath: "OEBPS/chapter-1.xhtml",
  spineIndexHint: 0,
  target: { kind: "text" as const, textProfile: "visible-codepoints-no-whitespace-v1" as const, offset: 12, snippet: "hello" },
};

function progressVersion(stampValue: ReturnType<typeof stamp>, offset: number, updatedAtMs: number) {
  return versionFromInitialStamp<ProgressValue>(stampValue, {
    locator: { ...locator, target: { ...locator.target, offset } },
    progressPctHint: 10,
  }, updatedAtMs);
}

function fixture(): PortableStateV3 {
  return {
    schemaVersion: 3,
    books: {
      [HASH]: {
        metadata: { value: { title: "Book", creator: "Author", fileName: "book.epub", addedAtMs: 1 }, stamp: stamp(A, 1) },
        progress: { versions: [progressVersion(stamp(A, 2), 10, 100)] },
        bookmarks: {},
        notes: {},
      },
    },
    organization: emptyOrganization(),
  };
}

describe("portable state parser", () => {
  test("parses the frozen v3 wire and preserves explicit null progress", () => {
    const parsed = parsePortableStateV3(fixture());
    expect(parsed.books[HASH].progress.versions).toHaveLength(1);
    const reset: PortableStateV3 = {
      ...fixture(),
      books: {
        [HASH]: {
          ...fixture().books[HASH],
          progress: { versions: [progressVersion(stamp(A, 3), 99, 101)] },
        },
      },
    };
    const withNull = {
      ...reset,
      books: {
        [HASH]: {
          ...reset.books[HASH],
          progress: { versions: [{ ...reset.books[HASH].progress.versions[0], value: null }] },
        },
      },
    };
    expect(parsePortableStateV3(withNull).books[HASH].progress.versions[0].value).toBeNull();
  });

  test("rejects unknown fields, missing null rules and non-canonical UUIDs", () => {
    const extra = { ...fixture(), extra: true };
    expect(tryParsePortableStateV3(extra).errors[0]).toMatchObject({ code: "unknown-field" });
    expect(tryParsePortableStateV3(extra, { unknownFields: "ignore" }).state).not.toBeNull();
    expect(() => parseLocator({ locatorVersion: 0, spineIndex: 0, pageHint: 0, anchorIndex: null, anchorRatio: null, anchorTextOffset: null, anchorTextSnippet: null, mediaAnchor: null, extra: 1 })).toThrow(/unknown field/);
    const nestedExtra = fixture();
    const nestedRaw = { ...nestedExtra, books: { ...nestedExtra.books } };
    const nestedBook = nestedRaw.books[HASH];
    nestedRaw.books[HASH] = {
      ...nestedBook,
      progress: { ...nestedBook.progress, extra: true },
    } as unknown as typeof nestedBook;
    expect(tryParsePortableStateV3(nestedRaw, { unknownFields: "ignore" }).state).not.toBeNull();
    const badClock = fixture();
    const version = badClock.books[HASH].progress.versions[0];
    const invalid = {
      ...badClock,
      books: {
        [HASH]: {
          ...badClock.books[HASH],
          progress: { versions: [{ ...version, stamp: stamp("not-a-uuid", 2) }] },
        },
      },
    };
    expect(tryParsePortableStateV3(invalid).errors.some((issue) => issue.code === "invalid-stamp")).toBe(true);
  });

  test("a legacy locator preserves old fields until a book can resolve it", () => {
    const legacy = legacyLocatorFromReadingFields({
      spineIndex: 4,
      page: 9,
      anchorIndex: 2,
      anchorRatio: 0.25,
      anchorTextOffset: null,
      anchorTextSnippet: null,
      mediaAnchor: { index: 1, tag: "img", signature: "figure-1", ratio: 0.4 },
    });
    expect(legacy).toMatchObject({ locatorVersion: 0, spineIndex: 4, pageHint: 9, anchorIndex: 2, anchorRatio: 0.25 });
    expect(upgradeLegacyLocator(legacy, "OEBPS/ch.xhtml")).toMatchObject({
      locatorVersion: 1,
      chapterPath: "OEBPS/ch.xhtml",
      target: { kind: "media", signature: "figure-1", tag: "img" },
    });
    const unresolved = upgradeLegacyLocator({ ...legacy, mediaAnchor: { index: 1, tag: "figure", signature: "x", ratio: 0.4 } }, "OEBPS/ch.xhtml");
    expect(unresolved).toBeNull();
  });

  test("merge keeps concurrent progress branches and tombstone clocks stay visible to allocation", () => {
    const initial = writeObserved([], [], stamp(A, 1), { locator: locator, progressPctHint: 1 }, 1);
    const left = writeObserved(initial, initial, stamp(A, 2), { locator: locator, progressPctHint: 2 }, 2);
    const right = writeObserved(initial, initial, stamp(B, 2), { locator: locator, progressPctHint: 3 }, 3);
    const localBook = fixture().books[HASH];
    const merged = mergePortableBook({ ...localBook, progress: { versions: left } }, { ...localBook, progress: { versions: right } });
    expect(merged.progress.versions).toHaveLength(2);

    const tombstoned: PortableStateV3 = {
      ...fixture(),
      books: {
        [HASH]: {
          ...fixture().books[HASH],
          notes: {
            "note-1": annotationFromInitialStamp(stamp(B, 80), {
              chapterPath: "OEBPS/ch.xhtml",
              spineIndexHint: 0,
              textProfile: "visible-codepoints-no-whitespace-v1",
              startTextOffset: 0,
              endTextOffset: 5,
              startTextSnippet: "hello",
              endTextSnippet: "world",
              selectedText: "hello",
              content: "note",
              createdAtMs: 1,
            }, 1),
          },
        },
      },
    };
    const withTombstone = {
      ...tombstoned,
      books: {
        [HASH]: {
          ...tombstoned.books[HASH],
          notes: { "note-1": { versions: [], deleted: stamp(A, 90) } },
        },
      },
    };
    expect(maximumPortableStateReceivedCounter(withTombstone)).toBe(90);
    expect(mergeRegister({ value: 1, stamp: stamp(A, 2) }, { value: 1, stamp: stamp(B, 3) })).toMatchObject({ stamp: stamp(B, 3) });
    expect(() => mergeRegister({ value: 1, stamp: stamp(A, 2) }, { value: 2, stamp: stamp(A, 2) })).toThrow(/collision/);
  });

  test("preferences use explicit whitelisted ranges", () => {
    const parsed = parsePortableStateV3({
      ...fixture(),
      preferences: { theme: "sepia", fontSizePx: 18, lineHeight: 1.8 },
    });
    expect(parsed.preferences).toMatchObject({ theme: "sepia", fontSizePx: 18, lineHeight: 1.8 });
    const invalid = tryParsePortableStateV3({ ...fixture(), preferences: { fontSizePx: 100 } });
    expect(invalid.state).toBeNull();
    expect(invalid.errors.some((issue) => issue.code === "invalid-preference")).toBe(true);
  });

  test("note values keep the existing code-point range and limits", () => {
    const note = parseNoteValue({
      chapterPath: "OEBPS/ch1.xhtml",
      spineIndexHint: 1,
      textProfile: "visible-codepoints-no-whitespace-v1",
      startTextOffset: 2,
      endTextOffset: 7,
      startTextSnippet: "hello",
      endTextSnippet: "world",
      selectedText: "hello",
      content: "note body",
      createdAtMs: 10,
    });
    expect(note.endTextOffset - note.startTextOffset).toBe(5);
    expect(() => parseNoteValue({
      ...note,
      selectedText: "hello",
      endTextOffset: 8,
    })).toThrow(/selectedText/);
  });

  test("bookmark conversion preserves old id, created time and locator fields", () => {
    const sourceVersion = annotationFromInitialStamp<BookmarkValue>(stamp(A, 7), {
      locator: legacyLocatorFromReadingFields({ spineIndex: 3, page: 4, anchorIndex: null, anchorRatio: null, anchorTextOffset: 5, anchorTextSnippet: "ab" }),
      text: "old bookmark",
      createdAtMs: 1234,
    }, 1234);
    expect(Object.keys(sourceVersion)[0]).toBe("versions");
    expect(sourceVersion.versions[0].updatedAtMs).toBe(1234);
    expect(sourceVersion.versions[0].value.createdAtMs).toBe(1234);
    expect(sourceVersion.versions[0].value.locator).toMatchObject({ locatorVersion: 0, spineIndex: 3, pageHint: 4 });
  });
});
