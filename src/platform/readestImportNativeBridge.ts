/**
 * Typed calls for the Readest import commands. The native side owns the source
 * session (a backup ZIP or Readest's library folder), candidate digests, book
 * staging and the import transaction; this module only shapes arguments and
 * reads entries to EOF.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { BookmarkValue, Locator, NoteValue, ProgressValue } from "../core/portableState/portable-state-types";
import type { Version } from "../core/portableState/portable-register-core";
import type { SaveFileLocation } from "./saveFileNativeBridge";

export type ReadestImportScope = { kind: "public" } | { kind: "private"; sessionId: string };

/** One readable backup entry: `library.json` or a book's `config.json`. */
export interface ReadestJsonEntry {
  entryIndex: number;
  bytes: number;
}

/** The original book file Readest keeps beside a book's config. */
export interface ReadestBookFile {
  readestHash: string;
  fileName: string;
  bytes: number;
}

export interface ReadestBackupInfo {
  sessionId: string;
  chunkBytes: number;
  library: ReadestJsonEntry;
  kind: "zip" | "folder";
  /** Only books whose file is in the source and in a format SeLis reads. */
  books: ReadestBookFile[];
}

export interface ReadestStageProgress {
  completed: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
}

/** One book made importable: a path on desktop, a content URI on Android. */
export interface ReadestStagedBook {
  readestHash: string;
  path?: string;
  uri?: string;
  fileName?: string;
  errorCode?: string;
}

export interface ReadestLibraryProbe {
  path: string;
  books: number;
}

/** The native portable progress projection for the local book. */
export interface ReadestLocalProgress {
  versions: Version<ProgressValue>[];
  display: Version<ProgressValue> | null;
  conflict: boolean;
}

export interface ReadestTargetCandidate {
  bookHash: string;
  partialMd5?: string;
  targetToken?: string;
  progress?: ReadestLocalProgress;
  errorCode?: string;
}

export interface ReadestBookImportPayload {
  bookHash: string;
  readestHash: string;
  targetToken: string;
  /** Omitted when the user keeps the local position; never null. */
  progress?: { locator: Locator; progressPctHint: number };
  bookmarks: Array<{ sourceKey: string; value: BookmarkValue }>;
  notes: Array<{ sourceKey: string; value: NoteValue }>;
}

export interface ReadestImportOutcome {
  importedBooks: number;
  bookmarksAdded: number;
  notesAdded: number;
  progressWritten: number;
  skippedExisting: number;
  progressUnchanged: number;
}

export type ReadestCloseStatus = "closed" | "committed" | "not-found";

/** Native limits the dialog has to respect before calling. */
export const READEST_TARGET_BATCH = 128;
export const READEST_COMMIT_MAX_BOOKS = 128;
export const READEST_COMMIT_MAX_RECORDS = 20_000;
export const READEST_STAGE_BATCH = 128;

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const call: Invoke = (command, args) => invoke(command, args);

export function openReadestBackup(
  input: { sessionId: string; source: SaveFileLocation; scope: ReadestImportScope },
  run: Invoke = call,
): Promise<ReadestBackupInfo> {
  return run("readest_backup_open", input);
}

export function findReadestConfig(sessionId: string, readestHash: string, run: Invoke = call): Promise<ReadestJsonEntry | null> {
  return run("readest_backup_config", { sessionId, readestHash });
}

/**
 * Read one entry from offset 0 to EOF, sequentially, then decode strictly as
 * UTF-8. An empty entry still issues one read so the archive layer validates it.
 */
export async function readReadestEntryText(
  sessionId: string,
  entry: ReadestJsonEntry,
  run: Invoke = call,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  do {
    const buffer = await run<ArrayBuffer>("readest_backup_read", { sessionId, entryIndex: entry.entryIndex, offset });
    const chunk = new Uint8Array(buffer);
    if (chunk.byteLength === 0 && offset < entry.bytes) {
      throw Object.assign(new Error("Readest backup entry ended early"), { code: "invalid-backup" });
    }
    chunks.push(chunk);
    offset += chunk.byteLength;
  } while (offset < entry.bytes);
  if (offset !== entry.bytes) throw Object.assign(new Error("Readest backup entry size mismatch"), { code: "invalid-backup" });
  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error("Readest backup entry is not UTF-8"), { code: "invalid-data" });
  }
}

export function readestImportTargets(sessionId: string, bookHashes: string[], run: Invoke = call): Promise<ReadestTargetCandidate[]> {
  return run("readest_import_targets", { sessionId, bookHashes });
}

export function commitReadestImport(sessionId: string, books: ReadestBookImportPayload[], run: Invoke = call): Promise<ReadestImportOutcome> {
  return run("readest_import_commit", { sessionId, books });
}

/**
 * Makes the chosen books importable. Rows carry per-book failures; a cancelled
 * or closed session rejects the whole call.
 */
export function stageReadestBooks(
  sessionId: string,
  readestHashes: string[],
  onProgress: (progress: ReadestStageProgress) => void,
  run: Invoke = call,
): Promise<ReadestStagedBook[]> {
  return run("readest_books_stage", { sessionId, readestHashes, onProgress: new Channel<ReadestStageProgress>(onProgress) });
}

/** Drops staged copies once the importer has taken them. */
export function releaseReadestBooks(sessionId: string, run: Invoke = call): Promise<void> {
  return run("readest_books_release", { sessionId });
}

/** Desktop only: Readest's library in its default data location, if any. */
export function probeReadestLibrary(run: Invoke = call): Promise<ReadestLibraryProbe | null> {
  return run("readest_library_probe");
}

export async function closeReadestBackup(sessionId: string, run: Invoke = call): Promise<ReadestCloseStatus> {
  const reply = await run<{ status: ReadestCloseStatus }>("readest_backup_close", { sessionId });
  return reply.status;
}
