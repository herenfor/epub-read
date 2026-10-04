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
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "cache_storage_get_status") return baseStatus;
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
    } finally {
      await harness.dispose();
    }
  });
  it("keeps the cleanup error visible after refreshing status", async () => {
    const harness = createReactDomHarness();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "cache_storage_get_status") return baseStatus;
      if (command === "ai_cache_clear") throw new Error("正在建立全文索引，请完成或取消后再清理");
      return undefined;
    });
    try {
      await harness.render(createElement(CacheStoragePanel, { open: true, onClose: vi.fn() }));
      await harness.run(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await harness.click(buttonByText(harness.container, "清除全文索引"));
      await harness.run(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain("正在建立全文索引");
    } finally {
      await harness.dispose();
    }
  });

});
