// Pure shelf entry, filter and progress helpers.

import { sanitizePersistedTextAnchor } from "../../render/textAnchor";
import { normalizeReaderNotes } from "../notes";
import { currentUiLocale } from "../localization/UiLanguageProvider";
import type { MediaReadingAnchor } from "../../render/paginator";
import type { ShelfEntry, ShelfProgressPatch, Bookmark } from "./types";

export type ShelfSort = "recent" | "added" | "title" | "progress";

export function sortShelfEntries(entries: ShelfEntry[], sort: ShelfSort): ShelfEntry[] {
  const list = [...entries];
  switch (sort) {
    case "added":
      return list.sort((a, b) => b.addedAtMs - a.addedAtMs);
    case "title":
      return list.sort((a, b) =>
        a.title.localeCompare(b.title, "zh-Hans-CN", { numeric: true })
      );
    case "progress":
      return list.sort((a, b) => (b.progressPct ?? 0) - (a.progressPct ?? 0));
    case "recent":
      return list.sort((a, b) => {
        const aRecent = a.lastReadAtMs > 0 ? a.lastReadAtMs : a.addedAtMs;
        const bRecent = b.lastReadAtMs > 0 ? b.lastReadAtMs : b.addedAtMs;
        return bRecent - aRecent;
      });
  }
}

export function filterShelfEntries(entries: ShelfEntry[], query: string): ShelfEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.title.toLowerCase().includes(q) || e.creator.toLowerCase().includes(q)
  );
}

/**
 * Normalize the value used for author grouping without changing the OPF value
 * stored in `ShelfEntry.creator`.
 *
 * NFKC handles compatibility forms (including full-width latin letters and
 * digits).  Whitespace and format characters are removed only when they are
 * between Han, Hiragana, or Katakana characters; ordinary spaces in western
 * names therefore remain intact.
 */
export const UNKNOWN_SHELF_AUTHOR = "未知作者";

export function normalizeShelfAuthor(value: string): string {
  const normalized = value.normalize("NFKC");
  const cjk = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
  const compact = normalized.replace(
    new RegExp(`(?<=[${cjk}])[\\p{White_Space}\\p{Cf}]+(?=[${cjk}])`, "gu"),
    "",
  );
  return compact.trim() || UNKNOWN_SHELF_AUTHOR;
}

/** Alias matching the terminology used by the shelf UI. */
export const normalizeShelfCreator = normalizeShelfAuthor;

export const UNKNOWN_SHELF_LANGUAGE = "未知语言";

/** Collapse BCP-47 language tags into stable, user-facing shelf groups. */
export function normalizeShelfLanguage(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) return UNKNOWN_SHELF_LANGUAGE;
  const normalized = raw.replace(/_/g, "-");
  const primary = normalized.split("-", 1)[0].toLowerCase();
  const groups: Record<string, string> = {
    zh: "中文",
    zho: "中文",
    chi: "中文",
    ja: "日语",
    jpn: "日语",
    en: "英语",
    eng: "英语",
    ko: "韩语",
    kor: "韩语",
    fr: "法语",
    fra: "法语",
    fre: "法语",
    de: "德语",
    deu: "德语",
    ger: "德语",
    es: "西班牙语",
    spa: "西班牙语",
    ru: "俄语",
    rus: "俄语",
  };
  return groups[primary] ?? normalized;
}

export type ShelfTimeSegment = "today" | "last7Days" | "last30Days" | "thisYear" | "older";

export const SHELF_TIME_SEGMENTS: readonly ShelfTimeSegment[] = [
  "today",
  "last7Days",
  "last30Days",
  "thisYear",
  "older",
];

export const SHELF_TIME_SEGMENT_LABELS: Readonly<Record<ShelfTimeSegment, string>> = {
  today: "今天",
  last7Days: "最近 7 天",
  last30Days: "最近 30 天",
  thisYear: "今年",
  older: "更早",
};

