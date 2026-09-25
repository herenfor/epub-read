/**
 * Portable library state.
 *
 * This module deliberately has no dependency on ShelfStore.  A library archive
 * is a user-owned, JSON-only value; device paths and file metadata belong in a
 * DeviceBinding and must never cross this boundary.
 */

import { sanitizePersistedTextAnchor } from "../render/textAnchor";
import { hasReadEvidence } from "./readEvidence";
import { hasDuplicateReaderNoteIds, normalizeReaderNote, type ReaderNote, validateReaderNote } from "./notes";
import {
  emptyOrganization,
  mergeOrganization,
  validateOrganization,
  type LibraryOrganization,
} from "./libraryOrganization";

export const LIBRARY_ARCHIVE_VERSION = 2 as const;
export type SupportedArchiveVersion = 1 | 2;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ArchiveAnchor {
  index: number | null;
  ratio: number | null;
}

export interface ArchiveBookmark {
  id: string;
  spineIndex: number;
  page: number;
  anchorIndex: number | null;
  anchorRatio: number | null;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  text: string;
  createdAtMs: number;
}

export interface LibraryRecord {
  contentHash: string;
  title: string;
  creator: string;
  /** OPF dc:language; optional so existing v1 archives stay valid. */
  language?: string;
  /** Display hint only; never a source path. */
  fileName: string;
  addedAtMs: number;
  lastReadAtMs: number;
  spineIndex: number;
  page: number;
  progressPct: number;
  anchorIndex: number | null;
  anchorRatio: number | null;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  isNew: boolean;
  bookmarks: ArchiveBookmark[];
  /** Added in the note feature; omitted in old v1 archives and normalized to []. */
  notes?: ReaderNote[];
}

export type ReaderSettingsArchive = { [key: string]: JsonValue };

export interface LibraryArchive {
  version: typeof LIBRARY_ARCHIVE_VERSION;
  records: Record<string, LibraryRecord>;
  settings?: ReaderSettingsArchive;
  organization: LibraryOrganization;
}

/** Local-only association. This type is intentionally not part of LibraryArchive. */
export interface DeviceBinding {
  contentHash: string;
  sourcePath: string;
  fileSize: number;
  mtime: number;
  coverEntryPath?: string;
  coverMime?: string;
  lastVerifiedAt: number;
}

export interface ArchiveIssue {
  /** JSON-ish location, e.g. records.abc.fileName. */
  path: string;
  code: string;
  message: string;
}

export interface ArchiveParseResult {
  archive: LibraryArchive;
  errors: ArchiveIssue[];
}

const EMPTY_ARCHIVE = (): LibraryArchive => ({
  version: LIBRARY_ARCHIVE_VERSION,
  records: {},
  organization: emptyOrganization(),
});

const HASH = /^[0-9a-f]{64}$/;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\/;
const UNIX_ABSOLUTE = /^\//;
const FILE_URI = /^file:\/\//i;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const FORBIDDEN_DEVICE_FIELDS = new Set([
  "sourcePath", "source_path", "path", "absolutePath", "absolute_path", "filePath", "file_path",
  "mtime", "fileSize", "file_size", "coverBytes", "thumbnail", "thumbnailBytes", "coverPath",
  "cover_path", "lastVerifiedAt", "last_verified_at",
]);

function issue(errors: ArchiveIssue[], path: string, code: string, message: string): void {
  errors.push({ path, code, message });
}

function objectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, path: string, errors: ArchiveIssue[], integer = false): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    issue(errors, path, "invalid-number", "expected a finite number");
    return null;
  }
  return value;
}

function nonNegative(value: unknown, path: string, errors: ArchiveIssue[], integer = false): number | null {
  const result = finiteNumber(value, path, errors, integer);
  if (result !== null && result < 0) {
    issue(errors, path, "invalid-range", "must not be negative");
    return null;
  }
  return result;
}

function stringValue(value: unknown, path: string, errors: ArchiveIssue[], pathBearing = false): string | null {
  if (typeof value !== "string") {
    issue(errors, path, "invalid-string", "expected a string");
    return null;
  }
  // A slash in a title is ordinary text. Only path-bearing fields use the
  // absolute-path check, with file:// accepted nowhere in an archive.
  if (pathBearing && (FILE_URI.test(value) || WINDOWS_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value) || UNIX_ABSOLUTE.test(value))) {
    issue(errors, path, "path-leak", "device paths are not allowed in a portable archive");
    return null;
  }
  return value;
}

