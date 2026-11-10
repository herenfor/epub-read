/** Matching projections only: all returned ranges address the canonical index. */
import type { ChapterTextIndex } from "./epubCfi";
export interface TextMatchView {
  kind: "exact" | "presentation" | "content";
  chars: string[];
  canonicalOffsets: number[];
}
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
const CONTENT = /[\p{L}\p{N}]/u;
const cache = new WeakMap<ChapterTextIndex, TextMatchView[]>();
function project(chars: string[], offsets: number[], kind: TextMatchView["kind"]): TextMatchView {
  if (kind === "exact") return { kind, chars, canonicalOffsets: offsets };
  const text = chars.join("");
  const excluded = new Set<number>();
  // These are presentation alternatives, never a rewrite of stored text.
  const groups = /[（(][A-Za-z\s.'’\-]*[）)]|\[\d+\]|[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu;
  for (const match of text.matchAll(groups)) {
    for (let i = match.index!; i < match.index! + match[0].length; i++) excluded.add(i);
  }
  const view: TextMatchView = { kind, chars: [], canonicalOffsets: [] };
  let raw = 0;
  chars.forEach((char, i) => {
    const at = raw;
    raw += char.length;
    if (!excluded.has(at) && !INVISIBLE.test(char) && (kind !== "content" || CONTENT.test(char))) {
      view.chars.push(char); view.canonicalOffsets.push(offsets[i]);
    }
  });
  return view;
}
export function textMatchViews(index: ChapterTextIndex): TextMatchView[] {
  let views = cache.get(index);
  if (!views) {
    const offsets = index.codePoints.map((_, i) => i);
    const body = offsets.filter((i) => !index.annotations[i]);
    views = [project(index.codePoints, offsets, "exact"), ...(["presentation", "content"] as const)
      .map((kind) => project(body.map((i) => index.codePoints[i]), body, kind))];
    cache.set(index, views);
  }
  return views;
}
export interface TextMatch { start: number; end: number; kind: TextMatchView["kind"] }
function nearest(hits: TextMatch[], near: number | null): TextMatch | null {
  if (hits.length === 1) return hits[0];
  if (near === null || !hits.length) return null;
  hits.sort((a, b) => Math.abs(a.start - near) - Math.abs(b.start - near));
  return Math.abs(hits[0].start - near) === Math.abs(hits[1].start - near) ? null : hits[0];
}
export function matchEpubText(index: ChapterTextIndex, source: string, near: number | null): TextMatch | null {
  const chars = Array.from(source).filter((c) => !/\p{White_Space}/u.test(c));
  for (const view of textMatchViews(index)) {
    const needle = project(chars, chars.map((_, i) => i), view.kind).chars;
    if (!needle.length) continue;
    const hits: TextMatch[] = [];
    outer: for (let i = 0; i <= view.chars.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (view.chars[i + j] !== needle[j]) continue outer;
      hits.push({ start: view.canonicalOffsets[i], end: view.canonicalOffsets[i + needle.length - 1] + 1, kind: view.kind });
    }
    // Short captures are only accepted when globally unique, even with a CFI hint.
    const found = nearest(hits, chars.length < 4 && view.kind !== "exact" ? null : near);
    if (found) return found;
  }
  return null;
}
