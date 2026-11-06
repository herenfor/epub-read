import { hasReadPosition } from "./readEvidence";
import type { ShelfEntry } from "./shelf";
import { uiText } from "./localization/UiLanguageProvider";

/** Presentation only: not added to ShelfEntry, storage DTOs or sync payloads. */
type DisplayProgress = { progressPct: number; progressPctPending?: boolean };

export function projectShelfProgressReadiness(
  entries: readonly ShelfEntry[],
  knownBookKeys: ReadonlySet<string>,
): ShelfEntry[] {
  return entries.map((entry) => {
    if (entry.progressPct !== 0 || !hasReadPosition(entry) || knownBookKeys.has(entry.contentHash ?? entry.id)) {
      return entry;
    }
    return { ...entry, progressPctPending: true };
  });
}

export function isShelfProgressPending(entry: DisplayProgress): boolean {
  return entry.progressPctPending === true;
}

export type ShelfReadingStatus = "reading" | "unread" | "finished";

/**
 * The single reading-status judgement for badges, status filters/counts and the
 * resume stage. A saved position with a read timestamp is reading even at 0%:
 * an image page or the first screen of a chapter can legitimately round to 0%.
 * Merely opening a book (isNew cleared, no saved progress) stays unread.
 */
export function shelfReadingStatus(
  entry: DisplayProgress & Parameters<typeof hasReadPosition>[0] & { lastReadAtMs: number },
): ShelfReadingStatus {
  if (entry.progressPct >= 100) return "finished";
  if (!hasReadPosition(entry)) return "unread";
  return entry.progressPct > 0 || isShelfProgressPending(entry) || entry.lastReadAtMs > 0 ? "reading" : "unread";
}

export function shelfProgressLabel(entry: DisplayProgress, suffix = ""): string {
  return isShelfProgressPending(entry) ? uiText("shelf.progress.pending") : `${Math.round(entry.progressPct)}%${suffix}`;
}
