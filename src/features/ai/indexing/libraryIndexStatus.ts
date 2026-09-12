import type { IndexedBookStatus } from "./indexStore";
import { indexStatusIsCurrent } from "./libraryIndexer";

export type LibraryIndexPhase =
  | "idle"
  | "checking"
  | "confirmation"
  | "indexing"
  | "cancelling"
  | "partial"
  | "ready"
  | "cancelled"
  | "error";

export interface LibraryIndexCandidate {
  contentHash?: string;
  available: boolean;
}

export interface LibraryIndexSummary {
  total: number;
  indexed: number;
  pending: number;
  unavailable: number;
  interrupted: boolean;
}

export function summarizeLibraryIndex(
  books: readonly LibraryIndexCandidate[],
  statuses: readonly IndexedBookStatus[],
  interrupted = false,
): LibraryIndexSummary {
  const byHash = new Map(statuses.map((status) => [status.contentHash, status]));
  let total = 0;
  let indexed = 0;
  let pending = 0;
  let unavailable = 0;
  for (const book of books) {
    if (!book.contentHash) continue;
    total++;
    if (indexStatusIsCurrent(byHash.get(book.contentHash))) {
      indexed++;
    } else if (book.available) {
      pending++;
    } else {
      unavailable++;
    }
  }
  return { total, indexed, pending, unavailable, interrupted };
}

export function phaseAfterIndexCheck(summary: LibraryIndexSummary): LibraryIndexPhase {
  if (summary.pending > 0) return "confirmation";
  if (summary.indexed > 0 || summary.total === 0) return "ready";
  return "partial";
}

export function phaseAfterIndexStop(summary: LibraryIndexSummary): LibraryIndexPhase {
  return summary.indexed > 0 ? "partial" : "cancelled";
}

export function libraryIndexCanSearch(phase: LibraryIndexPhase, summary: LibraryIndexSummary): boolean {
  return summary.indexed > 0 && ["confirmation", "partial", "ready", "cancelled"].includes(phase);
}
