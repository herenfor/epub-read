import { invoke } from "@tauri-apps/api/core";
import type { ImportCounts } from "../core/folderImport/contract";

/** One watched folder per device: a Windows path, or an Android tree's display name. */
export interface FolderWatchSettings {
  readonly enabled: boolean;
  readonly directory: string | null;
}

export interface FolderWatchResult {
  readonly scanned: number;
  readonly unchanged: number;
  readonly unreadableDirectories: number;
  readonly counts: ImportCounts;
}

/** `libraryInbox` is the Inbox inside the Windows library folder; Android never offers it. */
export type FolderWatchAction = "pick" | "libraryInbox" | "disable";

export interface FolderWatchNative {
  get(): Promise<FolderWatchSettings>;
  /** Null when the user cancels the picker. */
  configure(action: FolderWatchAction): Promise<FolderWatchSettings | null>;
  scan(): Promise<FolderWatchResult>;
}

export const folderWatchNative: FolderWatchNative = {
  get: () => invoke<FolderWatchSettings>("library_folder_watch_get"),
  configure: (action) => invoke<FolderWatchSettings | null>("library_folder_watch_configure", { action }),
  scan: () => invoke<FolderWatchResult>("library_folder_watch_scan"),
};

/** Another scan or import holds the native lock: wait for the next trigger. */
export function isFolderWatchBusy(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return String(typeof message === "string" ? message : error).startsWith("busy:");
}
