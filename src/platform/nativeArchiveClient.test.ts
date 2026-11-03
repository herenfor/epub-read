import { describe, expect, it, vi } from "vitest";
import { createNativeArchiveClient, type ArchiveInvoke } from "./nativeArchiveClient";

const CHUNK = 512 * 1024;
const HASH = "a".repeat(64);

describe("native Android archive client", () => {
  it("pages the directory and reads one bounded chunk per native call", async () => {
    const data = new Uint8Array(CHUNK + 7).map((_, index) => index % 251);
    const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
      if (command === "linked_library_archive_open") {
        return { protocolVersion: 1, sessionId: "session-1", entryCount: 1, chunkBytes: CHUNK };
      }
      if (command === "linked_library_archive_directory") {
        expect(args.start).toBe(0);
        return {
          entries: [{ entryIndex: 3, name: "chapter.xhtml", compressedBytes: data.length, expandedBytes: data.length }],
          next: null,
        };
      }
      if (command === "linked_library_archive_read") {
        const offset = args.offset as number;
        const length = Math.min(CHUNK, data.length - offset);
        return data.slice(offset, offset + length).buffer;
      }
      if (command === "linked_library_archive_close") return undefined;
      throw new Error(`unexpected command ${command}`);
    });

    const archive = await createNativeArchiveClient(HASH, invoke as unknown as ArchiveInvoke);
    const result = await archive.extract(["chapter.xhtml"]);
    expect([...result.get("chapter.xhtml")!]).toEqual([...data]);
    const readCalls = invoke.mock.calls.filter(([command]) => command === "linked_library_archive_read");
    expect(readCalls.map(([, args]) => args.offset)).toEqual([0, CHUNK]);
    archive.close();
    expect(invoke).toHaveBeenCalledWith("linked_library_archive_close", { sessionId: "session-1" });
  });

  it.each([true, false])("opens bounded compact directories with paged fallback (%s)", async packed => {
    const rows = [[0, "巻/1.jpg", 10, 10], [2, "巻/2.jpg", 17, 17]];
    const invoke = vi.fn(async (command: string) => {
      switch (command) {
        case "linked_library_archive_open":
          return { protocolVersion: 1, sessionId: "packed", entryCount: rows.length, chunkBytes: CHUNK, compactDirectory: true };
        case "linked_library_archive_compact_directory":
          return packed
            ? new Response(new Blob([JSON.stringify(rows)]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()
            : new ArrayBuffer(0);
        case "linked_library_archive_directory":
          return { entries: rows.map(([entryIndex, name, compressedBytes, expandedBytes]) => ({
            entryIndex, name, compressedBytes, expandedBytes,
          })), next: null };
        default: throw new Error(command);
      }
    });
    const archive = await createNativeArchiveClient(HASH, invoke as unknown as ArchiveInvoke);
    expect([...archive.directory.keys()]).toEqual(["巻/1.jpg", "巻/2.jpg"]);
    expect(invoke.mock.calls.some(([command]) => command === "linked_library_archive_directory")).toBe(!packed);
  });

  it("abandons stale reads at a chunk boundary without closing the session", async () => {
    const active = new AbortController();
    const queued = new AbortController();
    const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case "linked_library_archive_open":
          return { protocolVersion: 1, sessionId: "session-3", entryCount: 3, chunkBytes: CHUNK };
        case "linked_library_archive_directory":
          return {
            entries: ["old", "queued", "visible"].map((name, entryIndex) => ({
              entryIndex, name, compressedBytes: CHUNK + 1, expandedBytes: CHUNK + 1,
            })),
            next: null,
          };
        case "linked_library_archive_read":
          if (args.entryIndex === 0) {
            active.abort();
            queued.abort();
          }
          return new ArrayBuffer(args.offset === 0 ? CHUNK : 1);
        default:
          throw new Error(`unexpected command ${command}`);
      }
    });
    const archive = await createNativeArchiveClient(HASH, invoke as unknown as ArchiveInvoke);
    const results = await Promise.allSettled([
      archive.extract(["old"], active.signal),
      archive.extract(["queued"], queued.signal),
      archive.extract(["visible"]),
    ]);
    expect(results.slice(0, 2)).toMatchObject([
      { status: "rejected", reason: { name: "AbortError" } },
      { status: "rejected", reason: { name: "AbortError" } },
    ]);
    expect(results[2]).toMatchObject({ status: "fulfilled" });
    expect(invoke.mock.calls.filter(([command]) => command === "linked_library_archive_read")
      .map(([, args]) => [args.entryIndex, args.offset])).toEqual([[0, 0], [2, 0], [2, CHUNK]]);
    expect(invoke.mock.calls.some(([command]) => command === "linked_library_archive_close")).toBe(false);
  });

  it("rejects when the directory cursor does not match", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "linked_library_archive_open") {
        return { protocolVersion: 1, sessionId: "session-2", entryCount: 2, chunkBytes: CHUNK };
      }
      if (command === "linked_library_archive_directory") {
        return { entries: [], next: 1 };
      }
      return undefined;
    });
    await expect(
      createNativeArchiveClient(HASH, invoke as unknown as ArchiveInvoke),
    ).rejects.toThrow(/游标错误|目录不完整/);
  });
});
