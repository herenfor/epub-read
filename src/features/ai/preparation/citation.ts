import type { DocumentChunk } from "../../../core/chunking";
import type { SearchResult } from "../../../core/search";

/** Reuse reader navigation without converting code-point anchors into UTF-16 ranges. */
export function preparationCitation(chunk: DocumentChunk): SearchResult {
  return {
    spineIndex: chunk.spineIndex, chapterPath: chunk.chapterPath, chapterTitle: chunk.chapterTitle,
    snippet: chunk.originalText, snippetMatchRanges: [], originalRange: { start: 0, end: chunk.originalText.length },
    textOffset: chunk.textAnchor.start, textSnippet: chunk.textAnchor.snippet,
    matchedText: chunk.originalText, matchType: "phrase",
  };
}
