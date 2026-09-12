import { describe, expect, it } from "vitest";
import { calculateCorpusConcurrency, LARGE_BOOK_BYTES } from "./corpusConcurrency";

describe("corpus concurrency policy", () => {
  it("keeps automatic budgets within the documented device tiers", () => {
    expect(calculateCorpusConcurrency({ logicalCores: 1 })).toBe(1);
    expect(calculateCorpusConcurrency({ logicalCores: 4 })).toBe(1);
    expect(calculateCorpusConcurrency({ logicalCores: 8 })).toBe(2);
    expect(calculateCorpusConcurrency({ logicalCores: 12 })).toBe(4);
    expect(calculateCorpusConcurrency({ logicalCores: 16 })).toBe(6);
    expect(calculateCorpusConcurrency({ logicalCores: 32 })).toBe(8);
  });

  it("caps manual settings by one reserved core and sixteen workers", () => {
    expect(calculateCorpusConcurrency({ mode: "manual", logicalCores: 4, maxConcurrency: 16 })).toBe(3);
    expect(calculateCorpusConcurrency({ mode: "manual", logicalCores: 64, maxConcurrency: 64 })).toBe(16);
    expect(calculateCorpusConcurrency({ mode: "manual", logicalCores: 8, maxConcurrency: 8, hardCap: 2 })).toBe(2);
    expect(LARGE_BOOK_BYTES).toBe(512 * 1024 * 1024);
  });
});