export function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Assign a save time to one mutually-exclusive, display-friendly segment. */
export function shelfTimeSegment(addedAtMs: number, nowMs = Date.now()): ShelfTimeSegment {
  if (!Number.isFinite(addedAtMs) || addedAtMs <= 0) return "older";
  const today = startOfLocalDay(nowMs);
  if (addedAtMs >= today) return "today";
  const day = 24 * 60 * 60 * 1000;
  if (addedAtMs >= today - 6 * day) return "last7Days";
  if (addedAtMs >= today - 29 * day) return "last30Days";
  const yearStart = new Date(new Date(nowMs).getFullYear(), 0, 1).getTime();
  if (addedAtMs >= yearStart) return "thisYear";
  return "older";
}

/** Alias using the field name used in some consumers. */
export const getShelfTimeSegment = shelfTimeSegment;

export interface ShelfFilterSelection {
  /** Normalized author values; all values in one facet are OR-ed. */
  authors?: readonly string[];
  titles?: readonly string[];
  timeSegments?: readonly ShelfTimeSegment[];
  languages?: readonly string[];
  /** Optional free-text search, kept here so the menu can use one model. */
  query?: string;
}

export interface ShelfFacetOption {
  value: string;
  label: string;
  count: number;
}

export interface ShelfFacet {
  options: ShelfFacetOption[];
  counts: Record<string, number>;
}

export interface ShelfFilterFacets {
  authors: ShelfFacet;
  titles: ShelfFacet;
  timeSegments: ShelfFacet;
  languages: ShelfFacet;
}

export interface IndexedShelfEntry {
  entry: ShelfEntry;
  author: string;
  title: string;
  timeSegment: ShelfTimeSegment;
  language: string;
  searchText: string;
}

export interface ShelfFilterIndex {
  entries: readonly IndexedShelfEntry[];
  nowMs: number;
}

export function indexShelfEntries(entries: ShelfEntry[], nowMs: number): IndexedShelfEntry[] {
  return entries.map((entry) => {
    const author = normalizeShelfAuthor(entry.creator);
    const language = normalizeShelfLanguage(entry.language);
    return {
      entry,
      author,
      title: entry.title,
      timeSegment: shelfTimeSegment(entry.addedAtMs, nowMs),
      language,
      searchText: `${entry.title} ${entry.creator}`.toLocaleLowerCase(),
    };
  });
}

/** Build the reusable metadata index in one pass over the shelf entries. */
export function buildShelfFilterIndex(entries: ShelfEntry[], nowMs = Date.now()): ShelfFilterIndex {
  return { entries: indexShelfEntries(entries, nowMs), nowMs };
}

export function selectedSet(values: readonly string[] | undefined, normalize?: (value: string) => string): Set<string> {
  return new Set((values ?? []).map((value) => normalize ? normalize(value) : value));
}

export interface CompiledShelfFilterSelection {
  authors: Set<string>;
  titles: Set<string>;
  timeSegments: Set<ShelfTimeSegment>;
  languages: Set<string>;
  query: string;
}

export function compileSelection(selection: ShelfFilterSelection): CompiledShelfFilterSelection {
  return {
    authors: selectedSet(selection.authors, normalizeShelfAuthor),
    titles: selectedSet(selection.titles),
    timeSegments: new Set(selection.timeSegments ?? []),
    languages: selectedSet(selection.languages, normalizeShelfLanguage),
    query: selection.query?.trim().toLocaleLowerCase() ?? "",
  };
}

export function matchesCompiledSelection(
  item: IndexedShelfEntry,
  selection: CompiledShelfFilterSelection,
  skip?: keyof CompiledShelfFilterSelection,
): boolean {
  const query = selection.query;
  if (skip !== "authors" && selection.authors.size > 0 && !selection.authors.has(item.author)) return false;
  if (skip !== "titles" && selection.titles.size > 0 && !selection.titles.has(item.title)) return false;
  if (skip !== "timeSegments" && selection.timeSegments.size > 0 && !selection.timeSegments.has(item.timeSegment)) return false;
  if (skip !== "languages" && selection.languages.size > 0 && !selection.languages.has(item.language)) return false;
  if (skip !== "query" && query && !item.searchText.includes(query)) return false;
  return true;
}

