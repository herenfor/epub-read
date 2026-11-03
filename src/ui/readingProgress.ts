/** Current-chapter numerator only; full-book denominator remains App-owned. */
export function currentChapterCharsRead({
  textOffset,
  chapterFraction,
  page,
  pageCount,
  chapterChars,
}: {
  textOffset: number | null | undefined;
  /** Image hosts provide a source-page fraction, independent of single/double display. */
  chapterFraction?: number;
  page: number;
  pageCount: number;
  chapterChars: number;
}): number {
  if (typeof chapterFraction === "number" && Number.isFinite(chapterFraction)) {
    return Math.max(0, Math.min(1, chapterFraction)) * chapterChars;
  }
  if (typeof textOffset === "number" && Number.isSafeInteger(textOffset) && textOffset >= 0) {
    return textOffset;
  }
  if (pageCount > 0) return ((page + 1) / pageCount) * chapterChars;
  return 0;
}
