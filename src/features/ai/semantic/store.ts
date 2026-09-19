import type { DocumentChunk } from "../../../core/chunking";
import type { EmbeddingProfile, SemanticManifest } from "./contracts";

export type { EmbeddingProfile, SemanticManifest } from "./contracts";

/** Batch boundaries are part of the recoverable job identity; resuming must
 * split the corpus exactly like the interrupted run did. */
export interface SemanticBatchPolicy {
  maxRows: number;
  maxTokens: number;
  maxBytes: number;
}

export interface SemanticJobState {
  owner: string;
  manifestKey: string;
  corpusDigest: string;
  nextBatch: number;
  stagedRows: number;
  stagedBytes: number;
  complete: boolean;
  manifest: SemanticManifest | null;
  policy: SemanticBatchPolicy | null;
}

export interface SemanticGenerationState {
  generation: number;
  total: number;
  manifestKey: string;
  manifest: SemanticManifest;
  publishedAtMs: number;
}

export interface SemanticSnapshotPage {
  generation: number;
  manifest: SemanticManifest;
  manifestKey: string;
  total: number;
  rows: readonly { ordinal: number; chunk: DocumentChunk; vector: readonly number[] }[];
  done: boolean;
}

/** Bounded page of one pinned generation.  `close` releases the pin. */
export interface SemanticSnapshot {
  readonly generation: number;
  readonly manifest: SemanticManifest;
  readonly total: number;
  /** Yields pages of at most 32 rows; throws on cancellation or corruption. */
  batches(signal: AbortSignal): AsyncIterable<readonly { ordinal: number; chunk: DocumentChunk; vector: readonly number[] }[]>;
  close(): Promise<void>;
}

export type SemanticRequest =
  | { action: "begin"; manifest: SemanticManifest; manifestKey: string; owner: string; corpusDigest: string; policy: SemanticBatchPolicy; force: boolean }
  | { action: "append"; book: string; owner: string; sequence: number; rows: readonly { ordinal: number; chunk: DocumentChunk; vector: readonly number[] }[] }
  | { action: "replay"; book: string; owner: string; sequence: number; chunks: readonly DocumentChunk[] }
  | { action: "heartbeat" | "pause"; book: string; owner: string }
  | { action: "commit"; book: string; owner: string; batches: number; total: number }
  | { action: "clear"; book: string; owner: string }
  | { action: "status"; book: string }
  | { action: "openSnapshot"; book: string }
  | { action: "readSnapshot"; book: string; generation: number; after: number; limit: number }
  | { action: "closeSnapshot"; book: string; generation: number };

export interface SemanticReply {
  schema: number;
  supportedSchema: number;
  componentVersion: number;
  busyTimeoutMs: number;
  job: SemanticJobState | null;
  published: SemanticGenerationState | null;
  generations: readonly SemanticGenerationState[];
  snapshot: SemanticSnapshotPage | null;
}

/** One backend.  Rust and the browser preview implement the same contract so
 * the indexer and query controller are not duplicated per platform. */
export interface SemanticStore {
  request(input: SemanticRequest): Promise<SemanticReply>;
  /** Opens and pins the latest published generation. */
  openSnapshot(book: string): Promise<SemanticSnapshot>;
}

export function emptySemanticReply(): SemanticReply {
  return { schema: 0, supportedSchema: 0, componentVersion: 0, busyTimeoutMs: 0, job: null, published: null, generations: [], snapshot: null };
}

/** FNV-1a over the ordered chunk identities, including each chunk's position.
 * Purpose is to detect a corpus that changed while the manifest stayed the
 * same, so it only has to be stable and cheap on both sides of the boundary. */
export function corpusDigest(chunkIds: Iterable<string>): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let index = 0;
  const mix = (value: number) => {
    hash ^= BigInt(value & 0xffff);
    hash = (hash * prime) & mask;
    hash ^= BigInt((value >>> 16) & 0xffff);
    hash = (hash * prime) & mask;
  };
  for (const id of chunkIds) {
    // The position is part of the identity: reordering the corpus must force a
    // rebuild even when the chunk set is unchanged.
    mix(index++);
    for (let i = 0; i < id.length; i++) mix(id.charCodeAt(i));
  }
  return hash.toString(16).padStart(16, "0").repeat(4);
}

/** Wraps a reply-producing store into the pinned snapshot contract. */
export function createSnapshot(store: SemanticStore, book: string, page: SemanticSnapshotPage, batchRows = 32): SemanticSnapshot {
  let closed = false;
  let cursor = 0;
  const snapshot: SemanticSnapshot = {
    generation: page.generation,
    manifest: page.manifest,
    total: page.total,
    async *batches(signal) {
      // The first page was already fetched by `openSnapshot`, so the pin is
      // live before any row is yielded.
      let current = page;
      for (;;) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("查询已取消");
        if (current.rows.length) yield current.rows;
        cursor = current.rows.length ? current.rows[current.rows.length - 1].ordinal + 1 : cursor;
        if (current.done || cursor >= current.total) return;
        const next = await store.request({ action: "readSnapshot", book, generation: page.generation, after: cursor, limit: batchRows });
        if (!next.snapshot) throw new Error("索引快照读取失败");
        if (next.snapshot.generation !== page.generation || next.snapshot.total !== page.total
          || next.snapshot.manifestKey !== page.manifestKey) throw new Error("索引快照在查询期间发生变化");
        current = next.snapshot;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await store.request({ action: "closeSnapshot", book, generation: page.generation });
    },
  };
  return snapshot;
}

export function defaultBatchPolicy(profile: EmbeddingProfile): SemanticBatchPolicy {
  return { maxRows: 32, maxTokens: Math.max(1, Math.min(profile.maxTokens - 2, profile.maxTokens)), maxBytes: 512 * 1024 };
}
