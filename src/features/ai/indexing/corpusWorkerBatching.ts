import type { DocumentChunk } from "../../../core/chunking";

function characterCount(chunk: DocumentChunk): number {
  return Array.from(chunk.originalText).length + Array.from(chunk.normalizedText).length;
}

/** Split worker output with the same two bounded gates used by the sink controller. */
export function splitCorpusWorkerBatches(
  chunks: readonly DocumentChunk[],
  maxChunks: number,
  maxCharacters: number,
): DocumentChunk[][] {
  const result: DocumentChunk[][] = [];
  let batch: DocumentChunk[] = [];
  let characters = 0;
  const flush = (): void => {
    if (batch.length > 0) result.push(batch);
    batch = [];
    characters = 0;
  };
  for (const chunk of chunks) {
    const size = characterCount(chunk);
    if (batch.length > 0 && (batch.length >= maxChunks || characters + size > maxCharacters)) flush();
    batch.push(chunk);
    characters += size;
  }
  flush();
  return result;
}
