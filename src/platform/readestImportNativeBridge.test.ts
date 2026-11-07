import { describe, expect, it, vi } from "vitest";
import { readReadestEntryText } from "./readestImportNativeBridge";

const chunks = (...parts: Uint8Array[]) => {
  const run = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
    const index = run.mock.calls.length - 1;
    expect(args).toMatchObject({ sessionId: "s", entryIndex: 3 });
    return parts[index].buffer.slice(parts[index].byteOffset, parts[index].byteOffset + parts[index].byteLength);
  });
  return run as unknown as Parameters<typeof readReadestEntryText>[2] & typeof run;
};

describe("Readest backup entry reads", () => {
  it("reads sequentially to EOF and joins a code point split across chunks", async () => {
    const bytes = new TextEncoder().encode("[\"书\"]");
    const run = chunks(bytes.slice(0, 3), bytes.slice(3));
    expect(await readReadestEntryText("s", { entryIndex: 3, bytes: bytes.length }, run)).toBe("[\"书\"]");
    expect(run.mock.calls.map(([, args]) => args?.offset)).toEqual([0, 3]);
  });

  it("still validates an empty entry and rejects short or non-UTF-8 data", async () => {
    const empty = chunks(new Uint8Array(0));
    expect(await readReadestEntryText("s", { entryIndex: 3, bytes: 0 }, empty)).toBe("");
    expect(empty).toHaveBeenCalledTimes(1);
    await expect(readReadestEntryText("s", { entryIndex: 3, bytes: 5 }, chunks(new Uint8Array([1]), new Uint8Array(0))))
      .rejects.toMatchObject({ code: "invalid-backup" });
    await expect(readReadestEntryText("s", { entryIndex: 3, bytes: 2 }, chunks(new Uint8Array([0xff, 0xfe]))))
      .rejects.toMatchObject({ code: "invalid-data" });
  });
});
