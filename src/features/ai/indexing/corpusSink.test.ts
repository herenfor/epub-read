import { describe, expect, it, vi } from "vitest";
import type { DocumentChunk } from "../../../core/chunking";
import type { IndexStagingBatch, IndexStagingStorePort } from "./indexStore";
import { createSerialCorpusSink, type CorpusSink } from "./corpusSink";
import { createFtsCorpusSink } from "./ftsCorpusSink";

const hash = "a".repeat(64);
function chunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    bookFingerprint: hash, chunkId: "chunk-1", chapterPath: "Text/1.xhtml", chapterTitle: "第一章", spineIndex: 0,
    contentType: "paragraph", originalText: "正文", normalizedText: "正文", textAnchor: { start: 0, end: 2, snippet: "正文" },
    parserVersion: "parser-v1", normalizerVersion: "normalizer-v1", chunkerVersion: "chunker-v1", unitStart: 0, unitEnd: 1,
    ...overrides,
  };
}

function store(): IndexStagingStorePort & { batches: IndexStagingBatch[] } {
  const batches: IndexStagingBatch[] = [];
  return {
    batches,
    begin: vi.fn(async () => "stage-1"),
    append: vi.fn(async (_id, batch) => { batches.push(batch); }),
    commit: vi.fn(async () => batches.reduce((total, batch) => total + batch.chunks.length, 0)),
    abort: vi.fn(async () => undefined),
  };
}

describe("corpus sink boundaries", () => {
  it("adapts stable chunks to one ordered FTS staging transaction", async () => {
    const active = store();
    const transaction = await createFtsCorpusSink(active).begin({ contentHash: hash, title: "书", creator: "作者" });
    await transaction.append([chunk()]);
    await transaction.commit();
    expect(active.begin).toHaveBeenCalledWith({ contentHash: hash, title: "书", creator: "作者", parserVersion: "parser-v1", normalizerVersion: "normalizer-v1", chunkerVersion: "chunker-v1" });
    expect(active.batches[0].sequence).toBe(0);
    expect(active.batches[0].chunks[0].anchorJson).toBe('{"start":0,"end":2,"snippet":"正文"}');
    expect(active.commit).toHaveBeenCalledWith("stage-1");
  });

  it("serializes writes from independent sink transactions", async () => {
    const order: string[] = [];
    const sink: CorpusSink = {
      begin: async (book) => ({
        append: async (chunks) => { if (chunks.length > 0) order.push(`append-${book.contentHash}`); },
        commit: async () => { order.push(`commit-${book.contentHash}`); return 1; },
        abort: async () => { order.push(`abort-${book.contentHash}`); },
      }),
    };
    const serial = createSerialCorpusSink(sink);
    const [one, two] = await Promise.all([
      serial.begin({ contentHash: "one", title: "", creator: "" }),
      serial.begin({ contentHash: "two", title: "", creator: "" }),
    ]);
    await Promise.all([one.append([]), two.append([]), one.commit(), two.commit()]);
    expect(order).toEqual(["commit-one", "commit-two"]);
  });

  it("rejects chunks that would change the stable version contract", async () => {
    const active = store();
    const transaction = await createFtsCorpusSink(active).begin({ contentHash: hash, title: "书", creator: "作者" });
    await transaction.append([chunk()]);
    await expect(transaction.append([chunk({ normalizerVersion: "normalizer-v2" })])).rejects.toThrow("不一致");
  });
});
