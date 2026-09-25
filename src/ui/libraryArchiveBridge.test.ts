import { describe, expect, it } from "vitest";
import type { ShelfEntry } from "./shelf";
import {
  archiveRecordsForBackend,
  buildLibraryArchive,
  projectArchiveToBrowserShelf,
} from "./libraryArchiveBridge";
import { emptyOrganization } from "./libraryOrganization";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function entry(hash: string, extra: Record<string, unknown> = {}): ShelfEntry {
  return {
    id: `bytes-${hash.slice(0, 4)}`,
    title: "Title / file:// is ordinary metadata",
    creator: "Creator",
    language: "ja-JP",
    fileName: "book.epub",
    fileSize: 42,
    coverMime: "image/jpeg",
    addedAtMs: 10,
    lastReadAtMs: 20,
    spineIndex: 1,
    page: 2,
    progressPct: 30,
    anchorIndex: 4,
    anchorRatio: 0.5,
    contentHash: hash,
    isNew: false,
    bookmarks: [],
    ...extra,
  };
}

describe("library archive bridge", () => {
  it("whitelists portable fields and strips device metadata and paths", () => {
    const source = {
      ...entry(hashA, { fileName: "C:\\Users\\me\\book.epub", sourcePath: "/home/me/book.epub" }),
      available: true,
      bytes: new Uint8Array([1, 2, 3]),
    } as ShelfEntry & { available: boolean; bytes: Uint8Array; sourcePath: string };
    const archive = buildLibraryArchive([source], emptyOrganization(), {
      fontSizePx: 18,
      theme: "dark",
      uiScale: 1.1,
      forceHorizontal: true,
      preloadNextChapter: true,
      customFonts: [{ family: "private", url: "file:///C:/private.woff2" }],
    });
    const json = JSON.stringify(archive);
    expect(json).not.toContain("sourcePath");
    expect(json).not.toContain("Users");
    expect(json).not.toContain("available");
    expect(json).not.toContain("fileSize");
    expect(json).not.toContain("coverMime");
    expect(json).not.toContain("customFonts");
    expect(archive.version).toBe(2);
    expect(archive.records[hashA].fileName).toBe("book.epub");
    expect(archive.records[hashA].language).toBe("ja-JP");
    expect(archive.records[hashA].anchorTextOffset).toBeNull();
    expect(archive.records[hashA].anchorTextSnippet).toBeNull();
    expect(archive.settings).toEqual({ fontSizePx: 18, theme: "dark", forceHorizontal: true, preloadNextChapter: true, uiScale: 1.1 });
    expect(archive.organization).toEqual(emptyOrganization());
  });

  it("round-trips text anchors through the portable bridge", () => {
    const archive = buildLibraryArchive([
      entry(hashA, { anchorTextOffset: 7, anchorTextSnippet: "😀正文" }),
    ], emptyOrganization());
    const projected = projectArchiveToBrowserShelf([], archive);
    expect(projected[0]).toMatchObject({
      anchorTextOffset: 7,
      anchorTextSnippet: "😀正文",
    });
  });

  it("keeps a text-only bookmark portable without serializing the internal legacy sentinel", () => {
    const archive = buildLibraryArchive([
      entry(hashA, {
        bookmarks: [{
          id: "b",
          spineIndex: 1,
          page: 2,
          anchorIndex: null,
          anchorRatio: null,
          anchorTextOffset: 42,
          anchorTextSnippet: "正文",
          text: "正文",
          createdAtMs: 1,
        }],
      }),
    ], emptyOrganization());
    const bookmark = archive.records[hashA].bookmarks[0];
    expect(bookmark).toMatchObject({
      anchorIndex: null,
      anchorRatio: null,
      anchorTextOffset: 42,
      anchorTextSnippet: "正文",
    });
    expect(archiveRecordsForBackend(archive)[0].bookmarks[0]).toMatchObject(bookmark);
  });

  it("returns a backend array without the keyed records wrapper", () => {
    const archive = buildLibraryArchive([entry(hashA)], emptyOrganization());
    const records = archiveRecordsForBackend(archive);
    expect(records).toHaveLength(1);
    expect(records[0].contentHash).toBe(hashA);
    expect(JSON.stringify(records)).not.toContain("fileSize");
  });

  it("projects archive state while preserving browser byte identity and local metadata", () => {
    const local = {
      ...entry(hashA, { title: "old", fileSize: 99, coverMime: "image/png" }),
      available: true,
      sourcePath: "C:\\Users\\me\\book.epub",
    } as ShelfEntry & { available: boolean; sourcePath: string };
    const archive = buildLibraryArchive([
      entry(hashA, { title: "new", progressPct: 80 }),
      entry(hashB, { title: "remote" }),
    ], emptyOrganization());
    const projected = projectArchiveToBrowserShelf([local], archive);
    expect(projected).toHaveLength(2);
    expect(projected[0].id).toBe(local.id);
    expect(projected[0].title).toBe("new");
    expect(projected[0].language).toBe("ja-JP");
    expect(projected[0].fileSize).toBe(99);
    expect(projected[0].coverMime).toBe("image/png");
    expect(projected[0].available).toBe(true);
    expect(projected[1].id).toBe(hashB);
    expect(projected[1].available).toBe(false);
    expect(projected[1].fileSize).toBe(0);
    expect(JSON.stringify(projected)).not.toContain("sourcePath");
    expect(JSON.stringify(projected)).not.toContain("Users");
  });

  it("embeds and validates organization in v2 archive", () => {
    const folderId = "3f2a6c1e-9b4d-4f0a-8c2e-5d6b7a8c9d0e";
    const customOrg = {
      schemaVersion: 1 as const,
      folders: {
        [folderId]: {
          name: { value: "科幻", stamp: { counter: 1, deviceId: "00000000-0000-4000-8000-00000000000a" } },
        },
      },
      books: {
        [hashA]: {
          favorite: { value: true, stamp: { counter: 2, deviceId: "00000000-0000-4000-8000-00000000000a" } },
          folderId: { value: folderId, stamp: { counter: 3, deviceId: "00000000-0000-4000-8000-00000000000a" } },
        },
      },
    };
    const archive = buildLibraryArchive([entry(hashA)], customOrg);
    expect(archive.version).toBe(2);
    expect(archive.organization.folders[folderId].name.value).toBe("科幻");
    expect(archive.organization.books[hashA].favorite?.value).toBe(true);
    expect(archive.organization.books[hashA].folderId?.value).toBe(folderId);
  });
});
