/**
 * Turn normalized Readest records into SeLis portable values for one local
 * EPUB, graded so the preview can say what is exact, what moved, and what
 * could not be placed. Nothing here writes; the caller commits only what the
 * user confirms, through the existing portable-state write path.
 */
import type {
  BookmarkValue,
  ModernLocator,
  NoteValue,
  ProgressValue,
} from "../../core/portableState/portable-state-types";
import {
  ChapterTextIndex,
  collapseCfi,
  parseEpubCfi,
  resolveCfiInDocument,
  resolveCfiSpine,
  type CfiPath,
} from "../../render/interop/epubCfi";
import { normalizeAnchorText } from "../../render/textAnchor";
import { MAX_NOTE_CONTENT_CODE_POINTS, MAX_NOTE_SELECTED_CODE_POINTS } from "../notes";
import type { ReadestBookConfig, ReadestRecord } from "./readestBackup";

const TEXT_PROFILE = "visible-codepoints-no-whitespace-v1" as const;
const BOOKMARK_TEXT_CHARS = 80;
const ONE_DAY_MS = 86_400_000;

export interface ReadestImportTarget {
  /** Manifest idrefs in spine order (`Book.spine[i].idref`). */
  spineIdrefs: readonly string[];
  /** Archive path of a spine item (`spineItemPath`). */
  chapterPath(spineIndex: number): string | undefined;
  /** The book's own parsed OPF; without it spine positions are only guessed. */
  opfDocument: Document | null;
  /** Parsed original chapter XHTML (not the live reader DOM); null if unreadable. */
  loadChapter(spineIndex: number): Promise<Document | null>;
}

/** "unsupported": a record kind this release does not import (never committed). */
export type ImportGrade = "exact" | "approximate" | "unresolved" | "unsupported";

export type ImportReason =
  /** Position found, but through a fallback the user should know about. */
  | "spine-guessed"
  | "id-corrected"
  | "text-relocated"
  | "text-differs"
  /** Position not found. */
  | "bad-cfi"
  | "chapter-missing"
  | "node-missing"
  | "outside-text"
  | "text-mismatch"
  | "text-ambiguous"
  | "too-long"
  /** Not imported in this release. */
  | "highlight-only";

export interface ImportCandidate<T> {
  /** Stable per source record, so importing the same backup twice adds nothing. */
  sourceKey: string;
  grade: ImportGrade;
  reasons: ImportReason[];
  /** Null exactly when grade is "unresolved" or "unsupported". */
  value: T | null;
  source: { cfi: string; text: string | null };
}

export interface ReadestBookPreview {
  progress: ImportCandidate<ProgressValue> | null;
  bookmarks: ImportCandidate<BookmarkValue>[];
  notes: ImportCandidate<NoteValue>[];
}

interface Placed {
  spineIndex: number;
  chapterPath: string;
  index: ChapterTextIndex;
  offset: number;
  reasons: ImportReason[];
}

type PointResult = { ok: true; placed: Placed } | { ok: false; reason: ImportReason; chapter?: Omit<Placed, "offset"> };

class ChapterCache {
  private readonly cache = new Map<number, Promise<ChapterTextIndex | null>>();
  constructor(private readonly target: ReadestImportTarget) {}
  get(spineIndex: number): Promise<ChapterTextIndex | null> {
    let entry = this.cache.get(spineIndex);
    if (!entry) {
      entry = this.target.loadChapter(spineIndex).then((doc) => (doc ? new ChapterTextIndex(doc) : null), () => null);
      this.cache.set(spineIndex, entry);
    }
    return entry;
  }
}

async function placePoint(path: CfiPath, target: ReadestImportTarget, chapters: ChapterCache): Promise<PointResult> {
  if (path.length !== 2) return { ok: false, reason: "bad-cfi" };
  const spine = resolveCfiSpine(path[0], target.spineIdrefs, target.opfDocument);
  if (!spine) return { ok: false, reason: "chapter-missing" };
  const chapterPath = target.chapterPath(spine.spineIndex);
  const index = chapterPath ? await chapters.get(spine.spineIndex) : null;
  if (!chapterPath || !index?.root) return { ok: false, reason: "chapter-missing" };
  const reasons: ImportReason[] = spine.via === "path" ? [] : ["spine-guessed"];
  const chapter = { spineIndex: spine.spineIndex, chapterPath, index, reasons };
  const doc = index.root.ownerDocument;
  const resolved = doc ? resolveCfiInDocument(doc, path[1]) : null;
  if (!resolved) return { ok: false, reason: "node-missing", chapter };
  const offset = index.offsetAt(resolved.point);
  if (offset === null) return { ok: false, reason: "outside-text", chapter };
  return { ok: true, placed: { ...chapter, offset, reasons: resolved.idCorrected ? [...reasons, "id-corrected"] : reasons } };
}

