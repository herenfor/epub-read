import type { DocumentChunk } from "../../../core/chunking";

export interface CorpusBookMetadata {
  contentHash: string;
  title: string;
  creator: string;
  language?: string;
}

/** A sink consumes stable chunks without knowing how EPUB chapters are produced. */
export interface CorpusSink {
  begin(book: CorpusBookMetadata): Promise<CorpusSinkTransaction>;
}

export interface CorpusSinkTransaction {
  append(chunks: readonly DocumentChunk[]): Promise<void>;
  commit(): Promise<number>;
  abort(reason?: string): Promise<void>;
}

/**
 * Serialize every sink operation, including operations from different books.
 * SQLite may read concurrently, but this is the only write path exposed to a
 * scheduler. The wrapped sink remains reusable for FTS, vector and tag sinks.
 */
export function createSerialCorpusSink(sink: CorpusSink): CorpusSink {
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    begin: (book) => enqueue(async () => {
      const transaction = await sink.begin(book);
      return {
        append: (chunks) => enqueue(() => transaction.append(chunks)),
        commit: () => enqueue(() => transaction.commit()),
        abort: (reason) => enqueue(() => transaction.abort(reason)),
      };
    }),
  };
}
