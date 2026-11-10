/** Readest-specific fallback policy; matching itself stays reader-independent. */
import { collapseCfi, type ParsedCfi } from "../../render/interop/epubCfi";
import { matchEpubText } from "../../render/interop/epubTextMatch";
import { normalizeAnchorText } from "../../render/textAnchor";
import { placePoint, type ChapterCache, type ImportReason, type Placed, type ReadestImportTarget } from "./readestConvert";
export async function placeReadestNote(parsed: ParsedCfi, text: string, target: ReadestImportTarget, chapters: ChapterCache): Promise<{
  chapter: Omit<Placed, "offset">; start: number; end: number; reasons: ImportReason[];
} | null> {
  const startPath = collapseCfi(parsed);
  const endPath = collapseCfi(parsed, true);
  const first = await placePoint(startPath, target, chapters);
  const last = parsed.kind === "range" ? await placePoint(endPath, target, chapters) : null;
  const chapter = first.ok ? first.placed : first.chapter;
  if (!chapter) return null;
  const reasons = [...chapter.reasons];
  const length = Array.from(normalizeAnchorText(text)).length;
  if (first.ok && last?.ok && first.placed.spineIndex === last.placed.spineIndex
    && chapter.index.slice(first.placed.offset, last.placed.offset) === normalizeAnchorText(text)) {
    return { chapter, start: first.placed.offset, end: last.placed.offset, reasons };
  }
  const matched = matchEpubText(chapter.index, text, first.ok ? first.placed.offset : null);
  if (matched) {
    if (matched.kind !== "exact") while (chapter.index.annotations[matched.end]) matched.end++;
    reasons.push(matched.kind === "exact" ? "text-relocated" : "text-reconciled");
    if (matched.kind !== "exact" && chapter.index.annotations.slice(matched.start, matched.end + 1).some(Boolean)) reasons.push("ruby-annotation");
    return { chapter, start: matched.start, end: matched.end, reasons };
  }
  if (first.ok && last?.ok && first.placed.spineIndex === last.placed.spineIndex && last.placed.offset > first.placed.offset) {
    return { chapter, start: first.placed.offset, end: last.placed.offset, reasons: [...reasons, "cfi-only"] };
  }
  const begin = first.ok ? first : await placePoint(startPath, target, chapters, true);
  const finish = last?.ok ? last : await placePoint(endPath, target, chapters, true);
  const total = chapter.index.totalChars;
  let start = begin.ok ? begin.placed.offset : finish.ok && finish.placed.spineIndex === chapter.spineIndex
    ? Math.max(0, finish.placed.offset - Math.max(1, length)) : 0;
  // A missing text point falls back to the nearest resolvable ancestor edge.
  if (!begin.ok && !finish.ok) {
    for (let count = startPath[1]?.length - 1; count > 0; count--) {
      const ancestor = await placePoint([startPath[0], startPath[1].slice(0, count)], target, chapters);
      if (ancestor.ok) { start = ancestor.placed.offset; break; }
    }
  }
  start = Math.min(start, Math.max(0, total - 1));
  const end = finish.ok && finish.placed.spineIndex === chapter.spineIndex && finish.placed.offset > start
    ? finish.placed.offset : Math.min(total, start + Math.max(1, length));
  return { chapter, start, end, reasons: [...reasons, "anchored"] };
}
