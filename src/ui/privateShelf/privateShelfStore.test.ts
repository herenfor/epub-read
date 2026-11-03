import { afterEach, describe, expect, test, vi } from "vitest";
import { emptyOrganization } from "../libraryOrganization";
import { versionFromInitialStamp } from "../../core/portableState/legacy";
import type { ProgressValue } from "../../core/portableState/portable-state-types";
import { MemoryPortableStateStorage } from "../portableState/memoryStorage";
import { PortableStateError, PortableStateService } from "../portableState/service";
import { PrivateShelfError, type PrivateShelfNative, type PrivateShelfOperation } from "../../platform/privateShelf";
import { createPrivateShelfStore } from "./privateShelfStore";
import { SHELF_SPACES, activeShelfSpace, enterShelfSpace, leaveShelfSpace, shelfSpaceStorage } from "../shelfSpaces";
import { getShelfStore, resetShelfStoreForTest } from "../shelf";

const A = "00000000-0000-4000-8000-000000000001";
const HASH = "b".repeat(64);
const SESSION = "session-1";

const progress = (offset: number): ProgressValue => ({
  locator: {
    locatorVersion: 1,
    chapterPath: "OEBPS/c1.xhtml",
    spineIndexHint: 0,
    target: { kind: "text", textProfile: "visible-codepoints-no-whitespace-v1", offset, snippet: "x" },
  },
  progressPctHint: 10,
});

/** The private wire backed by the real Web repository, recording every operation. */
function fakeNative() {
  const storage = new MemoryPortableStateStorage();
  const metadata = { value: { title: "私密书", creator: "作者", fileName: "secret.txt", addedAtMs: 1 }, stamp: { deviceId: A, counter: 1 } };
  storage.seed({
    envelope: { deviceId: A, counter: 3, state: emptyOrganization() },
    metadata: [{ hash: HASH, metadata }],
    progress: [{ hash: HASH, versions: [versionFromInitialStamp({ deviceId: A, counter: 2 }, progress(1), 100)], localRevision: 2 }],
  });
  const service = new PortableStateService(storage);
  const ops: PrivateShelfOperation[] = [];
  let locked = false;
  const library = async (sessionId: string, op: PrivateShelfOperation): Promise<unknown> => {
    ops.push(op);
    if (locked || sessionId !== SESSION) throw new PrivateShelfError("locked", "隐私书架已锁定");
    const o = op as unknown as Record<string, never>;
    try {
      switch (op.kind) {
        case "import": return { bookHash: HASH, duplicate: false };
        case "list": return { books: [{ bookHash: HASH, metadata: metadata.value }], organization: await service.getOrganization() };
        case "read": return service.read({ bookHash: o.bookHash });
        case "adopt": return service.adopt({ readId: o.readId, entity: o.entity, selection: o.selection });
        case "writeProgress": case "writeBookmark": case "writeNote":
          return service.write({ basisId: o.basisId, intent: o.intent, value: o.value, updatedAtMs: o.updatedAtMs });
        case "createBookmark": case "createNote":
          return service.createAnnotation({ bookHash: o.bookHash, kind: op.kind === "createBookmark" ? "bookmark" : "note", id: o.id, value: o.value, updatedAtMs: o.updatedAtMs });
        case "releaseBasis": return service.release({ basisId: o.basisId });
        case "releaseRead": return service.release({ readId: o.readId });
        case "organize": return service.applyOrganization(o.command);
        case "archiveOpen": return { protocolVersion: 1, sessionId: "archive-1", entryCount: 1, chunkBytes: 512 * 1024 };
        case "archiveDirectory": return { entries: [{ name: "a.txt", compressedBytes: 2, expandedBytes: 2, entryIndex: 0 }], next: null };
        case "archiveClose": return null;
        default: throw new Error(`unexpected ${op.kind}`);
      }
    } catch (error) {
      if (error instanceof PortableStateError) throw { code: error.code, message: error.message };
      throw error;
    }
  };
  const native: PrivateShelfNative = {
    status: vi.fn(async () => "unlocked" as const),
    setup: vi.fn(async () => "locked" as const),
    unlock: vi.fn(async () => ({ status: "unlocked" as const, sessionId: SESSION })),
    lock: vi.fn(async () => { locked = true; }),
    reset: vi.fn(async () => "unconfigured" as const),
    library: library as PrivateShelfNative["library"],
    archiveRead: vi.fn(async () => new Uint8Array([104, 105]).buffer),
    cover: vi.fn(async () => new ArrayBuffer(0)),
    move: vi.fn(async () => undefined),
  };
  return { native, ops, service, lock: () => { locked = true; } };
}

afterEach(async () => {
  await leaveShelfSpace();
  resetShelfStoreForTest();
});

