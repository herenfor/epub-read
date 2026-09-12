import type { DocumentChunk } from "../../../core/chunking";
import { makeNativeIndexChunk, normalizeIndexedBookMetadata, type IndexStagingBeginInput, type IndexStagingStorePort } from "./indexStore";
import type { CorpusSink, CorpusSinkTransaction } from "./corpusSink";

/** Adapter for the current SQLite FTS staging boundary. */
export function createFtsCorpusSink(store: IndexStagingStorePort): CorpusSink {
  return {
    begin: async (book): Promise<CorpusSinkTransaction> => {
      let stagingId: string | undefined;
      let sequence = 0;
      let chunksWritten = 0;
      let expectedVersions: DocumentChunk | undefined;
      let committed = false;
      let aborted = false;

      const append = async (chunks: readonly DocumentChunk[]): Promise<void> => {
        if (committed || aborted) throw new Error("语料 sink 事务已结束");
        if (chunks.length === 0) return;
        for (const chunk of chunks) {
          if (chunk.bookFingerprint !== book.contentHash) throw new Error("索引正文块与书籍内容指纹不一致");
          if (expectedVersions && (
            chunk.parserVersion !== expectedVersions.parserVersion
            || chunk.normalizerVersion !== expectedVersions.normalizerVersion
            || chunk.chunkerVersion !== expectedVersions.chunkerVersion
          )) throw new Error("索引正文块的 parserVersion、normalizerVersion 或 chunkerVersion 不一致");
          expectedVersions ??= chunk;
        }
        if (!stagingId || !expectedVersions) {
          const versions = expectedVersions;
          if (!versions) throw new Error("索引正文块缺少版本信息");
          const begin: IndexStagingBeginInput = {
            ...normalizeIndexedBookMetadata(book),
            parserVersion: versions.parserVersion,
            normalizerVersion: versions.normalizerVersion,
            chunkerVersion: versions.chunkerVersion,
          };
          stagingId = await store.begin(begin);
        }
        await store.append(stagingId, { sequence, chunks: chunks.map(makeNativeIndexChunk) });
        sequence++;
        chunksWritten += chunks.length;
      };

      const abort = async (reason?: string): Promise<void> => {
        if (committed || aborted) return;
        aborted = true;
        if (stagingId) await store.abort(stagingId, reason);
      };

      return {
        append,
        commit: async (): Promise<number> => {
          if (committed) return chunksWritten;
          if (aborted) throw new Error("语料 sink 事务已结束");
          if (!stagingId || !expectedVersions || chunksWritten === 0) {
            throw new Error("不能为没有正文块的书籍建立索引");
          }
          const committedChunks = await store.commit(stagingId);
          committed = true;
          return committedChunks;
        },
        abort,
      };
    },
  };
}

export type { CorpusBookMetadata } from "./corpusSink";
