import { createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import type { LibraryLocationProgress } from "../platform/libraryLocationBridge";
import { LibraryLocationPanel, type LibraryLocationPanelProps } from "./LibraryLocationPanel";
import { resetLibrarySettingsForTest, type LibrarySettingsView } from "./librarySettings";
import { ShelfSettingsPage } from "./ShelfSettingsPage";

const { invoke, pickFolder, channels, capabilities } = vi.hoisted(() => ({
  invoke: vi.fn(),
  pickFolder: vi.fn(),
  channels: [] as Array<{ onmessage: ((event: LibraryLocationProgress) => void) | null }>,
  capabilities: { supportsLibraryFolder: true },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((event: LibraryLocationProgress) => void) | null = null;
    constructor() { channels.push(this); }
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFolder }));
vi.mock("../platform/runtimeCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/runtimeCapabilities")>();
  return {
    ...actual,
    getRuntimeCapabilities: () => ({ ...actual.getRuntimeCapabilities(), supportsCacheStorage: true, supportsLibraryFolder: capabilities.supportsLibraryFolder }),
  };
});

const library: LibrarySettingsView = {
  copyOnImport: true, libraryDirectory: "C:\\Users\\me\\AppData\\Local\\app\\linked-library\\books",
  customBaseDirectory: null, available: true, recoveryPending: false, error: null,
};
const plan = {
  sourceDirectory: library.libraryDirectory, targetDirectory: "E:\\书\\app\\books-v1",
  bookCount: 2, totalBytes: 3 * 1024 * 1024, availableBytes: 50 * 1024 * 1024 * 1024, recoveryPending: false,
};