describe("private shelf store", () => {
  test("lists only its own books and routes progress writes by the adopted entity", async () => {
    const { native, ops, service } = fakeNative();
    const store = createPrivateShelfStore(native, SESSION, () => undefined);
    const [entry] = await store.list();
    expect(entry).toMatchObject({ id: HASH, title: "私密书", contentHash: HASH, available: true });

    const lease = await store.prepareProgressSession(HASH, { kind: "chosen", stamp: { deviceId: A, counter: 2 } });
    store.activateProgressSession(lease);
    const written = await store.updateProgressForSession(lease, {
      spineIndex: 0, page: 1, progressPct: 40, lastReadAtMs: 500, anchorIndex: null, anchorRatio: null,
      anchorTextOffset: 9, anchorTextSnippet: "x", chapterPath: "OEBPS/c1.xhtml",
    } as never);
    expect(written.status).toBe("saved");
    expect(ops.some((op) => op.kind === "writeProgress")).toBe(true);
    expect(ops.some((op) => op.kind === "writeBookmark" || op.kind === "writeNote")).toBe(false);
    const read = await service.read({ bookHash: HASH });
    expect(read.book?.progress.versions.some((version) => version.value?.progressPctHint === 40)).toBe(true);
    await store.closeProgressLease(lease);
  });

  test("cancels remaining private document imports after the current file", async () => {
    const { native, ops } = fakeNative();
    const store = createPrivateShelfStore(native, SESSION, () => undefined);
    const controller = new AbortController();
    const result = await store.importDocuments(
      [{ uri: "content://test/first" }, { uri: "content://test/second" }],
      () => controller.abort(),
      controller.signal,
    );
    expect(result.results.map(item => item.status)).toEqual(["saved", "cancelled"]);
    expect(ops.filter(op => op.kind === "import")).toHaveLength(1);
  });

  test("bookmarks go through the private create route", async () => {
    const { native, ops } = fakeNative();
    const store = createPrivateShelfStore(native, SESSION, () => undefined);
    const saved = await store.createBookmark!(HASH, {
      id: "00000000-0000-4000-8000-000000000020", spineIndex: 0, page: 1, anchorIndex: null, anchorRatio: null,
      text: "书签", createdAtMs: 10,
    } as never);
    expect(saved.bookmarks).toHaveLength(1);
    expect(ops.filter((op) => op.kind === "createBookmark")).toHaveLength(1);
  });

  test("the archive client speaks the session's archive routes and passes the TXT encoding", async () => {
    const { native, ops } = fakeNative();
    const store = createPrivateShelfStore(native, SESSION, () => undefined);
    const archive = await store.openArchive!(HASH, "gb18030");
    expect(ops.find((op) => op.kind === "archiveOpen")).toMatchObject({ bookHash: HASH, textEncoding: "gb18030" });
    expect(ops.find((op) => op.kind === "archiveDirectory")).toMatchObject({ archiveId: "archive-1", start: 0 });
    const files = await archive.extract(["a.txt"]);
    expect(new TextDecoder().decode(files.get("a.txt"))).toBe("hi");
    expect(native.archiveRead).toHaveBeenCalledWith(SESSION, "archive-1", 0, 0);
    archive.close();
    await Promise.resolve();
    expect(ops.some((op) => op.kind === "archiveClose")).toBe(true);
    expect(store.archiveOnly).toBe(true);
  });

  test("a revoked session reports locked once per call and never falls back", async () => {
    const { native, lock } = fakeNative();
    const onLocked = vi.fn();
    const store = createPrivateShelfStore(native, SESSION, onLocked);
    lock();
    await expect(store.list()).rejects.toMatchObject({ code: "locked" });
    expect(onLocked).toHaveBeenCalled();
  });

  test("derived thumbnails stay in the store's memory", async () => {
    const { native } = fakeNative();
    const store = createPrivateShelfStore(native, SESSION, () => undefined);
    const asset = { bytes: new Uint8Array([1]), mime: "image/webp" };
    await store.writeThumbnail(HASH, asset);
    expect(await store.readThumbnail(HASH)).toBe(asset);
    store.clear();
    expect(await store.readThumbnail(HASH)).toBeNull();
  });
});

describe("shelf spaces", () => {
  test("an open private shelf replaces the store, keeps browser state in memory, and locks on leave", async () => {
    const { native } = fakeNative();
    const store = createPrivateShelfStore(native, SESSION, () => undefined);
    const close = vi.fn(async () => undefined);
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    });
    enterShelfSpace({ space: SHELF_SPACES.private, store, token: SESSION, close });
    expect(getShelfStore()).toBe(store);
    expect(activeShelfSpace().policy.libraryServices).toBe(false);
    shelfSpaceStorage.setItem("probe", "private");
    expect(shelfSpaceStorage.getItem("probe")).toBe("private");
    expect(localStorage.getItem("probe")).toBeNull();

    await leaveShelfSpace();
    expect(close).toHaveBeenCalledOnce();
    expect(getShelfStore()).not.toBe(store);
    expect(activeShelfSpace().kind).toBe("library");
    expect(shelfSpaceStorage.getItem("probe")).toBeNull();
    vi.unstubAllGlobals();
  });
});
