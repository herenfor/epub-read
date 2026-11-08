/**
 * View model for the single-book KOReader progress import (ER-0138).
 *
 * UI-side shapes and small pure decisions. Sidecar parsing and XPointer
 * conversion stay in render/interop/koreaderProgress (ER-0137); the hook
 * maps their results and the native bridge rows onto these shapes.
 */
import type { Locator, ModernLocator } from "../../core/portableState/portable-state-types";
import type { KoreaderPointReason } from "../../render/interop/koreaderProgress";

/** Why a local book was offered as a candidate. Candidates are never proof of the same book. */
export type KoreaderCandidateBasis = "partial-md5" | "title";

export interface KoreaderLocalBook {
  /** Shelf book id. */
  readonly id: string;
  readonly title: string;
  readonly author: string;
  /** null = this book has no progress on this device. */
  readonly progressPct: number | null;
  /** null = unknown. The UI says so instead of inventing a time. */
  readonly progressUpdatedAtMs: number | null;
  /** null = not a candidate, but still offered as a manual choice. */
  readonly basis: KoreaderCandidateBasis | null;
}

export interface KoreaderSidecarSummary {
  /** The picked file or folder name, shown as the subtitle. */
  readonly label: string;
  readonly title: string | null;
  readonly author: string | null;
}

/**
 * UI reasons for "cannot import". The hook maps native error codes onto these;
 * a code it does not know becomes "other" and keeps the code for the message.
 */
export type KoreaderBlockReason =
  | "no-progress"
  | "chapter-missing"
  | "node-missing"
  | "offset-out-of-range"
  | "dom-version-unsupported"
  | "whitespace-unverified"
  | "unsupported-position"
  | "other";

export interface KoreaderPosition {
  readonly progressPct: number | null;
  readonly updatedAtMs: number | null;
}

export interface KoreaderPreview {
  /** The local book the preview was made against; must equal the chosen id. */
  readonly bookId: string;
  readonly koreader: KoreaderPosition;
  readonly local: KoreaderPosition;
  /** The local book holds conflicting progress versions; importing adds one more, it does not pick. */
  readonly localConflict: boolean;
  /** Where the imported position lands in the local book, when it can be placed. */
  readonly target: { readonly spineIndex: number; readonly chapterTitle: string | null; readonly excerpt: string | null } | null;
  readonly status:
    | { readonly kind: "ready" }
    /** The local book already has exactly this position: nothing to write. */
    | { readonly kind: "same" }
    | { readonly kind: "blocked"; readonly reason: KoreaderBlockReason; readonly code?: string };
}

export type KoreaderImportState =
  | { kind: "idle" }
  | { kind: "working"; step: "opening" | "matching" | "previewing" | "committing"; sourceLabel: string; done: number; total: number }
  | { kind: "choose"; sidecar: KoreaderSidecarSummary; books: readonly KoreaderLocalBook[]; chosen: string | null }
  | {
      kind: "preview";
      sidecar: KoreaderSidecarSummary;
      books: readonly KoreaderLocalBook[];
      chosen: string;
      preview: KoreaderPreview;
    };

const BASIS_ORDER: Record<KoreaderCandidateBasis, number> = { "partial-md5": 0, title: 1 };

/** Candidates first (sampled digest before title), then every other local book in shelf order. */
export function splitKoreaderBooks(books: readonly KoreaderLocalBook[]): {
  candidates: KoreaderLocalBook[];
  others: KoreaderLocalBook[];
} {
  const candidates = books
    .map((book, at) => ({ book, at }))
    .filter(({ book }) => book.basis !== null)
    .sort((a, b) => BASIS_ORDER[a.book.basis!] - BASIS_ORDER[b.book.basis!] || a.at - b.at)
    .map(({ book }) => book);
  return { candidates, others: books.filter((book) => book.basis === null) };
}

/**
 * The only state that may confirm: a ready preview made for the book that is
 * still chosen. A stale or blocked preview never writes.
 */
export function canConfirmKoreader(state: KoreaderImportState): boolean {
  return state.kind === "preview" && state.preview.bookId === state.chosen && state.preview.status.kind === "ready";
}

/** Core conversion reasons → what the dialog explains. Only the first reason is shown. */
export function koreaderBlockReason(reasons: readonly KoreaderPointReason[]): { reason: KoreaderBlockReason; code?: string } {
  const first = reasons[0];
  switch (first) {
    case "chapter-missing": return { reason: "chapter-missing" };
    case "node-missing": return { reason: "node-missing" };
    case "offset-out-of-bounds": return { reason: "offset-out-of-range" };
    case "crengine-dom-version-unsupported": return { reason: "dom-version-unsupported" };
    case "crengine-whitespace-unverified": return { reason: "whitespace-unverified" };
    case "bad-xpointer": case "paging-page-only": case "unsupported-format":
    case "crengine-autoboxing": case "outside-text": case "element-boundary":
      return { reason: "unsupported-position", code: first };
    default: return { reason: "other", code: first ?? "unknown" };
  }
}

/** Same canonical text point: chapter and offset agree. Anything else is a change. */
export function sameKoreaderLocator(a: Locator | null | undefined, b: ModernLocator): boolean {
  if (!a || a.locatorVersion !== 1 || a.chapterPath !== b.chapterPath) return false;
  return a.target.kind === "text" && b.target.kind === "text" && a.target.offset === b.target.offset;
}

/**
 * Display-only progress hint for the stored position, from the spine and the
 * offset inside the chapter (the Readest import's spine fallback, refined by
 * the chapter fraction). KOReader's own percent is never used.
 */
export function koreaderProgressHint(spineIndex: number, spineCount: number, offset: number, chapterChars: number): number {
  const fraction = chapterChars > 0 ? Math.min(1, Math.max(0, offset / chapterChars)) : 0;
  const pct = ((spineIndex + fraction) / Math.max(1, spineCount)) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)));
}

const normalizedTitle = (title: string): string => title.normalize("NFKC").trim().toLowerCase();

/** Why a local book is a candidate: the sampled digest first, then an equal title. */
export function koreaderCandidateBasis(
  sidecar: { partialMd5Checksum: string | null; title: string | null },
  local: { partialMd5: string; title: string },
): KoreaderCandidateBasis | null {
  if (sidecar.partialMd5Checksum && sidecar.partialMd5Checksum.toLowerCase() === local.partialMd5.toLowerCase()) return "partial-md5";
  if (sidecar.title && normalizedTitle(sidecar.title) === normalizedTitle(local.title)) return "title";
  return null;
}
