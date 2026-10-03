/**
 * Shared v3 merge helpers.
 *
 * These functions assume both inputs were produced by the strict parser or by
 * the repository; they do not parse untrusted JSON by themselves. The counter
 * scanner deliberately observes the RAW pre-merge state so a tombstone cannot
 * hide an edit counter.
 */
import { mergeOrganization, type LibraryOrganization, type Register } from "../../ui/libraryOrganization";
import {
  compareStamp,
  mergeAnnotation,
  mergeVersions,
  sameJsonValue,
  type Annotation,
  type Json,
  type Stamp,
  type Version,
} from "./portable-register-core";
import type { BookMetadata, PortableBook, PortablePreferences, PortableStateV3 } from "./portable-state-types";
import { maximumReceivedCounter } from "./portable-write-core";

export const REGISTER_COLLISION = "portable register collision";

function registerValueEqual<T extends Json>(a: T, b: T): boolean {
  return sameJsonValue(a, b);
}

/**
 * Same deterministic rule as the existing organization registers:
 * larger `(counter, deviceId ASCII)` wins; the same stamp with a different
 * value is corruption and must not be decided by argument order.
 */
export function mergeRegister<T extends Json>(a: Register<T>, b: Register<T>): Register<T> {
  const order = compareStamp(a.stamp, b.stamp);
  if (order === 0 && !registerValueEqual(a.value, b.value)) throw new Error(REGISTER_COLLISION);
  return order >= 0 ? a : b;
}

function mergeAnnotations<T extends Json>(
  a: Annotation<T> | undefined,
  b: Annotation<T> | undefined,
): Annotation<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  return mergeAnnotation(a, b);
}

export function mergePortableBook(a: PortableBook, b: PortableBook): PortableBook {
  const bookmarks: Record<string, Annotation<PortableBook["bookmarks"][string] extends Annotation<infer V> ? V : never>> = {};
  const bookmarkIds = new Set([...Object.keys(a.bookmarks), ...Object.keys(b.bookmarks)]);
  for (const id of bookmarkIds) {
    const merged = mergeAnnotations(a.bookmarks[id], b.bookmarks[id]);
    if (merged) bookmarks[id] = merged;
  }

  const notes: Record<string, Annotation<PortableBook["notes"][string] extends Annotation<infer V> ? V : never>> = {};
  const noteIds = new Set([...Object.keys(a.notes), ...Object.keys(b.notes)]);
  for (const id of noteIds) {
    const merged = mergeAnnotations(a.notes[id], b.notes[id]);
    if (merged) notes[id] = merged;
  }

  return {
    metadata: mergeRegister(a.metadata, b.metadata) as Register<BookMetadata>,
    progress: { versions: mergeVersions(a.progress.versions, b.progress.versions) },
    bookmarks: bookmarks as PortableBook["bookmarks"],
    notes: notes as PortableBook["notes"],
  };
}

function copyBookmarks(value: PortableBook["bookmarks"]): PortableBook["bookmarks"] {
  const out: Record<string, Annotation<PortableBook["bookmarks"][string] extends Annotation<infer V> ? V : never>> = {};
  for (const [id, annotation] of Object.entries(value)) {
    out[id] = annotation.deleted ? { versions: [], deleted: annotation.deleted } : { versions: [...annotation.versions] };
  }
  return out as PortableBook["bookmarks"];
}

function copyNotes(value: PortableBook["notes"]): PortableBook["notes"] {
  const out: Record<string, Annotation<PortableBook["notes"][string] extends Annotation<infer V> ? V : never>> = {};
  for (const [id, annotation] of Object.entries(value)) {
    out[id] = annotation.deleted ? { versions: [], deleted: annotation.deleted } : { versions: [...annotation.versions] };
  }
  return out as PortableBook["notes"];
}

function mergePreferences(a: PortablePreferences | undefined, b: PortablePreferences | undefined): PortablePreferences | undefined {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b };
}

export interface PortableStateMergeOptions {
  /** Preferences are never applied implicitly; import UI must opt in explicitly. */
  readonly applyPreferences?: boolean;
}

export function mergePortableState(
  local: PortableStateV3,
  incoming: PortableStateV3,
  options: PortableStateMergeOptions = {},
): PortableStateV3 {
  const books: Record<string, PortableBook> = {};
  const hashes = new Set([...Object.keys(local.books), ...Object.keys(incoming.books)]);
  for (const hash of hashes) {
    const a = local.books[hash];
    const b = incoming.books[hash];
    if (a && b) books[hash] = mergePortableBook(a, b);
    else if (a) books[hash] = { metadata: a.metadata, progress: { versions: [...a.progress.versions] }, bookmarks: copyBookmarks(a.bookmarks), notes: copyNotes(a.notes) };
    else if (b) books[hash] = { metadata: b.metadata, progress: { versions: [...b.progress.versions] }, bookmarks: copyBookmarks(b.bookmarks), notes: copyNotes(b.notes) };
  }

  const organization: LibraryOrganization = mergeOrganization(local.organization, incoming.organization);
  const preferences = options.applyPreferences
    ? mergePreferences(local.preferences, incoming.preferences)
    : local.preferences;
  return {
    schemaVersion: 3,
    books,
    organization,
    ...(preferences === undefined ? {} : { preferences }),
  };
}

function observeRegister(stamp: Stamp | undefined, registerStamps: Stamp[]): void {
  if (stamp) registerStamps.push(stamp);
}

function observeAnnotation<T extends Json>(
  annotation: Annotation<T>,
  versions: Version<Json>[],
  tombstones: Stamp[],
): void {
  for (const version of annotation.versions) versions.push(version as Version<Json>);
  if (annotation.deleted) tombstones.push(annotation.deleted);
}

/**
 * Scan every raw pre-merge event in a validated state. Call this before any
 * edit is discarded by tombstone or causal domination.
 */
export function maximumPortableStateReceivedCounter(state: PortableStateV3): number {
  const versions: Version<Json>[] = [];
  const registerStamps: Stamp[] = [];
  const tombstones: Stamp[] = [];
  for (const book of Object.values(state.books)) {
    observeRegister(book.metadata.stamp, registerStamps);
    for (const version of book.progress.versions) versions.push(version as Version<Json>);
    for (const annotation of Object.values(book.bookmarks)) observeAnnotation(annotation, versions, tombstones);
    for (const annotation of Object.values(book.notes)) observeAnnotation(annotation, versions, tombstones);
  }
  for (const folder of Object.values(state.organization.folders)) {
    observeRegister(folder.name.stamp, registerStamps);
    if (folder.deleted) tombstones.push(folder.deleted);
  }
  for (const book of Object.values(state.organization.books)) {
    observeRegister(book.favorite?.stamp, registerStamps);
    observeRegister(book.folderId?.stamp, registerStamps);
  }
  return maximumReceivedCounter({ versions, registerStamps, tombstones });
}
