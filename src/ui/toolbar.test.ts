import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "./Toolbar";

describe("Toolbar 书签与面板互斥渲染", () => {
  it("书签状态激活时 BookmarkIcon 具有 is-active 样式且填充 currentColor", () => {
    const activeHtml = renderToStaticMarkup(
      createElement(Toolbar, {
        title: "测试书籍标题",
        issueCount: 0,
        onToggleBookmark: () => {},
        isBookmarked: true,
      })
    );

    expect(activeHtml).toContain("bookmark-toggle active");
    expect(activeHtml).toContain("is-active");
    expect(activeHtml).toContain('fill="currentColor"');
  });

  it("书签列表不再渲染在工具栏内，只保留触发按钮", () => {
    const html = renderToStaticMarkup(
      createElement(Toolbar, {
        title: "测试书籍标题",
        issueCount: 0,
        onToggleBookmark: () => {},
        onOpenBookmarks: () => {},
        bookmarksOpen: true,
        isBookmarked: true,
      })
    );

    // 浮层已提升为 App 的前景层：工具栏内不得再出现列表、空态与遮罩。
    expect(html).not.toContain("bookmark-pop");
    expect(html).not.toContain("bookmark-backdrop");
    expect(html).not.toContain("bookmark-item");
    expect(html).toContain("bookmark-dropdown active");
    expect(html).toContain('aria-expanded="true"');
    // 打开时顶部状态岛必须保持可见：否则 Pin/旧方向会把入口自己压掉。
    expect(html).toContain("toolbar-top-island is-visible");
  });

  it("打开其他面板时隐藏工具栏及感应区", () => {
    const html = renderToStaticMarkup(
      createElement(Toolbar, {
        title: "测试书籍标题",
        issueCount: 0,
        isPanelOpen: true,
        onOpenToc: () => {},
        onOpenNotes: () => {},
      })
    );

    // 根节点包含 is-suppressed
    expect(html).toContain("toolbar-root is-suppressed");
    // 四方感应区在 DOM 中彻底不渲染
    expect(html).not.toContain("toolbar-sensor");
    // 悬浮胶囊全部保持 is-hidden
    expect(html).toContain("toolbar-top-island is-hidden");
    expect(html).toContain("toolbar-bottom-dock is-hidden");
    expect(html).toContain("left-handle is-hidden");
    expect(html).toContain("right-handle is-hidden");
  });
});
