// Device-local desktop preference: whether the reader's top bar auto-hides.
// Kept outside ReaderSettings for the same reasons as batteryPreferences.
const KEY = "epub-reader:reader-titlebar-auto-hide";

/** Defaults to auto-hide; only an explicit "false" keeps the bar pinned. */
export function readTitlebarAutoHide(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeTitlebarAutoHide(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "true" : "false");
  } catch {
    /* ignore */
  }
}
