import { afterEach, describe, expect, it, vi } from "vitest";
import { assessMemoryBudget } from "./budget";
import { previewHardware } from "./preview";
import { clearAppBuildSession, setAppBuildSession } from "../../../config/appBuildSession";
import { requestHardwareReport } from "./native";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const desktop = () => setAppBuildSession({ source: "desktop", buildInfo: { edition: "ai", debug: true, version: "test", protocolVersion: 1, target: "windows", profile: "debug" } });
afterEach(() => { clearAppBuildSession(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("hardware budget evidence", () => {
  it("uses budget minus current usage, treats unknown separately from zero and refuses invalid values", () => {
    expect(assessMemoryBudget(1024, 768, 256)).toEqual({ status: "fits", availableBytes: 256 });
    expect(assessMemoryBudget(1024, 768, 257).status).toBe("insufficient");
    expect(assessMemoryBudget(0, 0, 1)).toEqual({ status: "insufficient", availableBytes: 0 });
    expect(assessMemoryBudget(100, 120, 1).availableBytes).toBe(0);
    expect(assessMemoryBudget(null, 0, 1).status).toBe("unknown");
    expect(assessMemoryBudget(100, null, 1).status).toBe("unknown");
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(assessMemoryBudget(value, 0, 1).status).toBe("invalid");
      expect(assessMemoryBudget(100, value, 1).status).toBe("invalid");
    }
    expect(assessMemoryBudget(100, 0, 0).status).toBe("invalid");
  });
  it("keeps fixtures explicit and distinguishes missing budget from failed device query", () => {
    const unknown = previewHardware("unknown-budget");
    expect(unknown.source).toBe("preview"); expect(unknown.devices[0].memory.budgetBytes).toBeNull();
    expect(previewHardware("unsupported").devices[0].candidate.available).toBe(false);
    expect(previewHardware("failure").devices).toEqual([]);
    expect(previewHardware("failure").reason).not.toBeNull();
  });
});
describe("native probe lifecycle", () => {
  it("does not invoke native APIs in a browser or release build", async () => {
    setAppBuildSession({ source: "browser", edition: "ai", debug: true });
    await expect(requestHardwareReport(new AbortController().signal)).rejects.toThrow("桌面");
    setAppBuildSession({ source: "desktop", buildInfo: { edition: "ai", debug: false, version: "test", protocolVersion: 1, target: "windows", profile: "release" } });
    await expect(requestHardwareReport(new AbortController().signal)).rejects.toThrow("桌面");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("bounds waiting and ignores a late success after timeout", async () => {
    desktop(); vi.useFakeTimers(); let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const request = requestHardwareReport(new AbortController().signal);
    const check = expect(request).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(5000); await check;
    finish(previewHardware("candidate")); await Promise.resolve();
    await expect(request).rejects.toThrow("超时");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels waiting, handles a late native rejection and does not start when already cancelled", async () => {
    desktop(); vi.useFakeTimers(); let fail!: (reason: unknown) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const controller = new AbortController(); const request = requestHardwareReport(controller.signal);
    const check = expect(request).rejects.toThrow("取消"); controller.abort(); await check;
    fail(new Error("late failure")); await Promise.resolve();
    await expect(requestHardwareReport(controller.signal)).rejects.toThrow("取消");
    expect(invoke).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
