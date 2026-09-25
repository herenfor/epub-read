import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ShelfEntry } from "./shelf";
import {
  emptyOrganization,
  type LibraryOrganization,
  type OrganizationCommand,
  type ShelfScope,
} from "./libraryOrganization";
import { isShelfCardActionTarget } from "./shelfCardEventScope";
import { ShelfView, type ShelfViewProps } from "./ShelfView";
import { createReactDomHarness } from "../test/reactDomHarness";

const DEVICE = "00000000-0000-4000-8000-00000000000a";
const FOLDER_A = "11111111-1111-4111-8111-111111111111";
const FOLDER_GONE = "33333333-3333-4333-8333-333333333333";
const HASH_FILED = "a".repeat(64);
const HASH_LOOSE = "b".repeat(64);

function entry(id: string, hash: string, title: string, progressPct: number): ShelfEntry {
  return {
    id,
    title,
    creator: "作者",
    fileName: `${title}.epub`,
    fileSize: 1024,
    coverMime: "image/jpeg",
    addedAtMs: 1,
    lastReadAtMs: 2,
    spineIndex: 0,
    page: 1,
    progressPct,
    anchorIndex: null,
    anchorRatio: null,
    contentHash: hash,
    isNew: false,
  };
}

const filedBook = entry("id-filed", HASH_FILED, "文件夹里的书", 42);
const looseBook = entry("id-loose", HASH_LOOSE, "未归类的书", 7);

function organizationWithFolder(): LibraryOrganization {
  const base = emptyOrganization();
  return {
    ...base,
    folders: {
      [FOLDER_A]: { name: { value: "资料", stamp: { counter: 1, deviceId: DEVICE } } },
      [FOLDER_GONE]: {
        name: { value: "已解散", stamp: { counter: 2, deviceId: DEVICE } },
        deleted: { counter: 3, deviceId: DEVICE },
      },
    },
    books: {
      [HASH_FILED]: {
        folderId: { value: FOLDER_A, stamp: { counter: 4, deviceId: DEVICE } },
        favorite: { value: true, stamp: { counter: 5, deviceId: DEVICE } },
      },
      [HASH_LOOSE]: {
        // 引用了一个已解散 / 未知的文件夹：按有效归属视为未归类。
        folderId: { value: FOLDER_GONE, stamp: { counter: 6, deviceId: DEVICE } },
      },
    },
  };
}

type Harness = ReturnType<typeof createReactDomHarness>;

function childrenOf(root: unknown): Element[] {
  return Array.from((root as { children: ArrayLike<Element> }).children);
}

function findByTextWithin(root: unknown, text: string): HTMLElement {
  const match = childrenOf(root).find((el) => (el.textContent ?? "").trim() === text);
  if (!match) throw new Error(`missing element with text: ${text}`);
  return match as unknown as HTMLElement;
}

function cardFor(dom: Harness, bookId: string): HTMLElement {
  const card = dom.container.querySelector(`[data-book-id="${bookId}"]`);
  if (!card) throw new Error(`missing book card: ${bookId}`);
  return card as unknown as HTMLElement;
}

/** linkedom 没有 KeyboardEvent；直接派发带 key 的通用事件即可满足 React 的合成事件读取。 */
async function pressEnter(dom: Harness, element: Element): Promise<void> {
  const event = new (dom.container.ownerDocument.defaultView as unknown as {
    Event: new (type: string, init: { bubbles: boolean }) => Event;
  }).Event("keydown", { bubbles: true });
  Object.assign(event, { key: "Enter" });
  element.dispatchEvent(event);
}

function cardMenu(dom: Harness, bookId: string): Element {
  const menu = cardFor(dom, bookId).querySelector(".shelf-card-pop-menu");
  if (!menu) throw new Error(`menu is not open for: ${bookId}`);
  return menu as unknown as Element;
}

interface RenderOptions {
  scope?: ShelfScope;
  busy?: boolean;
  onApplyOrganization?: (command: OrganizationCommand) => Promise<void>;
}

async function renderShelf(options: RenderOptions = {}) {
  const dom = createReactDomHarness();
  const opened: string[] = [];
  const commands: OrganizationCommand[] = [];
  const onApplyOrganization =
    options.onApplyOrganization ??
    (async (command: OrganizationCommand) => {
      commands.push(command);
    });

  const props: ShelfViewProps = {
    entries: [filedBook, looseBook],
    organization: organizationWithFolder(),
    scope: options.scope ?? { type: "root" },
    busy: options.busy ?? false,
    theme: "light",
    onThemeChange: () => {},
    onOpen: (id) => opened.push(id),
    onImport: () => {},
    onImportArchive: () => {},
    onExportArchive: () => {},
    onDelete: () => {},
    onDeleteMany: () => {},
    onApplyOrganization,
  };

  await dom.render(createElement(ShelfView, props));

  return {
    dom,
    opened,
    commands,
    async openMenu(bookId: string): Promise<Element> {
      const more = cardFor(dom, bookId).querySelector(".shelf-card-more-btn");
      if (!more) throw new Error(`missing more button: ${bookId}`);
      await dom.click(more);
      return cardMenu(dom, bookId);
    },
    async openFolderModal(): Promise<void> {
      const folderCard = dom.container.querySelector(`[data-folder-id="${FOLDER_A}"]`);
      if (!folderCard) throw new Error("missing folder card");
      await dom.click(folderCard);
    },
  };
}