const gradeOf = (reasons: readonly ImportReason[]): ImportGrade => (reasons.length ? "approximate" : "exact");

function locatorAt(placed: Placed): ModernLocator {
  const { index, chapterPath, spineIndex } = placed;
  if (index.totalChars === 0) {
    return { locatorVersion: 1, chapterPath, spineIndexHint: spineIndex, target: { kind: "chapter-start" } };
  }
  // A point after the last character is stored on the last character so the
  // snippet still validates when the reader reopens the chapter.
  const offset = Math.min(placed.offset, index.totalChars - 1);
  return {
    locatorVersion: 1,
    chapterPath,
    spineIndexHint: spineIndex,
    target: { kind: "text", textProfile: TEXT_PROFILE, offset, snippet: index.snippetAt(offset)! },
  };
}

function createdAt(record: ReadestRecord, nowMs: number): number {
  const at = record.createdAtMs;
  return at !== null && at <= nowMs + ONE_DAY_MS ? at : nowMs;
}

/** Choose among text occurrences: the unique one nearest the CFI, never just the first. */
function pickOccurrence(hits: readonly number[], near: number | null): number | null {
  if (hits.length === 1) return hits[0];
  if (!hits.length || near === null) return null;
  const distance = Math.min(...hits.map((hit) => Math.abs(hit - near)));
  const nearest = hits.filter((hit) => Math.abs(hit - near) === distance);
  return nearest.length === 1 ? nearest[0] : null;
}

const unresolved = <T>(sourceKey: string, record: { cfi: string; text: string | null }, reason: ImportReason): ImportCandidate<T> =>
  ({ sourceKey, grade: "unresolved", reasons: [reason], value: null, source: { cfi: record.cfi, text: record.text } });

async function convertProgress(
  hash: string,
  config: ReadestBookConfig,
  target: ReadestImportTarget,
  chapters: ChapterCache,
): Promise<ImportCandidate<ProgressValue> | null> {
  if (!config.location) return null;
  const sourceKey = `readest:${hash}:progress`;
  const source = { cfi: config.location, text: null };
  const parsed = parseEpubCfi(config.location);
  if (!parsed) return unresolved(sourceKey, source, "bad-cfi");
  const point = await placePoint(collapseCfi(parsed), target, chapters);
  if (!point.ok) return unresolved(sourceKey, source, point.reason);
  const { placed } = point;
  const pct = config.pages
    ? (config.pages[0] / config.pages[1]) * 100
    : (placed.spineIndex / Math.max(1, target.spineIdrefs.length)) * 100;
  return {
    sourceKey,
    grade: gradeOf(placed.reasons),
    reasons: placed.reasons,
    // The native progress hint is an integer percentage.
    value: { locator: locatorAt(placed), progressPctHint: Math.round(Math.max(0, Math.min(100, pct))) },
    source,
  };
}

async function convertBookmark(
  sourceKey: string,
  record: ReadestRecord,
  target: ReadestImportTarget,
  chapters: ChapterCache,
  nowMs: number,
): Promise<ImportCandidate<BookmarkValue>> {
  const parsed = parseEpubCfi(record.cfi);
  if (!parsed) return unresolved(sourceKey, record, "bad-cfi");
  const point = await placePoint(collapseCfi(parsed), target, chapters);
  if (!point.ok) return unresolved(sourceKey, record, point.reason);
  const { placed } = point;
  const reasons = [...placed.reasons];
  // The excerpt Readest kept should start where the bookmark points. A
  // mismatch is reported, but a bookmark's position is still usable.
  const excerpt = record.text ? Array.from(normalizeAnchorText(record.text)).slice(0, 8).join("") : "";
  if (excerpt && !placed.index.slice(placed.offset, placed.offset + Array.from(excerpt).length).startsWith(excerpt)) {
    reasons.push("text-differs");
  }
  const locator = locatorAt(placed);
  const label = record.text?.replace(/\s+/g, " ").trim()
    || (locator.target.kind === "text" ? locator.target.snippet : "");
  return {
    sourceKey,
    grade: gradeOf(reasons),
    reasons,
    // Cut by code point: a UTF-16 cut can leave a lone surrogate that fails JSON round trips.
    value: { locator, text: Array.from(label).slice(0, BOOKMARK_TEXT_CHARS).join(""), createdAtMs: createdAt(record, nowMs) },
    source: { cfi: record.cfi, text: record.text },
  };
}