function reportForbiddenFields(value: Record<string, unknown>, path: string, errors: ArchiveIssue[]): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_DEVICE_FIELDS.has(key)) {
      issue(errors, `${path}.${key}`, "device-field", "device-only fields are not allowed in a portable archive");
    }
  }
}

function bookmarkValue(value: unknown, path: string, errors: ArchiveIssue[]): ArchiveBookmark | null {
  if (!objectLike(value)) {
    issue(errors, path, "invalid-record", "expected a bookmark object");
    return null;
  }
  reportForbiddenFields(value, path, errors);
  const id = stringValue(value.id, `${path}.id`, errors);
  const spineIndex = nonNegative(value.spineIndex, `${path}.spineIndex`, errors, true);
  const page = nonNegative(value.page, `${path}.page`, errors, true);
  const anchorIndex = value.anchorIndex === null ? null : nonNegative(value.anchorIndex, `${path}.anchorIndex`, errors, true);
  const anchorRatio = value.anchorRatio === null ? null : finiteNumber(value.anchorRatio, `${path}.anchorRatio`, errors);
  if (anchorRatio !== null && (anchorRatio < 0 || anchorRatio > 1)) issue(errors, `${path}.anchorRatio`, "invalid-range", "must be between 0 and 1");
  const textAnchor = sanitizePersistedTextAnchor({
    textOffset: value.anchorTextOffset,
    textSnippet: value.anchorTextSnippet,
  });
  const invalidTextAnchor =
    (value.anchorTextOffset !== undefined && value.anchorTextOffset !== null && textAnchor.textOffset === null) ||
    (value.anchorTextSnippet !== undefined && value.anchorTextSnippet !== null && textAnchor.textSnippet === null);
  if (invalidTextAnchor) issue(errors, `${path}.anchorTextOffset`, "invalid-anchor-text", "text anchor must be a bounded non-whitespace code-point snippet");
  const text = stringValue(value.text, `${path}.text`, errors);
  const createdAtMs = nonNegative(value.createdAtMs, `${path}.createdAtMs`, errors);
  if (id === null || spineIndex === null || page === null || (anchorIndex === null && value.anchorIndex !== null) || (anchorRatio === null && value.anchorRatio !== null) || invalidTextAnchor || text === null || createdAtMs === null) return null;
  return { id, spineIndex, page, anchorIndex, anchorRatio, anchorTextOffset: textAnchor.textOffset, anchorTextSnippet: textAnchor.textSnippet, text, createdAtMs };
}

function noteValue(value: unknown, path: string, errors: ArchiveIssue[]): ReaderNote | null {
  const validation = validateReaderNote(value);
  if (!validation.valid) {
    issue(
      errors,
      validation.field ? `${path}.${validation.field}` : path,
      "invalid-note",
      validation.reason ?? "invalid note",
    );
    return null;
  }
  return normalizeReaderNote(value);
}

