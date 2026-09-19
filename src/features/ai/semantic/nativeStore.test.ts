import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeSemanticStore, toNativeRequest } from "./nativeStore";
import type { SemanticRequest } from "./store";
import { manifestFor } from "./indexer";
import { createPreviewSession } from "./previewSession";
import { policy, testChunk } from "./testStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../../../config/appBuildSession", () => ({
  getAppBuildSession: () => ({ source: "desktop" }),
  isAiDevelopmentActionsAllowed: () => true,
}));

const invokeMock = vi.mocked(invoke);

function beginRequest(): SemanticRequest {
  const chunk = testChunk(0);
  return {
    action: "begin",
    manifest: manifestFor(createPreviewSession(), chunk),
    manifestKey: "a".repeat(64),
    owner: "owner-1",
    corpusDigest: "b".repeat(64),
    policy: policy(2),
    force: false,
  };
}

describe("native semantic store request mapping", () => {
  beforeEach(() => invokeMock.mockClear());

  it("spells the two multi-word begin fields the way the Rust enum expects", () => {
    expect(toNativeRequest(beginRequest())).toMatchObject({
      action: "begin",
      manifest_key: "a".repeat(64),
      corpus_digest: "b".repeat(64),
      owner: "owner-1",
      force: false,
    });
  });

  it("passes single-word actions through unchanged", () => {
    const request: SemanticRequest = { action: "status", book: "c".repeat(64) };
    expect(toNativeRequest(request)).toEqual({ action: "status", book: "c".repeat(64) });
  });

  it("sends the mapped payload to the IPC command", async () => {
    const store = createNativeSemanticStore();
    await store.request(beginRequest());
    expect(invokeMock).toHaveBeenCalledWith("ai_semantic", {
      input: expect.objectContaining({ manifest_key: "a".repeat(64), corpus_digest: "b".repeat(64) }),
    });
    const payload = invokeMock.mock.calls[0][1] as { input: Record<string, unknown> };
    expect(payload.input).not.toHaveProperty("manifestKey");
    expect(payload.input).not.toHaveProperty("corpusDigest");
  });
});
