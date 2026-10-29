import { invoke } from "@tauri-apps/api/core";
import type { Theme } from "../render/settings";
import { createReaderStatusBarCoordinator } from "./readerSystemStatusBar";
import { isDarkReaderTheme } from "../config/readerPalette";

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

/** Native appearance is independent of immersion: changing theme must not hide a revealed bar. */
export function createStatusBarAppearanceCoordinator(
  apply: (darkIcons: boolean) => Promise<void> = (darkIcons) => invoke("android_status_bar_appearance", { darkIcons }),
) {
  const driver = createReaderStatusBarCoordinator(apply);
  return {
    requestTheme: (theme: Theme) => driver.requestHidden(!isDarkReaderTheme(theme)),
  };
}