function recordValue(value: unknown, hash: string, path: string, errors: ArchiveIssue[]): LibraryRecord | null {
  if (!objectLike(value)) {
    issue(errors, path, "invalid-record", "expected a record object");
    return null;
  }
  reportForbiddenFields(value, path, errors);
  const title = stringValue(value.title, `${path}.title`, errors);
  const creator = stringValue(value.creator, `${path}.creator`, errors);
  const language = value.language === undefined
    ? undefined
    : stringValue(value.language, `${path}.language`, errors);
  const fileName = stringValue(value.fileName, `${path}.fileName`, errors, true);
  const addedAtMs = nonNegative(value.addedAtMs, `${path}.addedAtMs`, errors);
  const lastReadAtMs = nonNegative(value.lastReadAtMs, `${path}.lastReadAtMs`, errors);
  const spineIndex = nonNegative(value.spineIndex, `${path}.spineIndex`, errors, true);
  const page = nonNegative(value.page, `${path}.page`, errors, true);
  const progressPct = finiteNumber(value.progressPct, `${path}.progressPct`, errors);
  if (progressPct !== null && (progressPct < 0 || progressPct > 100)) issue(errors, `${path}.progressPct`, "invalid-range", "must be between 0 and 100");
  const anchorIndex = value.anchorIndex === null ? null : nonNegative(value.anchorIndex, `${path}.anchorIndex`, errors, true);
  const anchorRatio = value.anchorRatio === null ? null : finiteNumber(value.anchorRatio, `${path}.anchorRatio`, errors);
  if (anchorRatio !== null && (anchorRatio < 0 || anchorRatio > 1)) issue(errors, `${path}.anchorRatio`, "invalid-range", "must be between 0 and 1");
  const textAnchor = sanitizePersistedTextAnchor({
    textOffset: value.anchorTextOffset,
    textSnippet: value.anchorTextSnippet,
  });
  const invalidTextAnchor =
    (value.anchorTextOffset !== undefined && value.anchorTextOffset !== null && textAnchor.textOffset === null) ||
    (value.anchorTextSnippet !== undefined && value.anchorTextSnippet !== null && textAnchor.textSnippet === null);
  if (invalidTextAnchor) issue(errors, `${path}.anchorTextOffset`, "invalid-anchor-text", "text anchor must be a bounded non-whitespace code-point snippet");
  if (typeof value.isNew !== "boolean") issue(errors, `${path}.isNew`, "invalid-boolean", "expected a boolean");
  const bookmarks: ArchiveBookmark[] = [];
  if (!Array.isArray(value.bookmarks)) {
    issue(errors, `${path}.bookmarks`, "invalid-array", "expected an array");
  } else {
    value.bookmarks.forEach((item, index) => {
      const bookmark = bookmarkValue(item, `${path}.bookmarks[${index}]`, errors);
      if (bookmark) bookmarks.push(bookmark);
    });
  }
  const notes: ReaderNote[] = [];
  if (value.notes === undefined) {
    // v1 records predate notes and intentionally normalize to an empty list.
  } else if (!Array.isArray(value.notes)) {
    issue(errors, `${path}.notes`, "invalid-array", "expected an array");
  } else {
    value.notes.forEach((item, index) => {
      const note = noteValue(item, `${path}.notes[${index}]`, errors);
      if (note) notes.push(note);
    });
    if (hasDuplicateReaderNoteIds(notes)) {
      issue(errors, `${path}.notes`, "duplicate-note-id", "note IDs must be unique within a book");
    }
  }
  if (title === null || creator === null || language === null || fileName === null || addedAtMs === null || lastReadAtMs === null || spineIndex === null || page === null || progressPct === null || progressPct < 0 || progressPct > 100 || (anchorIndex === null && value.anchorIndex !== null) || (anchorRatio === null && value.anchorRatio !== null) || invalidTextAnchor || typeof value.isNew !== "boolean") return null;
  return { contentHash: hash, title, creator, ...(language ? { language } : {}), fileName, addedAtMs, lastReadAtMs, spineIndex, page, progressPct, anchorIndex, anchorRatio, anchorTextOffset: textAnchor.textOffset, anchorTextSnippet: textAnchor.textSnippet, isNew: value.isNew, bookmarks, notes };
}

const SETTING_KEYS = new Set([
  "fontSizePx", "theme", "fontFamily", "customFontName", "fontSource", "customFontId", "customCss", "gapPx",
  "lineHeight", "fontWeight", "letterSpacingPx", "wordSpacingPx", "uiScale",
  "forceHorizontal",
  "preloadNextChapter",
]);

function jsonValue(value: unknown, path: string, errors: ArchiveIssue[]): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    value.forEach((item, index) => {
      const converted = jsonValue(item, `${path}[${index}]`, errors);
      if (converted !== undefined) out.push(converted);
    });
    return out;
  }
  if (objectLike(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonValue(item, `${path}.${key}`, errors);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  }
  issue(errors, path, "invalid-json", "value is not JSON serializable");
  return undefined;
}

