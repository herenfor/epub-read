import { invoke } from "@tauri-apps/api/core";
import type { DocumentChunk } from "../../../core/chunking";
import { normalizeCorpusText, type CorpusContentType, type TextAnchor } from "../../../core/corpus";

export interface IndexedBookMetadata {
  contentHash: string;
  title: string;
  creator: string;
  language?: string;
}

/** Legacy shelf records use an empty string for an unknown OPF language. */
export function normalizeIndexedBookMetadata(metadata: IndexedBookMetadata): IndexedBookMetadata {
  const language = metadata.language?.trim();
  return {
    contentHash: metadata.contentHash,
    title: metadata.title,
    creator: metadata.creator,
    ...(language ? { language } : {}),
  };
}

export interface CrossBookSearchInput {
  query: string;
  limit?: number;
  contentHash?: string;
  contentType?: CorpusContentType | "mixed";
  title?: string;
  creator?: string;
  chapterPath?: string;
  parserVersion?: string;
  normalizerVersion?: string;
  chunkerVersion?: string;
}

export interface CrossBookSearchHit {
  contentHash: string;
  title: string;
  creator: string;
  language?: string;
  chunkId: string;
  spineIndex: number;
  chapterPath: string;
  chapterTitle?: string;
  contentType: CorpusContentType | "mixed";
  originalText: string;
  normalizedText: string;
  anchorJson: string;
}

export interface ResolvedCrossBookSearchHit extends Omit<CrossBookSearchHit, "anchorJson"> {
  textAnchor: TextAnchor;
}

export interface IndexedBookStatus {
  contentHash: string;
  parserVersion: string;
  normalizerVersion: string;
  chunkerVersion: string;
  chunkCount: number;
  updatedAt: number;
}

/** JSON-safe chunk payload shared by the current replace command and future staging commands. */
export interface NativeIndexChunk {
  chunkId: string;
  spineIndex: number;
  chapterPath: string;
  chapterTitle?: string;
  contentType: string;
  originalText: string;
  normalizedText: string;
  anchorJson: string;
}

/** Metadata sent once when a Rust staging transaction is opened. */
export interface IndexStagingBeginInput extends IndexedBookMetadata {
  parserVersion: string;
  normalizerVersion: string;
  chunkerVersion: string;
  expectedChunks?: number;
}

/** One ordered, bounded append payload for a staging transaction. */
export interface IndexStagingBatch {
  /** Starts at zero and increases by one for every append. */
  sequence: number;
  chunks: NativeIndexChunk[];
}

/**
 * Storage boundary for a cancellable, incrementally written index.
 *
 * The opaque id maps directly to a future Rust staging handle. Implementations
 * must make commit atomic and make abort/reclaim safe to call once after any
 * failed begin/append/commit operation that returned a handle.
 */
export interface IndexStagingStorePort {
  begin(input: IndexStagingBeginInput): Promise<string>;
  append(stagingId: string, batch: IndexStagingBatch): Promise<void>;
  commit(stagingId: string): Promise<number>;
  abort(stagingId: string, reason?: string): Promise<void>;
}

export function makeNativeIndexChunk(chunk: DocumentChunk): NativeIndexChunk {
  return {
    chunkId: chunk.chunkId,
    spineIndex: chunk.spineIndex,
    chapterPath: chunk.chapterPath,
    chapterTitle: chunk.chapterTitle || undefined,
    contentType: chunk.contentType,
    originalText: chunk.originalText,
    normalizedText: chunk.normalizedText,
    anchorJson: JSON.stringify(chunk.textAnchor),
  };
}

interface NativeIndexBookInput extends IndexedBookMetadata {
  parserVersion: string;
  normalizerVersion: string;
  chunkerVersion: string;
  chunks: NativeIndexChunk[];
}

function requireConsistentVersion(chunks: readonly DocumentChunk[], field: "parserVersion" | "normalizerVersion" | "chunkerVersion"): string {
  const version = chunks[0]?.[field];
  if (!version || chunks.some((chunk) => chunk[field] !== version)) {
    throw new Error(`索引正文块的 ${field} 不一致`);
  }
  return version;
}

export function makeNativeIndexInput(
  metadata: IndexedBookMetadata,
  chunks: readonly DocumentChunk[],
): NativeIndexBookInput {
  if (chunks.length === 0) throw new Error("不能为没有正文块的书籍建立索引");
  if (chunks.some((chunk) => chunk.bookFingerprint !== metadata.contentHash)) {
    throw new Error("索引正文块与书籍内容指纹不一致");
  }
  return {
    ...normalizeIndexedBookMetadata(metadata),
    parserVersion: requireConsistentVersion(chunks, "parserVersion"),
    normalizerVersion: requireConsistentVersion(chunks, "normalizerVersion"),
    chunkerVersion: requireConsistentVersion(chunks, "chunkerVersion"),
    chunks: chunks.map(makeNativeIndexChunk),
  };
}

/**
 * Bridge factory for the future Rust staging commands. It is intentionally
 * not used by the current UI until those commands are registered by Rust.
 */
export function createTauriIndexStagingStore(): IndexStagingStorePort {
  return {
    begin: (input) => invoke<string>("ai_index_begin", { input }),
    append: (stagingId, batch) => invoke<void>("ai_index_append", {
      input: { stagingId, chunks: batch.chunks },
    }),
    commit: (stagingId) => invoke<number>("ai_index_commit", { stagingId }),
    abort: (stagingId) => invoke<void>("ai_index_abort", { stagingId }),
  };
}

export async function replaceBookTextIndex(
  metadata: IndexedBookMetadata,
  chunks: readonly DocumentChunk[],
): Promise<number> {
  return invoke<number>("ai_index_replace", { input: makeNativeIndexInput(metadata, chunks) });
}

export async function searchBookTextIndex(input: CrossBookSearchInput): Promise<ResolvedCrossBookSearchHit[]> {
  const normalizedInput = { ...input, query: normalizeCorpusText(input.query) };
  const hits = await invoke<CrossBookSearchHit[]>("ai_search", { input: normalizedInput });
  return hits.map(({ anchorJson, ...hit }) => {
    const textAnchor = parseTextAnchor(anchorJson);
    return { ...hit, textAnchor };
  });
}

export async function listIndexedBooks(): Promise<IndexedBookStatus[]> {
  return invoke<IndexedBookStatus[]>("ai_index_status");
}

export async function clearAllTextIndexes(): Promise<void> {
  await invoke<void>("ai_index_clear_all");
}

function parseTextAnchor(json: string): TextAnchor {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object") throw new Error("全文索引包含无效文本锚点");
  const candidate = value as Record<string, unknown>;
  const { start, end, snippet } = candidate;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number)) {
    throw new Error("全文索引包含无效文本锚点范围");
  }
  if (typeof snippet !== "string" || Array.from(snippet).length > 32 || /\p{White_Space}/u.test(snippet)) {
    throw new Error("全文索引包含无效文本锚点片段");
  }
  return { start: start as number, end: end as number, snippet };
}
