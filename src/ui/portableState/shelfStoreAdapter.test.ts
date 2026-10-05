import { describe, expect, test, vi } from "vitest";
import type { Bookmark, LinkedImportBatchResult, ShelfEntry, ShelfProgressPatch, ShelfSaveInput, ShelfSaveResult, ShelfStore } from "../shelf";
import type { ReaderNote } from "../notes";
import type { LibraryOrganization, OrganizationCommand } from "../libraryOrganization";
import { emptyOrganization } from "../libraryOrganization";
import { generateFolderId } from "../libraryOrganization";
import { MemoryPortableStateStorage } from "./memoryStorage";
import { PortableStateError, PortableStateService } from "./service";
import { PortableShelfStore, activatePortableShelfStore } from "./shelfStoreAdapter";
import { latestVersion } from "../../core/portableState/projection";
import type { NoteValue } from "../../core/portableState/portable-state-types";
import { ScopedProgressWriter, ShelfProgressWriter } from "../progressWriter";
import { planFreshProgressOpen } from "../progressOpenOrder";
import type { PortableShelfEntry } from "./projection";

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

function noteValue(content: string): NoteValue {
  return {
    chapterPath: "OEBPS/ch.xhtml",
    spineIndexHint: 0,
    textProfile: "visible-codepoints-no-whitespace-v1",
    startTextOffset: 0,
    endTextOffset: 5,
    startTextSnippet: "hello",
    endTextSnippet: "world",
    selectedText: "hello",
    content,
    createdAtMs: 10,
  };
}

function readerNote(id: string, content: string): ReaderNote {
  return { ...noteValue(content), id, spineIndex: 0, updatedAtMs: 10 };
}

async function beginLatestProgress(
  store: PortableShelfStore,
  service: PortableStateService,
): Promise<void> {
  const versions = (await service.snapshot()).books[HASH].progress.versions;
  const latest = latestVersion(versions);
  await store.beginProgressSession(
    LOCAL_ID,
    latest ? { kind: "chosen", stamp: latest.stamp } : { kind: "empty" },
  );
}

