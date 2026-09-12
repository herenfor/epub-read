import { describe, expect, it } from "vitest";
import type { DocumentChunk } from "../../../core/chunking";
import { toTransferableArrayBuffer } from "./corpusWorkerPool";
import { splitCorpusWorkerBatches } from "./corpusWorkerBatching";

function chunk(id: string, text = "正文"): DocumentChunk {
  return {
    bookFingerprint: "a".repeat(64), chunkId: id, chapterPath: "1.xhtml", chapterTitle: "一", spineIndex: 0,
    contentType: "paragraph", originalText: text, normalizedText: text, textAnchor: { start: 0, end: 1, snippet: text },
    parserVersion: "p", normalizerVersion: "n", chunkerVersion: "c", unitStart: 0, unitEnd: 1,
  };
}

describe("corpus Worker batch and transfer boundaries", () => {
  it("splits worker output by both chunk and character limits", () => {
    const batches = splitCorpusWorkerBatches([chunk("1"), chunk("2"), chunk("3")], 2, 5);
    expect(batches.map((batch) => batch.map((item) => item.chunkId))).toEqual([["1"], ["2"], ["3"]]);
  });

  it("transfers a full Uint8Array buffer without copying, but isolates subviews", () => {
    const full = new Uint8Array([1, 2, 3]);
    expect(toTransferableArrayBuffer(full)).toBe(full.buffer);
    const view = full.subarray(1);
    const copied = toTransferableArrayBuffer(view);
    expect(copied).not.toBe(full.buffer);
    expect([...new Uint8Array(copied)]).toEqual([2, 3]);
  });
});
