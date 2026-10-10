import { invoke } from "@tauri-apps/api/core";
import { createReaderStatusBarCoordinator } from "./readerSystemStatusBar";

const PREFERENCE_KEY = "epub-reader:keep-screen-on";

/** Off unless the device-local value is exactly "true"; unreadable storage stays off. */
export function readReaderKeepScreenOn(): boolean {
  try { return localStorage.getItem(PREFERENCE_KEY) === "true"; }
  catch { return false; }
}

/** Local device preference; deliberately excluded from reader settings, saves and LAN. */
export function writeReaderKeepScreenOn(enabled: boolean): void {
  localStorage.setItem(PREFERENCE_KEY, String(enabled));
}

export interface ReaderKeepScreenOnIntent {
  readonly readerActive: boolean;
  readonly keepWhileReading: boolean;
  readonly visible: boolean;
}

/** The runtime intent sent to native — never the stored preference by itself. */
export function shouldKeepReaderScreenOn(intent: ReaderKeepScreenOnIntent): boolean {
  return intent.readerActive && intent.keepWhileReading && intent.visible;
}

export async function setReaderKeepScreenOn(enabled: boolean): Promise<void> {
  await invoke<void>("reader_set_keep_screen_on", { enabled });
}

/**
 * One app-root owner. Reuses the status-bar serializer (latest intent wins after
 * the in-flight write) as a separate instance; the two must never share one.
 */
export function createReaderKeepScreenOnCoordinator(apply: (enabled: boolean) => Promise<void> = setReaderKeepScreenOn) {
  const driver = createReaderStatusBarCoordinator(apply);
  return {
    requestEnabled: (enabled: boolean, force = false): Promise<void> => driver.requestHidden(enabled, force),
  };
}
