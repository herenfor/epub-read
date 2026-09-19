import { beforeEach, describe, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../../config/appBuildSession", () => ({
  getAppBuildSession: () => ({ source: "desktop" }), isAiDevelopmentActionsAllowed: () => true,
}));
import { embeddingErrorMessage, openSemanticSession, probeSemanticEmbedding } from "./nativeSession";
import { PREVIEW_PROFILE } from "./previewSession";

beforeEach(() => { invokeMock.mockReset(); });
describe("native embedding errors", () => {
  it("keeps structured open and probe errors readable", async () => {
    const cause = { kind: "executionFailed", message: "已有活动的嵌入会话，请先关闭" };
    invokeMock.mockRejectedValue(cause);
    await expect(openSemanticSession("test")).rejects.toMatchObject({ message: cause.message, kind: cause.kind });
    await expect(probeSemanticEmbedding()).rejects.toThrow(cause.message);
    expect(embeddingErrorMessage(cause)).toBe(cause.message);
    expect(embeddingErrorMessage({ message: "其他后端错误" })).toBe("其他后端错误");
  });
  it("turns a token overflow object into an Error understood by the indexer", async () => {
    invokeMock.mockResolvedValueOnce({ sessionId: "native-1", profile: PREVIEW_PROFILE });
    const { session } = await openSemanticSession("test");
    invokeMock.mockRejectedValueOnce({ kind: "executionFailed", message: "正文块超过模型 token 上限（900 > 512）" });
    await expect(session.embed(["正文"], "passage", new AbortController().signal)).rejects.toThrow("token 上限");
  });
  it("preserves native cancellation as cancellation and reports close failure", async () => {
    invokeMock.mockResolvedValueOnce({ sessionId: "native-1", profile: PREVIEW_PROFILE });
    const { session } = await openSemanticSession("test");
    invokeMock.mockRejectedValueOnce({ kind: "cancelled", message: "嵌入计算已取消" });
    await expect(session.embed(["正文"], "passage", new AbortController().signal)).rejects.toMatchObject({ code: "aborted" });
    invokeMock.mockRejectedValueOnce({ kind: "executionFailed", message: "驱动释放失败" });
    await expect(session.close()).rejects.toThrow("驱动释放失败");
  });
});
