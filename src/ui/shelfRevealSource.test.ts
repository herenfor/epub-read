import { createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization } from "./libraryOrganization";
import { revealShelfSource, type ShelfEntry } from "./shelf";
import { groupShelfActions, shelfBookActions } from "./shelfActions";
import { ShelfView, type ShelfViewProps } from "./ShelfView";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => { invoke.mockReset(); });

function entry(id: string, title: string, available = true): ShelfEntry {
  return {
    id, title, creator: "作者", fileName: `${title}.epub`, fileSize: 1024, coverMime: "image/jpeg",
    addedAtMs: 1, lastReadAtMs: 2, spineIndex: 0, page: 1, progressPct: 10,
    anchorIndex: null, anchorRatio: null, contentHash: id.padEnd(64, "0"), isNew: false, available,
  };
}

it("“在文件资源管理器中打开”排在导出之后；不可用的书禁用，未提供时不出现", () => {
  const base = {
    favorite: false, inFolder: false, busy: false, deleteDisabled: false, canSelect: false,
    canFavorite: false, canMove: false, canRemoveFromFolder: false, canExport: true,
  };
  const ids = (ctx: Parameters<typeof shelfBookActions>[0]) =>
    groupShelfActions(shelfBookActions(ctx)).map((g) => `${g.group}:${g.actions.map((a) => a.id).join(",")}`);
  expect(ids(base)).toEqual(["read:open", "organize:exportBook", "danger:delete"]);
  expect(ids({ ...base, canReveal: true })).toEqual(["read:open", "organize:exportBook,revealSource", "danger:delete"]);
  const reveal = (ctx: Parameters<typeof shelfBookActions>[0]) => shelfBookActions(ctx).find((a) => a.id === "revealSource");
  expect(reveal({ ...base, canReveal: true })?.disabled).toBe(false);
  // Busy (open/delete) does not block a read-only look; a missing file does.
  expect(reveal({ ...base, canReveal: true, busy: true })?.disabled).toBe(false);
  expect(reveal({ ...base, canReveal: true, revealDisabled: true })?.disabled).toBe(true);
});

function props(entries: ShelfEntry[], onRevealSource?: (entry: ShelfEntry) => void): ShelfViewProps {
  return {
    entries, organization: emptyOrganization(), busy: false, theme: "light",
    onThemeChange: () => {}, onOpen: () => {}, onImport: () => {}, onImportArchive: () => {},
    onExportArchive: () => {}, onDelete: () => {}, onDeleteMany: () => {}, onRevealSource,
  };
}

async function menuItem(dom: ReturnType<typeof createReactDomHarness>, bookId: string): Promise<HTMLButtonElement | undefined> {
  await dom.click(dom.container.querySelector(`[data-book-id="${bookId}"] .shelf-card-more-btn`)!);
  const menu = dom.container.ownerDocument.querySelector(".shelf-action-popover, .shelf-action-sheet")!;
  return [...menu.querySelectorAll<HTMLButtonElement>(".shelf-action-item")]
    .find((item) => (item.textContent ?? "").trim() === "在文件资源管理器中打开");
}

it("书籍菜单点击后把这本书交给 App；缺文件的书禁用，未接线的平台不显示", async () => {
  const onRevealSource = vi.fn();
  const ok = entry("ok", "在的书");
  const gone = entry("gone", "不在的书", false);
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(ShelfView, props([ok, gone], onRevealSource)));
    const item = await menuItem(dom, ok.id);
    expect(item?.disabled).toBe(false);
    await dom.click(item!);
    expect(onRevealSource).toHaveBeenCalledWith(ok);
  } finally {
    await dom.dispose();
  }

  const disabled = createReactDomHarness();
  try {
    await disabled.render(createElement(ShelfView, props([ok, gone], onRevealSource)));
    expect((await menuItem(disabled, gone.id))?.disabled).toBe(true);
  } finally {
    await disabled.dispose();
  }

  const absent = createReactDomHarness();
  try {
    await absent.render(createElement(ShelfView, props([ok])));
    expect(await menuItem(absent, ok.id)).toBeUndefined();
  } finally {
    await absent.dispose();
  }
});

it("桥接只发送内容指纹，原生错误转成可读文字", async () => {
  invoke.mockResolvedValueOnce({ status: "missing" });
  await expect(revealShelfSource("a".repeat(64))).resolves.toBe("missing");
  expect(invoke).toHaveBeenCalledWith("linked_library_reveal_source", { contentHash: "a".repeat(64) });

  invoke.mockRejectedValueOnce({ code: "storage", message: "无法打开文件资源管理器：拒绝访问" });
  await expect(revealShelfSource("a".repeat(64))).rejects.toThrow("无法打开文件资源管理器：拒绝访问");
});