async function convertNote(
  sourceKey: string,
  record: ReadestRecord,
  target: ReadestImportTarget,
  chapters: ChapterCache,
  nowMs: number,
): Promise<ImportCandidate<NoteValue>> {
  // A highlight or excerpt without a written note has no SeLis counterpart:
  // notes require content, and an invented body would misrepresent the record.
  if (!record.note.trim()) {
    return { sourceKey, grade: "unsupported", reasons: ["highlight-only"], value: null, source: { cfi: record.cfi, text: record.text } };
  }
  const selected = record.text ?? "";
  const needle = normalizeAnchorText(selected);
  const needleLength = Array.from(needle).length;
  if (!needleLength) return unresolved(sourceKey, record, "text-mismatch");
  if (Array.from(selected).length > MAX_NOTE_SELECTED_CODE_POINTS
    || Array.from(record.note).length > MAX_NOTE_CONTENT_CODE_POINTS) {
    return unresolved(sourceKey, record, "too-long");
  }
  const parsed = parseEpubCfi(record.cfi);
  if (!parsed) return unresolved(sourceKey, record, "bad-cfi");
  const startPoint = await placePoint(collapseCfi(parsed), target, chapters);
  const endPoint = parsed.kind === "range" ? await placePoint(collapseCfi(parsed, true), target, chapters) : null;
  const chapter = startPoint.ok ? startPoint.placed : startPoint.chapter;
  if (!chapter) return unresolved(sourceKey, record, startPoint.ok ? "chapter-missing" : startPoint.reason);
  const reasons = [...chapter.reasons];
  let start: number | null = null;
  if (startPoint.ok && endPoint?.ok && endPoint.placed.spineIndex === chapter.spineIndex
    && chapter.index.slice(startPoint.placed.offset, endPoint.placed.offset) === needle) {
    start = startPoint.placed.offset;
  } else {
    // The CFI and the captured text disagree (or the CFI could not be walked):
    // trust the text only when it identifies one place in this chapter.
    const near = startPoint.ok ? startPoint.placed.offset : null;
    const hits = chapter.index.occurrences(needle);
    start = pickOccurrence(hits, near);
    if (start === null) return unresolved(sourceKey, record, hits.length ? "text-ambiguous" : "text-mismatch");
    reasons.push("text-relocated");
  }
  const end = start + needleLength;
  return {
    sourceKey,
    grade: gradeOf(reasons),
    reasons,
    value: {
      chapterPath: chapter.chapterPath,
      spineIndexHint: chapter.spineIndex,
      textProfile: TEXT_PROFILE,
      startTextOffset: start,
      endTextOffset: end,
      startTextSnippet: chapter.index.snippetAt(start)!,
      endTextSnippet: chapter.index.snippetBefore(end)!,
      selectedText: selected,
      content: record.note,
      createdAtMs: createdAt(record, nowMs),
    },
    source: { cfi: record.cfi, text: record.text },
  };
}

/** Preview everything one Readest book config can contribute to one local EPUB. */
export async function convertReadestBook(
  hash: string,
  config: ReadestBookConfig,
  target: ReadestImportTarget,
  nowMs: number,
): Promise<ReadestBookPreview> {
  const chapters = new ChapterCache(target);
  const bookmarks: ImportCandidate<BookmarkValue>[] = [];
  const notes: ImportCandidate<NoteValue>[] = [];
  for (const record of config.records) {
    const sourceKey = `readest:${hash}:${record.id}`;
    if (record.kind === "bookmark") bookmarks.push(await convertBookmark(sourceKey, record, target, chapters, nowMs));
    else notes.push(await convertNote(sourceKey, record, target, chapters, nowMs));
  }
  return { progress: await convertProgress(hash, config, target, chapters), bookmarks, notes };
}
