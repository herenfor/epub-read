/**
 * Pure search-hit range helpers.  These functions operate on extracted chapter
 * text and visible-text code points only; they never touch the DOM, styles or
 * pagination state.
 */

export interface ExactTextHit {
  /** Non-whitespace Unicode code-point coordinate, end exclusive. */
  start: number;
  end: number;
  /**
   * Original matched text with whitespace and corpus block separators removed.
   * No NFKC or case conversion is performed here.
   */
  exactText: string;
}

export interface RawTextRange {
  start: number;
  end: number;
}

/**
 * Convert core/search raw UTF-16 chapter ranges to non-whitespace Unicode
 * code-point ranges.  A single scan builds the boundary map; soft hyphens and
 * corpus block boundaries are omitted in the same order as visible text.
 */
export function buildExactTextHits(
  source: string,
  rawRanges: readonly RawTextRange[],
): ExactTextHit[] | null {
  if (rawRanges.length === 0) return null;
  const needed = new Set<number>();
  for (const range of rawRanges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > source.length
    ) {
      return null;
    }
    needed.add(range.start);
    needed.add(range.end);
  }
  const boundaries = new Map<number, number>();
  const points: string[] = [];
  let rawOffset = 0;
  if (needed.has(0)) boundaries.set(0, 0);
  for (const point of source) {
    // BLOCK_BOUNDARY is U+0000; whitespace is omitted by both the corpus
    // anchor coordinate and this runtime mapping.
    if (point !== "\u0000" && !/\p{White_Space}/u.test(point)) points.push(point);
    rawOffset += point.length;
    if (needed.has(rawOffset)) boundaries.set(rawOffset, points.length);
  }
  const hits: ExactTextHit[] = [];
  for (const range of rawRanges) {
    const start = boundaries.get(range.start);
    const end = boundaries.get(range.end);
    if (start === undefined || end === undefined || end <= start) return null;
    hits.push({ start, end, exactText: points.slice(start, end).join("") });
  }
  return hits;
}

/**
 * Resolve one hit inside the current visible text index.  Exact position wins;
 * a bounded KMP search is the only fallback.  Equidistant ambiguity or a hit
 * outside the radius returns null so navigation and highlighting can share the
 * same truthful decision.
 */
export function resolveExactTextHit(
  visiblePoints: readonly string[],
  hit: ExactTextHit,
  radius = 4096,
): RawTextRange | null {
  const needle = Array.from(hit.exactText);
  if (
    !Number.isSafeInteger(hit.start) ||
    !Number.isSafeInteger(hit.end) ||
    hit.start < 0 ||
    needle.length === 0 ||
    hit.end - hit.start !== needle.length ||
    !Number.isSafeInteger(radius) ||
    radius < 0
  ) {
    return null;
  }
  const matches = (start: number): boolean =>
    start >= 0 &&
    start + needle.length <= visiblePoints.length &&
    needle.every((point, offset) => visiblePoints[start + offset] === point);
  if (matches(hit.start)) return { start: hit.start, end: hit.end };

  const low = Math.max(0, hit.start - radius);
  const high = Math.min(visiblePoints.length - needle.length, hit.start + radius);
  if (high < low) return null;

  const prefix = new Array<number>(needle.length).fill(0);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j > 0 && needle[i] !== needle[j]) j = prefix[j - 1];
    if (needle[i] === needle[j]) j++;
    prefix[i] = j;
  }
  let best: number | null = null;
  let distance = Infinity;
  let tied = false;
  for (let i = low, j = 0; i < high + needle.length; i++) {
    while (j > 0 && visiblePoints[i] !== needle[j]) j = prefix[j - 1];
    if (visiblePoints[i] === needle[j]) j++;
    if (j === needle.length) {
      const start = i - needle.length + 1;
      const nextDistance = Math.abs(start - hit.start);
      if (nextDistance < distance) {
        best = start;
        distance = nextDistance;
        tied = false;
      } else if (nextDistance === distance) {
        tied = true;
      }
      j = prefix[j - 1];
    }
  }
  return best === null || tied ? null : { start: best, end: best + needle.length };
}

/**
 * Resolve every range in one search result as a single transaction.  The
 * earliest range is the relocation anchor; all later ranges must validate at
 * the same delta and preserve the original text.  Legitimate duplicate or
 * overlapping keyword ranges are allowed; drawing later deduplicates them.
 */
export function resolveExactTextHits(
  visiblePoints: readonly string[],
  hits: readonly ExactTextHit[],
  radius = 4096,
): RawTextRange[] | null {
  if (hits.length === 0) return null;
  const ordered = [...hits].sort((a, b) => a.start - b.start || a.end - b.end);
  const first = resolveExactTextHit(visiblePoints, ordered[0], radius);
  if (!first) return null;
  const delta = first.start - ordered[0].start;
  const resolved: RawTextRange[] = [];
  for (const hit of ordered) {
    const expectedStart = hit.start + delta;
    const needle = Array.from(hit.exactText);
    if (
      expectedStart < 0 ||
      expectedStart + needle.length > visiblePoints.length ||
      !needle.every((point, offset) => visiblePoints[expectedStart + offset] === point)
    ) {
      return null;
    }
    resolved.push({ start: expectedStart, end: expectedStart + needle.length });
  }
  return resolved;
}
