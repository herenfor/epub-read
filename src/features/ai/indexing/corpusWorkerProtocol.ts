import type { DocumentChunk } from "../../../core/chunking";
import type { CorpusBookMetadata } from "./corpusSink";

export const CORPUS_WORKER_PROTOCOL_VERSION = 1;

export interface CorpusWorkerStartMessage {
  protocol: typeof CORPUS_WORKER_PROTOCOL_VERSION;
  type: "start";
  jobId: string;
  book: CorpusBookMetadata;
  bytes: ArrayBuffer;
  maxChunksPerBatch: number;
  maxCharactersPerBatch: number;
}

export interface CorpusWorkerCancelMessage {
  protocol: typeof CORPUS_WORKER_PROTOCOL_VERSION;
  type: "cancel";
  jobId: string;
}

export interface CorpusWorkerAckMessage {
  protocol: typeof CORPUS_WORKER_PROTOCOL_VERSION;
  type: "ack";
  jobId: string;
  sequence: number;
}

export type CorpusWorkerRequest = CorpusWorkerStartMessage | CorpusWorkerCancelMessage | CorpusWorkerAckMessage;

export interface CorpusWorkerBatchMessage {
  protocol: typeof CORPUS_WORKER_PROTOCOL_VERSION;
  type: "batch";
  jobId: string;
  sequence: number;
  chunks: DocumentChunk[];
}

export interface CorpusWorkerDoneMessage {
  protocol: typeof CORPUS_WORKER_PROTOCOL_VERSION;
  type: "done";
  jobId: string;
  batches: number;
}

export interface CorpusWorkerErrorMessage {
  protocol: typeof CORPUS_WORKER_PROTOCOL_VERSION;
  type: "error";
  jobId: string;
  error: string;
}

export type CorpusWorkerResponse = CorpusWorkerBatchMessage | CorpusWorkerDoneMessage | CorpusWorkerErrorMessage;

export interface CorpusWorkerMessageEvent {
  data?: CorpusWorkerResponse;
  error?: unknown;
  message?: string;
}

export type CorpusWorkerErrorEvent = CorpusWorkerMessageEvent;

/** Minimal adapter keeps tests deterministic while production still uses a real Worker. */
export interface CorpusWorkerLike {
  postMessage(message: CorpusWorkerRequest, transfer?: readonly Transferable[]): void;
  addEventListener(type: "message" | "error", listener: (event: CorpusWorkerMessageEvent) => void): void;
  removeEventListener(type: "message" | "error", listener: (event: CorpusWorkerMessageEvent) => void): void;
  terminate(): void | Promise<void>;
}

export type CorpusWorkerFactory = () => CorpusWorkerLike;

/** Wraps a browser Worker without claiming that a Promise is a worker. */
export function createBrowserCorpusWorkerFactory(workerUrl: URL | string): CorpusWorkerFactory {
  return () => {
    if (typeof Worker === "undefined") throw new Error("当前运行时不支持真实 Worker");
    const worker = new Worker(workerUrl, { type: "module" });
    return worker as unknown as CorpusWorkerLike;
  };
}

/** Vite-recognized static worker entry for the production desktop bundle. */
export function createDefaultCorpusWorkerFactory(): CorpusWorkerFactory {
  return () => {
    if (typeof Worker === "undefined") throw new Error("当前运行时不支持真实 Worker");
    // Keep Worker(new URL(...)) in one static expression: Vite recognizes
    // this form and bundles imports instead of inlining raw module source.
    const worker = new Worker(new URL("./corpusWorker.ts", import.meta.url), { type: "module" });
    return worker as unknown as CorpusWorkerLike;
  };
}
