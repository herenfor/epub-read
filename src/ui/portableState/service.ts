/**
 * Web portable-state service.
 *
 * This is the web implementation of the frozen native repository wire. UI
 * callers only ever receive opaque `readId` / `basisId` handles; all clocks,
 * observed frontiers and revisions stay inside this service/transaction.
 */
import {
  captureReadBasis,
  maximumReceivedCounter,
  nextLocalCounter,
  prepareObservedWrite,
  type EntityRef,
  type ReadBasis,
} from "../../core/portableState/portable-write-core";
import {
  writeObserved,
  type Annotation,
  type Json,
  type Stamp,
  type Version,
} from "../../core/portableState/portable-register-core";
import {
  maximumPortableStateReceivedCounter,
  mergePortableState,
} from "../../core/portableState/merge";
import {
  PortableStateParseError,
  parseBookmarkValue,
  parseNoteValue,
  parsePortablePreferences,
  parsePortableStateV3,
  parseProgressValue,
  tryParsePortableStateV3,
} from "../../core/portableState/parser";
import type {
  BookmarkValue,
  NoteValue,
  PortableBook,
  PortableStateV3,
  ProgressValue,
} from "../../core/portableState/portable-state-types";
import {
  applyCommand,
  emptyOrganization,
  generateFolderId,
  mergeIntoEnvelope,
  validCanonicalUuid,
  validContentHash,
  validStamp,
  validateEnvelope,
  validateOrganization,
  type LibraryOrganization,
  type OrganizationCommand,
  type OrganizationEnvelope,
} from "../libraryOrganization";
import type { ShelfEntry } from "../shelf";
import {
  META_MIGRATION,
  META_PENDING_PREFERENCES,
  META_PREFERENCES,
  type AnnotationRow,
  type BookmarkAnnotationRow,
  type NoteAnnotationRow,
  type PortableMetadataRow,
  type PortableProgressRow,
  type PortableStateStorage,
  type PortableStateTransaction,
} from "./storage";

export type PortableStateErrorCode =
  | "invalid-data"
  | "invalid-entity"
  | "invalid-choice"
  | "invalid-intent"
  | "stale-basis"
  | "stale-choice"
  | "deleted-entity"
  | "clock-exhausted"
  | "storage-error";

export class PortableStateError extends Error {
  readonly code: PortableStateErrorCode;

  constructor(code: PortableStateErrorCode, message: string) {
    super(message);
    this.name = "PortableStateError";
    this.code = code;
  }
}

export type PortableWriteIntent = "auto" | "edit" | "resolve" | "reset";

export type PortableAdoptSelection =
  | { readonly kind: "chosen"; readonly stamp: Stamp }
  | { readonly kind: "empty" }
  | { readonly kind: "shown-all" };

export interface PortableReadResult {
  readonly readId: string;
  readonly book: PortableBook | null;
}

export type PortableProgressEntityState = { readonly versions: readonly Version<ProgressValue>[] };
export type PortableBookmarkEntityState = Annotation<BookmarkValue>;
export type PortableNoteEntityState = Annotation<NoteValue>;
export type PortableEntityState =
  | PortableProgressEntityState
  | PortableBookmarkEntityState
  | PortableNoteEntityState;

export interface PortableWriteResult {
  readonly status: "written" | "unchanged";
  readonly entity: EntityRef;
  readonly state: PortableEntityState;
  readonly nextBasisId: string;
}

export interface PortableDeleteResult {
  readonly status: "deleted" | "unchanged";
  readonly entity: EntityRef;
  readonly state: PortableEntityState;
}

interface ReadSnapshot {
  readonly bookHash: string;
  readonly metadata: PortableMetadataRow | null;
  readonly progress: PortableProgressRow | null;
  readonly annotations: ReadonlyMap<string, AnnotationRow>;
}

type AnyReadBasis = ReadBasis<ProgressValue> | ReadBasis<BookmarkValue> | ReadBasis<NoteValue>;

interface BasisRecord {
  readonly bookHash: string;
  readonly basis: AnyReadBasis;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function progressRevisionKey(hash: string): string {
  return `${hash}\u0000progress`;
}

function annotationRevisionKey(hash: string, kind: "bookmark" | "note", id: string): string {
  return `${hash}\u0000${kind}\u0000${id}`;
}

function annotationMapKey(hash: string, kind: "bookmark" | "note", id: string): string {
  return `${hash}\u0000${kind}\u0000${id}`;
}

function newOpaqueId(): string {
  return generateFolderId();
}

function safeUpdatedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PortableStateError("invalid-data", "updatedAtMs must be a non-negative safe integer");
  }
  return value;
}

