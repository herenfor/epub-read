import { invoke } from "@tauri-apps/api/core";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import { createSnapshot, type SemanticReply, type SemanticRequest, type SemanticSnapshot, type SemanticStore } from "./store";

/** SQLite-backed store.  Windows AI debug builds only; the browser preview has
 * its own clearly labelled adapter and never claims native persistence. */
export function createNativeSemanticStore(): SemanticStore {
  const request = (input: SemanticRequest): Promise<SemanticReply> => {
    if (!isAiDevelopmentActionsAllowed() || getAppBuildSession()?.source !== "desktop") {
      return Promise.reject(new Error("真实语义索引仅在 AI 桌面调试版可用"));
    }
    const payload = toNativeRequest(input);
    return invoke<SemanticReply>("ai_semantic", { input: payload });
  };
  return {
    request,
    async openSnapshot(book: string): Promise<SemanticSnapshot> {
      const reply = await request({ action: "openSnapshot", book });
      if (!reply.snapshot) throw new Error("此书尚未发布语义索引");
      return createSnapshot({ request, openSnapshot: () => Promise.reject(new Error("嵌套快照不受支持")) }, book, reply.snapshot);
    },
  };
}

/** Rust's enum rename_all changes action names, not fields inside variants.
 * Map the two multi-word begin fields at the IPC boundary; the remaining
 * request fields already match their Rust spelling. */
export function toNativeRequest(input: SemanticRequest): Record<string, unknown> {
  if (input.action === "begin") {
    const { manifestKey, corpusDigest, ...rest } = input;
    return { ...rest, manifest_key: manifestKey, corpus_digest: corpusDigest };
  }
  return { ...input };
}

/** Selects by verified host.  Importing never opens storage. */
export function createSemanticStore(): SemanticStore {
  const native = createNativeSemanticStore();
  return {
    async request(input) {
      if (getAppBuildSession()?.source === "browser" && isAiDevelopmentActionsAllowed()) {
        const { createBrowserSemanticStore } = await import("./browserStore");
        return createBrowserSemanticStore().request(input);
      }
      return native.request(input);
    },
    async openSnapshot(book) {
      if (getAppBuildSession()?.source === "browser" && isAiDevelopmentActionsAllowed()) {
        const { createBrowserSemanticStore } = await import("./browserStore");
        return createBrowserSemanticStore().openSnapshot(book);
      }
      return native.openSnapshot(book);
    },
  };
}
