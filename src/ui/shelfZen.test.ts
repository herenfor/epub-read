import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ShelfEntry } from "./shelf";
import { emptyOrganization, type LibraryOrganization } from "./libraryOrganization";
import { ShelfView, type ShelfViewProps } from "./ShelfView";
import { createReactDomHarness } from "../test/reactDomHarness";

function makeEntry(id: string, title: string, creator: string, progressPct: number, lastReadAtMs = 0): ShelfEntry {
  return {
    id,
    title,
    creator,
    fileName: `${title}.epub`,
    fileSize: 2048,
    coverMime: "image/jpeg",
    addedAtMs: 1000,
    lastReadAtMs,
    spineIndex: 2,
    page: 5,
    progressPct,
    anchorIndex: null,
    anchorRatio: null,
    contentHash: id.repeat(4),
    isNew: false,
  };
}

describe("ShelfZen Packet 1 现代书架体验", () => {
  it("Level 1: 渲染极简顶栏、藏书微标签与快速书名过滤框", async () => {
    const dom = createReactDomHarness();
    const book1 = makeEntry("b1", "三国演义", "罗贯中", 35, 5000);
    const book2 = makeEntry("b2", "水浒传", "施耐庵", 0, 0);

    const props: ShelfViewProps = {
      entries: [book1, book2],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 总数只在“全部 N”筛选上显示，品牌区不再重复“藏书 N 本”
      expect(dom.container.querySelector(".shelf-total-badge")).toBeNull();

      // 验证极速快速过滤框
      const quickFilter = dom.container.querySelector(".shelf-quick-filter-input") as HTMLInputElement;
      expect(quickFilter).not.toBeNull();
      expect(quickFilter.getAttribute("placeholder")).toContain("快速搜书名... (按 / 键聚焦)");

      // 验证视图切换按钮
      const viewToggles = dom.container.querySelectorAll(".shelf-view-toggle-btn");
      expect(viewToggles.length).toBe(2);
    } finally {
      await dom.dispose();
    }
  });

  it("Level 2: 渲染正在阅读续读控制台，支持点击开书与折叠", async () => {
    const dom = createReactDomHarness();
    const opened: string[] = [];
    const bookReading = makeEntry("reading-1", "红楼梦", "曹雪芹", 45, 10000);
    const bookUnread = makeEntry("unread-1", "西游记", "吴承恩", 0, 0);

    const props: ShelfViewProps = {
      entries: [bookReading, bookUnread],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: (id) => opened.push(id),
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 验证续读控制台存在
      const stage = dom.container.querySelector(".shelf-resume-stage");
      expect(stage).not.toBeNull();

      // 验证书名与锚点提示
      const title = dom.container.querySelector(".shelf-resume-title");
      expect(title?.textContent).toBe("红楼梦");

      const anchor = dom.container.querySelector(".shelf-resume-anchor-text");
      expect(anchor?.textContent).toContain("上次读到：第 3 章 · 45%");

      // 点击继续阅读开书
      const resumeBtn = dom.container.querySelector(".shelf-btn-resume");
      expect(resumeBtn).not.toBeNull();
      await dom.click(resumeBtn!);
      expect(opened).toEqual(["reading-1"]);

      // 点击折叠按钮收起为单行条
      const toggleBtn = dom.container.querySelector(".shelf-resume-toggle-btn");
      expect(toggleBtn).not.toBeNull();
      await dom.click(toggleBtn!);

      const collapsed = dom.container.querySelector(".shelf-resume-collapsed");
      expect(collapsed).not.toBeNull();
      expect(collapsed?.textContent).toContain("《红楼梦》");
    } finally {
      await dom.dispose();
    }
  });

  it("Level 2: 无已读书籍时自动隐藏续读控制台", async () => {
    const dom = createReactDomHarness();
    const bookUnread = makeEntry("unread-1", "西游记", "吴承恩", 0, 0);

    const props: ShelfViewProps = {
      entries: [bookUnread],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));
      const stage = dom.container.querySelector(".shelf-resume-stage");
      expect(stage).toBeNull();
    } finally {
      await dom.dispose();
    }
  });

  it("Level 3: 状态分流胶囊组统计正确，点击分流切换", async () => {
    const dom = createReactDomHarness();
    const b1 = makeEntry("b1", "正在读书籍", "作者A", 50, 5000);
    const b2 = makeEntry("b2", "未读书籍", "作者B", 0, 0);
    const b3 = makeEntry("b3", "已读完书籍", "作者C", 100, 8000);

    const props: ShelfViewProps = {
      entries: [b1, b2, b3],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 验证各胶囊按钮计数
      const capsules = Array.from(dom.container.querySelectorAll(".shelf-capsule-tab"));
      expect(capsules.length).toBe(5);

      const texts = capsules.map((c) => c.textContent?.trim());
      expect(texts[0]).toContain("全部3");
      expect(texts[1]).toContain("正在读1");
      expect(texts[2]).toContain("未读1");
      expect(texts[3]).toContain("已读完1");
      expect(texts[4]).toContain("收藏0");

      // 点击“正在读”胶囊
      await dom.click(capsules[1]);
      const cardsAfterReading = dom.container.querySelectorAll(".shelf-card");
      expect(cardsAfterReading.length).toBe(1);
      expect(cardsAfterReading[0].getAttribute("data-book-id")).toBe("b1");

      // 点击“未读”胶囊
      await dom.click(capsules[2]);
      const cardsAfterUnread = dom.container.querySelectorAll(".shelf-card");
      expect(cardsAfterUnread.length).toBe(1);
      expect(cardsAfterUnread[0].getAttribute("data-book-id")).toBe("b2");
    } finally {
      await dom.dispose();
    }
  });

  it("Level 3: 集中式文件夹下拉菜单展开与切换", async () => {
    const dom = createReactDomHarness();
    const org: LibraryOrganization = {
      schemaVersion: 1,
      folders: {
        "f-hist": {
          name: { value: "历史", stamp: { counter: 1, deviceId: "dev-1" } },
        },
      },
      books: {},
    };

    const props: ShelfViewProps = {
      entries: [],
      organization: org,
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      const folderBtn = dom.container.querySelector(".shelf-folder-dropdown-btn");
      expect(folderBtn).not.toBeNull();
      expect(folderBtn?.textContent).toContain("文件夹 (1)");

      // 点击展开下拉
      await dom.click(folderBtn!);
      const popover = dom.container.querySelector(".shelf-folder-popover-menu");
      expect(popover).not.toBeNull();
      expect(popover?.textContent).toContain("历史");
      expect(popover?.textContent).toContain("新建文件夹");
    } finally {
      await dom.dispose();
    }
  });

  it("Packet 2: 莫兰迪算法优雅兜底封套渲染与样式类验证", async () => {
    const dom = createReactDomHarness();
    const book = makeEntry("morandi-1", "百年孤独", "马尔克斯", 20);

    const props: ShelfViewProps = {
      entries: [book],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 验证莫兰迪封套与书脊阴影
      const morandiCover = dom.container.querySelector(".morandi-cover");
      expect(morandiCover).not.toBeNull();
      expect(morandiCover?.querySelector(".morandi-spine-shadow")).not.toBeNull();
      expect(morandiCover?.querySelector(".morandi-inner-frame")).not.toBeNull();

      // 验证水印文字与书名同时保留向后兼容类
      const watermark = dom.container.querySelector(".morandi-watermark");
      expect(watermark).not.toBeNull();
      expect(watermark?.classList.contains("fallback-mark")).toBe(true);
      expect(watermark?.textContent).toBe("百");

      const title = dom.container.querySelector(".morandi-title");
      expect(title).not.toBeNull();
      expect(title?.classList.contains("fallback-title")).toBe(true);
      expect(title?.textContent).toBe("百年孤独");
    } finally {
      await dom.dispose();
    }
  });

  it("Packet 2: 切换到列表视图（Table View）渲染数据表格与行点击开书", async () => {
    const dom = createReactDomHarness();
    const opened: string[] = [];
    const b1 = makeEntry("b1", "红楼梦", "曹雪芹", 40);
    const b2 = makeEntry("b2", "三国演义", "罗贯中", 80);

    const props: ShelfViewProps = {
      entries: [b1, b2],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: (id) => opened.push(id),
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 切换到列表视图
      const listToggle = dom.container.querySelector('.shelf-view-toggle-btn[title="列表视图"]');
      expect(listToggle).not.toBeNull();
      await dom.click(listToggle!);

      // 验证渲染出 shelf-table-view 与 shelf-table
      const table = dom.container.querySelector(".shelf-table");
      expect(table).not.toBeNull();

      // 验证表头包含书名、进度、大小、阅读时间等
      const ths = Array.from(dom.container.querySelectorAll(".shelf-table th")).map((th) => th.textContent?.trim());
      expect(ths).toContain("封面");
      expect(ths.some((t) => t?.includes("书名"))).toBe(true);
      expect(ths.some((t) => t?.includes("进度"))).toBe(true);

      // 验证数据行包含进度条与缩略图
      const rows = dom.container.querySelectorAll(".shelf-table-row");
      expect(rows.length).toBe(2);

      const firstRow = rows[0];
      expect(firstRow.querySelector(".shelf-table-thumb-box")).not.toBeNull();
      expect(firstRow.querySelector(".shelf-table-title")?.textContent).toBe("红楼梦");
      expect(firstRow.querySelector(".shelf-table-progress-text")?.textContent).toBe("40%");

      // 点击行触发开书
      await dom.click(firstRow);
      expect(opened).toEqual(["b1"]);
    } finally {
      await dom.dispose();
    }
  });

  it("Packet 2: 书名排序且多书时触发 A-Z 快速定位索引轨与吐司", async () => {
    const dom = createReactDomHarness();
    const books = [
      makeEntry("1", "阿Q正传", "鲁迅", 10),
      makeEntry("2", "百年孤独", "马尔克斯", 20),
      makeEntry("3", "红楼梦", "曹雪芹", 30),
      makeEntry("4", "三国演义", "罗贯中", 40),
      makeEntry("5", "水浒传", "施耐庵", 50),
      makeEntry("6", "西游记", "吴承恩", 60),
    ];

    const props: ShelfViewProps = {
      entries: books,
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 切换为书名排序
      const sortSelect = dom.container.querySelector(".shelf-sort-select-zen") as HTMLSelectElement;
      expect(sortSelect).not.toBeNull();
      const option = sortSelect.querySelector('option[value="title"]') as HTMLOptionElement | null;
      if (option) option.selected = true;
      const changeEvt = new (dom.container.ownerDocument.defaultView as unknown as {
        Event: new (type: string, init?: { bubbles?: boolean }) => Event;
      }).Event("change", { bubbles: true });
      Object.defineProperty(changeEvt, "target", { value: { value: "title" } });
      sortSelect.dispatchEvent(changeEvt);

      // 重新渲染后 A-Z 索引轨出现
      await new Promise((r) => setTimeout(r, 50));
      const azRail = dom.container.querySelector(".shelf-az-rail");
      expect(azRail).not.toBeNull();

      // 点击字母 'B' (百年孤独)
      const letterBtns = Array.from(dom.container.querySelectorAll(".shelf-az-letter"));
      const bBtn = letterBtns.find((b) => b.textContent?.trim() === "B");
      expect(bBtn).not.toBeNull();
      expect(bBtn?.classList.contains("disabled")).toBe(false);

      await dom.click(bBtn!);

      // 验证弹出 350ms 吐司
      const toast = dom.container.querySelector(".shelf-az-toast");
      expect(toast).not.toBeNull();
      expect(toast?.textContent).toBe("B");
    } finally {
      await dom.dispose();
    }
  });

  it("Packet 2: 多选模式下唤起底部悬浮批量操作底坞 (Floating Batch Bar)", async () => {
    const dom = createReactDomHarness();
    const b1 = makeEntry("b1", "书一", "作者", 0);
    const b2 = makeEntry("b2", "书二", "作者", 0);

    const props: ShelfViewProps = {
      entries: [b1, b2],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 点击顶栏“管理”按钮进入多选模式
      const manageBtn = dom.container.querySelector(".shelf-manage-toggle-btn");
      expect(manageBtn).not.toBeNull();
      expect(manageBtn?.textContent).toContain("批量选择");
      await dom.click(manageBtn!);

      // 点击第一本书勾选
      const firstCard = dom.container.querySelector('[data-book-id="b1"]');
      expect(firstCard).not.toBeNull();
      await dom.click(firstCard!);

      // 验证底部悬浮操作底坞出现
      const dock = dom.container.querySelector(".shelf-floating-batch-dock");
      expect(dock).not.toBeNull();
      expect(dock?.textContent).toContain("已选 1 本");
      expect(dock?.textContent).toContain("移至文件夹");
      expect(dock?.textContent).toContain("删除");

      // 点击取消按钮退出多选
      const cancelBtn = dock?.querySelector(".shelf-batch-action-btn.cancel");
      expect(cancelBtn).not.toBeNull();
      await dom.click(cancelBtn!);

      // 验证触发 150ms 退场动效类 is-closing
      expect(dom.container.querySelector(".shelf-floating-batch-dock.is-closing")).not.toBeNull();

      // 150ms 动效结束后悬浮底坞自动移除
      await new Promise((r) => setTimeout(r, 160));
      expect(dom.container.querySelector(".shelf-floating-batch-dock")).toBeNull();
    } finally {
      await dom.dispose();
    }
  });

  it("Packet 2: 新建文件夹弹窗点击取消触发 150ms 平滑关闭动画", async () => {
    const dom = createReactDomHarness();
    const props: ShelfViewProps = {
      entries: [],
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: () => {},
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
    };

    try {
      await dom.render(createElement(ShelfView, props));

      // 展开文件夹下拉并点击新建文件夹
      const folderBtn = dom.container.querySelector(".shelf-folder-dropdown-btn");
      await dom.click(folderBtn!);
      const newFolderBtn = dom.container.querySelector(".shelf-folder-menu-new-btn");
      await dom.click(newFolderBtn!);

      // 验证确认弹窗出现
      const backdrop = dom.container.querySelector(".shelf-confirm-backdrop");
      expect(backdrop).not.toBeNull();
      expect(backdrop?.classList.contains("is-closing")).toBe(false);

      // 点击取消
      const cancelBtn = backdrop?.querySelector(".shelf-selection-cancel");
      expect(cancelBtn).not.toBeNull();
      await dom.click(cancelBtn!);

      // 验证添加了 is-closing 动画类
      expect(backdrop?.classList.contains("is-closing")).toBe(true);
    } finally {
      await dom.dispose();
    }
  });
});


