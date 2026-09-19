import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "./Toolbar";

async function readStyles(): Promise<string> {
  // @ts-expect-error The project intentionally does not include @types/node.
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../styles.css", import.meta.url), "utf8");
}

describe("Toolbar 四方空间协同架构、无界环境地脚与多彩矢量契约", () => {
  it("四方协同感应与浮岛/手柄样式契约", async () => {
    const styles = await readStyles();
    // 根层与四方感应区
    expect(styles).toMatch(/\.toolbar-root\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*left:\s*0;[^}]*right:\s*0;[^}]*z-index:\s*35;/s);
    expect(styles).toMatch(/\.toolbar-sensor\.top-sensor\s*\{[^}]*top:\s*0;[^}]*height:\s*20px;/s);
    expect(styles).toMatch(/\.toolbar-sensor\.bottom-sensor\s*\{[^}]*bottom:\s*0;[^}]*height:\s*22px;/s);
    expect(styles).toMatch(/\.toolbar-sensor\.left-sensor\s*\{[^}]*width:\s*22px;/s);
    expect(styles).toMatch(/\.toolbar-sensor\.right-sensor\s*\{[^}]*width:\s*22px;/s);

    // 顶部状态岛与底部操作坞圆角与 400ms 缓减速曲线
    expect(styles).toMatch(/\.toolbar-top-island\s*\{[^}]*border-radius:\s*21px;/s);
    expect(styles).toMatch(/\.toolbar-bottom-dock\s*\{[^}]*border-radius:\s*21px;/s);
    expect(styles).toMatch(/\.toolbar-top-island\s*\{[^}]*transition:\s*transform\s*400ms\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/s);
    expect(styles).toMatch(/\.toolbar-bottom-dock\s*\{[^}]*transition:\s*transform\s*400ms\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/s);

    // 左右边缘微手柄
    expect(styles).toMatch(/\.toolbar-side-handle\.left-handle\s*\{[^}]*left:\s*12px;/s);
    expect(styles).toMatch(/\.toolbar-side-handle\.right-handle\s*\{[^}]*right:\s*12px;/s);
    expect(styles).toMatch(/\.tb-side-btn\s*\{[^}]*border-radius:\s*19px;/s);
    expect(styles).toMatch(/\.reader-svg-icon\s*\{[^}]*display:\s*block;[^}]*flex-shrink:\s*0;/s);
  });

  it("底端状态栏去白线与无界环境地脚智能避让契约", async () => {
    const styles = await readStyles();
    // 彻底消除贯穿白线与实体灰块
    expect(styles).toMatch(/\.status-bar\s*\{[^}]*background:\s*transparent;[^}]*border-top:\s*none;/s);
    // 操作坞唤出时，中央章节名优雅淡隐让位
    expect(styles).toMatch(/\.app:has\(\.toolbar-bottom-dock\.is-visible\)\s*\.status-bar\s*\.sb-title\s*\{[^}]*opacity:\s*0;/s);
  });

  it("多彩矢量色彩系统：各功能按键具备独立优雅色彩与柔光悬停", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.tb-back \.reader-svg-icon\s*\{\s*color:\s*#e06c53;\s*\}/);
    expect(styles).toMatch(/\.tb-menu \.reader-svg-icon\s*\{\s*color:\s*#6366f1;\s*\}/);
    expect(styles).toMatch(/\.bookmark-toggle \.reader-svg-icon\s*\{\s*color:\s*#f43f5e;\s*\}/);
    expect(styles).toMatch(/\.tb-toc \.reader-svg-icon\s*\{\s*color:\s*#10b981;\s*\}/);
    expect(styles).toMatch(/\.tb-search \.reader-svg-icon\s*\{\s*color:\s*#0ea5e9;\s*\}/);
    expect(styles).toMatch(/\.tb-notes \.reader-svg-icon\s*\{\s*color:\s*#f59e0b;\s*\}/);
    expect(styles).toMatch(/\.tb-assistant \.reader-svg-icon\s*\{\s*color:\s*#a855f7;\s*\}/);
    expect(styles).toMatch(/\.tb-pin \.reader-svg-icon\s*\{\s*color:\s*#8b5cf6;\s*\}/);
    expect(styles).toMatch(/\.tb-side-toc \.reader-svg-icon\s*\{\s*color:\s*#10b981;\s*\}/);
    expect(styles).toMatch(/\.tb-side-notes \.reader-svg-icon\s*\{\s*color:\s*#f59e0b;\s*\}/);
  });

  it("胶囊组契约：阅读位置历史与书签采用 32px 高度与现代微圆角", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.toolbar-history\s*\{[^}]*height:\s*32px;[^}]*border-radius:\s*8px;/s);
    expect(styles).toMatch(/\.toolbar-bookmark\s*\{[^}]*height:\s*32px;[^}]*border-radius:\s*8px;/s);
    expect(styles).toMatch(/\.bookmark-pop\.closing\s*\{[^}]*animation:\s*bookmark-pop-out\s*150ms/s);
  });

  it("上下悬浮栏高度/厚度统一与无界通透幽灵设计语言契约", async () => {
    const styles = await readStyles();
    // 上下悬浮栏高度严格统一为 42px，圆角统一为 21px
    expect(styles).toMatch(/\.toolbar-top-island\s*\{[^}]*height:\s*42px;[^}]*border-radius:\s*21px;/s);
    expect(styles).toMatch(/\.toolbar-bottom-dock\s*\{[^}]*height:\s*42px;[^}]*border-radius:\s*21px;/s);

    // 底部操作坞按需紧凑包裹，消除两侧多余空区
    expect(styles).toMatch(/\.toolbar-bottom-dock\s*\{[^}]*width:\s*fit-content;/s);

    // 底部操作坞按钮全面贯彻无界通透幽灵圆形（Zero-Box Ghost Disc）
    expect(styles).toMatch(/\.tb-dock-btn\s*\{[^}]*border-radius:\s*50%;[^}]*background:\s*transparent;/s);

    // 底部历史记录微胶囊采用与顶部书签完全一致的 Ghost Twin Capsule 语言
    expect(styles).toMatch(/\.toolbar-bottom-dock\s+\.toolbar-history\s*\{[^}]*background:\s*transparent;[^}]*border-radius:\s*9999px;/s);
  });

  it("四方协同渲染与 1.5px 矢量 SVG 契约（无原生遗留 Emoji）", () => {
    const html = renderToStaticMarkup(
      createElement(Toolbar, {
        title: "测试书籍标题",
        issueCount: 2,
        onBackToShelf: () => {},
        onHistoryBack: () => {},
        canHistoryBack: true,
        onHistoryForward: () => {},
        canHistoryForward: true,
        onToggleMenu: () => {},
        onToggleBookmark: () => {},
        isBookmarked: false,
        onOpenBookmarks: () => {},
        onOpenToc: () => {},
        onOpenSearch: () => {},
        onOpenNotes: () => {},
        onOpenAssistant: () => {},
        onToggleLog: () => {},
      })
    );

    // 严禁出现生硬遗留字符或原生 Emoji
    expect(html).not.toContain("← 书架");
    expect(html).not.toContain("↩");
    expect(html).not.toContain("↪");
    expect(html).not.toContain("☰");
    expect(html).not.toContain("🔖");
    expect(html).not.toContain("📖");
    expect(html).not.toContain("🔍");
    expect(html).not.toContain("📝");

    // 必须包含四方协同架构与 1.5px 矢量 SVG 图标
    expect(html).toContain("toolbar-root");
    expect(html).toContain("toolbar-sensor top-sensor");
    expect(html).toContain("toolbar-sensor bottom-sensor");
    expect(html).toContain("toolbar-sensor left-sensor");
    expect(html).toContain("toolbar-sensor right-sensor");
    expect(html).toContain("toolbar-side-handle left-handle");
    expect(html).toContain("toolbar-side-handle right-handle");
    expect(html).toContain("tb-side-toc");
    expect(html).toContain("tb-side-notes");
    expect(html).toContain("toolbar-top-island");
    expect(html).toContain("toolbar-bottom-dock");
    expect(html).toContain("reader-svg-icon");
    expect(html).toContain('stroke-width="1.5"');
    expect(html).toContain("tb-back");
    expect(html).toContain("tb-pin");
    expect(html).toContain("tb-history-back");
    expect(html).toContain("tb-history-forward");
    expect(html).toContain("bookmark-toggle");
    expect(html).toContain("bookmark-dropdown");
    expect(html).toContain("tb-toc");
    expect(html).toContain("tb-search");
    expect(html).toContain("tb-notes");
    expect(html).toContain("tb-menu");
    expect(html).toContain("tb-assistant");
    expect(html).not.toContain("tb-diagnostics"); // 诊断已下沉至二级设置菜单
  });

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

  it("书签弹出浮层支持平滑退场并在展开时渲染矢量书签项目", () => {
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

  it("当 isPanelOpen 为 true 时，工具栏四方感应区与悬浮胶囊完全静音抑制", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(/\.toolbar-root\.is-suppressed\s*\{[^}]*pointer-events:\s*none\s*!important;/s);
    expect(styles).toMatch(/\.toolbar-root\.is-suppressed\s*\.toolbar-sensor\s*\{[^}]*display:\s*none\s*!important;/s);

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
