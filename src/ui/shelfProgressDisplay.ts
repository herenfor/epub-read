import { hasReadPosition } from "./readEvidence";
import type { ShelfEntry } from "./shelf";

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
  return isShelfProgressPending(entry) ? "待统计" : `${Math.round(entry.progressPct)}%${suffix}`;
}
