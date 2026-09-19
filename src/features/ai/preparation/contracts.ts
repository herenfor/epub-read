import { CORPUS_CHUNKER_VERSION, type DocumentChunk } from "../../../core/chunking";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";

/** Injected evidence, not a hardware scan or a vendor-name heuristic. */
export interface HardwareProbeResult {
  source: "mock" | "native";
  backends: readonly { id: string; available: boolean; reason: string | null }[];
  memoryBudgetBytes: number | null;
}
export const MOCK_PROBE: HardwareProbeResult = {
  source: "mock", backends: [{ id: "mock", available: true, reason: null }], memoryBudgetBytes: 16 * 1024 * 1024,
};
export interface IndexManifest {
  componentVersion: 1;
  bookFingerprint: string;
  parserVersion: string;
  normalizerVersion: string;
  chunkerVersion: string;
  modelId: string;
  modelDigest: string;
  providerVersion: string;
  embeddingVersion: string;
  dimensions: number;
  metric: "cosine";
  storageVersion: 1;
  batchSize: 32;
}
export function mockIndexManifest(bookFingerprint: string): IndexManifest {
  if (!/^[a-f0-9]{64}$/.test(bookFingerprint)) throw new Error("需要有效的书籍内容指纹");
  return {
    componentVersion: 1, bookFingerprint, parserVersion: CORPUS_PARSER_VERSION,
    normalizerVersion: CORPUS_NORMALIZER_VERSION, chunkerVersion: CORPUS_CHUNKER_VERSION,
    modelId: "mock-model", modelDigest: "mock-deterministic-v1", providerVersion: "0.1.0",
    embeddingVersion: "mock-char-v1", dimensions: 8, metric: "cosine", storageVersion: 1, batchSize: 32,
  };
}
export interface PreparationStatus {
  storage?: "sqlite" | "indexeddb";
  nextBatch: number;
  stagedChunks: number;
  publishedChunks: number;
  complete: boolean;
  sqliteVersion: string;
  databaseSchema: number;
  supportedDatabaseSchema: number;
  componentVersion: number;
  busyTimeoutMs: number;
}
export interface VectorRow { chunk: DocumentChunk; vector: readonly number[] }
export type PreparationRequest =
  | { action: "begin"; manifest: IndexManifest; owner: string; force: boolean }
  | { action: "append"; book: string; owner: string; sequence: number; rows: readonly VectorRow[] }
  | { action: "replay"; book: string; owner: string; sequence: number; chunks: readonly DocumentChunk[] }
  | { action: "heartbeat" | "pause" | "clear"; book: string; owner: string }
  | { action: "commit"; book: string; owner: string; batches: number; total: number }
  | { action: "status" | "citations"; book: string };
export interface PreparationReply { status: PreparationStatus; citations: DocumentChunk[] }
export interface PreparationStore { request(input: PreparationRequest): Promise<PreparationReply> }
