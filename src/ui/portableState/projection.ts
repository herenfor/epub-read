/**
 * Projection from portable v3 books to the existing shelf/bookmark/note UI
 * shapes. This is intentionally a display adapter: progress candidates are
 * retained in extra fields, while the legacy fields only carry the latest
 * display version and never claim that the largest stamp is the user's choice.
 */
import { mergeVersions, type Annotation, type Version } from "../../core/portableState/portable-register-core";
import {
  annotationDisplayVersion,
  latestVersion,
  projectLocator,
} from "../../core/portableState/projection";
import type {
  BookmarkValue,
  Locator,
  NoteValue,
  PortableBook,
  PortableStateV3,
  ProgressValue,
} from "../../core/portableState/portable-state-types";
import type { Bookmark, ShelfEntry } from "../shelf";
import type { ReaderNote } from "../notes";

export interface PortableBookmark extends Bookmark {
  /** Modern chapter path when available; null for an unresolved legacy locator. */
  readonly chapterPath: string | null;
  /** Full v3 locator retained for the integration navigation adapter. */
  readonly locator: Locator;
}

export interface PortableShelfEntry extends ShelfEntry {
  readonly chapterPath: string | null;
  readonly portableLocator: Locator | null;
  readonly portableProgressVersions: readonly Version<ProgressValue>[];
  readonly portableProgressConflict: boolean;
  readonly portableBookmarkAnnotations: Readonly<Record<string, Annotation<BookmarkValue>>>;
  readonly portableNoteAnnotations: Readonly<Record<string, Annotation<NoteValue>>>;
}

function localHash(entry: ShelfEntry): string | null {
  const candidates = [entry.contentHash, entry.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[0-9a-f]{64}$/.test(candidate)) return candidate;
  }
  return null;
}

interface EmptyReading {
  readonly chapterPath: string | null;
  readonly portableLocator: Locator | null;
  readonly spineIndex: number;
  readonly page: number;
  readonly progressPct: number;
  readonly anchorIndex: number | null;
  readonly anchorRatio: number | null;
  readonly anchorTextOffset: number | null;
  readonly anchorTextSnippet: string | null;
  readonly mediaAnchor: { readonly index: number; readonly tag: string; readonly signature: string; readonly ratio: number } | null;
}

function emptyReading(): EmptyReading {
  return {
    chapterPath: null,
    portableLocator: null,
    spineIndex: 0,
    page: 0,
    progressPct: 0,
    anchorIndex: null as number | null,
    anchorRatio: null as number | null,
    anchorTextOffset: null as number | null,
    anchorTextSnippet: null as string | null,
    mediaAnchor: null as { index: number; tag: string; signature: string; ratio: number } | null,
  };
}

export function projectBookmarkAnnotation(
  id: string,
  annotation: Annotation<BookmarkValue>,
): PortableBookmark | null {
  const version = annotationDisplayVersion(annotation);
  if (!version) return null;
  const value = version.value;
  const projection = projectLocator(value.locator);
  return {
    id,
    spineIndex: projection.spineIndex,
    page: projection.page,
    anchorIndex: projection.anchorIndex,
    anchorRatio: projection.anchorRatio,
    anchorTextOffset: projection.anchorTextOffset,
    anchorTextSnippet: projection.anchorTextSnippet,
    ...(projection.mediaAnchor ? { mediaAnchor: projection.mediaAnchor } : {}),
    text: value.text,
    createdAtMs: value.createdAtMs,
    chapterPath: projection.chapterPath,
    locator: value.locator,
  };
}

export function projectNoteAnnotation(
  id: string,
  annotation: Annotation<NoteValue>,
): ReaderNote | null {
  const version = annotationDisplayVersion(annotation);
  if (!version) return null;
  const value = version.value;
  return {
    id,
    spineIndex: value.spineIndexHint,
    chapterPath: value.chapterPath,
    startTextOffset: value.startTextOffset,
    endTextOffset: value.endTextOffset,
    startTextSnippet: value.startTextSnippet,
    endTextSnippet: value.endTextSnippet,
    selectedText: value.selectedText,
    content: value.content,
    createdAtMs: value.createdAtMs,
    updatedAtMs: version.updatedAtMs,
  };
}

