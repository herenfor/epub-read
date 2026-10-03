import { describe, expect, test } from "vitest";
import { emptyOrganization } from "../libraryOrganization";
import {
  annotationFromInitialStamp,
  versionFromInitialStamp,
} from "../../core/portableState/legacy";
import type { Annotation } from "../../core/portableState/portable-register-core";
import type {
  BookmarkValue,
  PortableStateV3,
  ProgressValue,
} from "../../core/portableState/portable-state-types";
import { MemoryPortableStateStorage } from "./memoryStorage";
import { migrateLegacyShelfEntries, planLegacyShelfMigration } from "./legacyShelf";
import { PortableStateError, PortableStateService, type PortableProgressEntityState } from "./service";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);
const BOOKMARK_ID = "00000000-0000-4000-8000-000000000010";
const stamp = (deviceId: string, counter: number) => ({ deviceId, counter });

const locator = {
  locatorVersion: 1 as const,
  chapterPath: "OEBPS/chapter-1.xhtml",
  spineIndexHint: 0,
  target: {
    kind: "text" as const,
    textProfile: "visible-codepoints-no-whitespace-v1" as const,
    offset: 10,
    snippet: "hello",
  },
};

function progressValue(offset: number, progressPctHint = 10): ProgressValue {
  return {
    locator: { ...locator, target: { ...locator.target, offset } },
    progressPctHint,
  };
}

function metadata(stampValue = stamp(A, 1)) {
  return {
    value: { title: "Book", creator: "Author", fileName: "book.epub", addedAtMs: 1 },
    stamp: stampValue,
  };
}

function stateWithProgress(progress: ProgressValue, stampValue = stamp(B, 3), bookmark?: Annotation<BookmarkValue>): PortableStateV3 {
  return {
    schemaVersion: 3,
    books: {
      [HASH]: {
        metadata: metadata(),
        progress: { versions: [versionFromInitialStamp(stampValue, progress, 100)] },
        bookmarks: bookmark ? { [BOOKMARK_ID]: bookmark } : {},
        notes: {},
      },
    },
    organization: emptyOrganization(),
  };
}

function seeded() {
  const storage = new MemoryPortableStateStorage();
  storage.seed({
    envelope: { deviceId: A, counter: 3, state: emptyOrganization() },
    metadata: [{ hash: HASH, metadata: metadata() }],
    progress: [{ hash: HASH, versions: [versionFromInitialStamp(stamp(A, 2), progressValue(100), 100)], localRevision: 2 }],
  });
  return { storage, service: new PortableStateService(storage) };
}

