import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test/reactDomHarness";
import type { CloudSyncStatus } from "../../platform/cloudSyncNative";
import { CloudSyncPanel, cloudSyncFailureText } from "./CloudSyncPanel";
import { resetCloudSyncStoreForTest } from "./cloudSyncStore";

const { invoke, runtime } = vi.hoisted(() => ({ invoke: vi.fn(), runtime: { platform: "windows" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../platform/runtimeCapabilities", () => ({
  getRuntimeCapabilities: () => ({ platform: runtime.platform, supportsCloudSync: true }),
}));

const disconnected: CloudSyncStatus = {
  nativeReady: true, connection: null, phase: "error", lastSuccessAtMs: null,
  retryAtMs: null, lastError: null, pending: false, localChanged: false,
  issues: [], deviceCount: 0, cloudOnlyBookCount: 0, localRecoverySaved: false,
};

beforeEach(() => {
  resetCloudSyncStoreForTest();
  invoke.mockReset();
  runtime.platform = "windows";
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

describe("Linux keyring not ready", () => {
  const notReady: CloudSyncStatus = { ...disconnected, nativeReady: false, phase: "disconnected" };
  const keyringFailure = { code: "native-bridge-unavailable", remote: null, repositoryCode: null };

  async function type(dom: ReturnType<typeof createReactDomHarness>, input: HTMLInputElement, text: string): Promise<void> {
    // Same value-change path as shelfFolderSearch.test: focus + key events on this DOM.
    Object.assign(input, { attachEvent() {}, detachEvent() {} });
    await dom.dispatch(input, new dom.window.Event("focusin", { bubbles: true }));
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
    await dom.dispatch(input, new dom.window.Event("keyup", { bubbles: true }));
  }

  async function fill(dom: ReturnType<typeof createReactDomHarness>): Promise<HTMLButtonElement> {
    const inputs = Array.from(dom.container.querySelectorAll("input"));
    // Jianguoyun preset: username, password, folder, device name.
    await type(dom, inputs[0], "reader@example.com");
    await type(dom, dom.container.querySelector<HTMLInputElement>("input[type=password]")!, "app-password");
    return Array.from(dom.container.querySelectorAll("button")).find((item) => item.textContent === "测试连接")!;
  }

  it("keeps the form usable and says to unlock the keyring; a test retries it at once and the status is re-read", async () => {
    runtime.platform = "linux";
    invoke.mockImplementation(async (command: string) => {
      if (command === "cloud_sync_test_connection") throw keyringFailure;
      return notReady;
    });
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(CloudSyncPanel, { active: true }));
      expect(dom.container.textContent).toContain("没有找到可用的系统密钥环");
      const inputs = Array.from(dom.container.querySelectorAll("input"));
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every((input) => !input.disabled)).toBe(true);
      expect(inputs.at(-1)!.value).toBe("Linux 电脑");
      const test = await fill(dom);
      expect(test.disabled).toBe(false);
      await dom.click(test);
      expect(dom.container.textContent).toContain("系统密钥环暂不可用。请启动并解锁密钥环后重试。");
      expect(invoke.mock.calls.map(([command]) => command)).toEqual(["cloud_sync_get_status", "cloud_sync_test_connection", "cloud_sync_get_status"]);
    } finally {
      await dom.dispose();
    }
  });

  it("once the retried test reaches the keyring the not-ready line goes away", async () => {
    runtime.platform = "linux";
    let ready = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "cloud_sync_test_connection") {
        ready = true;
        return { probeId: "p1", existingSpaceId: null, cloudBookCount: 0, devices: [], issues: [] };
      }
      return ready ? { ...notReady, nativeReady: true } : notReady;
    });
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(CloudSyncPanel, { active: true }));
      await dom.click(await fill(dom));
      expect(dom.container.textContent).not.toContain("系统密钥环");
      expect(Array.from(dom.container.querySelectorAll("button")).some((item) => item.textContent === "创建并连接")).toBe(true);
    } finally {
      await dom.dispose();
    }
  });

  it("a locked keyring at save time names the keyring, not only a reconnect", () => {
    const t = ((key: string) => key) as unknown as Parameters<typeof cloudSyncFailureText>[0];
    const locked = { code: "credential-unavailable", remote: null, repositoryCode: null };
    runtime.platform = "linux";
    expect(cloudSyncFailureText(t, locked)).toBe("cloudSync.error.credential-unavailable.linux");
    runtime.platform = "windows";
    expect(cloudSyncFailureText(t, locked)).toBe("cloudSync.error.credential-unavailable");
  });

  it("Windows and Android keep blocking the form while secure storage is not ready", async () => {
    invoke.mockResolvedValue(notReady);
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(CloudSyncPanel, { active: true }));
      expect(dom.container.textContent).toContain("这台设备的安全存储或证书校验暂不可用");
      expect(Array.from(dom.container.querySelectorAll("input")).every((input) => input.disabled)).toBe(true);
      expect(Array.from(dom.container.querySelectorAll("input")).at(-1)!.value).toBe("Windows 电脑");
    } finally {
      await dom.dispose();
    }
  });
});
