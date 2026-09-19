import type { DocumentChunk } from "../../../core/chunking";
import { throwIfAborted } from "../contracts/provider";
import { embedBatch } from "./pipeline";
import { manifestKey, type SemanticManifest, type SemanticSession } from "./contracts";
import { corpusDigest, type SemanticBatchPolicy, type SemanticJobState, type SemanticStore } from "./store";

export interface SemanticIndexOptions {
  store: SemanticStore;
  session: SemanticSession;
  policy: SemanticBatchPolicy;
  /** Every chunk of one book, in corpus order. May be re-read for recovery.
   * The session is passed because chunk sizing is derived from the model's
   * token budget, not from a fixed lexical constant. */
  chunks(session: SemanticSession, signal: AbortSignal): AsyncIterable<readonly DocumentChunk[]>;
  owner?: string;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?(status: SemanticIndexProgress): void;
  /** Lets the reader keep priority between batches. */
  yieldToReader?(): Promise<void>;
}

export interface SemanticIndexProgress {
  nextBatch: number;
  stagedRows: number;
  totalRows: number;
  completedRows: number;
  complete: boolean;
  generation: number | null;
  recovered: boolean;
}

export interface SemanticIndexResult {
  status: SemanticIndexProgress;
  /** True when the run stopped at a checkpoint and can be resumed. */
  interrupted: boolean;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === "aborted";
}

function isTokenOverflow(error: unknown): boolean {
  return error instanceof Error && /token 上限|超过模型/.test(error.message);
}

/** Builds the manifest for one book from the session identity and its corpus. */
export function manifestFor(session: SemanticSession, first: DocumentChunk): SemanticManifest {
  return {
    componentVersion: 1,
    bookFingerprint: first.bookFingerprint,
    parserVersion: first.parserVersion,
    normalizerVersion: first.normalizerVersion,
    chunkerVersion: first.chunkerVersion,
    profile: session.profile,
  };
}

/** Streams one book into the store, committing only after full validation.
 * Cancellation leaves a resumable checkpoint; identity changes force a rebuild. */
export async function runSemanticIndex(options: SemanticIndexOptions): Promise<SemanticIndexResult> {
  const { store, session, policy } = options;
  const owner = options.owner ?? crypto.randomUUID();
  const controller = new AbortController();
  const forward = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forward();
  else options.signal?.addEventListener("abort", forward, { once: true });
  const signal = controller.signal;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let beating: Promise<unknown> | undefined;
  // The manifest needs one chunk; every later pass re-reads the same corpus.
  const probe = await firstChunk(options, session, signal);
  const manifest = manifestFor(session, probe);
  const key = manifestKey(manifest);
  const book = manifest.bookFingerprint;
  let sequence = 0;
  let staged = 0;
  let checkpoint = 0;
  let recovered = false;
  let live = false;
  try {
    throwIfAborted(signal);
    const digest = await digestCorpus(options, session, signal);
    throwIfAborted(signal);
    const begun = await store.request({
      action: "begin", manifest, manifestKey: key, owner,
      corpusDigest: digest.digest, policy, force: options.force ?? false,
    });
    // `begin` refuses a different corpus against an unfinished checkpoint, so a
    // resumed job here always belongs to the same corpus, profile and policy.
    if (begun.job) verifyJob(begun.job, key, digest.digest, policy);
    live = true;
    if (begun.job?.complete && !options.force) {
      if (!begun.published || begun.published.manifestKey !== key || begun.published.total !== digest.count) {
        throw new Error("语义索引完成状态与发布数据不一致，请重建索引");
      }
      return {
        status: result(begun.job.nextBatch, begun.job.stagedRows, digest.count,
          begun.published?.total ?? 0, begun.published?.generation ?? null, true, false),
        interrupted: false,
      };
    }
    checkpoint = begun.job?.nextBatch ?? 0;
    staged = begun.job?.stagedRows ?? 0;
    heartbeat = setInterval(() => {
      if (beating) return;
      beating = store.request({ action: "heartbeat", book, owner })
        .catch((error) => {
          controller.abort(error);
        }).finally(() => { beating = undefined; });
    }, 5000);
    let pending: DocumentChunk[] = [];
    const flush = async (): Promise<void> => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      await options.yieldToReader?.();
      throwIfAborted(signal);
      if (sequence < checkpoint) {
        // Recovery replays the stored boundary instead of re-embedding it.
        await store.request({ action: "replay", book, owner, sequence, chunks: batch });
        recovered = true;
        sequence++;
        return;
      }
      const rows = await embedWithSplit(manifest, session, batch, staged, signal);
      await store.request({ action: "append", book, owner, sequence, rows });
      sequence++;
      staged = rows[rows.length - 1].ordinal + 1;
    };
    for await (const group of options.chunks(session, signal)) {
      for (const chunk of group) {
        throwIfAborted(signal);
        if (chunk.bookFingerprint !== book) throw new Error("正文块与索引书籍不一致");
        pending.push(chunk);
        if (pending.length >= policy.maxRows) await flush();
      }
      options.onProgress?.(result(sequence, staged, digest.count, 0, null, false, recovered));
    }
    await flush();
    throwIfAborted(signal);
    if (staged !== digest.count) throw new Error("语义索引段落数不完整，未发布");
    const committed = await store.request({ action: "commit", book, owner, batches: sequence, total: staged });
    live = false;
    const total = committed.published?.total ?? staged;
    return {
      status: result(sequence, staged, digest.count, total, committed.published?.generation ?? null, true, recovered),
      interrupted: false,
    };
  } catch (error) {
    const cancelled = isAbort(error);
    if (live) await store.request({ action: "pause", book, owner }).catch(() => {});
    live = false;
    if (!cancelled) throw error;
    const status = await store.request({ action: "status", book }).catch(() => null);
    return {
      status: result(status?.job?.nextBatch ?? sequence, status?.job?.stagedRows ?? staged, 0,
        status?.published?.total ?? 0, status?.published?.generation ?? null, false, true),
      interrupted: true,
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await beating?.catch(() => {});
    options.signal?.removeEventListener("abort", forward);
  }
}

