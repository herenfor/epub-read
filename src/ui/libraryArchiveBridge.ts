/**
 * Explicit adapters at the archive boundary.
 *
 * The bridge intentionally does not spread ShelfEntry objects. ShelfEntry has
 * device-only fields (bytes, cover metadata and, in the desktop store, paths),
 * while an archive is a portable value. Browser projection does the inverse:
 * it overlays portable fields on the local byte-store row without replacing
 * that row's storage identity.
 */
import type { ReaderSettings } from "../render/settings";
import type { Bookmark, ShelfEntry } from "./shelf";
import type { ReaderNote } from "./notes";
import {
  LIBRARY_ARCHIVE_VERSION,
  parseLibraryArchive,
  type ArchiveParseResult,
  type JsonValue,
  type LibraryArchive,
  type LibraryRecord,
  type ReaderSettingsArchive,
} from "./libraryArchive";
import { validateOrganization, type LibraryOrganization } from "./libraryOrganization";

const HASH = /^[0-9a-f]{64}$/;
const SETTINGS_KEYS = [
  "fontSizePx",
  "theme",
  "fontFamily",
  "customFontName",
  "fontSource",
  "customFontId",
  "customCss",
  "gapPx",
  "lineHeight",
  "fontWeight",
  "letterSpacingPx",
  "wordSpacingPx",
  "forceHorizontal",
  "preloadNextChapter",
  "uiScale",
] as const;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;

type PortableSettingsInput = Partial<ReaderSettings> & { uiScale?: number };

export interface ArchiveBuildIssue {
  entryIndex: number;
  reason: string;
}

export interface ArchiveBuildResult {
  archive: LibraryArchive;
  skipped: ArchiveBuildIssue[];
}

export interface BrowserShelfEntry extends ShelfEntry {
  /** Browser-only local binding state; never part of an archive. */
  available?: boolean;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object" && value !== null) return Object.values(value).every(isJsonValue);
  return false;
}

