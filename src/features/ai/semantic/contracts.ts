import type { DocumentChunk } from "../../../core/chunking";
import { sha256Hex } from "./digest";

/** Output-affecting identity. Digests cover actual verified files, not display names. */
export interface EmbeddingProfile {
  modelId: string;
  modelDigest: string;
  tokenizerDigest: string;
  runtimeVersion: string;
  dimensions: number;
  maxTokens: number;
  pooling: "cls" | "mean";
  normalization: "l2";
  queryPrefix: string;
  passagePrefix: string;
}
export interface SemanticManifest {
  componentVersion: 1;
  bookFingerprint: string;
  parserVersion: string;
  normalizerVersion: string;
  chunkerVersion: string;
  profile: EmbeddingProfile;
}
export function profileKey(p: EmbeddingProfile): string {
  if (![p.modelDigest, p.tokenizerDigest].every(v => /^[a-f0-9]{64}$/.test(v))
    || ![p.modelId, p.runtimeVersion].every(v => typeof v === "string" && v.length > 0 && v.length <= 128)
    || !Number.isInteger(p.dimensions) || p.dimensions < 1 || p.dimensions > 4096
    || !Number.isInteger(p.maxTokens) || p.maxTokens < 2 || p.maxTokens > 8192
    || !["cls", "mean"].includes(p.pooling) || p.normalization !== "l2"
    || ![p.queryPrefix, p.passagePrefix].every(v => typeof v === "string" && v.length <= 1024)) {
    throw new Error("无效的真实 Embedding 配置");
  }
  return JSON.stringify([p.modelId, p.modelDigest, p.tokenizerDigest, p.runtimeVersion,
    p.dimensions, p.maxTokens, p.pooling, p.normalization, p.queryPrefix, p.passagePrefix]);
}
/**
 * Stable identity of one index generation.
 *
 * The native store keeps this in `semantic_jobs.manifest_key` and refuses
 * anything that is not a 64-character lowercase hex digest, so the canonical
 * JSON is hashed rather than sent verbatim. `profileKey` still runs first, so an
 * invalid profile keeps failing here instead of being silently hashed.
 */
export function manifestKey(m: SemanticManifest): string {
  if (m.componentVersion !== 1 || !/^[a-f0-9]{64}$/.test(m.bookFingerprint)
    || ![m.parserVersion, m.normalizerVersion, m.chunkerVersion].every(v => typeof v === "string" && v.length > 0 && v.length <= 128)) {
    throw new Error("无效的语义索引身份");
  }
  return sha256Hex(JSON.stringify([m.componentVersion, m.bookFingerprint, m.parserVersion,
    m.normalizerVersion, m.chunkerVersion, profileKey(m.profile)]));
}
export function assertChunk(m: SemanticManifest, c: DocumentChunk): void {
  if (c.bookFingerprint !== m.bookFingerprint || c.parserVersion !== m.parserVersion
    || c.normalizerVersion !== m.normalizerVersion || c.chunkerVersion !== m.chunkerVersion
    || !c.chunkId || !c.normalizedText.trim()) throw new Error("正文块与语义索引身份不一致");
}
/** Native adapter owns tokenizer, model read guard, GPU admission and worker lifetime.
 * embed must reject token overflow (including prefix/special tokens); never silently truncate.
 * close resolves only after native work and resources have actually stopped. */
export interface SemanticSession {
  readonly profile: EmbeddingProfile;
  embed(texts: readonly string[], purpose: "query" | "passage", signal: AbortSignal): Promise<readonly (readonly number[])[]>;
  close(): Promise<void>;
}
export interface SemanticRow { ordinal: number; chunk: DocumentChunk; vector: readonly number[] }
/** Adapter pins one immutable published generation until close. Staging is never visible. */
export interface PublishedSnapshot {
  /** Monotonic published generation number; never a staging identity. */
  readonly generation: number;
  readonly manifest: SemanticManifest;
  readonly total: number;
  batches(signal: AbortSignal): AsyncIterable<readonly SemanticRow[]>;
  close(): Promise<void>;
}
