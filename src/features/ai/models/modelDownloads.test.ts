import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTauriModelDownloadPort } from "./modelDownloads";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

describe("model download adapter", () => {
  beforeEach(() => invokeMock.mockReset());

  it("keeps downloads as a command-only boundary", async () => {
    invokeMock.mockResolvedValue({});
    const port = createTauriModelDownloadPort();
    await port.enqueue("default");
    await port.list();
    await port.pause("task");
    await port.resume("task");
    await port.cancel("task");
    await port.acceptLicense("default");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_model_download_enqueue", { packageId: "default" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "ai_model_download_list");
    expect(invokeMock).toHaveBeenNthCalledWith(6, "ai_model_license_accept", { packageId: "default" });
  });
});
