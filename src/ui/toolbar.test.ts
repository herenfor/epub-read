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

  it("展开书签菜单时显示摘录和章节", () => {
    const popHtml = renderToStaticMarkup(
      createElement(Toolbar, {
        title: "测试书籍标题",
        issueCount: 0,
        onToggleBookmark: () => {},
        bookmarkMenuOpen: true,
        bookmarks: [
          {
            id: "b1",
            text: "重要段落摘录",
            spineIndex: 0,
            page: 1,
            createdAtMs: Date.now(),
            chapterLabel: "第一章",
          },
        ],
      })
    );

    expect(popHtml).toContain("bookmark-pop");
    expect(popHtml).toContain("bookmark-item");
    expect(popHtml).toContain("重要段落摘录");
    expect(popHtml).toContain("第一章");
    expect(popHtml).toContain("reader-svg-icon");
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