function validateBookHash(value: unknown, field = "bookHash"): string {
  if (typeof value !== "string" || !validContentHash(value)) {
    throw new PortableStateError("invalid-data", `${field} must be a 64-character lowercase SHA-256 hash`);
  }
  return value;
}

function validateEntityRef(value: unknown): EntityRef {
  if (!isObject(value)) throw new PortableStateError("invalid-data", "entity must be an object");
  const bookHash = validateBookHash(value.bookHash);
  const kind = value.kind;
  if (kind === "progress") return { bookHash, kind: "progress" };
  if (kind === "bookmark" || kind === "note") {
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new PortableStateError("invalid-data", "annotation id must be a non-empty string");
    }
    return { bookHash, kind, id: value.id };
  }
  throw new PortableStateError("invalid-data", "unknown entity kind");
}

function validateAnnotationEntity(value: EntityRef): asserts value is Extract<EntityRef, { kind: "bookmark" | "note" }> {
  if (value.kind === "progress") throw new PortableStateError("invalid-entity", "annotation entity required");
}

function parseIntent(value: unknown): PortableWriteIntent {
  if (value === "auto" || value === "edit" || value === "resolve" || value === "reset") return value;
  throw new PortableStateError("invalid-intent", "unknown write intent");
}

function parseAdoptSelection(value: unknown): PortableAdoptSelection {
  if (!isObject(value)) throw new PortableStateError("invalid-choice", "selection must be an object");
  if (value.kind === "empty") return { kind: "empty" };
  if (value.kind === "shown-all") return { kind: "shown-all" };
  if (value.kind === "chosen") {
    const stamp = value.stamp;
    if (!isObject(stamp) || !validStamp(stamp)) {
      throw new PortableStateError("invalid-choice", "chosen selection needs a valid stamp");
    }
    return { kind: "chosen", stamp: { deviceId: stamp.deviceId, counter: stamp.counter } };
  }
  throw new PortableStateError("invalid-choice", "unknown selection kind");
}

function parseEntityValue(entity: EntityRef, intent: PortableWriteIntent, raw: unknown): ProgressValue | BookmarkValue | NoteValue {
  if (entity.kind === "progress") {
    if (intent === "reset") {
      if (raw !== null) throw new PortableStateError("invalid-intent", "reset progress value must be null");
      return null;
    }
    return parseProgressValue(raw);
  }
  if (intent === "auto" || intent === "reset") {
    throw new PortableStateError("invalid-intent", `intent ${intent} is not valid for annotations`);
  }
  return entity.kind === "bookmark" ? parseBookmarkValue(raw) : parseNoteValue(raw);
}

