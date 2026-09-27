/** Search-result identity context used only for new explicit search targets. */
import type { ExactTextHit, RawTextRange } from "./exactTextHits";

export interface SearchOccurrence {
  /** All group ranges use non-whitespace Unicode code-point coordinates. */
  hits: readonly ExactTextHit[];
  /** Up to 24 code points before the first hit in the source chapter. */
  before: string;
  /** Up to 24 code points after the last hit in the source chapter. */
  after: string;
}

/** Capture the exact group plus a small two-sided context. Never re-index display text. */
export function captureSearchOccurrence(
  points: readonly string[],
  hits: readonly ExactTextHit[],
): SearchOccurrence | null {
  if (hits.length === 0) return null;
  const ordered = [...hits].sort((a, b) => a.start - b.start || a.end - b.end);
  const start = ordered[0].start;
  const end = Math.max(...ordered.map((hit) => hit.end));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  return {
    hits: ordered.map((hit) => ({ ...hit })),
    before: points.slice(Math.max(0, start - 24), start).join(""),
    after: points.slice(end, end + 24).join(""),
  };
}

/**
 * Resolve an exact context-bearing occurrence. The original coordinates win
 * only when both the whole group and its two-sided context still match. A
 * relocation is accepted only when one unique full group matches within the
 * bounded window; repeated/ambiguous hits return null instead of the nearest
 * same-word result. Overlapping/duplicate ranges are valid as one group.
 */
export function resolveSearchOccurrence(
  points: readonly string[],
  target: SearchOccurrence,
  radius = 4096,
): RawTextRange[] | null {
  if (!target.hits.length) return null;
  if (!Number.isSafeInteger(radius) || radius < 0) return null;
  const hits = [...target.hits].sort((a, b) => a.start - b.start || a.end - b.end);
  const start = hits[0].start;
  const end = Math.max(...hits.map((hit) => hit.end));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  const before = Array.from(target.before);
  const after = Array.from(target.after);
  const needles: string[][] = [];
  for (const hit of hits) {
    if (
      !Number.isSafeInteger(hit.start) ||
      !Number.isSafeInteger(hit.end) ||
      hit.start < 0 ||
      hit.end <= hit.start
    ) {
      return null;
    }
    const needle = Array.from(hit.exactText);
    if (needle.length === 0 || hit.end - hit.start !== needle.length) return null;
    needles.push(needle);
  }
  const matches = (at: number, needle: readonly string[]): boolean =>
    Number.isSafeInteger(at) &&
    at >= 0 &&
    at + needle.length <= points.length &&
    needle.every((point, i) => points[at + i] === point);
  const groupMatches = (delta: number): boolean =>
    matches(start + delta - before.length, before) &&
    matches(end + delta, after) &&
    hits.every((hit, i) => matches(hit.start + delta, needles[i]));
  const relocated = (delta: number): RawTextRange[] =>
    hits.map((hit) => ({ start: hit.start + delta, end: hit.end + delta }));
  if (groupMatches(0)) return relocated(0);

  const low = Math.max(-radius, before.length - start);
  const high = Math.min(radius, points.length - end - after.length);
  let found: number | null = null;
  for (let delta = low; delta <= high; delta++) {
    if (delta === 0 || !groupMatches(delta)) continue;
    if (found !== null) return null;
    found = delta;
  }
  return found === null ? null : relocated(found);
}
