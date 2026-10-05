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
