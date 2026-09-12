import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  clearDerivedDataCache,
  createTauriDerivedDataCachePort,
  DERIVED_CACHE_KINDS,
  isDerivedCacheKind,
  listDerivedDataCaches,
} from "./derivedDataCache";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

describe("derived data cache bridge", () => {
  beforeEach(() => invokeMock.mockReset());

  it("exposes only the implemented cache category", () => {
    expect(DERIVED_CACHE_KINDS).toEqual(["full-text-index"]);
    expect(isDerivedCacheKind("full-text-index")).toBe(true);
    expect(isDerivedCacheKind("vector-index")).toBe(false);
  });

  it("lists native cache metadata without touching shelf data", async () => {
    invokeMock.mockResolvedValue([{
      kind: "full-text-index",
      displayName: "全文索引",
      itemCount: 3,
      sizeBytes: 1024,
      updatedAt: 42,
      state: "ready",
    }]);
    await expect(listDerivedDataCaches()).resolves.toEqual([expect.objectContaining({ itemCount: 3 })]);
    expect(invokeMock).toHaveBeenCalledWith("ai_cache_status");
  });

  it("clears one known category through the native kind boundary", async () => {
    invokeMock.mockResolvedValue(undefined);
    await clearDerivedDataCache("full-text-index");
    expect(invokeMock).toHaveBeenCalledWith("ai_cache_clear", { kind: "full-text-index" });
  });

  it("keeps the port injectable for a future cache management UI", async () => {
    invokeMock.mockResolvedValue([]);
    const port = createTauriDerivedDataCachePort();
    await port.list();
    expect(invokeMock).toHaveBeenCalledWith("ai_cache_status");
  });
});