function cssContainsLocalPath(value: string): boolean {
  // A file URL can also appear in @import quotes, so check that explicit URL
  // scheme globally. Other absolute-path checks stay inside url(...), where a
  // slash is a resource reference rather than an ordinary CSS token.
  if (/file:\s*\/\//i.test(value)) return true;
  CSS_URL_RE.lastIndex = 0;
  for (const match of value.matchAll(CSS_URL_RE)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (FILE_URI.test(target) || WINDOWS_ABSOLUTE.test(target) || UNC_ABSOLUTE.test(target) || UNIX_ABSOLUTE.test(target)) return true;
  }
  return false;
}

function customFontNameContainsResource(value: string): boolean {
  return /^(?:file|https?|data|blob):/i.test(value) || /url\(/i.test(value);
}

function settingsValue(value: unknown, errors: ArchiveIssue[]): ReaderSettingsArchive | undefined {
  if (value === undefined) return undefined;
  if (!objectLike(value)) {
    issue(errors, "settings", "invalid-settings", "expected a JSON object");
    return undefined;
  }
  reportForbiddenFields(value, "settings", errors);
  const out: ReaderSettingsArchive = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SETTING_KEYS.has(key)) continue;
    if (key === "customCss" && typeof item === "string" && cssContainsLocalPath(item)) {
      issue(errors, `settings.${key}`, "path-leak", "custom CSS contains an absolute local resource path");
      continue;
    }
    if (key === "customFontName" && typeof item === "string" && customFontNameContainsResource(item)) {
      issue(errors, `settings.${key}`, "path-leak", "custom font name must not contain a resource URL");
      continue;
    }
    const converted = jsonValue(item, `settings.${key}`, errors);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

function decodeInput(input: unknown, errors: ArchiveIssue[]): unknown {
  if (typeof input !== "string") return input;
  try { return JSON.parse(input) as unknown; } catch {
    issue(errors, "$", "invalid-json", "archive is not valid JSON");
    return null;
  }
}

function absoluteLocalPath(value: unknown, path: string, errors: ArchiveIssue[]): string | null {
  if (typeof value !== "string" || value.length === 0) {
    issue(errors, path, "invalid-path", "expected a non-empty absolute local path");
    return null;
  }
  if (FILE_URI.test(value) || !(WINDOWS_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value) || UNIX_ABSOLUTE.test(value))) {
    issue(errors, path, "invalid-path", "expected a non-empty absolute local path");
    return null;
  }
  return value;
}

function zipRelativePath(value: unknown, path: string, errors: ArchiveIssue[]): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/") || WINDOWS_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value) || FILE_URI.test(value) || value.split("/").some((part) => part === "..")) {
    issue(errors, path, "invalid-zip-path", "cover entry must be a safe ZIP-relative path");
    return null;
  }
  return value;
}

