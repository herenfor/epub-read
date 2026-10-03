/**
 * In-memory, fully transactional storage used by direct repository tests.
 * It follows the same rollback contract as IndexedDB so service semantics can
 * be exercised without a browser global.
 */
import type { OrganizationEnvelope } from "../libraryOrganization";
import type {
  AnnotationRow,
  BookmarkAnnotationRow,
  NoteAnnotationRow,
  PortableMetadataRow,
  PortableProgressRow,
  PortableStateStorage,
  PortableStateTransaction,
} from "./storage";

interface MemoryState {
  envelope: OrganizationEnvelope | null;
  metadata: Map<string, PortableMetadataRow>;
  progress: Map<string, PortableProgressRow>;
  annotations: Map<string, AnnotationRow>;
  meta: Map<string, unknown>;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyState(): MemoryState {
  return {
    envelope: null,
    metadata: new Map(),
    progress: new Map(),
    annotations: new Map(),
    meta: new Map(),
  };
}

function annotationKey(hash: string, kind: "bookmark" | "note", id: string): string {
  return `${hash}\u0000${kind}\u0000${id}`;
}

class MemoryTransaction implements PortableStateTransaction {
  constructor(private readonly state: MemoryState) {}

  async getEnvelope(): Promise<OrganizationEnvelope | null> {
    return this.state.envelope ? clone(this.state.envelope) : null;
  }

  async putEnvelope(envelope: OrganizationEnvelope): Promise<void> {
    this.state.envelope = clone(envelope);
  }

  async getMetadata(hash: string): Promise<PortableMetadataRow | null> {
    const row = this.state.metadata.get(hash);
    return row ? clone(row) : null;
  }

  async putMetadata(row: PortableMetadataRow): Promise<void> {
    this.state.metadata.set(row.hash, clone(row));
  }

  async listMetadata(): Promise<readonly PortableMetadataRow[]> {
    return [...this.state.metadata.values()].map(clone);
  }

  async getProgress(hash: string): Promise<PortableProgressRow | null> {
    const row = this.state.progress.get(hash);
    return row ? clone(row) : null;
  }

  async putProgress(row: PortableProgressRow): Promise<void> {
    this.state.progress.set(row.hash, clone(row));
  }

  async listProgress(): Promise<readonly PortableProgressRow[]> {
    return [...this.state.progress.values()].map(clone);
  }

  async getBookmarkAnnotation(hash: string, id: string): Promise<BookmarkAnnotationRow | null> {
    const row = this.state.annotations.get(annotationKey(hash, "bookmark", id));
    return row && row.kind === "bookmark" ? clone(row) : null;
  }

  async getNoteAnnotation(hash: string, id: string): Promise<NoteAnnotationRow | null> {
    const row = this.state.annotations.get(annotationKey(hash, "note", id));
    return row && row.kind === "note" ? clone(row) : null;
  }

  async putBookmarkAnnotation(row: BookmarkAnnotationRow): Promise<void> {
    this.state.annotations.set(annotationKey(row.hash, row.kind, row.id), clone(row));
  }

  async putNoteAnnotation(row: NoteAnnotationRow): Promise<void> {
    this.state.annotations.set(annotationKey(row.hash, row.kind, row.id), clone(row));
  }

  async listAnnotations(hash?: string): Promise<readonly AnnotationRow[]> {
    return [...this.state.annotations.values()]
      .filter((row) => hash === undefined || row.hash === hash)
      .map(clone);
  }

  async getMeta(key: string): Promise<unknown> {
    const value = this.state.meta.get(key);
    return value === undefined ? undefined : clone(value);
  }

  async putMeta(key: string, value: unknown): Promise<void> {
    this.state.meta.set(key, clone(value));
  }

  async deleteMeta(key: string): Promise<void> {
    this.state.meta.delete(key);
  }
}

export class MemoryPortableStateStorage implements PortableStateStorage {
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();

  async transaction<T>(work: (transaction: PortableStateTransaction) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const draft = clone(this.state);
      const result = await work(new MemoryTransaction(draft));
      this.state = draft;
      return result;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Test convenience only: replace the whole backend state. */
  seed(state: Partial<{
    envelope: OrganizationEnvelope | null;
    metadata: PortableMetadataRow[];
    progress: PortableProgressRow[];
    annotations: AnnotationRow[];
    meta: Record<string, unknown>;
  }>): void {
    this.state = emptyState();
    if (state.envelope) this.state.envelope = clone(state.envelope);
    for (const row of state.metadata ?? []) this.state.metadata.set(row.hash, clone(row));
    for (const row of state.progress ?? []) this.state.progress.set(row.hash, clone(row));
    for (const row of state.annotations ?? []) this.state.annotations.set(annotationKey(row.hash, row.kind, row.id), clone(row));
    for (const [key, value] of Object.entries(state.meta ?? {})) this.state.meta.set(key, clone(value));
  }
}
