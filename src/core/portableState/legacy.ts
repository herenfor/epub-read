/**
 * Legacy v1/v2 reading-position and annotation adapters.
 *
 * These functions are pure conversions only. They intentionally do not guess
 * a chapter path from a title or merge books whose SHA-256 is unknown. A caller
 * that has access to the actual EPUB may resolve a legacy locator through the
 * reader's normal navigation callback and then create a modern locator.
 */
import { PortableStateParseError, parseLocator, type PortableStateIssue } from "./parser";
import type { Annotation, Json, Stamp, Version } from "./portable-register-core";
import type {
  BookmarkValue,
  LegacyLocator,
  Locator,
  ModernLocator,
  NoteValue,
  PortableBook,
  ProgressValue,
} from "./portable-state-types";

export interface LegacyReadingFields {
  readonly spineIndex: number;
  readonly page: number;
  readonly anchorIndex: number | null;
  readonly anchorRatio: number | null;
  readonly anchorTextOffset?: number | null;
  readonly anchorTextSnippet?: string | null;
  readonly mediaAnchor?: LegacyLocator["mediaAnchor"];
  /**
   * Set only when the caller already has the EPUB and can resolve the old
   * spine index to its canonical chapter path. Unresolved page-only records
   * stay version 0; they are never silently reported as chapter start.
   */
  readonly resolvedChapterPath?: string | null;
}

export interface LegacyBookmarkInput extends LegacyReadingFields {
  readonly text: string;
  readonly createdAtMs: number;
}

