import type { DocumentChunk } from "../../../core/chunking";
import { calculateCorpusConcurrency, LARGE_BOOK_BYTES } from "./corpusConcurrency";
import { createSerialCorpusSink, type CorpusBookMetadata, type CorpusSink, type CorpusSinkTransaction } from "./corpusSink";
import {
  CORPUS_WORKER_PROTOCOL_VERSION,
  type CorpusWorkerFactory,
  type CorpusWorkerLike,
  type CorpusWorkerMessageEvent,
  type CorpusWorkerRequest,
  type CorpusWorkerResponse,
} from "./corpusWorkerProtocol";

const DEFAULT_MAX_CHUNKS_PER_BATCH = 64;
const DEFAULT_MAX_CHARACTERS_PER_BATCH = 128_000;

export interface CorpusWorkerJob {
  jobId: string;
  book: CorpusBookMetadata;
  /** Eager bytes are useful for tests; production can read just before dispatch. */
  bytes?: ArrayBuffer;
  read?: () => Promise<Uint8Array | ArrayBuffer>;
  sizeBytes?: number;
}

export interface CorpusWorkerFailure {
  jobId: string;
  error: string;
}

export interface CorpusWorkerPoolResult {
  completedJobs: number;
  failedJobs: number;
  committedChunks: number;
  failures: CorpusWorkerFailure[];
  cancelled: boolean;
}

export interface CorpusWorkerPoolOptions {
  jobs: readonly CorpusWorkerJob[];
  workerFactory: CorpusWorkerFactory;
  sink: CorpusSink;
  concurrency?: number;
  logicalCores?: number;
  maxChunksPerBatch?: number;
  maxCharactersPerBatch?: number;
  signal?: AbortSignal;
  /** Optional reader-priority gate before a new book starts. */
  waitUntilRunnable?(signal: AbortSignal): void | Promise<void>;
  onJobStarted?(jobId: string): void;
  onJobSettled?(jobId: string, status: "completed" | "failed"): void;
}

export interface CorpusWorkerPool {
  readonly signal: AbortSignal;
  run(): Promise<CorpusWorkerPoolResult>;
  cancel(reason?: string): Promise<void>;
}

export function toTransferableArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength && value.buffer instanceof ArrayBuffer) {
    return value.buffer;
  }
  return value.slice().buffer as ArrayBuffer;
}

interface WorkerSlot {
  worker?: CorpusWorkerLike;
  active?: ActiveJob;
  reservedJob?: CorpusWorkerJob;
}

interface ActiveJob {
  job: CorpusWorkerJob;
  slot: WorkerSlot;
  transaction?: CorpusSinkTransaction;
  sequence: number;
  chain: Promise<void>;
  settled: boolean;
  cancelling: boolean;
  onMessage: (event: CorpusWorkerMessageEvent) => void;
  onError: (event: CorpusWorkerMessageEvent) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function batchCharacters(chunks: readonly DocumentChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + Array.from(chunk.originalText).length + Array.from(chunk.normalizedText).length, 0);
}

function abortError(reason?: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "语料建库已取消");
  error.name = "AbortError";
  return error;
}

/**
 * Schedule independent books onto actual Worker instances. Worker output is
 * consumed through one serial sink, so parallel parsing never parallelizes
 * SQLite writes. A failed Worker only fails its own job and is replaced.
 */