describe("Web portable-state service", () => {
  test("background merge keeps unseen branch and a stale basis is rejected", async () => {
    const { service } = seeded();
    const read = await service.read({ bookHash: HASH });
    expect(read.book).not.toBeNull();
    const { basisId } = await service.adopt({
      readId: read.readId,
      entity: { bookHash: HASH, kind: "progress" },
      selection: { kind: "chosen", stamp: stamp(A, 2) },
    });

    await service.mergeValidatedState(stateWithProgress(progressValue(300, 30), stamp(B, 3)));

    const written = await service.write({ basisId, intent: "auto", value: progressValue(220, 22), updatedAtMs: 1000 });
    expect(written.status).toBe("written");
    expect("versions" in written.state && written.state.versions).toHaveLength(2);
    const progressVersions = (written.state as PortableProgressEntityState).versions;
    const values = progressVersions.map((version) => {
      const value = version.value;
      const locatorValue = value?.locator;
      return locatorValue?.locatorVersion === 1 && locatorValue.target.kind === "text"
        ? locatorValue.target.offset
        : -1;
    });
    expect(values).toContain(300);
    expect(values).toContain(220);

    await expect(service.write({ basisId, intent: "auto", value: progressValue(230), updatedAtMs: 1001 }))
      .rejects.toMatchObject({ code: "stale-basis" });
  });

  test("a new background candidate invalidates an old shown-all resolve", async () => {
    const { service } = seeded();
    const first = await service.read({ bookHash: HASH });
    const { basisId } = await service.adopt({
      readId: first.readId,
      entity: { bookHash: HASH, kind: "progress" },
      selection: { kind: "shown-all" },
    });
    await service.mergeValidatedState(stateWithProgress(progressValue(300), stamp(B, 3)));
    await expect(service.write({ basisId, intent: "resolve", value: progressValue(200), updatedAtMs: 100 }))
      .rejects.toMatchObject({ code: "stale-choice" });
  });

  test("annotation create/edit/delete uses explicit IDs and tombstones never resurrect", async () => {
    const { service } = seeded();
    const created = await service.createAnnotation({
      bookHash: HASH,
      kind: "bookmark",
      id: BOOKMARK_ID,
      value: { locator: locator, text: "old", createdAtMs: 10 },
      updatedAtMs: 10,
    });
    expect(created.status).toBe("written");
    const versions = (created.state as { readonly versions: readonly { readonly value: BookmarkValue }[] }).versions;
    expect(versions[0].value.text).toBe("old");

    const edited = await service.write({
      basisId: created.nextBasisId,
      intent: "edit",
      value: { locator: locator, text: "new", createdAtMs: 10 },
      updatedAtMs: 20,
    });
    expect(edited.status).toBe("written");

    const deleted = await service.deleteAnnotation({ entity: { bookHash: HASH, kind: "bookmark", id: BOOKMARK_ID } });
    expect(deleted.status).toBe("deleted");
    await expect(service.createAnnotation({
      bookHash: HASH,
      kind: "bookmark",
      id: BOOKMARK_ID,
      value: { locator: locator, text: "again", createdAtMs: 30 },
      updatedAtMs: 30,
    })).rejects.toMatchObject({ code: "deleted-entity" });

    const old = stateWithProgress(progressValue(100), stamp(B, 3), annotationFromInitialStamp(stamp(B, 8), {
      locator: locator,
      text: "old-import",
      createdAtMs: 10,
    }, 10));
    await service.mergeValidatedState(old);
    const snapshot = await service.snapshot();
    expect(snapshot.books[HASH].bookmarks[BOOKMARK_ID]).toMatchObject({ versions: [] });
    expect(snapshot.books[HASH].bookmarks[BOOKMARK_ID].deleted).toMatchObject({ deviceId: A, counter: 6 });
  });

  test("storage transaction rolls back every write when the callback fails", async () => {
    const storage = new MemoryPortableStateStorage();
    await expect(storage.transaction(async (tx) => {
      await tx.putMetadata({ hash: HASH, metadata: metadata() });
      await tx.putMeta("probe", 1);
      throw new Error("commit-failed");
    })).rejects.toThrow("commit-failed");
    const after = await storage.transaction(async (tx) => ({
      rows: await tx.listMetadata(),
      probe: await tx.getMeta("probe"),
    }));
    expect(after.rows).toHaveLength(0);
    expect(after.probe).toBeUndefined();
  });

  test("empty progress entity can adopt an empty basis and project conflict state", async () => {
    const { storage } = seeded();
    const emptyService = new PortableStateService(storage);
    // The seeded service has one stored progress version; add a concurrent one through merge.
    await emptyService.mergeValidatedState(stateWithProgress(progressValue(400), stamp(B, 4)));
    const shelf = await emptyService.projectShelf();
    expect(shelf).toHaveLength(1);
    expect(shelf[0].portableProgressConflict).toBe(true);
    expect(shelf[0].portableProgressVersions.length).toBe(2);
    expect(shelf[0].title).toBe("Book");
  });

  test("legacy shelf adaptation preserves localEntryId, old annotation ids/times and pending hashes", () => {
    const plan = planLegacyShelfMigration([
      {
        id: "local-1",
        contentHash: HASH,
        title: "Old",
        creator: "Writer",
        fileName: "old.epub",
        addedAtMs: 1,
        lastReadAtMs: 50,
        spineIndex: 0,
        page: 3,
        progressPct: 12,
        anchorIndex: null,
        anchorRatio: null,
        anchorTextOffset: 4,
        anchorTextSnippet: "text",
        bookmarks: [{
          id: "bm_old",
          spineIndex: 0,
          page: 3,
          anchorIndex: null,
          anchorRatio: null,
          anchorTextOffset: 4,
          anchorTextSnippet: "text",
          text: "mark",
          createdAtMs: 40,
        }],
        notes: [],
      },
      { id: "local-2", title: "No hash" },
    ]);
    expect(plan.ready[0].localEntryId).toBe("local-1");
    expect(plan.ready[0].source.bookmarks?.[0].id).toBe("bm_old");
    expect(plan.pendingHash).toHaveLength(1);
    expect(plan.pendingHash[0].localEntryId).toBe("local-2");

    const migrated = migrateLegacyShelfEntries([
      {
        id: "local-1",
        contentHash: HASH,
        title: "Old",
        creator: "Writer",
        fileName: "old.epub",
        addedAtMs: 1,
        lastReadAtMs: 50,
        spineIndex: 0,
        page: 3,
        progressPct: 12,
        anchorIndex: null,
        anchorRatio: null,
        anchorTextOffset: 4,
        anchorTextSnippet: "text",
        bookmarks: [{
          id: "bm_old",
          spineIndex: 0,
          page: 3,
          anchorIndex: null,
          anchorRatio: null,
          anchorTextOffset: 4,
          anchorTextSnippet: "text",
          text: "mark",
          createdAtMs: 40,
        }],
      },
      { id: "local-2", title: "No hash" },
    ], stamp(A, 9));
    expect(migrated.books).toHaveLength(1);
    expect(migrated.books[0].localEntryId).toBe("local-1");
    expect(migrated.books[0].book.bookmarks.bm_old.versions[0].value.createdAtMs).toBe(40);
    expect(migrated.pendingHash[0].localEntryId).toBe("local-2");
  });

  test("invalid command values are reported with the contract code", async () => {
    const { service } = seeded();
    await expect(service.read({ bookHash: "nope" })).rejects.toBeInstanceOf(PortableStateError);
    await expect(service.write({ basisId: "missing", intent: "auto", value: progressValue(1), updatedAtMs: 1 }))
      .rejects.toMatchObject({ code: "stale-basis" });
    await expect(service.release({ basisId: "x", readId: "y" }))
      .rejects.toMatchObject({ code: "invalid-data" });
    await expect(service.mergeValidatedState({ schemaVersion: 1 } as unknown))
      .rejects.toMatchObject({ code: "invalid-data" });
  });
});