describe("书架计数与最近在读补修", () => {
  function props(entries: ShelfEntry[], onOpen = (_id: string) => {}): ShelfViewProps {
    return {
      entries, organization: emptyOrganization(), busy: false, theme: "light",
      onThemeChange: () => {}, onOpen, onImport: () => {}, onImportArchive: () => {},
      onExportArchive: () => {}, onDelete: () => {}, onDeleteMany: () => {},
    };
  }

  function prefs() {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === "epub_shelf_resume_collapsed" ? "false" : null,
      setItem: () => {},
    });
  }

  it("待统计的已读书计入在读，计数和网格/表格筛选一致", async () => {
    const dom = createReactDomHarness();
    prefs();
    const pending = Array.from({ length: 20 }, (_, i) => ({
      ...makeEntry(`pending-${i}`, `待统计${i}`, "作者", 0, 10000 + i),
      progressPctPending: true,
    }));
    const unread = { ...makeEntry("unread", "真正未读", "作者", 0), isNew: true, spineIndex: 0, page: 0 };
    const entries = [...pending, unread, makeEntry("reading", "在读", "作者", 30, 5000),
      makeEntry("finished", "完成", "作者", 100, 5000)];
    try {
      await dom.render(createElement(ShelfView, props(entries)));
      const tabs = () => [...dom.container.querySelectorAll(".shelf-capsule-tab")];
      const counts = () => tabs().map(tab => tab.querySelector(".shelf-capsule-count")?.textContent);
      expect(counts()).toEqual(["23", "21", "1", "1", "0"]);
      await dom.click(tabs()[2]);
      expect([...dom.container.querySelectorAll(".shelf-card")].map(e => e.getAttribute("data-book-id"))).toEqual(["unread"]);
      await dom.click(dom.container.querySelector('[aria-label="列表视图"]')!);
      expect([...dom.container.querySelectorAll(".shelf-table-row[data-book-id]")].map(e => e.getAttribute("data-book-id"))).toEqual(["unread"]);
      await dom.click(tabs()[1]);
      expect(dom.container.querySelectorAll(".shelf-table-row[data-book-id]")).toHaveLength(21);
      await dom.render(createElement(ShelfView, props(entries.map(e => e.id === "pending-0"
        ? { ...e, progressPct: 25, progressPctPending: false } : e))));
      expect(counts()).toEqual(["23", "21", "1", "1", "0"]);
      await dom.click(tabs()[3]);
      expect([...dom.container.querySelectorAll(".shelf-table-row[data-book-id]")].map(e => e.getAttribute("data-book-id"))).toEqual(["finished"]);
    } finally { await dom.dispose(); }
  });

  it("更多在读仅展示最近10本，排序、选择开书和全书架计数不受截断影响", async () => {
    const dom = createReactDomHarness();
    prefs();
    const opened: string[] = [];
    const books = Array.from({ length: 41 }, (_, i) => makeEntry(`recent-${i}`, `在读${i}`, "作者", 35, 10000 + i));
    const entries = [...books.filter((_, i) => i % 2), ...books.filter((_, i) => !(i % 2)),
      makeEntry("finished", "已经读完", "作者", 100, 99999)];
    try {
      await dom.render(createElement(ShelfView, props(entries, id => opened.push(id))));
      const more = dom.container.querySelector(".shelf-more-reading-btn")!;
      expect(more.textContent).toContain("更多在读 (10)");
      await dom.click(more);
      const items = [...dom.container.querySelectorAll(".shelf-more-reading-item")];
      expect(items.map(e => e.querySelector(".shelf-more-reading-item-title")?.textContent))
        .toEqual(books.slice(-10).reverse().map(e => e.title));
      await dom.click(items[9]);
      expect(dom.container.querySelector(".shelf-resume-title")?.textContent).toBe("在读31");
      await dom.click(dom.container.querySelector(".shelf-resume-continue")!);
      expect(opened).toEqual(["recent-31"]);
      const readingTab = dom.container.querySelectorAll(".shelf-capsule-tab")[1];
      expect(readingTab.querySelector(".shelf-capsule-count")?.textContent).toBe("41");
      await dom.click(readingTab);
      expect(dom.container.querySelectorAll(".shelf-card").length).toBeGreaterThan(10);
      expect(dom.container.querySelector('[data-book-id="recent-11"]')).not.toBeNull();
    } finally { await dom.dispose(); }
  });
});