export function createCorpusWorkerPool(options: CorpusWorkerPoolOptions): CorpusWorkerPool {
  const abort = new AbortController();
  let externalAbortListener: (() => void) | undefined;
  const requestedConcurrency = Math.floor(options.concurrency ?? calculateCorpusConcurrency({ logicalCores: options.logicalCores }));
  const concurrency = Math.min(16, Math.max(1, Number.isFinite(requestedConcurrency) ? requestedConcurrency : 1));
  const maxChunks = Math.max(1, Math.floor(options.maxChunksPerBatch ?? DEFAULT_MAX_CHUNKS_PER_BATCH));
  const maxCharacters = Math.max(1, Math.floor(options.maxCharactersPerBatch ?? DEFAULT_MAX_CHARACTERS_PER_BATCH));
  const byteLength = (job: CorpusWorkerJob): number => job.sizeBytes ?? job.bytes?.byteLength ?? 0;
  for (const job of options.jobs) {
    if (!job.bytes && !job.read) throw new Error(`Worker 任务 ${job.jobId} 缺少 EPUB 字节读取器`);
  }
  const pending = [...options.jobs];
  const sink = createSerialCorpusSink(options.sink);
  const slots = Array.from({ length: concurrency }, (): WorkerSlot => ({}));
  const failures: CorpusWorkerFailure[] = [];
  let completedJobs = 0;
  let committedChunks = 0;
  let settledJobs = 0;
  let started = false;
  let runPromise: Promise<CorpusWorkerPoolResult> | undefined;
  let resolveRun!: (result: CorpusWorkerPoolResult) => void;
  let runResult: CorpusWorkerPoolResult | undefined;

  const finishRunIfIdle = (): void => {
    if (!started || settledJobs < options.jobs.length || slots.some((slot) => slot.active || slot.reservedJob)) return;
    runResult ??= {
      completedJobs,
      failedJobs: failures.length,
      committedChunks,
      failures: [...failures],
      cancelled: abort.signal.aborted,
    };
    externalAbortListener?.();
    resolveRun(runResult);
  };

  const terminate = (slot: WorkerSlot): void => {
    const worker = slot.worker;
    slot.worker = undefined;
    if (worker) void worker.terminate();
  };

  const recordFailure = (job: CorpusWorkerJob, error: unknown): void => {
    failures.push({ jobId: job.jobId, error: errorMessage(error) });
    options.onJobSettled?.(job.jobId, "failed");
  };

  const release = (active: ActiveJob, status: "completed" | "failed"): void => {
    if (active.settled) return;
    active.settled = true;
    active.slot.active = undefined;
    active.slot.worker?.removeEventListener("message", active.onMessage);
    active.slot.worker?.removeEventListener("error", active.onError);
    if (status === "completed") {
      completedJobs++;
      options.onJobSettled?.(active.job.jobId, status);
    }
    settledJobs++;
    if (status === "failed") terminate(active.slot);
  };

  const fail = async (active: ActiveJob, error: unknown): Promise<void> => {
    if (active.settled) return;
    try {
      await active.transaction?.abort(errorMessage(error));
    } catch {
      // Keep the worker error; the sink's abort is best-effort cleanup.
    }
    recordFailure(active.job, error);
    release(active, "failed");
    schedule();
    finishRunIfIdle();
  };

  const succeed = async (active: ActiveJob): Promise<void> => {
    if (active.settled) return;
    try {
      if (abort.signal.aborted || active.cancelling) {
        await active.transaction?.abort(errorMessage(abort.signal.reason));
        recordFailure(active.job, abortError(abort.signal.reason));
        release(active, "failed");
      } else {
        committedChunks += await active.transaction?.commit() ?? 0;
        release(active, "completed");
      }
    } catch (error) {
      await fail(active, error);
      return;
    }
    schedule();
    finishRunIfIdle();
  };

  const handleResponse = (active: ActiveJob, response: CorpusWorkerResponse): void => {
    if (active.settled || response.jobId !== active.job.jobId) return;
    if (response.protocol !== CORPUS_WORKER_PROTOCOL_VERSION) {
      const error = new Error("语料 Worker 协议版本不匹配");
      void active.chain.then(() => fail(active, error), () => fail(active, error));
      return;
    }
    if (response.type === "batch") {
      const previous = active.chain;
      active.chain = previous.then(async () => {
        if (response.sequence !== active.sequence) throw new Error("语料 Worker 批次序号不连续");
        if (response.chunks.length > maxChunks || batchCharacters(response.chunks) > maxCharacters) {
          throw new Error("语料 Worker 返回了超出上限的批次");
        }
        // With ACK backpressure this also pauses an active parser at a bounded
        // batch boundary while the reader is loading or measuring.
        await options.waitUntilRunnable?.(abort.signal);
        if (abort.signal.aborted) throw abortError(abort.signal.reason);
        active.sequence++;
        await active.transaction?.append(response.chunks);
        active.slot.worker?.postMessage({
          protocol: CORPUS_WORKER_PROTOCOL_VERSION,
          type: "ack",
          jobId: active.job.jobId,
          sequence: response.sequence,
        });
      });
      void active.chain.catch((error) => fail(active, error));
    } else if (response.type === "error") {
      void active.chain.then(() => fail(active, new Error(response.error)), () => fail(active, new Error(response.error)));
    } else {
      const previous = active.chain;
      active.chain = previous.then(() => succeed(active));
      void active.chain.catch((error) => fail(active, error));
    }
  };

  const start = async (slot: WorkerSlot, job: CorpusWorkerJob): Promise<void> => {
    const active: ActiveJob = {
      job,
      slot,
      sequence: 0,
      chain: Promise.resolve(),
      settled: false,
      cancelling: false,
      onMessage: () => undefined,
      onError: () => undefined,
    };
    slot.active = active;
    try {
      active.transaction = await sink.begin(job.book);
      if (abort.signal.aborted) {
        await active.transaction.abort(errorMessage(abort.signal.reason));
        recordFailure(job, abortError(abort.signal.reason));
        release(active, "failed");
        schedule();
        finishRunIfIdle();
        return;
      }
      const worker = options.workerFactory();
      slot.worker = worker;
      active.onMessage = (event) => {
        if (event.data) handleResponse(active, event.data);
      };
      active.onError = (event) => {
        const error = event.error ?? event.message ?? "语料 Worker 运行失败";
        void active.chain.then(() => fail(active, error), () => fail(active, error));
      };
      worker.addEventListener("message", active.onMessage);
      worker.addEventListener("error", active.onError);
      const payload = job.bytes ?? (job.read
        ? await job.read().then(toTransferableArrayBuffer)
        : undefined);
      if (!payload) throw new Error(`Worker 任务 ${job.jobId} 缺少 EPUB 字节读取器`);
      const request: CorpusWorkerRequest = {
        protocol: CORPUS_WORKER_PROTOCOL_VERSION,
        type: "start",
        jobId: job.jobId,
        book: job.book,
        bytes: payload,
        maxChunksPerBatch: maxChunks,
        maxCharactersPerBatch: maxCharacters,
      };
      worker.postMessage(request, [payload]);
      options.onJobStarted?.(job.jobId);
    } catch (error) {
      await fail(active, error);
    }
  };

  const pickNext = (): CorpusWorkerJob | undefined => {
    if (pending.length === 0 || abort.signal.aborted) return undefined;
    const activeSlots = slots.filter((slot) => slot.active || slot.reservedJob);
    if (activeSlots.some((slot) => {
      const job = slot.active?.job ?? slot.reservedJob;
      return job !== undefined && byteLength(job) > LARGE_BOOK_BYTES;
    })) return undefined;
    if (activeSlots.length > 0 && pending.some((job) => byteLength(job) > LARGE_BOOK_BYTES)) return undefined;
    const largeIndex = pending.findIndex((job) => byteLength(job) > LARGE_BOOK_BYTES);
    const index = activeSlots.length === 0 && largeIndex >= 0 ? largeIndex : 0;
    return pending.splice(index, 1)[0];
  };

  function schedule(): void {
    if (!started || abort.signal.aborted) {
      finishRunIfIdle();
      return;
    }
    for (const slot of slots) {
      if (slot.active || slot.reservedJob) continue;
      const job = pickNext();
      if (!job) break;
      slot.reservedJob = job;
      void (async () => {
        try {
          await options.waitUntilRunnable?.(abort.signal);
          if (abort.signal.aborted || slot.reservedJob !== job) return;
          await start(slot, job);
        } finally {
          if (slot.reservedJob === job) slot.reservedJob = undefined;
          schedule();
          finishRunIfIdle();
        }
      })();
    }
    finishRunIfIdle();
  }

  const cancelActive = async (active: ActiveJob): Promise<void> => {
    if (active.settled || active.cancelling) return;
    active.cancelling = true;
    try { active.slot.worker?.postMessage({ protocol: CORPUS_WORKER_PROTOCOL_VERSION, type: "cancel", jobId: active.job.jobId }); } catch { /* worker may already be dead */ }
    active.chain = active.chain.then(async () => {
      await active.transaction?.abort(errorMessage(abort.signal.reason));
      recordFailure(active.job, abortError(abort.signal.reason));
      release(active, "failed");
    }).catch(() => {
      recordFailure(active.job, abortError(abort.signal.reason));
      release(active, "failed");
    });
    terminate(active.slot);
    await active.chain;
    finishRunIfIdle();
  };

  const cancel = async (reason?: string): Promise<void> => {
    if (!abort.signal.aborted) abort.abort(reason ? new Error(reason) : abortError());
    for (const job of pending.splice(0)) {
      recordFailure(job, abortError(abort.signal.reason));
      settledJobs++;
    }
    for (const slot of slots) {
      const job = slot.reservedJob;
      if (!job || slot.active) continue;
      slot.reservedJob = undefined;
      recordFailure(job, abortError(abort.signal.reason));
      settledJobs++;
    }
    await Promise.all(slots.filter((slot) => slot.active).map((slot) => cancelActive(slot.active!)));
    finishRunIfIdle();
  };

  if (options.signal) {
    const forward = (): void => {
      abort.abort(options.signal?.reason);
      void cancel();
    };
    if (options.signal.aborted) forward();
    else {
      options.signal.addEventListener("abort", forward, { once: true });
      externalAbortListener = () => options.signal?.removeEventListener("abort", forward);
    }
  }

  return {
    signal: abort.signal,
    run: () => {
      if (runPromise) return runPromise;
      started = true;
      runPromise = new Promise<CorpusWorkerPoolResult>((resolve) => { resolveRun = resolve; });
      if (abort.signal.aborted) {
        settledJobs = options.jobs.length;
        finishRunIfIdle();
      } else schedule();
      return runPromise;
    },
    cancel,
  };
}