export function matchesShelfFilterSelection(entry: ShelfEntry, selection: ShelfFilterSelection = {}, nowMs = Date.now()): boolean {
  const author = normalizeShelfAuthor(entry.creator);
  const item: IndexedShelfEntry = {
    entry,
    author,
    title: entry.title,
    timeSegment: shelfTimeSegment(entry.addedAtMs, nowMs),
    language: normalizeShelfLanguage(entry.language),
    searchText: `${entry.title} ${entry.creator}`.toLocaleLowerCase(),
  };
  return matchesCompiledSelection(item, compileSelection(selection));
}

export function facetFromValues(values: readonly string[], counts: Map<string, number>, label = (value: string): string => value): ShelfFacet {
  const countRecord: Record<string, number> = {};
  const options = values.map((value) => {
    const count = counts.get(value) ?? 0;
    countRecord[value] = count;
    return { value, label: label(value), count };
  });
  return { options, counts: countRecord };
}

/**
 * Build all facet options and cross-filtered counts. Each entry is indexed
 * once, then contributes to the four facet counters at most once. This keeps
 * the operation linear for normal book-sized shelves and makes it suitable
 * for a `useMemo` call.
 */
export function buildShelfFilterFacets(
  entriesOrIndex: ShelfEntry[] | ShelfFilterIndex,
  selection: ShelfFilterSelection = {},
  nowMs = Date.now(),
): ShelfFilterFacets {
  const index = Array.isArray(entriesOrIndex)
    ? buildShelfFilterIndex(entriesOrIndex, nowMs)
    : entriesOrIndex;
  const authorValues = new Set<string>();
  const titleValues = new Set<string>();
  const timeValues = new Set<ShelfTimeSegment>();
  const languageValues = new Set<string>();
  const authorCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const timeCounts = new Map<ShelfTimeSegment, number>();
  const languageCounts = new Map<string, number>();
  const compiled = compileSelection(selection);
  for (const item of index.entries) {
    authorValues.add(item.author);
    titleValues.add(item.title);
    timeValues.add(item.timeSegment);
    languageValues.add(item.language);
    if (matchesCompiledSelection(item, compiled, "authors")) authorCounts.set(item.author, (authorCounts.get(item.author) ?? 0) + 1);
    if (matchesCompiledSelection(item, compiled, "titles")) titleCounts.set(item.title, (titleCounts.get(item.title) ?? 0) + 1);
    if (matchesCompiledSelection(item, compiled, "timeSegments")) timeCounts.set(item.timeSegment, (timeCounts.get(item.timeSegment) ?? 0) + 1);
    if (matchesCompiledSelection(item, compiled, "languages")) languageCounts.set(item.language, (languageCounts.get(item.language) ?? 0) + 1);
  }
  return {
    authors: facetFromValues([...authorValues].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), authorCounts),
    titles: facetFromValues([...titleValues].sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true })), titleCounts),
    timeSegments: facetFromValues(SHELF_TIME_SEGMENTS.filter((value) => timeValues.has(value)), timeCounts, (value) => SHELF_TIME_SEGMENT_LABELS[value as ShelfTimeSegment]),
    languages: facetFromValues([...languageValues].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), languageCounts),
  };
}

export function filterShelfEntriesByFacets(
  entriesOrIndex: ShelfEntry[] | ShelfFilterIndex,
  selection: ShelfFilterSelection = {},
  nowMs = Date.now(),
): ShelfEntry[] {
  const index = Array.isArray(entriesOrIndex)
    ? buildShelfFilterIndex(entriesOrIndex, nowMs)
    : entriesOrIndex;
  const compiled = compileSelection(selection);
  return index.entries.filter((item) => matchesCompiledSelection(item, compiled)).map((item) => item.entry);
}

export interface ShelfFilterModel {
  index: ShelfFilterIndex;
  entries: ShelfEntry[];
  facets: ShelfFilterFacets;
}

/** One-call model for a memoized shelf view. */
export function createShelfFilterModel(
  entries: ShelfEntry[],
  selection: ShelfFilterSelection = {},
  nowMs = Date.now(),
): ShelfFilterModel {
  const index = buildShelfFilterIndex(entries, nowMs);
  return {
    index,
    entries: filterShelfEntriesByFacets(index, selection),
    facets: buildShelfFilterFacets(index, selection),
  };
}

export function applyShelfProgressPatch(
  entries: ShelfEntry[],
  id: string,
  patch: ShelfProgressPatch
): ShelfEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, ...patch, isNew: false } : entry));
}

