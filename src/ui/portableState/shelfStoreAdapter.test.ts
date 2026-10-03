import { describe, expect, test } from "vitest";
import type { Bookmark, LinkedImportBatchResult, ShelfEntry, ShelfProgressPatch, ShelfSaveInput, ShelfSaveResult, ShelfStore } from "../shelf";
import type { ReaderNote } from "../notes";
import type { LibraryOrganization, OrganizationCommand } from "../libraryOrganization";
import { emptyOrganization } from "../libraryOrganization";
import { generateFolderId } from "../libraryOrganization";
import { MemoryPortableStateStorage } from "./memoryStorage";
import { PortableStateService } from "./service";
import { PortableShelfStore, activatePortableShelfStore } from "./shelfStoreAdapter";

const HASH = "a".repeat(64);
const LOCAL_ID = "local-bytes-1";

function entry(overrides: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    id: LOCAL_ID,
    title: "Book",
    creator: "Author",
    language: "zh",
    fileName: "book.epub",
    fileSize: 42,
    coverMime: "image/jpeg",
    addedAtMs: 1,
    lastReadAtMs: 2,
    spineIndex: 3,
    page: 4,
    progressPct: 25,
    anchorIndex: null,
    anchorRatio: null,
    anchorTextOffset: 5,
    anchorTextSnippet: "hello",
    contentHash: HASH,
    isNew: false,
    bookmarks: [],
    notes: [],
    ...overrides,
  };
}

class FakeLegacyStore implements ShelfStore {
  entries: ShelfEntry[];
  organization: LibraryOrganization = emptyOrganization();

  constructor(entries: ShelfEntry[] = []) {
    this.entries = entries;
  }

  async list(): Promise<ShelfEntry[]> {
    return this.entries.map((item) => ({ ...item }));
  }

  async save(input: ShelfSaveInput): Promise<ShelfSaveResult> {
    const entryValue = entry({
      ...input.entry,
      id: input.entry.id,
      fileSize: input.bytes.byteLength,
      coverMime: input.coverMime ?? input.entry.coverMime ?? "",
      available: true,
    });
    this.entries = [...this.entries.filter((item) => item.id !== entryValue.id), entryValue];
    return { status: "saved", entry: entryValue };
  }

  async importPaths(): Promise<LinkedImportBatchResult> {
    return { results: [] };
  }

  async readBook(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3]);
  }

  async readCover(): Promise<Uint8Array | null> {
    return null;
  }

  async setContentHash(id: string, contentHash: string): Promise<ShelfEntry> {
    const current = this.entries.find((item) => item.id === id);
    if (!current) throw new Error("missing");
    const next = { ...current, contentHash };
    this.entries = this.entries.map((item) => item.id === id ? next : item);
    return next;
  }

  async updateProgress(id: string, patch: ShelfProgressPatch): Promise<ShelfEntry> {
    const current = this.entries.find((item) => item.id === id);
    if (!current) throw new Error("missing");
    const next = { ...current, ...patch };
    this.entries = this.entries.map((item) => item.id === id ? next : item);
    return next;
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    const current = this.entries.find((item) => item.id === id);
    if (!current) throw new Error("missing");
    const next = { ...current, isNew: false };
    this.entries = this.entries.map((item) => item.id === id ? next : item);
    return next;
  }

  async setBookmarks(id: string, bookmarks: Bookmark[]): Promise<ShelfEntry> {
    const current = this.entries.find((item) => item.id === id);
    if (!current) throw new Error("missing");
    const next = { ...current, bookmarks };
    this.entries = this.entries.map((item) => item.id === id ? next : item);
    return next;
  }

  async setNotes(id: string, notes: ReaderNote[]): Promise<ShelfEntry> {
    const current = this.entries.find((item) => item.id === id);
    if (!current) throw new Error("missing");
    const next = { ...current, notes };
    this.entries = this.entries.map((item) => item.id === id ? next : item);
    return next;
  }

  async relink(): Promise<ShelfEntry> {
    throw new Error("no relink");
  }

  async replacePortableRecords(recordsInput: Parameters<ShelfStore["replacePortableRecords"]>[0]): Promise<ShelfEntry[]> {
    this.entries = recordsInput.map((record) => ({
      ...entry({ id: record.contentHash, contentHash: record.contentHash }),
      ...record,
      id: record.contentHash,
      contentHash: record.contentHash,
      fileSize: 0,
      coverMime: "",
      available: false,
    }));
    return this.entries;
  }

  async readThumbnail(): Promise<null> {
    return null;
  }

  async writeThumbnail(): Promise<void> {}

  async deleteThumbnail(): Promise<void> {}

  async deleteBook(id: string): Promise<void> {
    this.entries = this.entries.filter((item) => item.id !== id);
  }

  async getOrganization(): Promise<LibraryOrganization> {
    return this.organization;
  }

  async applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    void command;
    return this.organization;
  }

  async mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization> {
    this.organization = incoming;
    return this.organization;
  }
}

function progressPatch(): ShelfProgressPatch {
  return {
    lastReadAtMs: 99,
    spineIndex: 7,
    page: 8,
    progressPct: 40,
    anchorIndex: null,
    anchorRatio: null,
    anchorTextOffset: 9,
    anchorTextSnippet: "anchor",
    mediaAnchor: null,
  };
}

