import { createElement } from "react";
import { expect, it, vi } from "vitest";
import type { DirectoryImportPort, DirectoryProgress } from "../../core/folderImport/contract";
import { createNativeDirectoryImportPort } from "../../platform/directoryImportBridge";
import { createReactDomHarness } from "../../test/reactDomHarness";
import { emptyOrganization } from "../libraryOrganization";
import { libraryCopyChoice, type LibrarySettingsView } from "../librarySettings";
import { FolderImportPanel, type FolderImportPanelProps } from "./FolderImportPanel";

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: nativeInvoke,
  Channel: class {
    onmessage: ((event: DirectoryProgress) => void) | null = null;
  },
}));

const zeroCounts = { completed: 0, imported: 0, duplicates: 0, failed: 0, placementSkipped: 0, createdFolders: 0 };
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

function onePathBookPort() {
  const start = vi.fn<DirectoryImportPort["start"]>(async ({ jobId }) => ({ jobId, status: "completed", counts: zeroCounts, issueCount: 0 }));
  const port: DirectoryImportPort = {
    scan: async () => ({ jobId: "j1", root: { sourceRootKey: "k", name: "书" }, inputCount: 1, skippedDirectoryCount: 0, unreadableDirectoryCount: 0 }),
    page: async () => ({ items: [{ inputId: "i1", relativeParentSegments: [], fileName: "a.epub" }], bindings: [], nextCursor: null }),
    start,
    issues: async () => ({ items: [], nextCursor: null }),
    cancel: async () => "already-finished",
    dispose: async () => {},
  };
  return { port, start };
}

async function previewPanel(extra: Partial<FolderImportPanelProps>) {
  const { port, start } = onePathBookPort();
  const dom = createReactDomHarness();
  await dom.render(createElement(FolderImportPanel, {
    port, organization: emptyOrganization(), autoScan: true, onSettled: () => {}, onClose: () => {}, ...extra,
  }));
  for (let i = 0; i < 3; i++) await dom.run(async () => { await flushAsync(); });
  const startButton = [...dom.container.querySelectorAll("button")].find((button) => button.textContent === "开始导入")!;
  return { dom, start, startButton, box: () => dom.container.querySelector<HTMLInputElement>(".folder-import-copy input") };
}

it("文件夹导入显示同一个“复制到书库”选择，并在开始时把它显式交给原生；未提供时不显示也不传", async () => {
  const onCopyToLibraryChange = vi.fn();
  const shown = await previewPanel({ copyToLibrary: true, onCopyToLibraryChange });
  try {
    expect(shown.box()?.checked).toBe(true);
    // linkedom never flips `checked`, so call React's own onChange as a click would.
    const input = shown.box()! as unknown as Record<string, { onChange(event: { target: { checked: boolean } }): void }>;
    const reactProps = Object.keys(input).find((key) => key.startsWith("__reactProps"))!;
    await shown.dom.run(() => { input[reactProps].onChange({ target: { checked: false } }); });
    expect(onCopyToLibraryChange).toHaveBeenCalledWith(false);
    await shown.dom.click(shown.startButton);
    expect(shown.start).toHaveBeenCalledWith(expect.objectContaining({ jobId: "j1", copyToLibrary: true }));
  } finally {
    await shown.dom.dispose();
  }

  const hidden = await previewPanel({});
  try {
    expect(hidden.box()).toBeNull();
    await hidden.dom.click(hidden.startButton);
    expect(hidden.start.mock.calls[0][0]).not.toHaveProperty("copyToLibrary");
  } finally {
    await hidden.dom.dispose();
  }
});

it("原生桥只在有选择时发送 copyToLibrary；不可用的自选位置仍保留选择，设置文件不可用时不显示", async () => {
  nativeInvoke.mockReset();
  nativeInvoke.mockImplementation(async (_command: string, args: { jobId: string }) => ({ jobId: args.jobId, status: "completed", counts: zeroCounts, issueCount: 0 }));
  const port = createNativeDirectoryImportPort();
  await port.start({ jobId: "j1", options: { grouping: "none", looseRootBooks: "root", existingPlacement: "fillUnclassified" }, targets: [], copyToLibrary: false, onProgress: () => {} });
  await port.start({ jobId: "j2", options: { grouping: "none", looseRootBooks: "root", existingPlacement: "fillUnclassified" }, targets: [], onProgress: () => {} });
  expect(nativeInvoke.mock.calls[0]).toEqual(["directory_import_start", expect.objectContaining({ jobId: "j1", copyToLibrary: false })]);
  expect(nativeInvoke.mock.calls[1][1]).not.toHaveProperty("copyToLibrary");

  const view: LibrarySettingsView = {
    copyOnImport: true, libraryDirectory: "E:\\书\\app\\books-v1", customBaseDirectory: "E:\\书",
    available: true, recoveryPending: false, error: null,
  };
  expect(libraryCopyChoice(view)).toBe(true);
  expect(libraryCopyChoice({ ...view, available: false, error: "自定义书库位置不可用" })).toBe(true);
  expect(libraryCopyChoice({ ...view, copyOnImport: false, customBaseDirectory: null, available: false, error: "损坏" })).toBeUndefined();
  expect(libraryCopyChoice(null)).toBeUndefined();
});
