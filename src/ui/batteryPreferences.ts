// Device-local display preference for the Android reading battery indicator.
// Kept outside ReaderSettings so toggling it never reloads or repaginates the
// reader, and outside portable preferences so it never travels in archives.
const KEY = "epub-reader:reader-battery-visible";

/** Defaults to enabled; only an explicit "false" hides the indicator. */
export function readBatteryIndicatorEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeBatteryIndicatorEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "true" : "false");
  } catch {
    /* ignore */
  }
}
