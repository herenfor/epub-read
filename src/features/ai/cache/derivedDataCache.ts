import { invoke } from "@tauri-apps/api/core";

/** Only categories implemented by the native AI store belong in this union. */
export const DERIVED_CACHE_KINDS = ["full-text-index"] as const;
export type DerivedCacheKind = (typeof DERIVED_CACHE_KINDS)[number];

export type DerivedCacheState = "empty" | "building" | "partial" | "ready" | "error";

export interface DerivedCacheStatus {
  kind: DerivedCacheKind;
  displayName: string;
  /** Number of indexed library items, not the number of source books. */
  itemCount: number;
  /** Null when the native store cannot safely obtain a file size. */
  sizeBytes: number | null;
  updatedAt: number;
  state: DerivedCacheState;
}

export interface DerivedDataCachePort {
  list(): Promise<DerivedCacheStatus[]>;
  clear(kind: DerivedCacheKind): Promise<void>;
}

export function isDerivedCacheKind(value: string): value is DerivedCacheKind {
  return (DERIVED_CACHE_KINDS as readonly string[]).includes(value);
}

export function createTauriDerivedDataCachePort(): DerivedDataCachePort {
  return {
    list: () => invoke<DerivedCacheStatus[]>("ai_cache_status"),
    clear: (kind) => invoke<void>("ai_cache_clear", { kind }),
  };
}

const tauriDerivedDataCache = createTauriDerivedDataCachePort();

/** Lists only rebuildable AI data; it never reads shelf or source-file state. */
export function listDerivedDataCaches(): Promise<DerivedCacheStatus[]> {
  return tauriDerivedDataCache.list();
}

/** Clears one known cache category while preserving user-owned data. */
export function clearDerivedDataCache(kind: DerivedCacheKind): Promise<void> {
  return tauriDerivedDataCache.clear(kind);
}
