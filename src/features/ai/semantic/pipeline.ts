import { throwIfAborted } from "../contracts/provider";
import type { DocumentChunk } from "../../../core/chunking";
import { preparationCitation } from "../preparation/citation";
import { assertChunk, manifestKey, profileKey, type SemanticManifest, type SemanticSession, type SemanticRow, type PublishedSnapshot } from "./contracts";
import { normalizeVector, ExactTopK } from "./vectors";

function assertSession(manifest: SemanticManifest, session: SemanticSession): void {
  manifestKey(manifest);
  if (profileKey(manifest.profile) !== profileKey(session.profile)) throw new Error("模型与索引不兼容，需要重建");
}
/** Produces a fully validated batch; caller appends it atomically with owner/sequence fencing. */
export async function embedBatch(manifest: SemanticManifest, session: SemanticSession,
  chunks: readonly DocumentChunk[], startOrdinal: number, signal: AbortSignal): Promise<readonly SemanticRow[]> {
  throwIfAborted(signal); assertSession(manifest, session);
  if (chunks.length < 1 || chunks.length > 32 || !Number.isSafeInteger(startOrdinal)
    || startOrdinal < 0 || startOrdinal + chunks.length > 100_000) throw new Error("语义批次越界");
  const ids = new Set<string>();
  for (const chunk of chunks) {
    assertChunk(manifest, chunk);
    if (ids.has(chunk.chunkId)) throw new Error("批次正文块重复");
    ids.add(chunk.chunkId);
  }
  if (new TextEncoder().encode(JSON.stringify(chunks)).byteLength > 512 * 1024) throw new Error("正文批次超过 512 KiB");
  const vectors = await session.embed(chunks.map(c => c.normalizedText), "passage", signal);
  throwIfAborted(signal); assertSession(manifest, session);
  if (vectors.length !== chunks.length) throw new Error("向量数量与正文批次不一致");
  const rows = chunks.map((chunk, i) => ({ ordinal: startOrdinal + i, chunk, vector: normalizeVector(vectors[i], manifest.profile.dimensions) }));
  if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > 512 * 1024) throw new Error("向量批次超过 512 KiB，请降低批次大小");
  return rows;
}
/** Caller owns the session. This function owns and always closes the supplied snapshot. */
export async function searchSnapshot(snapshot: PublishedSnapshot, session: SemanticSession,
  query: string, k: number, signal: AbortSignal) {
  try {
    throwIfAborted(signal); assertSession(snapshot.manifest, session);
    const identity = manifestKey(snapshot.manifest);
    const generation = snapshot.generation;
    const total = snapshot.total;
    if (!Number.isSafeInteger(generation) || generation < 1
      || !Number.isSafeInteger(total) || total < 1 || total > 100_000
      || !query.trim() || query.length > 8192) throw new Error("查询或已发布索引无效");
    const top = new ExactTopK<DocumentChunk>(k);
    const vectors = await session.embed([query.trim()], "query", signal);
    throwIfAborted(signal);
    if (vectors.length !== 1) throw new Error("查询向量数量无效");
    const q = normalizeVector(vectors[0], snapshot.manifest.profile.dimensions);
    let count = 0;
    for await (const batch of snapshot.batches(signal)) {
      throwIfAborted(signal);
      if (batch.length < 1 || batch.length > 32) throw new Error("检索读取批次越界");
      for (const row of batch) {
        if (row.ordinal !== count || count >= total) throw new Error("索引序号缺失、重复或越界");
        assertChunk(snapshot.manifest, row.chunk);
        const v = normalizeVector(row.vector, q.length);
        const score = Math.max(-1, Math.min(1, q.reduce((sum, x, i) => sum + x * v[i], 0)));
        top.add({ score, ordinal: count++, value: row.chunk });
      }
    }
    throwIfAborted(signal); assertSession(snapshot.manifest, session);
    if (count !== total || identity !== manifestKey(snapshot.manifest)
      || generation !== snapshot.generation || total !== snapshot.total) throw new Error("索引快照不完整或已变化");
    return top.results().map(hit => ({ chunkId: hit.value.chunkId, score: hit.score,
      citation: preparationCitation(hit.value), generation }));
  } finally { await snapshot.close(); }
}