async function firstChunk(options: SemanticIndexOptions, session: SemanticSession, signal: AbortSignal): Promise<DocumentChunk> {
  for await (const group of options.chunks(session, signal)) {
    if (group.length) return group[0];
  }
  throw new Error("没有可索引的正文块");
}

/** Embeds a batch, halving it when the tokenizer reports overflow. A single
 * chunk that still overflows is an explicit refusal, never a silent truncation. */
async function embedWithSplit(
  manifest: SemanticManifest,
  session: SemanticSession,
  batch: readonly DocumentChunk[],
  startOrdinal: number,
  signal: AbortSignal,
): ReturnType<typeof embedBatch> {
  try {
    return await embedBatch(manifest, session, batch, startOrdinal, signal);
  } catch (error) {
    if (!isTokenOverflow(error) || batch.length <= 1) throw error;
    const middle = Math.floor(batch.length / 2);
    const left = await embedWithSplit(manifest, session, batch.slice(0, middle), startOrdinal, signal);
    const right = await embedWithSplit(manifest, session, batch.slice(middle), startOrdinal + left.length, signal);
    return [...left, ...right];
  }
}

async function digestCorpus(options: SemanticIndexOptions, session: SemanticSession, signal: AbortSignal) {
  const ids: string[] = [];
  for await (const group of options.chunks(session, signal)) {
    for (const chunk of group) ids.push(chunk.chunkId);
  }
  return { digest: corpusDigest(ids), count: ids.length };
}

function verifyJob(job: SemanticJobState, key: string, digest: string, policy: SemanticBatchPolicy): void {
  if (job.manifestKey !== key) throw new Error("恢复的任务与当前模型身份不一致，请清理后重建");
  if (job.corpusDigest !== digest) throw new Error("正文语料已变化，需要重建语义索引");
  if (job.policy && (job.policy.maxRows !== policy.maxRows || job.policy.maxTokens !== policy.maxTokens || job.policy.maxBytes !== policy.maxBytes)) {
    throw new Error("批处理规则与恢复点不一致，请清理后重建");
  }
}

function result(nextBatch: number, stagedRows: number, totalRows: number, publishedRows: number, generation: number | null, complete: boolean, recovered: boolean): SemanticIndexProgress {
  return { nextBatch, stagedRows, totalRows, completedRows: publishedRows, complete, generation, recovered };
}
