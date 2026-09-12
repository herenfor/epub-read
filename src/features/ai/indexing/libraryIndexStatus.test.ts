import { describe, expect, it } from "vitest";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import {
  libraryIndexCanSearch,
  phaseAfterIndexCheck,
  phaseAfterIndexStop,
  summarizeLibraryIndex,
} from "./libraryIndexStatus";

function status(contentHash: string, parserVersion = CORPUS_PARSER_VERSION) {
  return {
    contentHash,
    parserVersion,
    normalizerVersion: CORPUS_NORMALIZER_VERSION,
    chunkerVersion: CORPUS_CHUNKER_VERSION,
    chunkCount: 3,
    updatedAt: 1,
  };
}

describe("library index status", () => {
  it("separates searchable, pending and unavailable books", () => {
    const summary = summarizeLibraryIndex([
      { contentHash: "a", available: true },
      { contentHash: "b", available: true },
      { contentHash: "c", available: false },
    ], [status("a"), status("b", "old")], true);
    expect(summary).toEqual({ total: 3, indexed: 1, pending: 1, unavailable: 1, interrupted: true });
    expect(phaseAfterIndexCheck(summary)).toBe("confirmation");
    expect(libraryIndexCanSearch("confirmation", summary)).toBe(true);
  });

  it("keeps completed books searchable after cancellation", () => {
    const partial = { total: 3, indexed: 1, pending: 2, unavailable: 0, interrupted: false };
    const empty = { ...partial, indexed: 0 };
    expect(phaseAfterIndexStop(partial)).toBe("partial");
    expect(phaseAfterIndexStop(empty)).toBe("cancelled");
    expect(libraryIndexCanSearch("partial", partial)).toBe(true);
    expect(libraryIndexCanSearch("cancelled", empty)).toBe(false);
  });
});