describe("CP-I portable ShelfStore facade", () => {
  test("native import returns the reset progress basis and current annotations", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const noteId = generateFolderId();
    await store.createNote(LOCAL_ID, readerNote(noteId, "keep this note"));
    const read = await service.read({ bookHash: HASH });
    const { basisId } = await service.adopt({
      readId: read.readId,
      entity: { bookHash: HASH, kind: "progress" },
      selection: { kind: "shown-all" },
    });
    await service.write({ basisId, intent: "reset", value: null, updatedAtMs: 100 });
    const [imported] = await store.importRecords([entry({ available: true, lastReadAtMs: 0 })]);
    expect(imported.available).toBe(true);
    const projected = imported as PortableShelfEntry;
    expect(projected.portableProgressVersions).toHaveLength(1);
    expect(projected.portableProgressVersions[0].value).toBeNull();
    expect(imported.notes?.some((note) => note.id === noteId && note.content === "keep this note"))
      .toBe(true);
    await expect(store.beginProgressSession(LOCAL_ID, {
      kind: "chosen", stamp: projected.portableProgressVersions[0].stamp,
    })).resolves.toBeUndefined();
    await store.closeProgressSession(LOCAL_ID);
    await service.release({ readId: read.readId });
  });

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
    await beginLatestProgress(store, service);
    await store.updateProgress(LOCAL_ID, progressPatch());
    const state = await service.snapshot();
    expect(state.books[HASH].progress.versions).toHaveLength(1);
    const written = state.books[HASH].progress.versions[0].value;
    expect(written?.progressPctHint).toBe(40);
    expect(written?.locator).toMatchObject({ locatorVersion: 0, spineIndex: 7, pageHint: 8, anchorTextOffset: 9 });
  });

  test("exact lease stale write is unconfirmed and does not silently adopt latest", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const first = new PortableShelfStore(legacy, service);
    const second = new PortableShelfStore(legacy, service);
    const initial = latestVersion((await service.snapshot()).books[HASH].progress.versions)!;
    const firstLease = await first.prepareProgressSession(LOCAL_ID, { kind: "chosen", stamp: initial.stamp });
    first.activateProgressSession(firstLease);
    await first.updateProgressForSession(firstLease, { ...progressPatch(), page: 8, anchorTextOffset: 8 });

    const afterFirst = latestVersion((await service.snapshot()).books[HASH].progress.versions)!;
    const secondLease = await second.prepareProgressSession(LOCAL_ID, { kind: "chosen", stamp: afterFirst.stamp });
    second.activateProgressSession(secondLease);
    await second.updateProgressForSession(secondLease, { ...progressPatch(), page: 20, anchorTextOffset: 20 });

    const stale = await first.updateProgressForSession(firstLease, { ...progressPatch(), page: 9, anchorTextOffset: 9 });
    expect(stale.status).toBe("unconfirmed");
    if (stale.status === "unconfirmed") {
      expect(["progress-needs-choice", "progress-write-interrupted"]).toContain(stale.code);
    }
    const versions = (await service.snapshot()).books[HASH].progress.versions;
    expect(versions.some((version) =>
      version.value?.locator.locatorVersion === 0 && version.value.locator.pageHint === 9,
    )).toBe(false);
    expect(latestVersion(versions)?.value?.locator).toMatchObject({ pageHint: 20 });

    await first.closeProgressLease(firstLease);
    await second.closeProgressLease(secondLease);
  });

  test("open_order flushes before reading and choosing the current single-book progress", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const oldEntry = await store.readProgressEntryForOpen(LOCAL_ID) as PortableShelfEntry;
    const old = latestVersion(oldEntry.portableProgressVersions)!;
    const lease = await store.prepareProgressSession(LOCAL_ID, { kind: "chosen", stamp: old.stamp });
    store.activateProgressSession(lease);
    const writer = new ScopedProgressWriter<ShelfProgressPatch>(0);
    writer.register(lease, async (patch) => {
      const result = await store.updateProgressForSession(lease, patch);
      if (result.status !== "saved") throw new Error(result.code);
    });
    writer.enqueue(lease, progressPatch());
    const plan = await planFreshProgressOpen({
      flushTarget: () => writer.flush(lease),
      readCurrent: async () => {
        const spy = vi.spyOn(service, "snapshot");
        try {
          const current = await store.readProgressEntryForOpen(LOCAL_ID) as PortableShelfEntry;
          expect(spy).not.toHaveBeenCalled();
          return current;
        } finally { spy.mockRestore(); }
      },
      choose: async (current) => ({
        explicitPositionChoice: false,
        stamp: latestVersion(current.portableProgressVersions)!.stamp,
      }),
    });
    expect(plan!.decision.stamp).not.toEqual(old.stamp);
    const candidate = await store.prepareProgressSession(LOCAL_ID, { kind: "chosen", stamp: plan!.decision.stamp });
    expect(store.hasProgressSession(lease)).toBe(true);
    await store.closeProgressLease(candidate);
    writer.retire(lease);
    await store.closeProgressLease(lease);
    writer.disposeTimers();
  });

  test("open_order native key reordering retains the actual written stamp and permits rebind", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const initial = latestVersion((await service.snapshot()).books[HASH].progress.versions)!;
    const lease = await store.prepareProgressSession(LOCAL_ID, { kind: "chosen", stamp: initial.stamp });
    store.activateProgressSession(lease);
    const write = service.write.bind(service);
    service.write = async (input) => {
      const result = await write(input);
      const state = result.state as { versions: typeof initial[] };
      return { ...result, state: { versions: state.versions.map((version) => ({
        ...version,
        value: version.value ? { progressPctHint: version.value.progressPctHint, locator: version.value.locator } : null,
      })) } };
    };
    const saved = await store.updateProgressForSession(lease, progressPatch());
    expect(saved.status).toBe("saved");
    const written = latestVersion((await service.snapshot()).books[HASH].progress.versions)!;
    expect(store.progressSessionChosenStamp(lease)).toEqual(written.stamp);
    await expect(store.rebindProgressSession(lease)).resolves.toBeUndefined();
    await store.closeProgressLease(lease);
  });

  test("exact progress lease close preserves a same-book note basis", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const latest = latestVersion((await service.snapshot()).books[HASH].progress.versions);
    const lease = await store.prepareProgressSession(
      LOCAL_ID,
      latest ? { kind: "chosen", stamp: latest.stamp } : { kind: "empty" },
    );
    store.activateProgressSession(lease);

    const noteRead = await service.read({ bookHash: HASH });
    const note = await service.adopt({
      readId: noteRead.readId,
      entity: { bookHash: HASH, kind: "note", id: "synthetic-note" },
      selection: { kind: "empty" },
    });

    await store.updateProgressForSession(lease, { ...progressPatch(), page: 12, anchorTextOffset: 12 });
    await store.closeProgressLease(lease);

    // v3 progress release must not clear the same-book note basis/read.
    await expect(service.write({
      basisId: note.basisId,
      intent: "auto",
      value: null,
      updatedAtMs: 2,
    })).rejects.toMatchObject({ code: "invalid-intent" });
    await service.release({ basisId: note.basisId });
    await service.release({ readId: noteRead.readId });

    const written = latestVersion((await service.snapshot()).books[HASH].progress.versions);
    expect(written?.value?.locator).toMatchObject({ locatorVersion: 0, pageHint: 12, anchorTextOffset: 12 });
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

  test("B5 legacy import absorbs incoming organization counter", async () => {
    const legacy = new FakeLegacyStore([]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const folderId = generateFolderId();
    const remote = "00000000-0000-4000-8000-0000000000dd";
    await store.replacePortableRecords([], {
      schemaVersion: 1,
      folders: {
        [folderId]: {
          name: {
            value: "箱",
            stamp: { deviceId: remote, counter: 999 },
          },
        },
      },
      books: {},
    });
    const next = await service.reserveStamps(1);
    expect(next.counter).toBeGreaterThan(999);
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
    await beginLatestProgress(store, service);
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
  test("review_stale progress samples preserve the newer position and allow exit", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const oldSession = new PortableShelfStore(legacy, service);
    const otherSession = new PortableShelfStore(legacy, service);

    await beginLatestProgress(oldSession, service);
    await oldSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 8, anchorTextOffset: 8 });

    await beginLatestProgress(otherSession, service);
    await otherSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 20, anchorTextOffset: 20 });

    // The old session submits its already-superseded sample. It must be
    // dropped, not retried against the new basis.
    const read = service.read.bind(service);
    service.read = async () => { throw new PortableStateError("storage-error", "read failed"); };
    await expect(oldSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 9, anchorTextOffset: 9 }))
      .rejects.toMatchObject({ code: "storage-error" });
    service.read = read;
    await oldSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 9, anchorTextOffset: 9 });

    const state = await service.snapshot();
    const versions = state.books[HASH].progress.versions;
    const latest = versions[versions.length - 1];
    expect(latest.value?.locator).toMatchObject({ pageHint: 20 });
    expect(versions.some((version) =>
      version.value?.locator.locatorVersion === 0 && version.value.locator.pageHint === 9,
    )).toBe(false);

    // The expired session must not silently adopt the merged winner. A later
    // sample is rejected explicitly until the book is reopened/reselected.
    await expect(
      oldSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 10, anchorTextOffset: 10 }),
    ).rejects.toThrow("进度基线已过期");
    const preserved = (await service.snapshot()).books[HASH].progress.versions;
    expect(latestVersion(preserved)?.value?.locator).toMatchObject({ pageHint: 20 });

    const writer = new ShelfProgressWriter(async (id, patch) => {
      await oldSession.updateProgress(id, patch);
    });
    try {
      writer.enqueue(LOCAL_ID, { ...progressPatch(), page: 10, anchorTextOffset: 10 });
      await expect(writer.flush()).resolves.toBeUndefined();
      await oldSession.closeProgressSession(LOCAL_ID);
      expect(latestVersion((await service.snapshot()).books[HASH].progress.versions)?.value?.locator)
        .toMatchObject({ pageHint: 20 });
    } finally {
      writer.dispose();
    }
  });

  test("review_progress session never adopts a remote version received during projection", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const oldSession = new PortableShelfStore(legacy, service);
    const otherSession = new PortableShelfStore(legacy, service);
    const initial = latestVersion((await service.snapshot()).books[HASH].progress.versions)!;
    await oldSession.beginProgressSession(LOCAL_ID, { kind: "chosen", stamp: initial.stamp });

    // Inject a concurrent device version after the transactional write and
    // before its returned shelf projection. It has never been displayed.
    const snapshot = service.snapshot.bind(service);
    const remoteId = "00000000-0000-4000-8000-000000000099";
    let injectRemote = true;
    service.snapshot = async () => {
      if (injectRemote) {
        injectRemote = false;
        const incoming = JSON.parse(JSON.stringify(await snapshot()));
        incoming.books[HASH].progress.versions = [{
          stamp: { deviceId: remoteId, counter: 999 },
          clock: { [remoteId]: 999 },
          value: { ...initial.value, locator: { ...initial.value!.locator, pageHint: 99 } },
          updatedAtMs: 999,
        }];
        await service.mergeValidatedState(incoming);
      }
      return snapshot();
    };
    await oldSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 8, anchorTextOffset: 8 });
    const ownVersion = (await snapshot()).books[HASH].progress.versions
      .find((version) => version.stamp.deviceId === initial.stamp.deviceId)!;
    await otherSession.beginProgressSession(LOCAL_ID, { kind: "chosen", stamp: ownVersion.stamp });
    await otherSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 20, anchorTextOffset: 20 });
    await oldSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 9, anchorTextOffset: 9 });
    await expect(oldSession.updateProgress(LOCAL_ID, { ...progressPatch(), page: 10, anchorTextOffset: 10 }))
      .rejects.toMatchObject({ code: "stale-basis" });

    const versions = (await snapshot()).books[HASH].progress.versions;
    expect(versions).toHaveLength(2);
    expect(versions.some((version) => version.stamp.deviceId === remoteId && version.stamp.counter === 999))
      .toBe(true);
    expect(latestVersion(versions)?.value?.locator).toMatchObject({ pageHint: 20 });
  });

  test("B3 single displayed progress is bound before parse and never silently replaced", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);

    const displayed = latestVersion((await service.snapshot()).books[HASH].progress.versions);
    expect(displayed).not.toBeNull();
    const incoming = JSON.parse(JSON.stringify(await service.snapshot())) as any;
    const deviceId = displayed!.stamp.deviceId;
    const counter = displayed!.stamp.counter + 10;
    incoming.books[HASH].progress.versions = [{
      stamp: { deviceId, counter },
      clock: { [deviceId]: counter },
      value: { ...displayed!.value, progressPctHint: 50 },
      updatedAtMs: displayed!.updatedAtMs + 1,
    }];
    await service.mergeValidatedState(incoming);

    // The displayed version is dominated by the merge. The pre-parse binding
    // must fail explicitly instead of adopting the newer unshown branch.
    await expect(
      store.beginProgressSession(LOCAL_ID, { kind: "chosen", stamp: displayed!.stamp }),
    ).rejects.toThrow();
    const state = await service.snapshot();
    expect(latestVersion(state.books[HASH].progress.versions)?.value?.progressPctHint).toBe(50);
  });

  test("closing a reading session releases its handles and a later update starts fresh", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);

    await beginLatestProgress(store, service);
    await store.closeProgressSession(LOCAL_ID);
    // No stale readId/basis may leak into the next real sample.
    await beginLatestProgress(store, service);
    await store.updateProgress(LOCAL_ID, progressPatch());

    const state = await service.snapshot();
    expect(latestVersion(state.books[HASH].progress.versions)?.value?.progressPctHint).toBe(40);
  });

  test("a newer background annotation is not overwritten when the user edits another note", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);

    const noteAId = generateFolderId();
    const noteBId = generateFolderId();
    await store.createNote(LOCAL_ID, readerNote(noteAId, "old-A"));
    await store.createNote(LOCAL_ID, readerNote(noteBId, "old-B"));

    const before = await service.snapshot();
    const noteB = before.books[HASH].notes[noteBId];
    const displayedB = latestVersion(noteB.versions);
    expect(displayedB).not.toBeNull();

    // Simulate a background merge that adds a remote version to A only.
    const incoming = JSON.parse(JSON.stringify(before)) as any;
    const remoteDevice = "00000000-0000-4000-8000-0000000000cc";
    const remoteStamp = { deviceId: remoteDevice, counter: 999 };
    incoming.books[HASH].notes[noteAId].versions.push({
      stamp: remoteStamp,
      clock: { [remoteDevice]: 999 },
      value: { ...noteValue("remote-A"), createdAtMs: 1 },
      updatedAtMs: 999,
    });
    await service.mergeValidatedState(incoming);

    const editedB = readerNote(noteBId, "edited-B");
    const editContext = await store.beginNoteEdit(LOCAL_ID, noteBId, displayedB!.stamp);
    expect(editContext).not.toBeNull();
    await store.writeNoteEdit(LOCAL_ID, { ...editedB, updatedAtMs: 1000 }, editContext!);
    await store.endNoteEdit(editContext!);

    const after = await service.snapshot();
    const storedA = after.books[HASH].notes[noteAId];
    const storedB = after.books[HASH].notes[noteBId];
    expect(storedA.versions.some((version) => version.value.content === "remote-A")).toBe(true);
    expect(latestVersion(storedA.versions)?.value.content).toBe("remote-A");
    expect(latestVersion(storedB.versions)?.value.content).toBe("edited-B");
  });

  test("B2 editor context keeps a concurrent background version of the same note", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);

    const noteId = generateFolderId();
    await store.createNote(LOCAL_ID, readerNote(noteId, "old-A"));
    const before = await service.snapshot();
    const displayed = latestVersion(before.books[HASH].notes[noteId].versions);
    expect(displayed).not.toBeNull();

    const incoming = JSON.parse(JSON.stringify(before)) as any;
    const remoteDevice = "00000000-0000-4000-8000-0000000000cd";
    incoming.books[HASH].notes[noteId].versions.push({
      stamp: { deviceId: remoteDevice, counter: 999 },
      clock: { [remoteDevice]: 999 },
      value: { ...noteValue("remote-A"), createdAtMs: 1 },
      updatedAtMs: 999,
    });
    await service.mergeValidatedState(incoming);

    const context = await store.beginNoteEdit(LOCAL_ID, noteId, displayed!.stamp);
    expect(context).not.toBeNull();
    const edited = readerNote(noteId, "edited-A");
    await store.writeNoteEdit(LOCAL_ID, { ...edited, updatedAtMs: 1000 }, context!);
    await store.endNoteEdit(context!);

    const after = await service.snapshot();
    const contents = after.books[HASH].notes[noteId].versions.map(
      (version) => version.value.content,
    );
    expect(contents).toContain("remote-A");
    expect(contents).toContain("edited-A");
  });

  test("legacy archive import adds missing note/book and preserves existing v3 progress", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    const before = await service.snapshot();
    const beforePct = latestVersion(before.books[HASH].progress.versions)?.value?.progressPctHint;

    const newNoteId = "note_new";
    await store.replacePortableRecords([{
      contentHash: HASH,
      title: "stale title",
      creator: "Stale",
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
      notes: [{
        id: newNoteId,
        spineIndex: 0,
        chapterPath: "OEBPS/ch.xhtml",
        startTextOffset: 0,
        endTextOffset: 5,
        startTextSnippet: "hello",
        endTextSnippet: "world",
        selectedText: "hello",
        content: "new note",
        createdAtMs: 20,
        updatedAtMs: 30,
      }],
    }]);

    const after = await service.snapshot();
    const afterPct = latestVersion(after.books[HASH].progress.versions)?.value?.progressPctHint;
    expect(after.books[HASH].metadata.value.title).toBe("Book");
    expect(after.books[HASH].notes[newNoteId]).toBeDefined();
    expect(afterPct).toBe(beforePct);

    const missingHash = "b".repeat(64);
    await store.replacePortableRecords([{
      contentHash: missingHash,
      title: "Missing source",
      creator: "Author",
      fileName: "missing.epub",
      addedAtMs: 2,
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
    }]);
    const entries = await store.list();
    expect(entries.find((item) => item.id === missingHash)).toMatchObject({
      id: missingHash,
      available: false,
    });
  });

  test("displayed chapter path upgrades a new progress sample to a modern locator", async () => {
    const legacy = new FakeLegacyStore([entry()]);
    const service = new PortableStateService(new MemoryPortableStateStorage());
    await activatePortableShelfStore(legacy, service);
    const store = new PortableShelfStore(legacy, service);
    await beginLatestProgress(store, service);
    await store.updateProgress(LOCAL_ID, {
      ...progressPatch(),
      chapterPath: "OEBPS/ch.xhtml",
    });

    const state = await service.snapshot();
    const latest = latestVersion(state.books[HASH].progress.versions);
    expect(latest?.value?.locator).toMatchObject({
      locatorVersion: 1,
      chapterPath: "OEBPS/ch.xhtml",
      target: {
        kind: "text",
        textProfile: "visible-codepoints-no-whitespace-v1",
        offset: 9,
        snippet: "anchor",
      },
    });
  });

});
