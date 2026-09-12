import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { getShelfStore, resetShelfStoreForTest } from "./shelf";

describe("Tauri linked ShelfStore IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    resetShelfStoreForTest();
  });

  it("lists and imports linked paths without sending EPUB bytes", async () => {
    invokeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ results: [] });
    const store = getShelfStore();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.importPaths(["C:\\Books\\a.epub"])).resolves.toEqual({ results: [] });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "linked_library_list_records");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "linked_library_import_paths", {
      paths: ["C:\\Books\\a.epub"],
    });
  });

  it("reads source bytes through raw IPC and never calls the legacy shelf command", async () => {
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const bytes = await getShelfStore().readBook("a".repeat(64));
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(invokeMock).toHaveBeenCalledWith("linked_library_read_source_raw", {
      contentHash: "a".repeat(64),
    });
    expect(invokeMock.mock.calls.flat()).not.toContain("shelf_read_book");
  });

  it("uses the cache MIME returned with the shelf view", async () => {
    invokeMock.mockResolvedValue(new Uint8Array([4, 5]).buffer);
    const asset = await getShelfStore().readThumbnail("b".repeat(64), "image/jpeg");
    expect(asset).toMatchObject({ mime: "image/jpeg" });
    expect(Array.from(asset?.bytes ?? [])).toEqual([4, 5]);
  });

  it("uses one batch command for indexed shelf deletion", async () => {
    invokeMock.mockResolvedValue(undefined);
    await getShelfStore().deleteBooks!(["a".repeat(64), "b".repeat(64)]);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("linked_library_delete_records", {
      contentHashes: ["a".repeat(64), "b".repeat(64)],
    });
  });
});
