import { invoke } from "@tauri-apps/api/core";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import type { PreparationReply, PreparationStore } from "./contracts";

export function createNativePreparationStore(): PreparationStore {
  return { request: (input) => {
    if (!isAiDevelopmentActionsAllowed() || getAppBuildSession()?.source !== "desktop") {
      return Promise.reject(new Error("可恢复 mock 索引仅在 AI 桌面调试版可用"));
    }
    return invoke<PreparationReply>("ai_preparation", { input });
  } };
}

/** Select by the verified host; importing/mounting never opens storage. */
export function createPreparationStore(): PreparationStore {
  const native = createNativePreparationStore();
  return { async request(input) {
    if (getAppBuildSession()?.source === "browser" && isAiDevelopmentActionsAllowed()) {
      const { createBrowserPreparationStore } = await import("./browserStore");
      return createBrowserPreparationStore().request(input);
    }
    return native.request(input);
  } };
}
