import type { DocumentChunk } from "../../../core/chunking";
import { throwIfAborted, type EmbeddingProvider } from "../contracts/provider";
import { type IndexManifest, type PreparationStatus, type PreparationStore } from "./contracts";
import { withMockEmbedding } from "./embeddingSession";
import { ResourceGovernor } from "./resourceGovernor";

export interface MockIndexOptions {
  manifest: IndexManifest;
  store: PreparationStore;
  governor: ResourceGovernor;
  chunks(signal: AbortSignal): AsyncIterable<readonly DocumentChunk[]>;
  signal?: AbortSignal;
  force?: boolean;
  createProvider?: () => EmbeddingProvider;
  onProgress?(status: PreparationStatus): void;
  yieldToReader?(): Promise<void>;
}
/** Explicit action only. Cancellation preserves a resumable checkpoint; clear is a separate operation. */
export async function runMockIndex(options: MockIndexOptions): Promise<PreparationStatus> {
  const owner = crypto.randomUUID();
  const book = options.manifest.bookFingerprint;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const signal = controller.signal;
  let acquired = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let beating: Promise<unknown> | undefined;
  try {
    throwIfAborted(signal);
    const begun = await options.store.request({ action: "begin", manifest: options.manifest, owner, force: options.force ?? false });
    if (begun.status.complete) { throwIfAborted(signal); return begun.status; }
    acquired = true;
    const checkpoint = begun.status.nextBatch;
    heartbeat = setInterval(() => {
      if (beating) return;
      beating = options.store.request({ action: "heartbeat", book, owner })
        .catch((error) => controller.abort(error)).finally(() => { beating = undefined; });
    }, 5000);
    const result = await withMockEmbedding(options.governor, signal, async (embed) => {
      let pending: DocumentChunk[] = [];
      let sequence = 0;
      let total = 0;
      const append = async () => {
        if (!pending.length) return;
        await options.governor.waitUntilRunnable(signal);
        throwIfAborted(signal);
        for (const chunk of pending) {
          if (chunk.bookFingerprint !== book || chunk.parserVersion !== options.manifest.parserVersion
            || chunk.normalizerVersion !== options.manifest.normalizerVersion || chunk.chunkerVersion !== options.manifest.chunkerVersion) {
            throw new Error("正文块与索引 manifest 不一致");
          }
        }
        let reply;
        if (sequence < checkpoint) {
          reply = await options.store.request({ action: "replay", book, owner, sequence, chunks: pending });
        } else {
          const vectors = await embed(pending.map((c) => c.normalizedText));
          throwIfAborted(signal);
          reply = await options.store.request({ action: "append", book, owner, sequence, rows: pending.map((chunk, i) => ({ chunk, vector: vectors[i] })) });
        }
        total += pending.length; sequence++; pending = [];
        throwIfAborted(signal);
        options.onProgress?.(reply.status);
        await options.yieldToReader?.();
      };
      for await (const batch of options.chunks(signal)) {
        throwIfAborted(signal);
        for (const chunk of batch) {
          pending.push(chunk);
          if (pending.length === options.manifest.batchSize) await append();
        }
      }
      await append();
      if (sequence < checkpoint || total === 0) throw new Error("恢复语料缺失或书籍无正文");
      throwIfAborted(signal);
      return (await options.store.request({ action: "commit", book, owner, batches: sequence, total })).status;
    }, options.createProvider);
    return result;
  } finally {
    clearInterval(heartbeat);
    await beating;
    // Pause fences this owner but retains committed staging for explicit resume.
    try { if (acquired) await options.store.request({ action: "pause", book, owner }); }
    finally { options.signal?.removeEventListener("abort", forwardAbort); }
  }
}