/** Validate a persisted media anchor. Invalid/legacy-missing values degrade to null. */
export function normalizeMediaReadingAnchor(value: unknown): MediaReadingAnchor | null {
  if (!value || typeof value !== "object") return null;
  const media = value as Partial<MediaReadingAnchor>;
  if (
    !Number.isSafeInteger(media.index) ||
    (media.index as number) < 0 ||
    typeof media.tag !== "string" ||
    media.tag.length === 0 ||
    typeof media.signature !== "string" ||
    media.signature.length === 0 ||
    typeof media.ratio !== "number" ||
    !Number.isFinite(media.ratio) ||
    media.ratio < 0 ||
    media.ratio > 1
  ) {
    return null;
  }
  return {
    index: media.index as number,
    tag: media.tag,
    signature: media.signature,
    ratio: media.ratio,
  };
}

/** Normalize legacy IndexedDB rows at the storage boundary; new writes use null. */
export function normalizeBookmarkTextAnchor(bookmark: Bookmark): Bookmark {
  const text = sanitizePersistedTextAnchor({
    textOffset: bookmark.anchorTextOffset,
    textSnippet: bookmark.anchorTextSnippet,
  });
  return {
    ...bookmark,
    anchorTextOffset: text.textOffset,
    anchorTextSnippet: text.textSnippet,
    mediaAnchor: normalizeMediaReadingAnchor(bookmark.mediaAnchor),
  };
}

export function normalizeShelfEntryTextAnchors(entry: ShelfEntry): ShelfEntry {
  const text = sanitizePersistedTextAnchor({
    textOffset: entry.anchorTextOffset,
    textSnippet: entry.anchorTextSnippet,
  });
  return {
    ...entry,
    anchorTextOffset: text.textOffset,
    anchorTextSnippet: text.textSnippet,
    mediaAnchor: normalizeMediaReadingAnchor(entry.mediaAnchor),
    bookmarks: entry.bookmarks?.map(normalizeBookmarkTextAnchor),
    notes: normalizeReaderNotes(entry.notes),
  };
}

/** Convert persisted shelf fields to a renderer restore anchor. Never persist -1. */
export function readingAnchorFromShelfEntry(entry: Pick<
  ShelfEntry,
  "anchorIndex" | "anchorRatio" | "anchorTextOffset" | "anchorTextSnippet" | "mediaAnchor"
>): {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  mediaAnchor?: MediaReadingAnchor | null;
} | null {
  const text = sanitizePersistedTextAnchor({
    textOffset: entry.anchorTextOffset,
    textSnippet: entry.anchorTextSnippet,
  });
  const mediaAnchor = normalizeMediaReadingAnchor(entry.mediaAnchor);
  const legacy =
    typeof entry.anchorIndex === "number" &&
    Number.isSafeInteger(entry.anchorIndex) &&
    entry.anchorIndex >= 0 &&
    typeof entry.anchorRatio === "number" &&
    Number.isFinite(entry.anchorRatio) &&
    entry.anchorRatio >= 0 &&
    entry.anchorRatio <= 1;
  if (!legacy && text.textOffset === null && !mediaAnchor) return null;
  const restored = {
    index: legacy ? entry.anchorIndex! : -1,
    ratio: legacy ? entry.anchorRatio! : (mediaAnchor?.ratio ?? 0),
    anchorTextOffset: text.textOffset,
    anchorTextSnippet: text.textSnippet,
  };
  return mediaAnchor ? { ...restored, mediaAnchor } : restored;
}

/** 只清除新书标记；异步 markOpened 的旧返回值不能覆盖更新后的进度。 */
export function markShelfEntryOpened(entries: ShelfEntry[], id: string): ShelfEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, isNew: false } : entry));
}

export function formatShelfTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  // zh-CN renders "10月10日" / "2025/03/04"; other UI languages get their own order.
  return sameYear
    ? new Intl.DateTimeFormat(currentUiLocale(), { month: "short", day: "numeric" }).format(d)
    : new Intl.DateTimeFormat(currentUiLocale(), { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ---- IndexedDB（浏览器 dev / 非 Tauri 环境回退） ----
