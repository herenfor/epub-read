import { buildDocument, MAX_ANCHOR_SNIPPET_CODE_POINTS, normalizeQueryPart } from "../core/corpus";
import type { ResolvedCrossBookSearchHit } from "../features/ai/indexing/indexStore";
import type { SearchPanelResult } from "./SearchPanel";

export interface CrossBookPanelResult extends SearchPanelResult {
  hit: ResolvedCrossBookSearchHit;
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
  const exactHit = {
    ...hit,
    textAnchor: {
      start: textOffset,
      end: textOffset + Math.max(1, Array.from(hit.originalText.slice(rawStart, rawEnd))
        .filter((point) => !/\p{White_Space}/u.test(point)).length),
      snippet: anchorSnippet(hit.originalText.slice(rawStart)),
    },
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
  };
}
