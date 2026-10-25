import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";

/**
 * A34 library folder (Windows): whether imports copy the EPUB into the app's
 * book library, and where that library is. The native settings file is the
 * source of truth; every import passes the value it shows explicitly.
 */

export interface LibrarySettingsView {
  copyOnImport: boolean;
  libraryDirectory: string;
  /** The chosen base folder, or null for the default inside app data. */
  customBaseDirectory: string | null;
  /** False while a chosen location is unreachable, or the settings file is unusable. */
  available: boolean;
  /** A location change left work to finish or clean up. */
  recoveryPending: boolean;
  /** Why the settings or the location cannot be used right now. */
  error: string | null;
}

const UNREADABLE: Omit<LibrarySettingsView, "error"> = {
  copyOnImport: false, libraryDirectory: "", customBaseDirectory: null, available: false, recoveryPending: false,
};

let view: LibrarySettingsView | null = null;
let loading: Promise<LibrarySettingsView | null> | null = null;
const listeners = new Set<() => void>();

function publish(next: LibrarySettingsView): LibrarySettingsView {
  view = next;
  for (const listener of [...listeners]) listener();
  return next;
}

function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : String(error);
}

/**
 * A path as Windows shows it: without the extended-length prefix
 * (\\?\D:\… → D:\…, \\?\UNC\server\share → \\server\share). Display only;
 * native calls keep the real path.
 */
export function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

export function librarySettingsSupported(): boolean {
  return getRuntimeCapabilities().supportsLibraryFolder;
}

/** Loads once; later calls return the current view. Null where unsupported. */
export function ensureLibrarySettings(): Promise<LibrarySettingsView | null> {
  if (!librarySettingsSupported()) return Promise.resolve(null);
  if (view) return Promise.resolve(view);
  // A failed read is remembered as an error view, so a render never re-asks in a loop.
  loading ??= invoke<LibrarySettingsView>("linked_library_settings_get")
    .then(publish, (error: unknown) => publish({ ...UNREADABLE, error: errorText(error) }))
    .finally(() => { loading = null; });
  return loading;
}

/** Re-reads after something native may have changed (a location change, finished or not). */
export async function refreshLibrarySettings(): Promise<LibrarySettingsView | null> {
  if (!librarySettingsSupported()) return null;
  try {
    return publish(await invoke<LibrarySettingsView>("linked_library_settings_get"));
  } catch (error) {
    return publish({ ...(view ?? UNREADABLE), error: errorText(error) });
  }
}

/**
 * The 复制到书库 choice an import entry shows, or undefined to show none. An
 * unreachable chosen location keeps the choice: copying is then refused with
 * a reason, and unticking still imports by link. Only an unusable settings
 * file (unavailable at the default location) hides it.
 */
export function libraryCopyChoice(current: LibrarySettingsView | null): boolean | undefined {
  if (!current || (!current.available && current.customBaseDirectory === null)) return undefined;
  return current.copyOnImport;
}

/** What an import should do right now: copy only when the shown setting says so. */
export async function copyOnImportNow(): Promise<boolean> {
  return (await ensureLibrarySettings())?.copyOnImport ?? false;
}

export async function setCopyOnImport(enabled: boolean): Promise<void> {
  try {
    publish(await invoke<LibrarySettingsView>("linked_library_settings_set_copy", { enabled }));
  } catch (error) {
    // Keep the last good values; surface why the change did not stick.
    publish({ ...(view ?? UNREADABLE), error: errorText(error) });
  }
}

export async function openLibraryFolder(): Promise<void> {
  try {
    await invoke("linked_library_open_folder");
  } catch (error) {
    throw new Error(errorText(error));
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLibrarySettings(): LibrarySettingsView | null {
  const current = useSyncExternalStore(subscribe, () => view, () => view);
  if (!current) void ensureLibrarySettings();
  return current;
}

export function resetLibrarySettingsForTest(): void {
  view = null;
  loading = null;
  listeners.clear();
}
