import { buildDocument, MAX_ANCHOR_SNIPPET_CODE_POINTS, normalizeQueryPart } from "../core/corpus";
import { buildExactTextHits, type ExactTextHit } from "../core/exactTextHits";
import type { ResolvedCrossBookSearchHit } from "../features/ai/indexing/indexStore";
import type { SearchPanelResult } from "./SearchPanel";

export interface CrossBookPanelResult extends SearchPanelResult {
  hit: ResolvedCrossBookSearchHit;
  /** Exact body ranges when the indexed block proves a contiguous match. */
  textHits?: ExactTextHit[];
}

function anchorSnippet(value: string): string {
  return Array.from(value)
    .filter((point) => !/\p{White_Space}/u.test(point))
    .slice(0, MAX_ANCHOR_SNIPPET_CODE_POINTS)
    .join("");
}

/** Build display/highlight data while retaining a reader-compatible exact hit anchor. */
export function presentCrossBookHit(
  hit: ResolvedCrossBookSearchHit,
  query: string,
  disabledReason?: string,
): CrossBookPanelResult {
  const document = buildDocument(hit.originalText);
  const normalizedQuery = normalizeQueryPart(query);
  const normalizedStart = normalizedQuery ? document.normalized.indexOf(normalizedQuery) : -1;
  let rawStart = 0;
  let rawEnd = 0;
  let localAnchorOffset = 0;
  if (normalizedStart >= 0) {
    const startEntry = document.normalizedUnitToEntry[normalizedStart] ?? 0;
    const endUnit = normalizedStart + normalizedQuery.length - 1;
    const endEntry = document.normalizedUnitToEntry[endUnit] ?? startEntry;
    rawStart = document.rawStarts[startEntry] ?? 0;
    rawEnd = document.rawEnds[endEntry] ?? rawStart;
    localAnchorOffset = document.anchorStarts[startEntry] ?? 0;
  }
  const contextStart = Math.max(0, rawStart - 48);
  const contextEnd = Math.min(hit.originalText.length, Math.max(rawEnd, rawStart) + 96);
  const snippet = hit.originalText.slice(contextStart, contextEnd).trim();
  const leadingTrim = hit.originalText.slice(contextStart, contextEnd).length -
    hit.originalText.slice(contextStart, contextEnd).trimStart().length;
  const matchStart = Math.max(0, rawStart - contextStart - leadingTrim);
  const matchEnd = Math.max(matchStart, rawEnd - contextStart - leadingTrim);
  const textOffset = hit.textAnchor.start + localAnchorOffset;
  const exactRanges = rawEnd > rawStart ? [{ start: rawStart, end: rawEnd }] : [];
  const localHits = exactRanges.length > 0
    ? buildExactTextHits(hit.originalText, exactRanges)
    : null;
  // buildExactTextHits returns block-local code-point ranges.  Convert them
  // exactly once to chapter coordinates by adding the raw block start; never
  // add the already-offset exactHit.textAnchor.start a second time.
  const textHits = localHits
    ?.map((range) => ({
      ...range,
      start: hit.textAnchor.start + range.start,
      end: hit.textAnchor.start + range.end,
    }))
    .filter((range) =>
      Number.isSafeInteger(range.start) &&
      Number.isSafeInteger(range.end) &&
      range.start >= 0 &&
      range.end > range.start
    );
  const exactHit = {
    ...hit,
    textAnchor: textHits && textHits.length > 0
      ? {
          start: textOffset,
          end: textOffset + textHits[0].end - textHits[0].start,
          snippet: anchorSnippet(hit.originalText.slice(rawStart)),
        }
      : hit.textAnchor,
  };
  return {
    id: `${hit.contentHash}:${hit.chunkId}`,
    bookTitle: hit.title,
    creator: hit.creator,
    chapterTitle: hit.chapterTitle || hit.chapterPath,
    chapterPath: hit.chapterPath,
    snippet: snippet || hit.originalText.slice(0, 144),
    matchRanges: matchEnd > matchStart ? [{ start: matchStart, end: matchEnd }] : [],
    disabledReason,
    hit: exactHit,
    textHits,
  };
}
