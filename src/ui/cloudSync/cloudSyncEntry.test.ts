import { createElement, Fragment } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test/reactDomHarness";
import type { CloudSyncStatus } from "../../platform/cloudSyncNative";
import { CloudSyncQuickAction, useCloudSyncRowDetail } from "./CloudSyncPanel";
import { adoptCloudSyncStatus, cloudSyncNeedsAttention, resetCloudSyncStoreForTest } from "./cloudSyncStore";
import { ProgressSourceChoices, type ProgressSourceCandidate } from "./ProgressSourceChoices";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../platform/runtimeCapabilities", () => ({
  getRuntimeCapabilities: () => ({ platform: "android", supportsCloudSync: true }),
}));

const connected: CloudSyncStatus = {
  nativeReady: true,
  connection: { connectionId: "c1", baseUrl: "https://dav.example/dav/", remoteRoot: "EPUBReader", username: "u", spaceId: "s", deviceLabel: "phone" },
  phase: "idle", lastSuccessAtMs: null, retryAtMs: null, lastError: null, pending: false, localChanged: false,
  issues: [], deviceCount: 1, cloudOnlyBookCount: 0, localRecoverySaved: false,
};
const failure = (code: string, remote: string | null = null) => ({
  code, remote: remote ? { code: remote, httpStatus: null, retryAfterSeconds: null, cleanupFailed: false } : null, repositoryCode: null,
});

beforeEach(() => {
  resetCloudSyncStoreForTest();
  invoke.mockReset();
});

it("红点只给不会自动重试的失败：退避、取消、正常状态都不亮", () => {
  expect(cloudSyncNeedsAttention({ ...connected, phase: "error", lastError: failure("remote", "authentication") })).toBe(true);
  expect(cloudSyncNeedsAttention({ ...connected, connection: null, phase: "error", lastError: failure("local-state-invalid") })).toBe(true);
  expect(cloudSyncNeedsAttention({ ...connected, phase: "error", lastError: failure("remote", "network"), retryAtMs: 5 })).toBe(false);
  expect(cloudSyncNeedsAttention({ ...connected, phase: "waiting", lastError: failure("remote", "timeout"), retryAtMs: 5 })).toBe(false);
  expect(cloudSyncNeedsAttention({ ...connected, phase: "error", lastError: failure("cancelled") })).toBe(false);
  expect(cloudSyncNeedsAttention({ ...connected, phase: "idle", lastError: null })).toBe(false);
  expect(cloudSyncNeedsAttention(null)).toBe(false);
});

function SyncRow() {
  return createElement(Fragment, null,
    createElement("small", null, useCloudSyncRowDetail()),
    createElement(CloudSyncQuickAction));
}

it("设置“更多”里的立即同步：未连接不显示，已连接请求一轮，进行中不可再点且不提前报成功", async () => {
  invoke.mockImplementation(async (command: string) => command === "cloud_sync_trigger" ? { ...connected, phase: "syncing" } : connected);
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(SyncRow));
    expect(dom.container.querySelector("button")).toBeNull();
    expect(dom.container.textContent).toBe("坚果云或 WebDAV 网盘");

    await dom.run(() => { adoptCloudSyncStatus(connected); });
    expect(dom.container.textContent).toContain("还没有同步过");
    const button = dom.container.querySelector<HTMLButtonElement>(".cloud-sync-quick")!;
    await dom.click(button);
    expect(invoke).toHaveBeenCalledWith("cloud_sync_trigger", { reason: "manual" });
    expect(button.disabled).toBe(true);
    expect(dom.container.querySelector("small")!.textContent).toBe("正在同步…");

    await dom.run(() => { adoptCloudSyncStatus({ ...connected, lastSuccessAtMs: Date.now() }); });
    expect(button.disabled).toBe(false);
    expect(dom.container.querySelector("small")!.textContent).toMatch(/^上次同步 \d\d:\d\d$/);
  } finally {
    await dom.dispose();
  }
});

const LOCAL = "00000000-0000-4000-8000-000000000001";
const TABLET = "00000000-0000-4000-8000-000000000002";
const OLD = "00000000-0000-4000-8000-000000000003";
const candidates: ProgressSourceCandidate[] = [
  { key: "a", deviceId: LOCAL, progressPct: 12, updatedAtMs: Date.UTC(2026, 9, 20, 8) },
  { key: "b", deviceId: TABLET, progressPct: 47.6, updatedAtMs: Date.UTC(2026, 9, 23, 8) },
  { key: "c", deviceId: OLD, progressPct: 30, updatedAtMs: Date.UTC(2026, 9, 21, 8) },
];

async function renderChoices(onChoose: (candidate: ProgressSourceCandidate) => void) {
  const dom = createReactDomHarness();
  await dom.render(createElement(ProgressSourceChoices, { candidates, onChoose }));
  await dom.run(async () => { await Promise.resolve(); });
  const rows = () => [...dom.container.querySelectorAll(".progress-source-item")];
  const names = () => rows().map((row) => row.querySelector("strong")!.textContent);
  return { dom, rows, names };
}

it("多份进度按设备名＋时间展示、最新在上，本机/未知来源明确标出，位置用百分比", async () => {
  invoke.mockResolvedValue([
    { eventDeviceId: LOCAL, deviceName: "我的手机", isLocal: true },
    { eventDeviceId: TABLET, deviceName: "客厅平板", isLocal: false },
    { eventDeviceId: OLD, deviceName: null, isLocal: false },
  ]);
  const onChoose = vi.fn();
  const view = await renderChoices(onChoose);
  try {
    expect(invoke).toHaveBeenCalledWith("cloud_sync_progress_sources", { eventDeviceIds: [LOCAL, TABLET, OLD] });
    expect(view.names()).toEqual(["客厅平板", "未知设备", "本机"]);
    expect(view.rows()[0].querySelector(".progress-source-where")!.textContent).toBe("读到 48%");
    expect(view.rows()[0].querySelector("time")!.textContent).not.toBe("");
    await view.dom.click(view.rows()[1]);
    expect(onChoose).toHaveBeenCalledWith(candidates[2]);
  } finally {
    await view.dom.dispose();
  }
});

it("来源查询失败只影响名字：全部显示未知设备，仍可选择", async () => {
  invoke.mockRejectedValue({ code: "repository-not-ready" });
  const onChoose = vi.fn();
  const view = await renderChoices(onChoose);
  try {
    expect(view.names()).toEqual(["未知设备", "未知设备", "未知设备"]);
    await view.dom.click(view.rows()[0]);
    expect(onChoose).toHaveBeenCalledWith(candidates[1]);
  } finally {
    await view.dom.dispose();
  }
});
