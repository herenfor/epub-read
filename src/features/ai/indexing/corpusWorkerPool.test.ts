import { describe, expect, it } from "vitest";
import type { DocumentChunk } from "../../../core/chunking";
import type { CorpusSink, CorpusSinkTransaction } from "./corpusSink";
import { createCorpusWorkerPool } from "./corpusWorkerPool";
import type { CorpusWorkerLike, CorpusWorkerRequest, CorpusWorkerResponse } from "./corpusWorkerProtocol";

const hash = "a".repeat(64);
function chunk(id: string, bookFingerprint = hash): DocumentChunk {
  return {
    bookFingerprint, chunkId: id, chapterPath: "Text/1.xhtml", chapterTitle: "第一章", spineIndex: 0,
    contentType: "paragraph", originalText: "正文", normalizedText: "正文", textAnchor: { start: 0, end: 2, snippet: "正文" },
    parserVersion: "parser-v1", normalizerVersion: "normalizer-v1", chunkerVersion: "chunker-v1", unitStart: 0, unitEnd: 1,
  };
}

class FakeWorker implements CorpusWorkerLike {
  readonly requests: CorpusWorkerRequest[] = [];
  private messageListeners = new Set<(event: { data?: CorpusWorkerResponse }) => void>();
  private errorListeners = new Set<(event: { error?: unknown; message?: string }) => void>();
  terminated = false;
  postMessage(message: CorpusWorkerRequest): void { this.requests.push(message); }
  addEventListener(type: "message" | "error", listener: (event: { data?: CorpusWorkerResponse; error?: unknown; message?: string }) => void): void {
    if (type === "message") this.messageListeners.add(listener);
    else this.errorListeners.add(listener);
  }
  removeEventListener(type: "message" | "error", listener: (event: { data?: CorpusWorkerResponse; error?: unknown; message?: string }) => void): void {
    if (type === "message") this.messageListeners.delete(listener);
    else this.errorListeners.delete(listener);
  }
  terminate(): void { this.terminated = true; }
  emit(message: CorpusWorkerResponse): void { for (const listener of this.messageListeners) listener({ data: message }); }
  emitError(message: string): void { for (const listener of this.errorListeners) listener({ message }); }
}

function sink(): CorpusSink & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    begin: async (book): Promise<CorpusSinkTransaction> => ({
      append: async (chunks) => { events.push(`append-${book.contentHash}-${chunks.length}`); },
      commit: async () => { events.push(`commit-${book.contentHash}`); return 1; },
      abort: async () => { events.push(`abort-${book.contentHash}`); },
    }),
  };
}

const book = (id: string) => ({ contentHash: id, title: id, creator: "作者" });
const job = (id: string, sizeBytes?: number) => ({ jobId: id, book: book(id), bytes: new ArrayBuffer(8), ...(sizeBytes === undefined ? {} : { sizeBytes }) });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

describe("corpus Worker pool", () => {
  it("uses the configured number of actual Worker instances and isolates failures", async () => {
    const workers: FakeWorker[] = [];
    const activeSink = sink();
    const pool = createCorpusWorkerPool({
      jobs: [job("one"), job("two"), job("three")], concurrency: 2, sink: activeSink,
      workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    });
    const run = pool.run();
    await flush();
    expect(workers).toHaveLength(2);
    workers[0].emitError("bad worker");
    workers[1].emit({ protocol: 1, type: "batch", jobId: "two", sequence: 0, chunks: [chunk("two", "two")] });
    workers[1].emit({ protocol: 1, type: "done", jobId: "two", batches: 1 });
    await flush();
    expect(workers[1].requests.filter((request) => request.type === "ack")).toHaveLength(1);
    expect(workers).toHaveLength(3);
    workers[2].emit({ protocol: 1, type: "done", jobId: "three", batches: 0 });
    const result = await run;
    expect(result.completedJobs).toBe(2);
    expect(result.failures).toEqual([{ jobId: "one", error: "bad worker" }]);
  });

  it("keeps a book larger than 512 MiB exclusive", async () => {
    const workers: FakeWorker[] = [];
    const pool = createCorpusWorkerPool({
      jobs: [job("small"), job("large", 512 * 1024 * 1024 + 1), job("small-2")], concurrency: 3, sink: sink(),
      workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    });
    const run = pool.run();
    await flush();
    expect(workers).toHaveLength(1);
    workers[0].emit({ protocol: 1, type: "done", jobId: "large", batches: 0 });
    await flush();
    expect(workers).toHaveLength(3);
    for (const [index, worker] of workers.slice(1).entries()) worker.emit({ protocol: 1, type: "done", jobId: index === 0 ? "small" : "small-2", batches: 0 });
    await run;
  });

  it("does not dispatch pending jobs after cancellation", async () => {
    const workers: FakeWorker[] = [];
    const pool = createCorpusWorkerPool({
      jobs: [job("one"), job("two")], concurrency: 1, sink: sink(),
      workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    });
    const run = pool.run();
    await flush();
    await pool.cancel("reader resumed");
    const result = await run;
    expect(workers).toHaveLength(1);
    expect(result.cancelled).toBe(true);
    expect(workers[0].requests.some((request) => request.type === "start" && request.jobId === "two")).toBe(false);
  });

  it("passes the cancellation signal through a reader-priority gate", async () => {
    const workers: FakeWorker[] = [];
    let gateSignal!: AbortSignal;
    const pool = createCorpusWorkerPool({
      jobs: [job("one")], concurrency: 1, sink: sink(),
      waitUntilRunnable: (signal) => {
        gateSignal = signal;
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    });
    const run = pool.run();
    await flush();
    expect(gateSignal.aborted).toBe(false);
    await pool.cancel("reader resumed");
    expect(gateSignal.aborted).toBe(true);
    expect(workers).toHaveLength(0);
    expect((await run).cancelled).toBe(true);
  });
});
