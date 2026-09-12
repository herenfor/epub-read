import { iterateBookChunkBatches, textForBookResource } from "../../../core/bookCorpusIndex";
import { loadBook } from "../../../core/book";
import { splitCorpusWorkerBatches } from "./corpusWorkerBatching";
import type {
  CorpusWorkerBatchMessage,
  CorpusWorkerCancelMessage,
  CorpusWorkerAckMessage,
  CorpusWorkerDoneMessage,
  CorpusWorkerErrorMessage,
  CorpusWorkerRequest,
  CorpusWorkerStartMessage,
} from "./corpusWorkerProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: { data: CorpusWorkerRequest }) => void): void;
  postMessage(message: CorpusWorkerBatchMessage | CorpusWorkerDoneMessage | CorpusWorkerErrorMessage): void;
};

const scope = globalThis as unknown as WorkerScope;
const cancelled = new Set<string>();
const acknowledgements = new Map<string, Map<number, (accepted: boolean) => void>>();

function isStart(request: CorpusWorkerRequest): request is CorpusWorkerStartMessage {
  return request.type === "start";
}

function isCancel(request: CorpusWorkerRequest): request is CorpusWorkerCancelMessage {
  return request.type === "cancel";
}

function isAck(request: CorpusWorkerRequest): request is CorpusWorkerAckMessage {
  return request.type === "ack";
}

function waitForAck(jobId: string, sequence: number): Promise<boolean> {
  return new Promise((resolve) => {
    const pending = acknowledgements.get(jobId) ?? new Map<number, (accepted: boolean) => void>();
    pending.set(sequence, resolve);
    acknowledgements.set(jobId, pending);
  });
}

async function build(request: CorpusWorkerStartMessage): Promise<void> {
  try {
    const book = await loadBook(new Uint8Array(request.bytes));
    if (book.fixedLayout) throw new Error("固定版式书籍不支持正文语料建库");
    let sequence = 0;
    for await (const batch of iterateBookChunkBatches(book, {
      bookFingerprint: request.book.contentHash,
      signal: { get aborted() { return cancelled.has(request.jobId); } } as AbortSignal,
      textFor: (path) => textForBookResource(book, path),
    })) {
      if (cancelled.has(request.jobId)) return;
      for (const chunks of splitCorpusWorkerBatches(batch.chunks, request.maxChunksPerBatch, request.maxCharactersPerBatch)) {
        const response: CorpusWorkerBatchMessage = {
          protocol: request.protocol,
          type: "batch",
          jobId: request.jobId,
          sequence,
          chunks,
        };
        scope.postMessage(response);
        sequence++;
        if (!(await waitForAck(request.jobId, sequence - 1)) || cancelled.has(request.jobId)) return;
      }
    }
    if (!cancelled.has(request.jobId)) {
      scope.postMessage({ protocol: request.protocol, type: "done", jobId: request.jobId, batches: sequence });
    }
  } catch (error) {
    if (!cancelled.has(request.jobId)) {
      scope.postMessage({ protocol: request.protocol, type: "error", jobId: request.jobId, error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    cancelled.delete(request.jobId);
    const pending = acknowledgements.get(request.jobId);
    pending?.forEach((resolve) => resolve(false));
    acknowledgements.delete(request.jobId);
  }
}

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (isCancel(request)) {
    cancelled.add(request.jobId);
    const pending = acknowledgements.get(request.jobId);
    pending?.forEach((resolve) => resolve(false));
    acknowledgements.delete(request.jobId);
    return;
  }
  if (isAck(request)) {
    const pending = acknowledgements.get(request.jobId)?.get(request.sequence);
    pending?.(true);
    acknowledgements.get(request.jobId)?.delete(request.sequence);
    return;
  }
  if (isStart(request)) void build(request);
});