describe("ShelfCard 文件夹内开书", () => {
  it("文件夹弹窗内点击封面与标题打开原书", async () => {
    const shelf = await renderShelf();
    try {
      await shelf.openFolderModal();
      const card = cardFor(shelf.dom, filedBook.id);
      const cover = card.querySelector(".shelf-cover-box");
      if (!cover) throw new Error("missing cover");
      await shelf.dom.click(cover);
      await shelf.dom.click(card.querySelector(".shelf-card-title")!);
      expect(shelf.opened).toEqual([filedBook.id, filedBook.id]);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("点击菜单与收藏按钮不误开书", async () => {
    const shelf = await renderShelf();
    try {
      await shelf.openFolderModal();
      const card = cardFor(shelf.dom, filedBook.id);
      const star = card.querySelector(".shelf-card-star-btn");
      if (!star) throw new Error("missing star button");
      await shelf.dom.click(star);
      const menu = await shelf.openMenu(filedBook.id);
      await shelf.dom.click(findByTextWithin(menu, "打开阅读"));
      // 只有菜单里的“打开阅读”开书，星标与菜单按钮本身不开书。
      expect(shelf.opened).toEqual([filedBook.id]);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("焦点在卡片内菜单按钮上时 Enter 不冒泡开书", async () => {
    const shelf = await renderShelf();
    try {
      await shelf.openFolderModal();
      const card = cardFor(shelf.dom, filedBook.id);
      await pressEnter(shelf.dom, card.querySelector(".shelf-card-more-btn")!);
      expect(shelf.opened).toEqual([]);
      // 卡片自身获得键盘激活时仍然开书。
      await pressEnter(shelf.dom, card);
      expect(shelf.opened).toEqual([filedBook.id]);
    } finally {
      await shelf.dom.dispose();
    }
  });
});

describe("isShelfCardActionTarget", () => {
  it("外层文件夹 dialog 不算卡片内部控件，卡片内控件才算", async () => {
    const dom = createReactDomHarness();
    try {
      const document = dom.container.ownerDocument;
      const create = (html: string): Element =>
        Object.assign(document.createElement("div"), { innerHTML: html })
          .firstElementChild as Element;
      const card = create('<div class="shelf-card"><button>菜单</button><span>标题</span></div>');
      const outsideButton = create("<button>外部</button>");
      document.body.appendChild(card);
      document.body.appendChild(outsideButton);
      const inner = card.querySelector("button")!;
      expect(isShelfCardActionTarget(inner, card)).toBe(true);
      expect(isShelfCardActionTarget(card.querySelector("span"), card)).toBe(false);
      expect(isShelfCardActionTarget(card, card)).toBe(false);
      expect(isShelfCardActionTarget(outsideButton, card)).toBe(false);
      expect(isShelfCardActionTarget(null, card)).toBe(false);
    } finally {
      await dom.dispose();
    }
  });
});

describe("从文件夹移除", () => {
  it("文件夹内菜单发出 folderId:null 的 moveBooks 命令", async () => {
    const shelf = await renderShelf({ scope: { type: "folder", folderId: FOLDER_A } });
    try {
      const menu = await shelf.openMenu(filedBook.id);
      expect(menu.textContent).toContain("从文件夹移除");
      expect(menu.textContent).toContain("从书架删除");
      await shelf.dom.click(findByTextWithin(menu, "从文件夹移除"));
      expect(shelf.commands).toEqual([
        { type: "moveBooks", contentHashes: [HASH_FILED], folderId: null },
      ]);
      // 移出只写归属寄存器：收藏与进度不在命令里，也不走删除接口。
      expect(shelf.dom.container.querySelector(".shelf-confirm")).toBeNull();
      expect(filedBook.progressPct).toBe(42);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("已解散 / 未知文件夹与未归类书不显示移出入口", async () => {
    const shelf = await renderShelf();
    try {
      const looseMenu = await shelf.openMenu(looseBook.id);
      expect(looseMenu.textContent).not.toContain("从文件夹移除");
      expect(looseMenu.textContent).toContain("从书架删除");
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("失败时不伪移出并在菜单内提示原因", async () => {
    const shelf = await renderShelf({
      scope: { type: "folder", folderId: FOLDER_A },
      onApplyOrganization: vi.fn().mockRejectedValue(new Error("index locked")),
    });
    try {
      const menu = await shelf.openMenu(filedBook.id);
      await shelf.dom.click(findByTextWithin(menu, "从文件夹移除"));
      const alert = menu.querySelector("[role='alert']");
      expect(alert?.textContent).toContain("index locked");
      // 书籍仍在文件夹视图内，删除确认也未出现。
      expect(cardFor(shelf.dom, filedBook.id)).toBeTruthy();
      expect(shelf.dom.container.querySelector(".shelf-confirm")).toBeNull();
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("全局忙时禁用移出按钮且不发命令", async () => {
    const shelf = await renderShelf({
      scope: { type: "folder", folderId: FOLDER_A },
      busy: true,
    });
    try {
      const menu = await shelf.openMenu(filedBook.id);
      const removeButton = findByTextWithin(menu, "从文件夹移除") as HTMLButtonElement;
      // 组件按 disabled={removePending || props.busy} 渲染；linkedom 不把 disabled
      // 反射到属性上，因此这里同时校验属性与等效的可观察行为。
      expect(removeButton.hasAttribute("disabled")).toBe(true);
      await shelf.dom.click(removeButton);
      expect(shelf.commands).toEqual([]);
    } finally {
      await shelf.dom.dispose();
    }
  });
});