export interface LegacyNoteInput {
  readonly chapterPath: string;
  readonly spineIndex: number;
  readonly startTextOffset: number;
  readonly endTextOffset: number;
  readonly startTextSnippet: string;
  readonly endTextSnippet: string;
  readonly selectedText: string;
  readonly content: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface LegacyBookSource {
  /** EPUB raw-byte SHA-256, or null/absent when the old row still needs lazy hashing. */
  readonly contentHash: string;
  /** Local shelf/store id. It stays local and is never written into v3 wire. */
  readonly localEntryId: string;
  readonly metadata: {
    readonly title: string;
    readonly creator: string;
    readonly language?: string;
    readonly fileName: string;
    readonly addedAtMs: number;
  };
  readonly progress?: (LegacyReadingFields & { readonly progressPctHint: number; readonly updatedAtMs: number }) | null;
  readonly bookmarks?: readonly (LegacyBookmarkInput & { readonly id: string })[];
  readonly notes?: readonly (LegacyNoteInput & { readonly id: string })[];
}

export interface MigratedLegacyBook {
  readonly contentHash: string;
  readonly localEntryId: string;
  readonly book: PortableBook;
}

function legacyLocator(fields: LegacyReadingFields, path = "legacyLocator"): LegacyLocator {
  const failures: PortableStateIssue[] = [];
  const locator = parseLocator({
    locatorVersion: 0,
    spineIndex: fields.spineIndex,
    pageHint: fields.page,
    anchorIndex: fields.anchorIndex,
    anchorRatio: fields.anchorRatio,
    anchorTextOffset: fields.anchorTextOffset ?? null,
    anchorTextSnippet: fields.anchorTextSnippet ?? null,
    mediaAnchor: fields.mediaAnchor ?? null,
  }, path, failures);
  if (!locator || locator.locatorVersion !== 0) throw new PortableStateParseError(failures);
  return locator;
}

/** Build a v3 initial event from a migration stamp. No other event is observed yet. */
export function versionFromInitialStamp<T extends Json>(
  stamp: Stamp,
  value: T,
  updatedAtMs: number,
): Version<T> {
  if (!Number.isSafeInteger(stamp.counter) || stamp.counter < 1) {
    throw new PortableStateParseError([{
      path: "stamp",
      code: "invalid-stamp",
      message: "migration stamp counter must be a positive safe integer",
    }]);
  }
  return {
    stamp: { deviceId: stamp.deviceId, counter: stamp.counter },
    clock: { [stamp.deviceId]: stamp.counter },
    value,
    updatedAtMs,
  };
}

export function legacyLocatorFromReadingFields(fields: LegacyReadingFields): LegacyLocator {
  return legacyLocator(fields);
}

function locatorForReading(fields: LegacyReadingFields): Locator {
  const legacy = legacyLocator(fields);
  if (!fields.resolvedChapterPath) return legacy;
  return upgradeLegacyLocator(legacy, fields.resolvedChapterPath) ?? legacy;
}

export function progressValueFromLegacyReading(
  fields: LegacyReadingFields & { readonly progressPctHint: number },
): ProgressValue {
  return {
    locator: locatorForReading(fields),
    progressPctHint: fields.progressPctHint,
  };
}

export function bookmarkValueFromLegacy(input: LegacyBookmarkInput): BookmarkValue {
  return {
    locator: locatorForReading(input),
    text: input.text,
    createdAtMs: input.createdAtMs,
  };
}

export function noteValueFromLegacy(input: LegacyNoteInput): NoteValue {
  return {
    chapterPath: input.chapterPath,
    spineIndexHint: input.spineIndex,
    textProfile: "visible-codepoints-no-whitespace-v1",
    startTextOffset: input.startTextOffset,
    endTextOffset: input.endTextOffset,
    startTextSnippet: input.startTextSnippet,
    endTextSnippet: input.endTextSnippet,
    selectedText: input.selectedText,
    content: input.content,
    createdAtMs: input.createdAtMs,
  };
}

/**
 * Upgrade a legacy locator only when its payload is sufficient to build a
 * modern target without observing the EPUB. Old page/anchor-index-only records
 * intentionally stay version 0; the reader resolves them after the book exists.
 */
export function upgradeLegacyLocator(locator: LegacyLocator, chapterPath: string): ModernLocator | null {
  if (locator.anchorTextOffset !== null && locator.anchorTextSnippet !== null) {
    return {
      locatorVersion: 1,
      chapterPath,
      spineIndexHint: locator.spineIndex,
      target: {
        kind: "text",
        textProfile: "visible-codepoints-no-whitespace-v1",
        offset: locator.anchorTextOffset,
        snippet: locator.anchorTextSnippet,
      },
    };
  }
  const media = locator.mediaAnchor;
  if (media && (media.tag === "img" || media.tag === "svg" || media.tag === "video")) {
    return {
      locatorVersion: 1,
      chapterPath,
      spineIndexHint: locator.spineIndex,
      target: {
        kind: "media",
        signature: media.signature,
        indexHint: media.index,
        tag: media.tag,
        ratio: media.ratio,
      },
    };
  }
  return null;
}

export function modernChapterStartLocator(chapterPath: string, spineIndexHint: number): ModernLocator {
  return { locatorVersion: 1, chapterPath, spineIndexHint, target: { kind: "chapter-start" } };
}

export function modernTextLocator(input: {
  readonly chapterPath: string;
  readonly spineIndexHint: number;
  readonly offset: number;
  readonly snippet: string;
}): ModernLocator {
  return {
    locatorVersion: 1,
    chapterPath: input.chapterPath,
    spineIndexHint: input.spineIndexHint,
    target: {
      kind: "text",
      textProfile: "visible-codepoints-no-whitespace-v1",
      offset: input.offset,
      snippet: input.snippet,
    },
  };
}

export function modernMediaLocator(input: {
  readonly chapterPath: string;
  readonly spineIndexHint: number;
  readonly signature: string;
  readonly indexHint: number;
  readonly tag: "img" | "svg" | "video";
  readonly ratio: number;
}): ModernLocator {
  return {
    locatorVersion: 1,
    chapterPath: input.chapterPath,
    spineIndexHint: input.spineIndexHint,
    target: { kind: "media", signature: input.signature, indexHint: input.indexHint, tag: input.tag, ratio: input.ratio },
  };
}

export function annotationFromInitialStamp<T extends Json>(
  stamp: Stamp,
  value: T,
  updatedAtMs: number,
): Annotation<T> {
  return { versions: [versionFromInitialStamp(stamp, value, updatedAtMs)] };
}

/**
 * Convert one legacy record into the v3 book shape. The same migration stamp is
 * valid for this atomic import operation; all entities keep their old IDs and
 * creation times. The localEntryId stays outside v3 so the browser byte/cover
 * keys cannot be rebuilt or moved by migration.
 */
export function portableBookFromLegacySource(
  source: LegacyBookSource,
  migrationStamp: Stamp,
): MigratedLegacyBook {
  const progress = source.progress
    ? { versions: [versionFromInitialStamp(
        migrationStamp,
        progressValueFromLegacyReading(source.progress),
        source.progress.updatedAtMs,
      )] }
    : { versions: [] };

  const bookmarks: Record<string, Annotation<BookmarkValue>> = {};
  for (const item of source.bookmarks ?? []) {
    bookmarks[item.id] = annotationFromInitialStamp(
      migrationStamp,
      bookmarkValueFromLegacy(item),
      item.createdAtMs,
    );
  }

  const notes: Record<string, Annotation<NoteValue>> = {};
  for (const item of source.notes ?? []) {
    notes[item.id] = annotationFromInitialStamp(
      migrationStamp,
      noteValueFromLegacy(item),
      item.updatedAtMs,
    );
  }

  const contentHash = legacyContentHash(source.contentHash);
  if (!contentHash) {
    throw new PortableStateParseError([{
      path: "contentHash",
      code: "invalid-hash",
      message: "legacy migration requires a 64-character lowercase SHA-256",
    }]);
  }
  return {
    contentHash,
    localEntryId: source.localEntryId,
    book: {
      metadata: {
        value: {
          title: source.metadata.title,
          creator: source.metadata.creator,
          ...(source.metadata.language === undefined ? {} : { language: source.metadata.language }),
          fileName: source.metadata.fileName,
          addedAtMs: source.metadata.addedAtMs,
        },
        stamp: migrationStamp,
      },
      progress,
      bookmarks,
      notes,
    },
  };
}

/** True only when a legacy record has a usable 64-bit lowercase content hash. */
export function legacyContentHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}