/** Parse and normalize an archive, retaining valid records and reporting each bad record/field. */
export function parseLibraryArchive(input: unknown): ArchiveParseResult {
  const errors: ArchiveIssue[] = [];
  const value = decodeInput(input, errors);
  if (!objectLike(value)) {
    issue(errors, "$", "invalid-archive", "expected an archive object");
    return { archive: EMPTY_ARCHIVE(), errors };
  }
  reportForbiddenFields(value, "$", errors);
  if (value.version !== 1 && value.version !== 2) {
    issue(errors, "version", "unsupported-version", "only archive version 1 and 2 are supported");
    return { archive: EMPTY_ARCHIVE(), errors };
  }
  const archive = EMPTY_ARCHIVE();
  if (value.version === 1) {
    // v1 不含组织数据，解释为空合并输入（不清空本机分类）
    archive.organization = emptyOrganization();
  } else {
    if (!("organization" in value) || value.organization === undefined) {
      issue(errors, "organization", "missing-organization", "v2 archive must include organization");
    } else {
      try {
        archive.organization = validateOrganization(value.organization);
      } catch (e) {
        issue(errors, "organization", "invalid-organization", e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (!objectLike(value.records)) {
    issue(errors, "records", "invalid-records", "expected an object keyed by content hash");
  } else {
    for (const [hash, record] of Object.entries(value.records)) {
      const path = `records.${hash}`;
      if (!HASH.test(hash)) {
        issue(errors, path, "invalid-hash", "record key must be a 64-character lowercase SHA-256 hex value");
        continue;
      }
      const normalized = recordValue(record, hash, path, errors);
      if (normalized) archive.records[hash] = normalized;
    }
  }
  const settings = settingsValue(value.settings, errors);
  if (settings !== undefined) archive.settings = settings;
  return { archive, errors };
}

/** Alias useful to callers that make the validation boundary explicit. */
export const normalizeLibraryArchive = parseLibraryArchive;

export function exportLibraryArchive(input: LibraryArchive | ArchiveParseResult): string {
  const archive = "archive" in input ? input.archive : input;
  const parsed = parseLibraryArchive(archive);
  // Export is strict: it never serializes an invalid record or a path-bearing field.
  if (parsed.errors.length) throw new Error(`无法导出存档：${parsed.errors[0].message}`);
  return JSON.stringify(parsed.archive);
}

function newerRecord(a: LibraryRecord, b: LibraryRecord): LibraryRecord {
  const aRead = hasReadEvidence(a);
  const bRead = hasReadEvidence(b);
  if (aRead !== bRead) return bRead ? b : a;
  if (b.lastReadAtMs > a.lastReadAtMs) return b;
  if (b.lastReadAtMs < a.lastReadAtMs) return a;
  // Equal timestamps are deterministic and permit an explicit newer bookmark set.
  return b;
}

function mergeBookmarks(a: ArchiveBookmark[], b: ArchiveBookmark[]): ArchiveBookmark[] {
  const merged = new Map<string, ArchiveBookmark>();
  for (const item of a) merged.set(item.id, item);
  for (const item of b) {
    const previous = merged.get(item.id);
    if (!previous || item.createdAtMs >= previous.createdAtMs) merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

function mergeNotes(a: ReaderNote[], b: ReaderNote[]): ReaderNote[] {
  const merged = new Map<string, ReaderNote>();
  for (const item of a) merged.set(item.id, item);
  for (const item of b) {
    const previous = merged.get(item.id);
    if (!previous || item.updatedAtMs > previous.updatedAtMs) {
      merged.set(item.id, item);
    } else if (previous.updatedAtMs === item.updatedAtMs) {
      // Equal timestamps must not depend on archive argument order.
      const previousKey = JSON.stringify(previous);
      const candidateKey = JSON.stringify(item);
      if (candidateKey > previousKey) merged.set(item.id, item);
    }
  }
  return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id));
}

/** Merge records without allowing an older reading position to win. */
export function mergeLibraryArchives(base: LibraryArchive, incoming: LibraryArchive): LibraryArchive {
  const left = parseLibraryArchive(base);
  const right = parseLibraryArchive(incoming);
  if (left.errors.length || right.errors.length) throw new Error("无法合并无效存档");
  const out = EMPTY_ARCHIVE();
  for (const [hash, record] of Object.entries(left.archive.records)) out.records[hash] = { ...record, bookmarks: [...record.bookmarks], notes: [...(record.notes ?? [])] };
  for (const [hash, candidate] of Object.entries(right.archive.records)) {
    const current = out.records[hash];
    if (!current) {
      out.records[hash] = { ...candidate, bookmarks: [...candidate.bookmarks], notes: [...(candidate.notes ?? [])] };
      continue;
    }
    const winner = newerRecord(current, candidate);
    out.records[hash] = {
      ...current,
      ...winner,
      addedAtMs: Math.min(current.addedAtMs, candidate.addedAtMs),
      isNew: current.isNew && candidate.isNew,
      bookmarks: mergeBookmarks(current.bookmarks, candidate.bookmarks),
      notes: mergeNotes(current.notes ?? [], candidate.notes ?? []),
    };
  }
  if (left.archive.settings || right.archive.settings) out.settings = { ...left.archive.settings, ...right.archive.settings };
  out.organization = mergeOrganization(left.archive.organization, right.archive.organization);
  return out;
}

/** Normalize and validate a local-only binding; it is never accepted by archive parsers. */
export function parseDeviceBinding(input: unknown): { binding?: DeviceBinding; errors: ArchiveIssue[] } {
  const errors: ArchiveIssue[] = [];
  if (!objectLike(input)) {
    issue(errors, "$", "invalid-binding", "expected a binding object");
    return { errors };
  }
  const contentHash = stringValue(input.contentHash, "contentHash", errors);
  if (contentHash !== null && !HASH.test(contentHash)) issue(errors, "contentHash", "invalid-hash", "invalid content hash");
  // Absolute paths are expected in the device-only binding. The portable
  // archive parser is the boundary that rejects them; this parser must not.
  const sourcePath = absoluteLocalPath(input.sourcePath, "sourcePath", errors);
  const fileSize = nonNegative(input.fileSize, "fileSize", errors);
  const mtime = nonNegative(input.mtime, "mtime", errors);
  const lastVerifiedAt = nonNegative(input.lastVerifiedAt, "lastVerifiedAt", errors);
  const coverEntryPath = zipRelativePath(input.coverEntryPath, "coverEntryPath", errors);
  const coverMime = input.coverMime === undefined ? undefined : stringValue(input.coverMime, "coverMime", errors);
  if (contentHash === null || !HASH.test(contentHash ?? "") || sourcePath === null || fileSize === null || mtime === null || lastVerifiedAt === null || coverEntryPath === null) return { errors };
  return { binding: { contentHash, sourcePath, fileSize, mtime, lastVerifiedAt, ...(coverEntryPath === undefined ? {} : { coverEntryPath }), ...(coverMime === undefined || coverMime === null ? {} : { coverMime }) }, errors };
}
