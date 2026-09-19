import { describe, expect, it } from "vitest";
import { sha256Hex } from "./digest";

async function nodeSha256(text: string): Promise<string> {
  // @ts-expect-error The project intentionally does not include @types/node.
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The Rust boundary only accepts a 64-character lowercase hex digest for
// `manifest_key`/`corpus_digest`, so the local implementation is checked
// against Node's own SHA-256 rather than against itself.
describe("semantic index digest", () => {
  const samples = [
    "",
    "abc",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "a".repeat(1000),
    "中文语料摘要：地震是怎么形成的",
    "emoji 🔥 and surrogate pairs 𠮷",
    JSON.stringify([1, "a".repeat(64), "visible-xhtml-v2"]),
  ];

  it("matches Node SHA-256 for every sample", async () => {
    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(await nodeSha256(sample));
    }
  });

  it("always returns a digest the native store accepts", async () => {
    for (const sample of samples) {
      expect(sha256Hex(sample)).toMatch(/^[a-f0-9]{64}$/);
      expect(sha256Hex(sample)).toBe(await nodeSha256(sample));
    }
  });
});
