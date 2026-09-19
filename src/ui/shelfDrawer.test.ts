import { describe, expect, it } from "vitest";

async function readStyles(): Promise<string> {
  // @ts-expect-error The production project intentionally omits @types/node.
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../styles.css", import.meta.url), "utf8");
}

describe("书架抽屉布局契约", () => {
  it("正文模式使用独立共享 query，并保留元数据模式与数据管理入口", async () => {
    // @ts-expect-error The production project intentionally omits @types/node.
    const source = await (await import("node:fs/promises")).readFile(new URL("./ShelfView.tsx", import.meta.url), "utf8");
    expect(source).toContain('type ShelfSearchMode = "metadata" | "body"');
    expect(source).toContain("bodySearch?: ShelfBodySearchProps");
    expect(source).toContain("书名与作者");
    expect(source).toContain("搜索全部书籍正文");
    expect(source.indexOf("数据管理")).toBeGreaterThan(source.indexOf("shelf-body-search"));
  });

  it("滚动区域填满抽屉标题栏以下空间", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(
      /\.shelf-drawer-scroll\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s,
    );
  });

  it("抽屉搜索框保留图标空间并使用固定垂直尺寸", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(
      /\.shelf-drawer-search-wrap \.shelf-drawer-search\s*\{[^}]*width:\s*100%;[^}]*height:\s*42px;[^}]*padding:\s*9px 36px 9px 42px;/s,
    );
    expect(styles).toMatch(
      /\.shelf-drawer-search-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*transform:\s*translateY\(-50%\);/s,
    );
    expect(styles).toMatch(/\.shelf-drawer-search-icon svg\s*\{[^}]*display:\s*block;[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*stroke:\s*currentColor;/s);
  });

  it("抽屉搜索支持自闭环即时结果直达与无障碍触控尺寸契约", async () => {
    // @ts-expect-error The production project intentionally omits @types/node.
    const source = await (await import("node:fs/promises")).readFile(new URL("./ShelfView.tsx", import.meta.url), "utf8");
    expect(source).toContain("shelf-drawer-live-results");
    expect(source).toContain("shelf-drawer-result-item");
    expect(source).toContain("onOpenBook");
    expect(source).toContain("onSearchKeyDown");

    const styles = await readStyles();
    expect(styles).toMatch(/\.shelf-drawer-result-item\s*\{[^}]*min-height:\s*48px;/s);
    expect(styles).toMatch(/\.shelf-drawer-live-results\s*\{[^}]*animation:\s*shelf-fade-in/s);
  });

  it("正文索引管理卡片采用书架统一微光规范与并发微调选择器契约", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.search-concurrency-select-wrap\s*\{/s);
    expect(styles).toMatch(/\.search-index-stepper\s*\{[^}]*height:\s*32px;/s);
    expect(styles).toMatch(/\.search-index-card\s*\{[^}]*border-radius:\s*12px;/s);
    expect(styles).toMatch(/\.search-index-card-actions button\s*\{[^}]*height:\s*32px;/s);
  });

  it("冒烟测试：验证防连击锁与防重入守卫代码契约存在", async () => {
    // @ts-expect-error The production project intentionally omits @types/node.
    const shelfSource = await (await import("node:fs/promises")).readFile(new URL("./ShelfView.tsx", import.meta.url), "utf8");
    expect(shelfSource).toContain("openingBookRef");
    expect(shelfSource).toContain("indexActionBusy");

    // @ts-expect-error The production project intentionally omits @types/node.
    const searchSource = await (await import("node:fs/promises")).readFile(new URL("./SearchPanel.tsx", import.meta.url), "utf8");
    expect(searchSource).toContain("startDebounce");
    expect(searchSource).toContain("search-concurrency-select-wrap");
  });
});
