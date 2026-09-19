import type { SemanticSession } from "./contracts";

/** Fixed dimensions for the preview identity, matching a small Chinese
 * sentence-embedding model so the UI exercises the real code paths. */
export const PREVIEW_PROFILE = {
  modelId: "preview-test-vectors",
  modelDigest: "0".repeat(64),
  tokenizerDigest: "1".repeat(64),
  runtimeVersion: "preview-indexeddb-1",
  dimensions: 256,
  maxTokens: 512,
  pooling: "cls" as const,
  normalization: "l2" as const,
  queryPrefix: "",
  passagePrefix: "",
};

/** Deterministic character-trigram hashing.  This is a *preview* vector: it
 * proves the storage, resume, ranking and citation path works in a browser, and
 * is never presented as a real model result. */
export function previewVector(text: string, dimensions = PREVIEW_PROFILE.dimensions): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const points = Array.from(text);
  for (let i = 0; i < points.length; i++) {
    const trigram = `${points[i]}${points[i + 1] ?? ""}${points[i + 2] ?? ""}`;
    let hash = 2166136261;
    for (const point of trigram) {
      hash ^= point.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    vector[hash % dimensions] += i % 2 === 0 ? 1 : -1;
  }
  let scale = 0;
  for (const value of vector) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) vector[0] = 1;
  else for (let i = 0; i < dimensions; i++) vector[i] /= scale;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export interface PreviewSessionOptions {
  /** Injected failure points so the UI can demonstrate error handling. */
  failAfter?: number;
  batchDelayMs?: number;
  /** Deterministic hook for tests that need to interrupt mid-batch. */
  onBeforeEmbed?(): void;
}

/** Browser preview session.  It reports `preview` in its identity and is only
 * available in AI Web debug builds. */
export function createPreviewSession(options: PreviewSessionOptions = {}): SemanticSession {
  let calls = 0;
  return {
    profile: { ...PREVIEW_PROFILE },
    async embed(texts, purpose, signal) {
      if (signal.aborted) throw abortError();
      options.onBeforeEmbed?.();
      if (signal.aborted) throw abortError();
      void purpose;
      if (options.failAfter !== undefined && calls++ >= options.failAfter) {
        throw new Error("预览向量在注入的故障点停止");
      }
      if (options.batchDelayMs) await new Promise((resolve) => setTimeout(resolve, options.batchDelayMs));
      if (signal.aborted) throw abortError();
      const prefix = purpose === "query" ? PREVIEW_PROFILE.queryPrefix : PREVIEW_PROFILE.passagePrefix;
      return texts.map((text) => previewVector(`${prefix}${text}`));
    },
    async close() {},
  };
}

/** Reports token counts the way the native tokenizer would, for batch planning. */
export function previewTokenCount(text: string): number {
  return Math.max(1, Array.from(text).length);
}

function abortError(): Error {
  const error = new Error("查询已取消");
  (error as { code?: string }).code = "aborted";
  return error;
}
