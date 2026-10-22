import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization } from "./libraryOrganization";
import { ShelfView, type ShelfViewProps } from "./ShelfView";

const capabilities = vi.hoisted(() => ({ supportsLanTransfer: true }));

vi.mock("../platform/runtimeCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/runtimeCapabilities")>();
  return {
    ...actual,
    getRuntimeCapabilities: () => ({
      ...actual.getRuntimeCapabilities(),
      supportsLanTransfer: capabilities.supportsLanTransfer,
    }),
  };
});

function props(overrides: Partial<ShelfViewProps> = {}): ShelfViewProps {
  return {
    entries: [],
    organization: emptyOrganization(),
    busy: false,
    theme: "light",
    onThemeChange: () => {},
    onOpen: vi.fn(),
    onImport: () => {},
    onImportArchive: () => {},
    onExportArchive: () => {},
    onDelete: () => {},
    onDeleteMany: () => {},
    onApplyOrganization: async () => {},
    ...overrides,
  };
}

it("导入菜单里有设备互传，和设置入口同样在存档任务进行时禁用、互传进行中可回到面板", async () => {
  capabilities.supportsLanTransfer = true;
  const onOpenLanTransfer = vi.fn();
  const dom = createReactDomHarness();
  try {
    // Even without folder import, the caret opens the menu for 设备互传.
    await dom.render(createElement(ShelfView, props({ onOpenLanTransfer })));
    const caret = () => dom.container.querySelector<HTMLButtonElement>(".shelf-import-caret")!;
    const lanItem = () => [...dom.container.querySelectorAll<HTMLButtonElement>(".shelf-import-menu-item")]
      .find((item) => item.querySelector("strong")?.textContent === "设备互传");
    await dom.click(caret());
    expect(lanItem()?.textContent).toContain("扫码与另一台设备互传书和阅读进度");
    await dom.click(lanItem()!);
    expect(onOpenLanTransfer).toHaveBeenCalledTimes(1);
    expect(onOpenLanTransfer.mock.calls[0]).toEqual([]);

    await dom.render(createElement(ShelfView, props({ onOpenLanTransfer, saveFileActive: true })));
    await dom.click(caret());
    expect(lanItem()!.disabled).toBe(true);
    await dom.render(createElement(ShelfView, props({ onOpenLanTransfer, saveFileActive: true, lanTransferActive: true })));
    expect(lanItem()!.disabled).toBe(false);
  } finally {
    await dom.dispose();
  }
});

it("不支持互传的平台导入菜单不显示设备互传", async () => {
  capabilities.supportsLanTransfer = false;
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(ShelfView, props({ onOpenLanTransfer: vi.fn() })));
    expect(dom.container.querySelector(".shelf-import-caret")).toBeNull();
    await dom.render(createElement(ShelfView, props({ onOpenLanTransfer: vi.fn(), onImportFolder: vi.fn() })));
    await dom.click(dom.container.querySelector<HTMLButtonElement>(".shelf-import-caret")!);
    const titles = [...dom.container.querySelectorAll(".shelf-import-menu-item strong")].map((item) => item.textContent);
    expect(titles).toEqual(["导入图书", "导入文件夹"]);
  } finally {
    await dom.dispose();
  }
});