beforeEach(() => {
  resetLibrarySettingsForTest();
  invoke.mockReset();
  pickFolder.mockReset();
  channels.length = 0;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function panel(overrides: Partial<LibraryLocationPanelProps> = {}) {
  const dom = createReactDomHarness();
  const onChanged = vi.fn();
  await dom.render(createElement(LibraryLocationPanel, { open: true, library, blocked: false, onChanged, onClose: () => {}, ...overrides }));
  const button = (text: string) => [...dom.container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
  const settle = async () => { for (let i = 0; i < 3; i++) await dom.run(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  return { dom, onChanged, button, settle };
}

it("搬到其他文件夹：选目录 → 预检显示目标和空间 → 开始后显示进度 → 完成后重读设置和书架", async () => {
  const run = deferred<unknown>();
  pickFolder.mockResolvedValue("E:\\书");
  invoke.mockImplementation(async (command: string) => {
    if (command === "linked_library_location_plan") return plan;
    if (command === "linked_library_location_start") return run.promise;
    if (command === "linked_library_settings_get") return { ...library, customBaseDirectory: "E:\\书", libraryDirectory: plan.targetDirectory };
  });
  const { dom, onChanged, button, settle } = await panel();
  try {
    await dom.click(button("搬到其他文件夹…")!);
    await settle();
    expect(invoke).toHaveBeenCalledWith("linked_library_location_plan", { baseDirectory: "E:\\书", mode: "move" });
    expect(dom.container.textContent).toContain(plan.targetDirectory);
    expect(dom.container.textContent).toContain("2 本");
    expect(dom.container.textContent).toContain("50.00 GB");

    await dom.click(button("开始")!);
    const [, args] = invoke.mock.calls.find(([command]) => command === "linked_library_location_start")!;
    expect(args).toMatchObject({ baseDirectory: "E:\\书", mode: "move" });
    expect(args.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(button("关闭")!.disabled).toBe(true);
    await dom.run(() => {
      channels[0].onmessage!({ jobId: "other-job", phase: "cleaning", completedBytes: 0, totalBytes: 1, completedBooks: 0, totalBooks: 1 });
      channels[0].onmessage!({ jobId: args.jobId, phase: "verifying", completedBytes: 1024 * 1024, totalBytes: plan.totalBytes, completedBooks: 1, totalBooks: 2 });
    });
    expect(dom.container.textContent).toContain("正在核对");
    expect(dom.container.textContent).toContain("1 / 2 本");

    run.resolve({ jobId: args.jobId, status: "completed", libraryDirectory: plan.targetDirectory, bookCount: 2, cleanupPendingCount: 0 });
    await settle();
    expect(dom.container.textContent).toContain(`书库已搬到：${plan.targetDirectory}`);
    expect(invoke).toHaveBeenCalledWith("linked_library_settings_get");
    expect(onChanged).toHaveBeenCalledTimes(1);
  } finally {
    await dom.dispose();
  }
});

it("取消只是请求：太晚时说明不能取消；失败按错误码提示，并且照样重读设置和书架", async () => {
  const run = deferred<unknown>();
  invoke.mockImplementation(async (command: string) => {
    if (command === "linked_library_location_plan") return { ...plan, targetDirectory: library.libraryDirectory };
    if (command === "linked_library_location_start") return run.promise;
    if (command === "linked_library_location_cancel") return { status: "too-late" };
    if (command === "linked_library_settings_get") return library;
  });
  const { dom, onChanged, button, settle } = await panel({ library: { ...library, customBaseDirectory: "E:\\书" } });
  try {
    await dom.click(button("恢复默认位置")!);
    await settle();
    expect(invoke).toHaveBeenCalledWith("linked_library_location_plan", { baseDirectory: null, mode: "move" });
    await dom.click(button("开始")!);
    const [, args] = invoke.mock.calls.find(([command]) => command === "linked_library_location_start")!;
    await dom.click(button("取消")!);
    await settle();
    expect(invoke).toHaveBeenCalledWith("linked_library_location_cancel", { jobId: args.jobId });
    expect(dom.container.textContent).toContain("已经开始切换，不能再取消");
    expect(button("取消")!.disabled).toBe(true);

    run.reject({ code: "library-verification-failed", message: "hash mismatch" });
    await settle();
    expect(dom.container.querySelector("[role=alert]")!.textContent).toBe("核对书的内容没有通过，没有切换到新位置。");
    expect(invoke).toHaveBeenCalledWith("linked_library_settings_get");
    expect(onChanged).toHaveBeenCalledTimes(1);
  } finally {
    await dom.dispose();
  }
});

it("有书打开或任务进行时不能开始；未完成的更换可处理，仍有残留时提供继续清理", async () => {
  const blocked = await panel({ blocked: true });
  try {
    expect(blocked.dom.container.textContent).toContain("请先关闭正在阅读的书");
    for (const text of ["搬到其他文件夹…", "连接已有书库…", "恢复默认位置"]) expect(blocked.button(text)!.disabled).toBe(true);
  } finally {
    await blocked.dom.dispose();
  }

  const pending = { ...library, customBaseDirectory: "E:\\书", recoveryPending: true };
  invoke.mockImplementation(async (command: string) => {
    if (command === "linked_library_location_recover") return { jobId: "r", status: "cleanup-pending", libraryDirectory: "E:\\书\\app\\books-v1", bookCount: 2, cleanupPendingCount: 1 };
    if (command === "linked_library_settings_get") return pending;
  });
  const { dom, onChanged, button, settle } = await panel({ library: pending });
  try {
    expect(button("恢复默认位置")!.disabled).toBe(false);
    await dom.click(button("处理未完成的更换")!);
    await settle();
    expect(invoke).toHaveBeenCalledWith("linked_library_location_recover", undefined);
    expect(dom.container.textContent).toContain("旧位置还有文件没清理掉");
    expect(button("继续清理")).toBeDefined();
    expect(onChanged).toHaveBeenCalledTimes(1);
  } finally {
    await dom.dispose();
  }
});

it("设置 → 存储：自选位置断开时，“更改书库位置”一行带提示，点开就是书库位置面板", async () => {
  const offline = { ...library, customBaseDirectory: "E:\\书", available: false, error: "自定义书库位置不可用，请重新连接书库" };
  invoke.mockImplementation(async (command: string) => command === "linked_library_settings_get" ? offline : null);
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(ShelfSettingsPage, {
      open: true, presentation: "dialog", initialSection: "storage", busy: false, bookCount: 0, theme: "light",
      onThemeChange: () => {}, onImportArchive: () => {}, onExportArchive: () => {}, onClose: () => {},
    }));
    await dom.run(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const row = [...dom.container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("更改书库位置"))!;
    expect(row.textContent).toContain("书库位置不可用，点此重新连接或恢复默认");
    await dom.click(row);
    expect(dom.container.querySelector("[role=dialog][aria-label='书库位置']")!.textContent).toContain("书库位置现在不可用");
  } finally {
    await dom.dispose();
  }
});