function progressFields(book: PortableBook): {
  readonly progressPct: number;
  readonly lastReadAtMs: number;
  readonly reading: ReturnType<typeof emptyReading>;
} {
  const version = latestVersion(book.progress.versions);
  if (!version || version.value === null) {
    return {
      progressPct: version?.value === null ? 0 : version?.value?.progressPctHint ?? 0,
      lastReadAtMs: version?.updatedAtMs ?? 0,
      reading: emptyReading(),
    };
  }
  const value = version.value;
  const projection = projectLocator(value.locator);
  return {
    progressPct: value.progressPctHint,
    lastReadAtMs: version.updatedAtMs,
    reading: {
      chapterPath: projection.chapterPath,
      portableLocator: value.locator,
      spineIndex: projection.spineIndex,
      page: projection.page,
      progressPct: value.progressPctHint,
      anchorIndex: projection.anchorIndex,
      anchorRatio: projection.anchorRatio,
      anchorTextOffset: projection.anchorTextOffset,
      anchorTextSnippet: projection.anchorTextSnippet,
      mediaAnchor: projection.mediaAnchor,
    },
  };
}

export function projectShelfEntry(
  hash: string,
  book: PortableBook,
  local?: ShelfEntry,
): PortableShelfEntry {
  const fields = progressFields(book);
  const bookmarkAnnotations: Record<string, Annotation<BookmarkValue>> = book.bookmarks;
  const noteAnnotations: Record<string, Annotation<NoteValue>> = book.notes;
  const bookmarks: PortableBookmark[] = [];
  for (const [id, annotation] of Object.entries(book.bookmarks)) {
    const projected = projectBookmarkAnnotation(id, annotation);
    if (projected) bookmarks.push(projected);
  }
  const notes: ReaderNote[] = [];
  for (const [id, annotation] of Object.entries(book.notes)) {
    const projected = projectNoteAnnotation(id, annotation);
    if (projected) notes.push(projected);
  }
  const frontier = mergeVersions(book.progress.versions);
  return {
    id: local?.id ?? hash,
    title: book.metadata.value.title,
    creator: book.metadata.value.creator,
    ...(book.metadata.value.language ? { language: book.metadata.value.language } : {}),
    fileName: book.metadata.value.fileName,
    fileSize: local?.fileSize ?? 0,
    coverMime: local?.coverMime ?? "",
    addedAtMs: book.metadata.value.addedAtMs,
    lastReadAtMs: fields.lastReadAtMs,
    spineIndex: fields.reading.spineIndex,
    page: fields.reading.page,
    progressPct: fields.progressPct,
    anchorIndex: fields.reading.anchorIndex,
    anchorRatio: fields.reading.anchorRatio,
    anchorTextOffset: fields.reading.anchorTextOffset,
    anchorTextSnippet: fields.reading.anchorTextSnippet,
    ...(fields.reading.mediaAnchor ? { mediaAnchor: fields.reading.mediaAnchor } : {}),
    contentHash: hash,
    isNew: local?.isNew ?? false,
    bookmarks,
    notes,
    ...(local?.available === undefined ? {} : { available: local.available }),
    ...(local?.thumbnailMime ? { thumbnailMime: local.thumbnailMime } : {}),
    chapterPath: fields.reading.chapterPath,
    portableLocator: fields.reading.portableLocator,
    portableProgressVersions: book.progress.versions,
    portableProgressConflict: frontier.length > 1,
    portableBookmarkAnnotations: bookmarkAnnotations,
    portableNoteAnnotations: noteAnnotations,
  };
}

/** Project all v3 books, preserving local byte-store ids and file metadata. */
export function projectShelfEntriesFromState(
  state: PortableStateV3,
  localEntries: readonly ShelfEntry[] = [],
): PortableShelfEntry[] {
  const localByHash = new Map<string, ShelfEntry>();
  const localWithoutHash: ShelfEntry[] = [];
  for (const entry of localEntries) {
    const hash = localHash(entry);
    if (hash) localByHash.set(hash, entry);
    else localWithoutHash.push(entry);
  }
  const result: PortableShelfEntry[] = [];
  for (const hash of Object.keys(state.books).sort()) {
    const book = state.books[hash];
    result.push(projectShelfEntry(hash, book, localByHash.get(hash)));
  }
  for (const entry of localWithoutHash) {
    if (!entry.contentHash) continue;
    const book = state.books[entry.contentHash];
    if (book) result.push(projectShelfEntry(entry.contentHash, book, entry));
  }
  return result;
}
