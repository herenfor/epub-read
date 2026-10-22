import { createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test/reactDomHarness";
import type { CloudSyncStatus } from "../../platform/cloudSyncNative";
import { CloudSyncPanel } from "./CloudSyncPanel";
import { resetCloudSyncStoreForTest } from "./cloudSyncStore";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../platform/runtimeCapabilities", () => ({
  getRuntimeCapabilities: () => ({ platform: "windows", supportsCloudSync: true }),
}));

const disconnected: CloudSyncStatus = {
  nativeReady: true, connection: null, phase: "error", lastSuccessAtMs: null,
  retryAtMs: null, lastError: null, pending: false, localChanged: false,
  issues: [], deviceCount: 0, cloudOnlyBookCount: 0, localRecoverySaved: false,
};

beforeEach(() => {
  resetCloudSyncStoreForTest();
  invoke.mockReset();
});

it("damaged sync state can be explicitly isolated before reconnecting, without a live connection", async () => {
  const problem = { ...disconnected, lastError: { code: "local-state-invalid", remote: null, repositoryCode: null } };
  const recovered = { ...disconnected, phase: "disconnected", localRecoverySaved: true };
  invoke.mockImplementation(async (command: string) => command === "cloud_sync_disconnect" ? recovered : problem);
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(CloudSyncPanel, { active: true }));
    expect(dom.container.textContent).toContain("本机同步记录已损坏");
    expect(dom.container.querySelector("input")).toBeNull();
    const button = (text: string) => Array.from(dom.container.querySelectorAll("button"))
      .find((item) => item.textContent === text)!;
    await dom.click(button("断开连接"));
    expect(invoke.mock.calls.filter(([command]) => command === "cloud_sync_disconnect")).toHaveLength(0);
    await dom.click(button("断开连接"));
    expect(invoke.mock.calls.filter(([command]) => command === "cloud_sync_disconnect")).toHaveLength(1);
    expect(dom.container.textContent).toContain("已另存");
    expect(dom.container.querySelector("input[type=password]")).not.toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "cloud_sync_test_connection" || command === "cloud_sync_connect")).toBe(false);
  } finally {
    await dom.dispose();
  }
});

it("a newer sync sidecar is shown as blocked, without a destructive recovery or connection form", async () => {
  invoke.mockResolvedValue({ ...disconnected, lastError: { code: "unsupported-local-version", remote: null, repositoryCode: null } });
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(CloudSyncPanel, { active: true }));
    expect(dom.container.textContent).toContain("请先更新本应用");
    expect(dom.container.querySelector("input")).toBeNull();
    expect(dom.container.querySelector("button")).toBeNull();
    expect(invoke.mock.calls).toEqual([["cloud_sync_get_status"]]);
  } finally {
    await dom.dispose();
  }
});
