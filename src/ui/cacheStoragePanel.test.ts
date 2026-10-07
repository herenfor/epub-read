import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createReactDomHarness } from "../test/reactDomHarness";
import type { CacheStorageStatus } from "../platform/cacheStorage";
import { CacheStoragePanel } from "./CacheStoragePanel";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../platform/runtimeCapabilities", () => ({
  getRuntimeCapabilities: () => ({
    platform: "windows",
    shell: "desktop",
    hasDesktopWindowChrome: true,
    usesAndroidBack: false,
    supportsCacheStorage: true,
    supportsCustomCacheDirectory: true,
    supportsLanTransfer: true,
  }),
}));

const baseStatus: CacheStorageStatus = {
  activeDirectory: "C:\\app\\ai",
  configuredBaseDirectory: null,
  restartRequired: false,
  fallbackReason: null,
  totalSizeBytes: 2048,
  caches: [
    {
      kind: "full-text-index",
      displayName: "全文索引",
      itemCount: 1,
      sizeBytes: null,
      updatedAt: 1_700_000_000_000,
      state: "ready",
    },
  ],
};

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((candidate) =>
    (candidate.textContent ?? "").includes(text),
  );
  if (!found) {
    throw new Error(`button not found: ${text}`);
  }
  return found as HTMLButtonElement;
}

describe("CacheStoragePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows status, saves a directory for next restart, and clears full text", async () => {
    const harness = createReactDomHarness();
    let cleared = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "cache_storage_get_status") return cleared
        ? { ...baseStatus, totalSizeBytes: 4096, caches: [{ ...baseStatus.caches[0], itemCount: 0, state: "empty" }] }
        : baseStatus;
      if (command === "ai_cache_clear") { cleared = true; return undefined; }
      if (command === "cache_storage_set_directory") {
        return {
          ...baseStatus,
          configuredBaseDirectory: "C:\\cache",
          restartRequired: true,
        } satisfies CacheStorageStatus;
      }
      return undefined;
    });
    mocks.open.mockResolvedValue("C:\\cache");

    try {
      await harness.render(createElement(CacheStoragePanel, { open: true, onClose: vi.fn() }));
      await harness.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(harness.container.textContent).toContain("C:\\app\\ai");
      expect(harness.container.textContent).toContain("全文索引");

      await harness.click(buttonByText(harness.container, "选择缓存目录"));
      await harness.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.open).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
        title: "选择缓存目录",
      });
      expect(mocks.invoke).toHaveBeenCalledWith("cache_storage_set_directory", {
        baseDirectory: "C:\\cache",
      });
      expect(harness.container.textContent).toContain("C:\\cache");
      expect(harness.container.textContent).toContain("重启应用后生效");

      await harness.click(buttonByText(harness.container, "清除全文索引"));
      await harness.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.invoke).toHaveBeenCalledWith("ai_cache_clear", {
        kind: "full-text-index",
      });
      expect(harness.container.textContent).toContain("4.0 KB");
      expect(harness.container.textContent).toContain("空闲缓存空间已回收");
    } finally {
      await harness.dispose();
    }
  });
  it.each([
    "正在建立全文索引，请完成或取消后再清理",
    "全文索引已清除，但回收缓存空间失败：disk full",
  ])("keeps the cleanup error visible after refreshing status: %s", async (message) => {
    const harness = createReactDomHarness();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "cache_storage_get_status") return baseStatus;
      if (command === "ai_cache_clear") throw message;
      return undefined;
    });
    try {
      await harness.render(createElement(CacheStoragePanel, { open: true, onClose: vi.fn() }));
      await harness.run(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await harness.click(buttonByText(harness.container, "清除全文索引"));
      await harness.run(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain(message);
    } finally {
      await harness.dispose();
    }
  });

  it("offers reset when the database status cannot load and recovers the panel", async () => {
    const harness = createReactDomHarness();
    let broken = true;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "cache_storage_get_status") {
        if (broken) throw "database disk image is malformed";
        return baseStatus;
      }
      if (command === "cache_storage_reset_indexes") { broken = false; return undefined; }
    });
    try {
      await harness.render(createElement(CacheStoragePanel, { open: true, onClose: vi.fn() }));
      await harness.run(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain("malformed");
      await harness.click(buttonByText(harness.container, "重置全部索引缓存"));
      await harness.run(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(mocks.invoke).toHaveBeenCalledWith("cache_storage_reset_indexes");
      expect(harness.container.querySelector('[role="alert"]')).toBeNull();
      expect(harness.container.textContent).toContain("全部索引缓存已重置");
    } finally { await harness.dispose(); }
  });

});
