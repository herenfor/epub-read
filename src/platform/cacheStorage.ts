import { invoke } from "@tauri-apps/api/core";

export interface AiCacheStatus {
  kind: string;
  displayName: string;
  itemCount: number;
  sizeBytes: number | null;
  updatedAt: number;
  state: string;
}

export interface CacheStorageStatus {
  /** Immutable directory used by this process. */
  activeDirectory: string;
  /** Saved selection that will apply on the next start. */
  configuredBaseDirectory: string | null;
  restartRequired: boolean;
  fallbackReason: string | null;
  totalSizeBytes: number;
  caches: AiCacheStatus[];
}

export async function getCacheStorageStatus(): Promise<CacheStorageStatus> {
  return invoke<CacheStorageStatus>("cache_storage_get_status");
}

export async function setCacheStorageDirectory(
  baseDirectory: string | null,
): Promise<CacheStorageStatus> {
  return invoke<CacheStorageStatus>("cache_storage_set_directory", { baseDirectory });
}

export async function clearFullTextIndex(): Promise<void> {
  await invoke("ai_cache_clear", { kind: "full-text-index" });
}

/** Explicit reset of all rebuildable indexes; durable user data stays intact. */
export async function resetIndexCaches(): Promise<void> {
  await invoke("cache_storage_reset_indexes");
}
