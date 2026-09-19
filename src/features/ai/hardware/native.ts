import { invoke } from "@tauri-apps/api/core";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import type { HardwareReport } from "./contracts";

/** Abort/timeout discard the result; the backend retains its single-flight guard. */
export function requestHardwareReport(signal: AbortSignal): Promise<HardwareReport> {
  if (!isAiDevelopmentActionsAllowed() || getAppBuildSession()?.source !== "desktop") {
    return Promise.reject(new Error("真实硬件探测仅在 AI 桌面调试版开放"));
  }
  if (signal.aborted) return Promise.reject(new Error("已取消本次结果等待"));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("已取消本次结果等待；系统查询可能仍在结束中")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("系统探测等待超时；未启用 CPU 回退，请稍后重试")); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
    invoke<HardwareReport>("ai_hardware_probe").then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
