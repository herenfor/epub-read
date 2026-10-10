import { invoke } from "@tauri-apps/api/core";

const PREFERENCE_KEY = "epub-reader:hide-system-status-bar";

export function readHideReaderSystemStatusBar(): boolean {
  try { return localStorage.getItem(PREFERENCE_KEY) !== "false"; }
  catch { return true; }
}

/** Local device preference; deliberately excluded from portable reader settings. */
export function writeHideReaderSystemStatusBar(hidden: boolean): void {
  localStorage.setItem(PREFERENCE_KEY, String(hidden));
}

export async function setReaderSystemStatusBarHidden(hidden: boolean): Promise<void> {
  await invoke("android_reader_system_bars", { hidden });
}