function mapCoreError(error: unknown): PortableStateError {
  if (error instanceof PortableStateError) return error;
  if (error instanceof PortableStateParseError) return new PortableStateError("invalid-data", error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (/stale-basis/.test(message)) return new PortableStateError("stale-basis", message);
  if (/stale-choice/.test(message)) return new PortableStateError("stale-choice", message);
  if (/invalid-basis|invalid-choice/.test(message)) return new PortableStateError("invalid-choice", message);
  if (/invalid-intent/.test(message)) return new PortableStateError("invalid-intent", message);
  if (/deleted-entity/.test(message)) return new PortableStateError("deleted-entity", message);
  if (/wrong-entity/.test(message)) return new PortableStateError("invalid-entity", message);
  if (/collision/.test(message)) return new PortableStateError("invalid-data", message);
  if (/clock-not-advanced|clock-exhausted/.test(message)) return new PortableStateError("clock-exhausted", message);
  return new PortableStateError("storage-error", message);
}

export interface PortableStateCommandService {
  read(input: { readonly bookHash: string }): Promise<PortableReadResult>;
  adopt(input: {
    readonly readId: string;
    readonly entity: EntityRef;
    readonly selection: PortableAdoptSelection;
  }): Promise<{ readonly basisId: string }>;
  write(input: {
    readonly basisId: string;
    readonly intent: PortableWriteIntent;
    readonly value: unknown;
    readonly updatedAtMs: number;
  }): Promise<PortableWriteResult>;
  createAnnotation(input: {
    readonly bookHash: string;
    readonly kind: "bookmark" | "note";
    readonly id: string;
    readonly value: unknown;
    readonly updatedAtMs: number;
  }): Promise<PortableWriteResult>;
  deleteAnnotation(input: { readonly entity: EntityRef }): Promise<PortableDeleteResult>;
  release(input: {
    readonly basisId?: string;
    readonly readId?: string;
    readonly bookHash?: string;
  }): Promise<null>;
}

export class PortableStateService implements PortableStateCommandService {
  private readonly reads = new Map<string, ReadSnapshot>();
  private readonly bases = new Map<string, BasisRecord>();

  constructor(private readonly storage: PortableStateStorage) {}

  private async withStorage<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw mapCoreError(error);
    }
  }

  private async loadEnvelope(tx: PortableStateTransaction): Promise<OrganizationEnvelope | null> {
    const raw = await tx.getEnvelope();
    if (!raw) return null;
    try {
      return validateEnvelope(raw);
    } catch (error) {
      throw new PortableStateError("storage-error", error instanceof Error ? error.message : String(error));
    }
  }

  private async requireEnvelope(tx: PortableStateTransaction): Promise<OrganizationEnvelope> {
    const existing = await this.loadEnvelope(tx);
    if (existing) return existing;
    const initial: OrganizationEnvelope = {
      deviceId: newOpaqueId(),
      counter: 0,
      state: emptyOrganization(),
    };
    await tx.putEnvelope(initial);
    return initial;
  }

  private async loadLocalState(
    tx: PortableStateTransaction,
    envelope: OrganizationEnvelope | null,
  ): Promise<{ state: PortableStateV3; revisions: Map<string, number> }> {
    const metadataRows = await tx.listMetadata();
    const progressRows = await tx.listProgress();
    const annotationRows = await tx.listAnnotations();

    const metadataByHash = new Map(metadataRows.map((row) => [row.hash, row]));
    const progressByHash = new Map(progressRows.map((row) => [row.hash, row]));
    const annotationsByHash = new Map<string, AnnotationRow[]>();
    for (const row of annotationRows) {
      const list = annotationsByHash.get(row.hash) ?? [];
      list.push(row);
      annotationsByHash.set(row.hash, list);
    }

    const hashes = new Set([...metadataByHash.keys(), ...progressByHash.keys(), ...annotationsByHash.keys()]);
    const revisions = new Map<string, number>();
    const books: Record<string, PortableBook> = {};
    for (const hash of [...hashes].sort()) {
      const metadata = metadataByHash.get(hash);
      if (!metadata) {
        throw new PortableStateError("storage-error", "portable book data is missing its metadata register");
      }
      const progress = progressByHash.get(hash);
      const bookmarks: Record<string, Annotation<BookmarkValue>> = {};
      const notes: Record<string, Annotation<NoteValue>> = {};
      for (const row of annotationsByHash.get(hash) ?? []) {
        if (row.kind === "bookmark") {
          bookmarks[row.id] = row.deleted
            ? { versions: [], deleted: row.deleted }
            : { versions: [...row.versions] };
          revisions.set(annotationRevisionKey(hash, "bookmark", row.id), row.localRevision);
        } else {
          notes[row.id] = row.deleted
            ? { versions: [], deleted: row.deleted }
            : { versions: [...row.versions] };
          revisions.set(annotationRevisionKey(hash, "note", row.id), row.localRevision);
        }
      }
      revisions.set(progressRevisionKey(hash), progress?.localRevision ?? 0);
      books[hash] = {
        metadata: metadata.metadata,
        progress: { versions: progress ? [...progress.versions] : [] },
        bookmarks,
        notes,
      };
    }

    const rawPreferences = await tx.getMeta(META_PREFERENCES);
    const preferences = rawPreferences === undefined ? undefined : parsePortablePreferences(rawPreferences);
    const state: PortableStateV3 = {
      schemaVersion: 3,
      books,
      organization: envelope?.state ?? emptyOrganization(),
      ...(preferences === undefined ? {} : { preferences }),
    };
    return { state, revisions };
  }

  private async writeStateRows(
    tx: PortableStateTransaction,
    state: PortableStateV3,
    revisions: ReadonlyMap<string, number>,
  ): Promise<void> {
    for (const [hash, book] of Object.entries(state.books)) {
      await tx.putMetadata({ hash, metadata: book.metadata });
      const progressRevision = revisions.get(progressRevisionKey(hash));
      if (book.progress.versions.length > 0 || progressRevision !== undefined) {
        await tx.putProgress({
          hash,
          versions: book.progress.versions,
          localRevision: progressRevision ?? 0,
        });
      }
      for (const [id, annotation] of Object.entries(book.bookmarks)) {
        const revision = revisions.get(annotationRevisionKey(hash, "bookmark", id));
        if (annotation.deleted || annotation.versions.length > 0 || revision !== undefined) {
          await tx.putBookmarkAnnotation({
            hash,
            kind: "bookmark",
            id,
            versions: annotation.versions,
            ...(annotation.deleted ? { deleted: annotation.deleted } : {}),
            localRevision: revision ?? 0,
          });
        }
      }
      for (const [id, annotation] of Object.entries(book.notes)) {
        const revision = revisions.get(annotationRevisionKey(hash, "note", id));
        if (annotation.deleted || annotation.versions.length > 0 || revision !== undefined) {
          await tx.putNoteAnnotation({
            hash,
            kind: "note",
            id,
            versions: annotation.versions,
            ...(annotation.deleted ? { deleted: annotation.deleted } : {}),
            localRevision: revision ?? 0,
          });
        }
      }
    }
  }

  private buildBook(snapshot: ReadSnapshot): PortableBook | null {
    if (!snapshot.metadata) return null;
    const bookmarks: Record<string, Annotation<BookmarkValue>> = {};
    const notes: Record<string, Annotation<NoteValue>> = {};
    for (const row of snapshot.annotations.values()) {
      if (row.kind === "bookmark") {
        bookmarks[row.id] = row.deleted ? { versions: [], deleted: row.deleted } : { versions: [...row.versions] };
      } else {
        notes[row.id] = row.deleted ? { versions: [], deleted: row.deleted } : { versions: [...row.versions] };
      }
    }
    return {
      metadata: snapshot.metadata.metadata,
      progress: { versions: snapshot.progress ? [...snapshot.progress.versions] : [] },
      bookmarks,
      notes,
    };
  }

  async read(input: { readonly bookHash: string }): Promise<PortableReadResult> {
    const bookHash = validateBookHash(input?.bookHash);
    const snapshot = await this.withStorage(async () => this.storage.transaction(async (tx) => {
      const metadata = await tx.getMetadata(bookHash);
      const progress = await tx.getProgress(bookHash);
      const annotations = new Map<string, AnnotationRow>();
      for (const row of await tx.listAnnotations(bookHash)) {
        annotations.set(annotationMapKey(row.hash, row.kind, row.id), row);
      }
      if (!metadata && (progress || annotations.size > 0)) {
        throw new PortableStateError("storage-error", "portable book data is missing its metadata register");
      }
      return { bookHash, metadata, progress, annotations } satisfies ReadSnapshot;
    }));
    const readId = newOpaqueId();
    this.reads.set(readId, snapshot);
    return { readId, book: snapshot.metadata ? cloneJson(this.buildBook(snapshot)) : null };
  }

  async adopt(input: {
    readonly readId: string;
    readonly entity: EntityRef;
    readonly selection: PortableAdoptSelection;
  }): Promise<{ readonly basisId: string }> {
    if (typeof input?.readId !== "string" || input.readId.length === 0) {
      throw new PortableStateError("stale-basis", "unknown readId");
    }
    const snapshot = this.reads.get(input.readId);
    if (!snapshot) throw new PortableStateError("stale-basis", "readId is expired or unknown");
    const entity = validateEntityRef(input.entity);
    if (!snapshot.metadata) {
      throw new PortableStateError("invalid-entity", "portable book does not exist");
    }
    if (entity.bookHash !== snapshot.bookHash) {
      throw new PortableStateError("invalid-entity", "entity does not belong to this read snapshot");
    }
    const selection = parseAdoptSelection(input.selection);
    const current = this.entityCurrentFromSnapshot(snapshot, entity);
    let basis: AnyReadBasis;
    try {
      if (selection.kind === "chosen") {
        basis = captureReadBasis({
          entity,
          current: current.versions,
          localRevision: current.localRevision,
          selection: { kind: "chosen", stamp: selection.stamp },
        }) as AnyReadBasis;
      } else if (selection.kind === "empty") {
        basis = captureReadBasis({
          entity,
          current: current.versions,
          localRevision: current.localRevision,
          selection: { kind: "chosen" },
        }) as AnyReadBasis;
      } else {
        basis = captureReadBasis({
          entity,
          current: current.versions,
          localRevision: current.localRevision,
          selection: { kind: "shown-all" },
        }) as AnyReadBasis;
      }
    } catch (error) {
      if (error instanceof Error && /invalid-choice/.test(error.message)) {
        throw new PortableStateError("invalid-choice", error.message);
      }
      throw mapCoreError(error);
    }
    const basisId = newOpaqueId();
    this.bases.set(basisId, { bookHash: entity.bookHash, basis });
    return { basisId };
  }

  private entityCurrentFromSnapshot(
    snapshot: ReadSnapshot,
    entity: EntityRef,
  ): { versions: readonly Version<Json>[]; localRevision: number; deleted?: Stamp } {
    if (entity.kind === "progress") {
      return {
        versions: (snapshot.progress?.versions ?? []) as readonly Version<Json>[],
        localRevision: snapshot.progress?.localRevision ?? 0,
      };
    }
    const row = snapshot.annotations.get(annotationMapKey(entity.bookHash, entity.kind, entity.id));
    return {
      versions: (row?.versions ?? []) as readonly Version<Json>[],
      localRevision: row?.localRevision ?? 0,
      ...(row?.deleted ? { deleted: row.deleted } : {}),
    };
  }

  async write(input: {
    readonly basisId: string;
    readonly intent: PortableWriteIntent;
    readonly value: unknown;
    readonly updatedAtMs: number;
  }): Promise<PortableWriteResult> {
    if (typeof input?.basisId !== "string" || input.basisId.length === 0) {
      throw new PortableStateError("stale-basis", "unknown basisId");
    }
    const record = this.bases.get(input.basisId);
    if (!record) throw new PortableStateError("stale-basis", "basisId is stale or unknown");
    const intent = parseIntent(input.intent);
    const updatedAtMs = safeUpdatedAt(input.updatedAtMs);
    const entity = record.basis.entity;
    let value: ProgressValue | BookmarkValue | NoteValue;
    try {
      value = parseEntityValue(entity, intent, input.value);
    } catch (error) {
      throw mapCoreError(error);
    }

    const outcome = await this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      const metadata = await tx.getMetadata(entity.bookHash);
      if (!metadata) throw new PortableStateError("invalid-entity", "portable book does not exist");
      if (entity.kind === "progress") {
        return this.writeProgress(tx, envelope, record.basis as ReadBasis<ProgressValue>, intent, value as ProgressValue, updatedAtMs);
      }
      if (entity.kind === "bookmark") {
        return this.writeBookmark(tx, envelope, record.basis as ReadBasis<BookmarkValue>, intent, value as BookmarkValue, updatedAtMs);
      }
      return this.writeNote(tx, envelope, record.basis as ReadBasis<NoteValue>, intent, value as NoteValue, updatedAtMs);
    }));

    if (outcome.nextBasis) {
      const nextBasisId = newOpaqueId();
      this.bases.set(nextBasisId, { bookHash: outcome.entity.bookHash, basis: outcome.nextBasis as AnyReadBasis });
      return { status: outcome.status, entity: outcome.entity, state: outcome.state, nextBasisId };
    }
    return { status: outcome.status, entity: outcome.entity, state: outcome.state, nextBasisId: input.basisId };
  }

  private writeProgress(
    tx: PortableStateTransaction,
    envelope: OrganizationEnvelope,
    basis: ReadBasis<ProgressValue>,
    intent: PortableWriteIntent,
    value: ProgressValue,
    updatedAtMs: number,
  ): Promise<WriteOutcome> {
    return this.commitEntityWrite({
      tx,
      envelope,
      basis,
      currentPromise: tx.getProgress(basis.entity.bookHash),
      persist: (next, nextStamp) => tx.putProgress({
        hash: basis.entity.bookHash,
        versions: next,
        localRevision: nextStamp.counter,
      }),
      toState: (next) => ({ versions: next }) as PortableEntityState,
      onUnchanged: async () => ({ versions: ((await tx.getProgress(basis.entity.bookHash))?.versions ?? []) as readonly Version<ProgressValue>[] }),
      intent,
      value,
      updatedAtMs,
    });
  }

  private async writeBookmark(
    tx: PortableStateTransaction,
    envelope: OrganizationEnvelope,
    basis: ReadBasis<BookmarkValue>,
    intent: PortableWriteIntent,
    value: BookmarkValue,
    updatedAtMs: number,
  ): Promise<WriteOutcome> {
    const entity = basis.entity;
    if (entity.kind !== "bookmark") throw new PortableStateError("invalid-entity", "wrong bookmark entity");
    const row = await tx.getBookmarkAnnotation(entity.bookHash, entity.id);
    if (!row) throw new PortableStateError("invalid-entity", "annotation does not exist");
    if (row.deleted) throw new PortableStateError("deleted-entity", "annotation is deleted");
    return this.commitEntityWrite({
      tx,
      envelope,
      basis,
      currentPromise: Promise.resolve(row),
      persist: (next, nextStamp) => tx.putBookmarkAnnotation({
        hash: entity.bookHash,
        kind: "bookmark",
        id: entity.id,
        versions: next,
        localRevision: nextStamp.counter,
      }),
      toState: (next) => ({ versions: next }) as PortableEntityState,
      onUnchanged: async () => ({ versions: [...((row as BookmarkAnnotationRow).versions)] }) as PortableEntityState,
      intent,
      value,
      updatedAtMs,
    });
  }

  private async writeNote(
    tx: PortableStateTransaction,
    envelope: OrganizationEnvelope,
    basis: ReadBasis<NoteValue>,
    intent: PortableWriteIntent,
    value: NoteValue,
    updatedAtMs: number,
  ): Promise<WriteOutcome> {
    const entity = basis.entity;
    if (entity.kind !== "note") throw new PortableStateError("invalid-entity", "wrong note entity");
    const row = await tx.getNoteAnnotation(entity.bookHash, entity.id);
    if (!row) throw new PortableStateError("invalid-entity", "annotation does not exist");
    if (row.deleted) throw new PortableStateError("deleted-entity", "annotation is deleted");
    return this.commitEntityWrite({
      tx,
      envelope,
      basis,
      currentPromise: Promise.resolve(row),
      persist: (next, nextStamp) => tx.putNoteAnnotation({
        hash: entity.bookHash,
        kind: "note",
        id: entity.id,
        versions: next,
        localRevision: nextStamp.counter,
      }),
      toState: (next) => ({ versions: next }) as PortableEntityState,
      onUnchanged: async () => ({ versions: [...((row as NoteAnnotationRow).versions)] }) as PortableEntityState,
      intent,
      value,
      updatedAtMs,
    });
  }

  private async commitEntityWrite<T extends Json>(input: {
    readonly tx: PortableStateTransaction;
    readonly envelope: OrganizationEnvelope;
    readonly basis: ReadBasis<T>;
    readonly currentPromise: Promise<{ readonly versions: readonly Version<T>[]; readonly localRevision: number; readonly deleted?: Stamp } | null>;
    readonly persist: (versions: readonly Version<T>[], nextStamp: Stamp) => Promise<void>;
    readonly toState: (versions: readonly Version<T>[]) => PortableEntityState;
    readonly onUnchanged: () => Promise<PortableEntityState>;
    readonly intent: PortableWriteIntent;
    readonly value: T;
    readonly updatedAtMs: number;
  }): Promise<WriteOutcome> {
    const current = await input.currentPromise;
    const currentVersions = current?.versions ?? [];
    const currentRevision = current?.localRevision ?? 0;
    const receivedMaximum = maximumReceivedCounter({
      versions: currentVersions as readonly Version<Json>[],
      registerStamps: [],
      tombstones: current?.deleted ? [current.deleted] : [],
    });
    let nextStamp: Stamp;
    let prepared;
    try {
      nextStamp = {
        deviceId: input.envelope.deviceId,
        counter: nextLocalCounter(input.envelope.counter, receivedMaximum),
      };
      prepared = prepareObservedWrite({
        entity: input.basis.entity,
        current: currentVersions,
        localRevision: currentRevision,
        basis: input.basis,
        intent: input.intent,
        nextStamp,
        value: input.value,
        updatedAtMs: input.updatedAtMs,
      });
    } catch (error) {
      throw mapCoreError(error);
    }
    if (prepared.kind === "unchanged") {
      return {
        status: "unchanged",
        entity: input.basis.entity,
        state: await input.onUnchanged(),
        nextBasis: null,
      };
    }
    await input.persist(prepared.versions, nextStamp);
    await input.tx.putEnvelope({
      deviceId: input.envelope.deviceId,
      counter: nextStamp.counter,
      state: input.envelope.state,
    });
    return {
      status: "written",
      entity: input.basis.entity,
      state: input.toState(prepared.versions),
      nextBasis: prepared.nextBasis,
    };
  }

  async createAnnotation(input: {
    readonly bookHash: string;
    readonly kind: "bookmark" | "note";
    readonly id: string;
    readonly value: unknown;
    readonly updatedAtMs: number;
  }): Promise<PortableWriteResult> {
    const bookHash = validateBookHash(input?.bookHash);
    if (input.kind !== "bookmark" && input.kind !== "note") {
      throw new PortableStateError("invalid-data", "unknown annotation kind");
    }
    if (typeof input.id !== "string" || input.id.length === 0) {
      throw new PortableStateError("invalid-data", "annotation id must be non-empty");
    }
    if (!validCanonicalUuid(input.id)) {
      throw new PortableStateError("invalid-data", "new annotation id must be a canonical lowercase UUID");
    }
    let value: BookmarkValue | NoteValue;
    try {
      value = input.kind === "bookmark" ? parseBookmarkValue(input.value) : parseNoteValue(input.value);
    } catch (error) {
      throw mapCoreError(error);
    }
    const updatedAtMs = safeUpdatedAt(input.updatedAtMs);
    const entity: EntityRef = { bookHash, kind: input.kind, id: input.id };

    const written = await this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      const metadata = await tx.getMetadata(bookHash);
      if (!metadata) throw new PortableStateError("invalid-entity", "portable book does not exist");
      const existing = input.kind === "bookmark"
        ? await tx.getBookmarkAnnotation(bookHash, input.id)
        : await tx.getNoteAnnotation(bookHash, input.id);
      if (existing?.deleted) throw new PortableStateError("deleted-entity", "annotation id is permanently deleted");
      if (existing) throw new PortableStateError("invalid-entity", "annotation id already exists");

      let nextStamp: Stamp;
      let versions: readonly Version<Json>[];
      try {
        nextStamp = {
          deviceId: envelope.deviceId,
          counter: nextLocalCounter(envelope.counter, 0),
        };
        versions = writeObserved([], [], nextStamp, value as Json, updatedAtMs);
      } catch (error) {
        throw mapCoreError(error);
      }
      if (input.kind === "bookmark") {
        await tx.putBookmarkAnnotation({
          hash: bookHash,
          kind: "bookmark",
          id: input.id,
          versions: versions as readonly Version<BookmarkValue>[],
          localRevision: nextStamp.counter,
        });
      } else {
        await tx.putNoteAnnotation({
          hash: bookHash,
          kind: "note",
          id: input.id,
          versions: versions as readonly Version<NoteValue>[],
          localRevision: nextStamp.counter,
        });
      }
      await tx.putEnvelope({ deviceId: envelope.deviceId, counter: nextStamp.counter, state: envelope.state });
      const basis = captureReadBasis({
        entity,
        current: versions,
        localRevision: nextStamp.counter,
        selection: { kind: "chosen", stamp: nextStamp },
      });
      return { basis };
    }));

    const nextBasisId = newOpaqueId();
    this.bases.set(nextBasisId, { bookHash, basis: written.basis as AnyReadBasis });
    return {
      status: "written",
      entity,
      state: input.kind === "bookmark" ? { versions: written.basis.observed as readonly Version<BookmarkValue>[] } : { versions: written.basis.observed as readonly Version<NoteValue>[] },
      nextBasisId,
    };
  }

  async deleteAnnotation(input: { readonly entity: EntityRef }): Promise<PortableDeleteResult> {
    const entity = validateEntityRef(input?.entity);
    validateAnnotationEntity(entity);

    const deleted = await this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      const metadata = await tx.getMetadata(entity.bookHash);
      if (!metadata) throw new PortableStateError("invalid-entity", "portable book does not exist");
      const row = entity.kind === "bookmark"
        ? await tx.getBookmarkAnnotation(entity.bookHash, entity.id)
        : await tx.getNoteAnnotation(entity.bookHash, entity.id);
      if (!row) throw new PortableStateError("invalid-entity", "annotation does not exist");
      if (row.deleted) {
        return {
          status: "unchanged" as const,
          entity,
          state: { versions: [], deleted: row.deleted } as PortableBookmarkEntityState | PortableNoteEntityState,
        };
      }
      let nextStamp: Stamp;
      try {
        nextStamp = {
          deviceId: envelope.deviceId,
          counter: nextLocalCounter(
            envelope.counter,
            maximumReceivedCounter({ versions: row.versions as readonly Version<Json>[], registerStamps: [], tombstones: [] }),
          ),
        };
      } catch (error) {
        throw mapCoreError(error);
      }
      const nextAnnotation = { versions: [], deleted: nextStamp } as const;
      if (entity.kind === "bookmark") {
        await tx.putBookmarkAnnotation({
          hash: entity.bookHash,
          kind: "bookmark",
          id: entity.id,
          versions: [],
          deleted: nextStamp,
          localRevision: nextStamp.counter,
        });
      } else {
        await tx.putNoteAnnotation({
          hash: entity.bookHash,
          kind: "note",
          id: entity.id,
          versions: [],
          deleted: nextStamp,
          localRevision: nextStamp.counter,
        });
      }
      await tx.putEnvelope({ deviceId: envelope.deviceId, counter: nextStamp.counter, state: envelope.state });
      return { status: "deleted" as const, entity, state: nextAnnotation as PortableBookmarkEntityState | PortableNoteEntityState };
    }));

    return deleted;
  }

  async release(input: {
    readonly basisId?: string;
    readonly readId?: string;
    readonly bookHash?: string;
  }): Promise<null> {
    const values = [input?.basisId, input?.readId, input?.bookHash].filter((value) => value !== undefined);
    if (values.length !== 1) {
      throw new PortableStateError("invalid-data", "release requires exactly one of basisId, readId or bookHash");
    }
    if (input.basisId !== undefined) {
      if (typeof input.basisId !== "string" || input.basisId.length === 0) {
        throw new PortableStateError("invalid-data", "basisId must be a non-empty string");
      }
      this.bases.delete(input.basisId);
      return null;
    }
    if (input.readId !== undefined) {
      if (typeof input.readId !== "string" || input.readId.length === 0) {
        throw new PortableStateError("invalid-data", "readId must be a non-empty string");
      }
      this.reads.delete(input.readId);
      return null;
    }
    const bookHash = validateBookHash(input.bookHash);
    for (const [id, snapshot] of this.reads) {
      if (snapshot.bookHash === bookHash) this.reads.delete(id);
    }
    for (const [id, record] of this.bases) {
      if (record.bookHash === bookHash) this.bases.delete(id);
    }
    return null;
  }

  /** Current organization state from the same envelope used by portable data. */
  async getOrganization(): Promise<LibraryOrganization> {
    return this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      return envelope.state;
    }));
  }

  /** Apply one explicit organization command inside the portable transaction boundary. */
  async applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    return this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      const knownHashes = new Set((await tx.listMetadata()).map((row) => row.hash));
      const next = applyCommand(envelope, command, knownHashes);
      await tx.putEnvelope(next);
      return next.state;
    }));
  }

  /** Merge an incoming organization state without replacing the local device identity. */
  async mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization> {
    const validated = validateOrganization(incoming);
    return this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      const next = mergeIntoEnvelope(envelope, validated);
      await tx.putEnvelope(next);
      return next.state;
    }));
  }

  /**
   * Atomically reserve a contiguous counter range for one migration batch.
   * The returned stamp is the first reserved counter; the envelope is moved to
   * the end of the range so later local writes cannot collide with it.
   */
  async reserveStamps(count: number): Promise<Stamp> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new PortableStateError("invalid-data", "count must be a positive safe integer");
    }
    return this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      const local = await this.loadLocalState(tx, envelope);
      const start = nextLocalCounter(envelope.counter, maximumPortableStateReceivedCounter(local.state));
      const end = start + count - 1;
      if (!Number.isSafeInteger(end) || end < start) {
        throw new PortableStateError("clock-exhausted", "installation counter is exhausted");
      }
      await tx.putEnvelope({ deviceId: envelope.deviceId, counter: end, state: envelope.state });
      return { deviceId: envelope.deviceId, counter: start };
    }));
  }

  /** Full validated state snapshot, used by shelf projection and integration. */
  async snapshot(): Promise<PortableStateV3> {
    const state = await this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.loadEnvelope(tx);
      return (await this.loadLocalState(tx, envelope)).state;
    }));
    const parsed = tryParsePortableStateV3(state);
    if (!parsed.state) {
      throw new PortableStateError("storage-error", parsed.errors[0]?.message ?? "stored portable state is invalid");
    }
    return parsed.state;
  }

  /** Shelf projection used by the integration layer after it reads the snapshot. */
  async projectShelf(localEntries: readonly ShelfEntry[] = []): Promise<import("./projection").PortableShelfEntry[]> {
    const { projectShelfEntriesFromState } = await import("./projection");
    return projectShelfEntriesFromState(await this.snapshot(), localEntries);
  }

  /**
   * Import/merge one already-validated v3 state. Raw incoming events are
   * scanned before any causal/tombstone filtering; local revisions and the
   * installation device id are kept local.
   */
  async mergeValidatedState(
    input: unknown,
    options: { readonly applyPreferences?: boolean; readonly migrationMark?: string } = {},
  ): Promise<PortableStateV3> {
    let incoming: PortableStateV3;
    try {
      incoming = parsePortableStateV3(input);
    } catch (error) {
      throw mapCoreError(error);
    }
    const incomingMaximum = maximumPortableStateReceivedCounter(incoming);
    await this.withStorage(async () => this.storage.transaction(async (tx) => {
      const envelope = await this.requireEnvelope(tx);
      const local = await this.loadLocalState(tx, envelope);
      const localMaximum = Math.max(envelope.counter, maximumPortableStateReceivedCounter(local.state));
      const nextCounter = Math.max(localMaximum, incomingMaximum);
      if (!Number.isSafeInteger(nextCounter) || nextCounter < 0 || nextCounter > Number.MAX_SAFE_INTEGER) {
        throw new PortableStateError("clock-exhausted", "installation counter is exhausted");
      }
      const merged = mergePortableState(local.state, incoming, {
        applyPreferences: options.applyPreferences === true,
      });
      await this.writeStateRows(tx, merged, local.revisions);
      await tx.putEnvelope({ deviceId: envelope.deviceId, counter: nextCounter, state: merged.organization });
      if (options.applyPreferences === true) {
        if (merged.preferences === undefined) await tx.deleteMeta(META_PREFERENCES);
        else await tx.putMeta(META_PREFERENCES, merged.preferences);
      } else if (incoming.preferences !== undefined) {
        const previous = await tx.getMeta(META_PENDING_PREFERENCES);
        const base = isObject(previous) ? previous : {};
        await tx.putMeta(META_PENDING_PREFERENCES, { ...base, ...incoming.preferences });
      }
      if (options.migrationMark !== undefined) {
        await tx.putMeta(META_MIGRATION, options.migrationMark);
      }
    }));
    return this.snapshot();
  }
}

interface WriteOutcome {
  readonly status: "written" | "unchanged";
  readonly entity: EntityRef;
  readonly state: PortableEntityState;
  readonly nextBasis: ReadBasis<Json> | null;
}
