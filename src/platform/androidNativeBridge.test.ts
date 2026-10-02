import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void;
    constructor(onmessage: (message: T) => void) {
      this.onmessage = onmessage;
    }
  }
  return { invoke: invokeMock, Channel };
});

import {
  cancelDocumentImport,
  importDocuments,
  readContentUriText,
  writeTextContentUri,
} from "./androidNativeBridge";

describe("Android native document bridge", () => {
  beforeEach(() => invokeMock.mockReset());

  it("imports full content URIs through the frozen documents command", async () => {
    const onProgress = vi.fn();
    invokeMock.mockResolvedValue({ results: [] });
    const batch = await importDocuments("req-1", [{ uri: "content://provider/book" }], onProgress);
    expect(batch).toEqual({ results: [] });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("linked_library_import_documents");
    expect(args.requestId).toBe("req-1");
    expect(args.documents).toEqual([{ uri: "content://provider/book" }]);
    expect((args.onProgress as { onmessage: unknown }).onmessage).toBe(onProgress);
  });

  it("maps cancel replies without guessing a different status", async () => {
    invokeMock.mockResolvedValue({ status: "too_late" });
    await expect(cancelDocumentImport("req-2")).resolves.toBe("too_late");
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("linked_library_cancel_document_import", {
      requestId: "req-2",
    });
  });

  it("reads text through the Android content URI bridge with an explicit limit", async () => {
    invokeMock.mockResolvedValue(new TextEncoder().encode("save-data").buffer);
    await expect(readContentUriText("content://provider/archive.json", 16 * 1024 * 1024)).resolves.toBe("save-data");
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("android_read_content_uri", {
      uri: "content://provider/archive.json",
      maxBytes: 16 * 1024 * 1024,
    });
  });

  it("writes archive text through the Android content URI bridge", async () => {
    invokeMock.mockResolvedValue(undefined);
    await writeTextContentUri("content://provider/archive.json", "{\"v\":2}");
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("android_write_text_content_uri", {
      uri: "content://provider/archive.json",
      text: "{\"v\":2}",
    });
  });
});
