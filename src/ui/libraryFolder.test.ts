import { createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization } from "./libraryOrganization";
import { copyOnImportNow, ensureLibrarySettings, resetLibrarySettingsForTest, setCopyOnImport } from "./librarySettings";
import { ShelfView, type ShelfViewProps } from "./ShelfView";

const { invoke, capabilities } = vi.hoisted(() => ({ invoke: vi.fn(), capabilities: { supportsLibraryFolder: true } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../platform/runtimeCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/runtimeCapabilities")>();
  return {
    ...actual,
    getRuntimeCapabilities: () => ({ ...actual.getRuntimeCapabilities(), supportsLibraryFolder: capabilities.supportsLibraryFolder }),
  };
});

beforeEach(() => {
  resetLibrarySettingsForTest();
  invoke.mockReset();
  capabilities.supportsLibraryFolder = true;
});

const shown = { copyOnImport: true, libraryDirectory: "C:\\Users\\me\\AppData\\Local\\app\\linked-library\\books", error: null };

it("导入按显示的设置复制：只读一次；读不到设置或不支持的平台都不复制", async () => {
  invoke.mockResolvedValueOnce(shown);
  await expect(copyOnImportNow()).resolves.toBe(true);
  await expect(copyOnImportNow()).resolves.toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("linked_library_settings_get");

  invoke.mockResolvedValueOnce({ ...shown, copyOnImport: false });
  await setCopyOnImport(false);
  expect(invoke).toHaveBeenLastCalledWith("linked_library_settings_set_copy", { enabled: false });
  await expect(copyOnImportNow()).resolves.toBe(false);

  resetLibrarySettingsForTest();
  invoke.mockRejectedValueOnce({ code: "storage", message: "书库设置文件已损坏" });
  await expect(ensureLibrarySettings()).resolves.toMatchObject({ copyOnImport: false, error: "书库设置文件已损坏" });
  await expect(copyOnImportNow()).resolves.toBe(false);

  resetLibrarySettingsForTest();
  capabilities.supportsLibraryFolder = false;
  invoke.mockClear();
  await expect(copyOnImportNow()).resolves.toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});

function props(overrides: Partial<ShelfViewProps>): ShelfViewProps {
  return {
    entries: [], organization: emptyOrganization(), busy: false, theme: "light",
    onThemeChange: () => {}, onOpen: () => {}, onImport: () => {}, onImportArchive: () => {},
    onExportArchive: () => {}, onDelete: () => {}, onDeleteMany: () => {}, onImportFolder: () => {},
    ...overrides,
  };
}

it("导入菜单里的“复制到书库”反映当前选择，切换不关菜单；未提供时不出现", async () => {
  invoke.mockImplementation(async () => null);
  const onCopyToLibraryChange = vi.fn();
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(ShelfView, props({ copyToLibrary: true, onCopyToLibraryChange })));
    await dom.click(dom.container.querySelector(".shelf-import-caret")!);
    const box = () => dom.container.querySelector<HTMLInputElement>(".shelf-import-menu-check input");
    expect(box()?.checked).toBe(true);
    expect(dom.container.querySelector(".shelf-import-menu-check")!.textContent).toContain("复制到书库");
    // linkedom never flips `checked` on click, so React's change event cannot fire there;
    // call the element's own onChange the way React would after a real click.
    const input = box()! as unknown as Record<string, { onChange(event: { target: { checked: boolean } }): void }>;
    const reactProps = Object.keys(input).find((key) => key.startsWith("__reactProps"))!;
    await dom.run(() => { input[reactProps].onChange({ target: { checked: false } }); });
    expect(onCopyToLibraryChange).toHaveBeenCalledWith(false);
    expect(dom.container.querySelector(".shelf-import-menu")).not.toBeNull();

    await dom.render(createElement(ShelfView, props({})));
    expect(box()).toBeNull();
  } finally {
    await dom.dispose();
  }
});
