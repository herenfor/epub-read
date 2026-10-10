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

export function shelfProgressLabel(entry: DisplayProgress, suffix = ""): string {
  return isShelfProgressPending(entry) ? uiText("shelf.progress.pending") : `${Math.round(entry.progressPct)}%${suffix}`;
}
