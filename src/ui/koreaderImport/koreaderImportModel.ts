/**
 * View model for the single-book KOReader progress import (ER-0138).
 *
 * These are UI-side shapes only. The hook that fills them maps the ER-0137
 * native bridge fields onto them once that package lands. Nothing here parses
 * sidecars or converts positions.
 */

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
  | "ambiguous"
  | "offset-out-of-range"
  | "dom-version-unsupported"
  | "whitespace-unverified"
  | "unsupported-position"
  | "text-mismatch"
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
  /** Where the imported position lands in the local book, when it can be placed. */
  readonly target: { readonly chapterTitle: string | null; readonly excerpt: string | null } | null;
  readonly status:
    | { readonly kind: "ready" }
    /** The local book already has exactly this position: nothing to write. */
    | { readonly kind: "same" }
    | { readonly kind: "blocked"; readonly reason: KoreaderBlockReason; readonly code?: string };
}

export type KoreaderImportState =
  | { kind: "idle" }
  | { kind: "working"; step: "opening" | "matching" | "previewing" | "committing"; sourceLabel: string }
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