describe("CP-I portable ShelfStore facade", () => {
  test("first activation migrates old rows and keeps local ids and annotations", async () => {
    const legacy = new FakeLegacyStore([entry({
      bookmarks: [{
        id: "bm_legacy",
        spineIndex: 3,
        page: 4,
        anchorIndex: null,
        anchorRatio: null,
        anchorTextOffset: 5,
        anchorTextSnippet: "hello",
        text: "mark",
        createdAtMs: 10,
      }],
      notes: [{
        id: "note_legacy",
        spineIndex: 3,
        chapterPath: "OEBPS/ch.xhtml",
        startTextOffset: 0,
        endTextOffset: 5,
        startTextSnippet: "hello",
        endTextSnippet: "world",
        selectedText: "hello",
        content: "content",
        createdAtMs: 20,
        updatedAtMs: 30,
      }],
    })]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    const activation = await activatePortableShelfStore(legacy, service);
    expect(activation).toMatchObject({ status: "migrated", books: 1 });
    const store = new PortableShelfStore(legacy, service);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: LOCAL_ID, contentHash: HASH, title: "Book", progressPct: 25 });
    expect(entries[0].bookmarks?.[0].id).toBe("bm_legacy");
    expect(entries[0].notes?.[0].id).toBe("note_legacy");
  });

  test("progress writes use a trusted basis and are visible after restart projection", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    await store.updateProgress(LOCAL_ID, progressPatch());
    const state = await service.snapshot();
    expect(state.books[HASH].progress.versions).toHaveLength(1);
    const written = state.books[HASH].progress.versions[0].value;
    expect(written?.progressPctHint).toBe(40);
    expect(written?.locator).toMatchObject({ locatorVersion: 0, spineIndex: 7, pageHint: 8, anchorTextOffset: 9 });
  });

  test("new bookmark/note ids use explicit create and missing current ids tombstone", async () => {
    const legacy = new FakeLegacyStore([entry({
      bookmarks: [{
        id: "00000000-0000-4000-8000-000000000010",
        spineIndex: 1,
        page: 2,
        anchorIndex: null,
        anchorRatio: null,
        anchorTextOffset: null,
        anchorTextSnippet: null,
        text: "old",
        createdAtMs: 1,
      }],
    })]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const newId = generateFolderId();
    await store.setBookmarks(LOCAL_ID, [{
      id: newId,
      spineIndex: 3,
      page: 4,
      anchorIndex: null,
      anchorRatio: null,
      anchorTextOffset: 5,
      anchorTextSnippet: "hello",
      chapterPath: "OEBPS/ch.xhtml",
      text: "new",
      createdAtMs: 5,
    }]);
    const state = await service.snapshot();
    expect(Object.keys(state.books[HASH].bookmarks)).toContain(newId);
    expect(state.books[HASH].bookmarks["00000000-0000-4000-8000-000000000010"].deleted).toBeDefined();
  });

  test("archive record import merges organization in the same repository call", async () => {
    const legacy = new FakeLegacyStore([]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const folderId = generateFolderId();
    const organization: LibraryOrganization = {
      schemaVersion: 1,
      folders: { [folderId]: { name: { value: "箱", stamp: { deviceId: "00000000-0000-4000-8000-0000000000aa", counter: 1 } } } },
      books: {},
    };
    await store.replacePortableRecords([{
      contentHash: HASH,
      title: "Archived",
      creator: "Author",
      fileName: "archived.epub",
      addedAtMs: 1,
      lastReadAtMs: 0,
      spineIndex: 0,
      page: 0,
      progressPct: 0,
      anchorIndex: null,
      anchorRatio: null,
      anchorTextOffset: null,
      anchorTextSnippet: null,
      isNew: false,
      bookmarks: [],
      notes: [],
    }], organization);
    const state = await service.snapshot();
    expect(state.books[HASH].metadata.value.title).toBe("Archived");
    expect(state.organization.folders[folderId].name.value).toBe("箱");
  });

  test("organization commands use the same portable envelope as book data", async () => {
    const legacy = new FakeLegacyStore([]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const folderId = generateFolderId();
    const next = await store.applyOrganization({ type: "createFolder", folderId, name: "箱" });
    expect(next.folders[folderId].name.value).toBe("箱");
    const persisted = await service.snapshot();
    expect(persisted.organization.folders[folderId].name.value).toBe("箱");
  });

  test("legacy JSON import preserves existing v3 progress and keeps organization in the same merge", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    await store.updateProgress(LOCAL_ID, progressPatch());
    const before = await service.snapshot();
    const beforeVersions = before.books[HASH].progress.versions.length;
    const folderId = generateFolderId();
    await store.replacePortableRecords([{
      contentHash: HASH,
      title: "Imported stale title",
      creator: "Author",
      fileName: "stale.epub",
      addedAtMs: 1,
      lastReadAtMs: 1,
      spineIndex: 0,
      page: 0,
      progressPct: 5,
      anchorIndex: null,
      anchorRatio: null,
      anchorTextOffset: null,
      anchorTextSnippet: null,
      isNew: false,
      bookmarks: [],
      notes: [],
    }], {
      schemaVersion: 1,
      folders: { [folderId]: { name: { value: "箱", stamp: { deviceId: "00000000-0000-4000-8000-0000000000bb", counter: 1 } } } },
      books: {},
    });
    const after = await service.snapshot();
    expect(after.books[HASH].metadata.value.title).toBe("Book");
    expect(after.books[HASH].progress.versions).toHaveLength(beforeVersions);
    expect(after.books[HASH].progress.versions[0].value?.progressPctHint).toBe(40);
    expect(after.organization.folders[folderId].name.value).toBe("箱");
  });
});
