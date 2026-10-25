import type { ReaderLibraryPassage } from "./contracts";

/** A preview is an exact substring, never a summary or a replacement for the
 * originalText field. Its anchor continues to identify the source chunk. */
export function readerSearchPreview(hit: ReaderLibraryPassage, queries: string[]) {
  let at = -1;
  for (const term of queries.flatMap(query => query.split(/\s+/u))) {
    const found = hit.originalText.search(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const points = Array.from(hit.originalText);
  const before = at < 0 ? 0 : Array.from(hit.originalText.slice(0, at)).length;
  const start = Math.max(0, before - 60);
  const excerpt = points.slice(start, start + 240).join("");
  const { originalText: _text, ...identity } = hit;
  return { ...identity, excerpt, excerptTruncated: excerpt.length < hit.originalText.length };
}
