/**
 * Storage boundary for the Web portable-state repository.
 *
 * The service owns all merge semantics; a storage implementation only has to
 * provide one atomic read/write transaction. IndexedDB and the in-memory
 * backend used by direct tests fulfil the same contract.
 */
import type { Stamp, Version } from "../../core/portableState/portable-register-core";
import type {
  BookMetadata,
  BookmarkValue,
  NoteValue,
  ProgressValue,
} from "../../core/portableState/portable-state-types";
import type { OrganizationEnvelope, Register } from "../libraryOrganization";

export interface PortableMetadataRow {
  readonly hash: string;
  readonly metadata: Register<BookMetadata>;
}

export interface PortableProgressRow {
  readonly hash: string;
  readonly versions: readonly Version<ProgressValue>[];
  /** Local-only counter of the last accepted local write for this entity. */
  readonly localRevision: number;
}

export interface BookmarkAnnotationRow {
  readonly hash: string;
  readonly kind: "bookmark";
  readonly id: string;
  readonly versions: readonly Version<BookmarkValue>[];
  readonly deleted?: Stamp;
  readonly localRevision: number;
}

export interface NoteAnnotationRow {
  readonly hash: string;
  readonly kind: "note";
  readonly id: string;
  readonly versions: readonly Version<NoteValue>[];
  readonly deleted?: Stamp;
  readonly localRevision: number;
}

export type AnnotationRow = BookmarkAnnotationRow | NoteAnnotationRow;

export interface PortableStateTransaction {
  /** Current local envelope, or null before first initialization. */
  getEnvelope(): Promise<OrganizationEnvelope | null>;
  putEnvelope(envelope: OrganizationEnvelope): Promise<void>;

  getMetadata(hash: string): Promise<PortableMetadataRow | null>;
  putMetadata(row: PortableMetadataRow): Promise<void>;
  listMetadata(): Promise<readonly PortableMetadataRow[]>;

  getProgress(hash: string): Promise<PortableProgressRow | null>;
  putProgress(row: PortableProgressRow): Promise<void>;
  listProgress(): Promise<readonly PortableProgressRow[]>;

  getBookmarkAnnotation(hash: string, id: string): Promise<BookmarkAnnotationRow | null>;
  getNoteAnnotation(hash: string, id: string): Promise<NoteAnnotationRow | null>;
  putBookmarkAnnotation(row: BookmarkAnnotationRow): Promise<void>;
  putNoteAnnotation(row: NoteAnnotationRow): Promise<void>;
  listAnnotations(hash?: string): Promise<readonly AnnotationRow[]>;

  getMeta(key: string): Promise<unknown>;
  putMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
}

export interface PortableStateStorage {
  /**
   * Run `work` inside one atomic transaction. Implementations MUST roll back
   * every write if `work` rejects.
   */
  transaction<T>(work: (transaction: PortableStateTransaction) => Promise<T>): Promise<T>;
}

/** Reserved meta keys (kept out of the portable wire). */
export const META_PREFERENCES = "preferences";
export const META_PENDING_PREFERENCES = "pendingPreferences";
export const META_MIGRATION = "migration";
