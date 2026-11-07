/**
 * Readest (v0.12.x) backup records, normalized and bounded.
 *
 * Input is the *text* of `library.json` and `<hash>/config.json`, already read
 * from the ZIP by the native side. Nothing else in the backup (settings.json
 * with optional credentials, statistics, covers, book files) is read here.
 * Shapes follow readest/apps/readest-app/src/types/book.ts at v0.12.20.
 */

import { isNoteStyle, type NoteStyle } from "../notes";

export const READEST_LIBRARY_ENTRY = "library.json";
export const readestConfigEntry = (hash: string): string => `${hash}/config.json`;

/** Readest's book key: KOReader-style partial MD5 (lowercase hex). */
const HASH = /^[0-9a-f]{32}$/;
const RECORD_ID = /^[\w.:-]{1,128}$/;
const MAX_JSON_CHARS = 64 * 1024 * 1024;
const MAX_BOOKS = 20_000;
const MAX_RECORDS = 20_000;
const MAX_TITLE_CHARS = 512;

export interface ReadestLibraryBook {
  hash: string;
  /** Readest `BookFormat`, upper case (EPUB, PDF, MOBI, ...). */
  format: string;
  title: string;
  author: string;
  /** Import basename including extension, when Readest kept it. */
  originalFilename: string | null;
  /** Tombstoned in Readest; listed for the user but never propagated. */
  deleted: boolean;
}

export type ReadestParseFailure = "invalid-json" | "unexpected-shape" | "too-large";

export type ReadestParseResult<T> = { ok: true; value: T } | { ok: false; reason: ReadestParseFailure };

function parseJson(text: string): ReadestParseResult<unknown> {
  if (typeof text !== "string" || text.length > MAX_JSON_CHARS) return { ok: false, reason: "too-large" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function shortString(value: unknown, max = MAX_TITLE_CHARS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? Array.from(trimmed).slice(0, max).join("") : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseReadestLibrary(text: string): ReadestParseResult<{ books: ReadestLibraryBook[]; ignored: number }> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return { ok: false, reason: "unexpected-shape" };
  if (parsed.value.length > MAX_BOOKS) return { ok: false, reason: "too-large" };
  const books: ReadestLibraryBook[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const raw of parsed.value) {
    const hash = isObject(raw) && typeof raw.hash === "string" ? raw.hash.toLowerCase() : "";
    if (!isObject(raw) || !HASH.test(hash) || seen.has(hash)) {
      ignored++;
      continue;
    }
    seen.add(hash);
    books.push({
      hash,
      format: (shortString(raw.format, 16) ?? "").toUpperCase(),
      title: shortString(raw.title) ?? shortString(raw.sourceTitle) ?? hash,
      author: shortString(raw.author) ?? "",
      originalFilename: shortString(raw.originalFilename),
      deleted: timestamp(raw.deletedAt) !== null,
    });
  }
  return { ok: true, value: { books, ignored } };
}

export type ReadestRecordKind = "bookmark" | "note";

export interface ReadestRecord {
  id: string;
  kind: ReadestRecordKind;
  /** Raw record type from Readest (bookmark, annotation, excerpt). */
  type?: "bookmark" | "annotation" | "excerpt";
  /** Readest `cfi`: a point for bookmarks, a range for highlights/notes. */
  cfi: string;
  /** Text Readest captured at the location (selection or page excerpt). */
  text: string | null;
  /** User-written note body; empty for plain highlights/excerpts. */
  note: string;
  /** Highlight style: highlight, underline, squiggly. */
  style?: NoteStyle;
  /** Highlight color: palette name or #rrggbb hex. */
  color?: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

export type ReadestSkipReason =
  | "deleted"
  | "handwriting"
  | "notebook"
  | "unknown-type"
  | "missing-location"
  | "missing-text"
  | "invalid-record";

export interface ReadestSkippedRecord {
  id: string | null;
  reason: ReadestSkipReason;
}

export interface ReadestBookConfig {
  /** CFI of the reading position (Readest stores the visible range). */
  location: string | null;
  /** `[current, total]` 1-based page numbers — an estimate only. */
  pages: [number, number] | null;
  records: ReadestRecord[];
  skipped: ReadestSkippedRecord[];
}

function pages(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [current, total] = value;
  return Number.isSafeInteger(current) && Number.isSafeInteger(total) && current >= 1 && total >= current
    ? [current as number, total as number]
    : null;
}

export function parseReadestBookConfig(text: string): ReadestParseResult<ReadestBookConfig> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  if (!isObject(parsed.value)) return { ok: false, reason: "unexpected-shape" };
  const raw = parsed.value;
  const notes = Array.isArray(raw.booknotes) ? raw.booknotes : [];
  if (notes.length > MAX_RECORDS) return { ok: false, reason: "too-large" };
  const latest = new Map<string, ReadestRecord>();
  const skipped: ReadestSkippedRecord[] = [];
  for (const item of notes) {
    const id = isObject(item) && typeof item.id === "string" && RECORD_ID.test(item.id) ? item.id : null;
    if (!isObject(item) || !id) {
      skipped.push({ id: null, reason: "invalid-record" });
      continue;
    }
    // Deletions are Readest's own sync state: an imported record is simply not created.
    if (timestamp(item.deletedAt) !== null) {
      skipped.push({ id, reason: "deleted" });
      continue;
    }
    const type = item.type;
    if (type === "ink") {
      skipped.push({ id, reason: "handwriting" });
      continue;
    }
    if (type === "notebook") {
      skipped.push({ id, reason: "notebook" });
      continue;
    }
    if (type !== "bookmark" && type !== "annotation" && type !== "excerpt") {
      skipped.push({ id, reason: "unknown-type" });
      continue;
    }
    const cfi = typeof item.cfi === "string" && item.cfi.trim() ? item.cfi.trim() : null;
    if (!cfi) {
      skipped.push({ id, reason: "missing-location" });
      continue;
    }
    const selected = typeof item.text === "string" && item.text.trim() ? item.text : null;
    const kind: ReadestRecordKind = type === "bookmark" ? "bookmark" : "note";
    if (kind === "note" && !selected) {
      skipped.push({ id, reason: "missing-text" });
      continue;
    }
    const style = typeof item.style === "string" && isNoteStyle(item.style) ? item.style : undefined;
    const color = typeof item.color === "string" && item.color.trim() ? item.color.trim() : undefined;
    const record: ReadestRecord = {
      id,
      kind,
      type,
      cfi,
      text: selected,
      note: typeof item.note === "string" ? item.note : "",
      ...(style !== undefined ? { style } : {}),
      ...(color !== undefined ? { color } : {}),
      createdAtMs: timestamp(item.createdAt),
      updatedAtMs: timestamp(item.updatedAt),
    };
    const previous = latest.get(id);
    if (!previous || (record.updatedAtMs ?? 0) > (previous.updatedAtMs ?? 0)) latest.set(id, record);
  }
  return {
    ok: true,
    value: {
      location: typeof raw.location === "string" && raw.location.trim() ? raw.location.trim() : null,
      pages: pages(raw.progress),
      records: [...latest.values()],
      skipped,
    },
  };
}
