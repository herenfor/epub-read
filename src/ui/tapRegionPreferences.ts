// Device-local tap-to-turn regions: a desktop and a touch profile plus the
// touch-only "left also goes forward" switch. Kept outside ReaderSettings so
// editing it never reloads or repaginates the reader, and outside portable
// preferences / LAN transfer so it never travels to another device.
import {
  parseReaderTapPreferences,
  serializeReaderTapPreferences,
  type ReaderTapPreferences,
} from "./readerTapRegions";

export const TAP_REGION_PREFERENCES_KEY = "epub-reader:tap-regions";

/** Missing, unreadable or damaged records fall back to the original default bands. */
export function readTapRegionPreferences(): ReaderTapPreferences {
  try {
    return parseReaderTapPreferences(localStorage.getItem(TAP_REGION_PREFERENCES_KEY));
  } catch {
    return parseReaderTapPreferences(null);
  }
}

export function writeTapRegionPreferences(preferences: ReaderTapPreferences): void {
  try {
    localStorage.setItem(TAP_REGION_PREFERENCES_KEY, serializeReaderTapPreferences(preferences));
  } catch {
    /* ignore */
  }
}