function cssHasLocalResource(value: string): boolean {
  if (/file:\s*\/\//i.test(value)) return true;
  CSS_URL_RE.lastIndex = 0;
  for (const match of value.matchAll(CSS_URL_RE)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (/^(?:file:\/\/|[a-zA-Z]:[\\/]|\\\\|\/)/.test(target)) return true;
  }
  return false;
}

function settingsForArchive(settings: PortableSettingsInput | undefined): ReaderSettingsArchive | undefined {
  if (!settings) return undefined;
  const out: ReaderSettingsArchive = {};
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    // customFonts is intentionally absent: its URLs are session/device data.
    if (key === "customCss" && typeof value === "string" && cssHasLocalResource(value)) continue;
    if (key === "customFontName" && typeof value === "string" && /^(?:file|https?|data|blob):/i.test(value)) continue;
    if (value !== undefined && isJsonValue(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function fileNameHint(fileName: string): string {
  // fileName is metadata, but old stores could have accidentally put an
  // absolute path there. Retain only the last component in the portable copy.
  const normalized = fileName.replaceAll("\\", "/");
  const last = normalized.slice(normalized.lastIndexOf("/") + 1);
  return /^file:\/\//i.test(last) ? "" : last;
}

function bookmarkForArchive(bookmark: Bookmark): LibraryRecord["bookmarks"][number] {
  return {
    id: bookmark.id,
    spineIndex: bookmark.spineIndex,
    page: bookmark.page,
    anchorIndex: bookmark.anchorIndex,
    anchorRatio: bookmark.anchorRatio,
    anchorTextOffset: bookmark.anchorTextOffset ?? null,
    anchorTextSnippet: bookmark.anchorTextSnippet ?? null,
    text: bookmark.text,
    createdAtMs: bookmark.createdAtMs,
  };
}

function noteForArchive(note: ReaderNote): ReaderNote {
  return { ...note };
}

function recordForArchive(entry: ShelfEntry, contentHash: string): LibraryRecord {
  return {
    contentHash,
    title: entry.title,
    creator: entry.creator,
    ...(entry.language ? { language: entry.language } : {}),
    fileName: fileNameHint(entry.fileName),
    addedAtMs: entry.addedAtMs,
    lastReadAtMs: entry.lastReadAtMs,
    spineIndex: entry.spineIndex,
    page: entry.page,
    progressPct: entry.progressPct,
    anchorIndex: entry.anchorIndex,
    anchorRatio: entry.anchorRatio,
    anchorTextOffset: entry.anchorTextOffset ?? null,
    anchorTextSnippet: entry.anchorTextSnippet ?? null,
    isNew: entry.isNew,
    bookmarks: (entry.bookmarks ?? []).map(bookmarkForArchive),
    notes: (entry.notes ?? []).map(noteForArchive),
  };
}

/** Build a portable archive and report entries that have no usable content hash. */
export function buildLibraryArchiveWithIssues(
  entries: readonly ShelfEntry[],
  organization: LibraryOrganization,
  settings?: PortableSettingsInput,
): ArchiveBuildResult {
  const cleanOrg = validateOrganization(organization);
  const records: Record<string, LibraryRecord> = {};
  const skipped: ArchiveBuildIssue[] = [];
  entries.forEach((entry, entryIndex) => {
    const contentHash = entry.contentHash?.toLowerCase();
    if (!contentHash || !HASH.test(contentHash)) {
      skipped.push({ entryIndex, reason: "缺少有效的 64 位 contentHash" });
      return;
    }
    records[contentHash] = recordForArchive(entry, contentHash);
  });
  return {
    archive: {
      version: LIBRARY_ARCHIVE_VERSION,
      records,
      ...(settingsForArchive(settings) ? { settings: settingsForArchive(settings) } : {}),
      organization: cleanOrg,
    },
    skipped,
  };
}

/** Construct an archive; invalid legacy rows are omitted (see the *WithIssues variant). */
export function buildLibraryArchive(
  entries: readonly ShelfEntry[],
  organization: LibraryOrganization,
  settings?: PortableSettingsInput,
): LibraryArchive {
  return buildLibraryArchiveWithIssues(entries, organization, settings).archive;
}

export const libraryArchiveFromShelfEntries = buildLibraryArchive;

function recordsForBackend(input: LibraryArchive | ArchiveParseResult | readonly LibraryRecord[]): LibraryRecord[] {
  if (Array.isArray(input)) return input.map((record) => ({ ...record, bookmarks: [...record.bookmarks], notes: [...(record.notes ?? [])] }));
  const parsed = parseLibraryArchive("archive" in input ? input.archive : input);
  if (parsed.errors.length) throw new Error(`存档包含不可交给后端的字段：${parsed.errors[0].message}`);
  return Object.values(parsed.archive.records).map((record) => ({ ...record, bookmarks: [...record.bookmarks], notes: [...(record.notes ?? [])] }));
}

/** Convert keyed records into an explicit backend payload array. */
export function archiveRecordsForBackend(input: LibraryArchive | ArchiveParseResult | readonly LibraryRecord[]): LibraryRecord[] {
  return recordsForBackend(input);
}

export const toPortableRecordArray = archiveRecordsForBackend;

function hashForEntry(entry: ShelfEntry): string | undefined {
  const hash = entry.contentHash?.toLowerCase();
  return hash && HASH.test(hash) ? hash : HASH.test(entry.id) ? entry.id : undefined;
}

function projectedEntry(record: LibraryRecord, existing: BrowserShelfEntry | undefined): BrowserShelfEntry {
  const result: BrowserShelfEntry = {
    id: existing?.id ?? record.contentHash,
    title: record.title,
    creator: record.creator,
    ...(record.language ? { language: record.language } : {}),
    fileName: record.fileName,
    // These are local byte-store fields and are never taken from the archive.
    fileSize: existing?.fileSize ?? 0,
    coverMime: existing?.coverMime ?? "",
    addedAtMs: record.addedAtMs,
    lastReadAtMs: record.lastReadAtMs,
    spineIndex: record.spineIndex,
    page: record.page,
    progressPct: record.progressPct,
    anchorIndex: record.anchorIndex,
    anchorRatio: record.anchorRatio,
    anchorTextOffset: record.anchorTextOffset,
    anchorTextSnippet: record.anchorTextSnippet,
    isNew: record.isNew,
    contentHash: record.contentHash,
    bookmarks: record.bookmarks.map((bookmark) => ({ ...bookmark })),
    notes: (record.notes ?? []).map((note) => ({ ...note })),
  };
  if (existing && Object.prototype.hasOwnProperty.call(existing, "available")) result.available = existing.available;
  if (!existing) result.available = false;
  return result;
}

function localEntryWithoutDeviceFields(entry: BrowserShelfEntry): BrowserShelfEntry {
  const result: BrowserShelfEntry = {
    id: entry.id,
    title: entry.title,
    creator: entry.creator,
    ...(entry.language ? { language: entry.language } : {}),
    fileName: fileNameHint(entry.fileName),
    fileSize: entry.fileSize,
    coverMime: entry.coverMime,
    addedAtMs: entry.addedAtMs,
    lastReadAtMs: entry.lastReadAtMs,
    spineIndex: entry.spineIndex,
    page: entry.page,
    progressPct: entry.progressPct,
    anchorIndex: entry.anchorIndex,
    anchorRatio: entry.anchorRatio,
    anchorTextOffset: entry.anchorTextOffset ?? null,
    anchorTextSnippet: entry.anchorTextSnippet ?? null,
    isNew: entry.isNew,
    ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
    bookmarks: entry.bookmarks ? entry.bookmarks.map((bookmark) => ({ ...bookmark })) : entry.bookmarks,
    notes: entry.notes ? entry.notes.map((note) => ({ ...note })) : [],
  };
  if (Object.prototype.hasOwnProperty.call(entry, "available")) result.available = entry.available;
  return result;
}

/**
 * Overlay portable records on the browser shelf. Existing rows retain their
 * local byte-store id/file metadata; an archive-only row is explicitly absent.
 */
export function projectArchiveToBrowserShelf(
  localEntries: readonly BrowserShelfEntry[],
  archive: LibraryArchive | ArchiveParseResult | readonly LibraryRecord[],
): BrowserShelfEntry[] {
  const records = recordsForBackend(archive);
  const recordsByHash = new Map(records.map((record) => [record.contentHash, record]));
  const used = new Set<string>();
  const result = localEntries.map((entry) => {
    const hash = hashForEntry(entry);
    const record = hash ? recordsByHash.get(hash) : undefined;
    if (!record) return localEntryWithoutDeviceFields(entry);
    used.add(record.contentHash);
    return projectedEntry(record, entry);
  });
  for (const record of records) {
    if (!used.has(record.contentHash)) result.push(projectedEntry(record, undefined));
  }
  return result;
}

export const projectArchiveForBrowser = projectArchiveToBrowserShelf;
