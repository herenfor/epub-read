import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TocPanel } from "./TocPanel";
import { NotesPanel } from "./NotesPanel";
import { LogPanel } from "./LogPanel";
import { SearchPanel } from "./SearchPanel";
import { MenuPanel } from "./MenuPanel";

async function readStyles(): Promise<string> {
  // @ts-expect-error The project intentionally does not include @types/node.
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../styles.css", import.meta.url), "utf8");
}

describe("阅读器全量二级面板方向性浮岛与移动端 Bottom Sheet 契约", () => {
  it("PC 桌面端按触发源方向弹出：左书脊目录、右切口笔记、底部居中控制台", async () => {
    const styles = await readStyles();

    // 目录：从左侧划出的书脊浮岛
    expect(styles).toMatch(/\.toc-panel\s*\{[^}]*position:\s*fixed;[^}]*left:\s*14px;[^}]*border-radius:\s*18px;/s);
    expect(styles).toMatch(/\.toc-panel\s*\{[^}]*backdrop-filter:\s*blur\(24px\);/s);

    // 笔记：从右侧划出的切口浮岛
    expect(styles).toMatch(/\.notes-panel\s*\{[^}]*position:\s*fixed;[^}]*right:\s*14px;[^}]*border-radius:\s*18px;/s);
    expect(styles).toMatch(/\.notes-panel\s*\{[^}]*backdrop-filter:\s*blur\(24px\);/s);

    // 搜索、设置、日志：从底部居中升起的控制台浮岛
    expect(styles).toMatch(/\.search-panel\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*20px;[^}]*left:\s*50%;[^}]*border-radius:\s*20px;/s);
    expect(styles).toMatch(/\.menu-panel\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*20px;[^}]*left:\s*50%;[^}]*border-radius:\s*20px;/s);
    expect(styles).toMatch(/\.log-panel\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*20px;[^}]*left:\s*50%;[^}]*border-radius:\s*20px;/s);
  });

  it("统一遮罩体系、入场动画关键帧与移动端 Bottom Sheet 变形契约", async () => {
    const styles = await readStyles();

    // 统一微光蒙层遮罩
    expect(styles).toMatch(/\.toc-backdrop,\s*\.menu-backdrop,\s*\.search-backdrop,\s*\.notes-backdrop,\s*\.log-backdrop,\s*\.ai-backdrop\s*\{/s);

    // 必须包含三方向平滑入场动画关键帧（绝无缺失丢失）
    expect(styles).toMatch(/@keyframes panel-float-from-left\s*\{[\s\S]*?from\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?to\s*\{[\s\S]*?opacity:\s*1;/);
    expect(styles).toMatch(/@keyframes panel-float-from-right\s*\{[\s\S]*?from\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?to\s*\{[\s\S]*?opacity:\s*1;/);
    expect(styles).toMatch(/@keyframes panel-float-from-bottom\s*\{[\s\S]*?from\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?to\s*\{[\s\S]*?opacity:\s*1;/);

    // 基础静态样式透明度必须为 1，确保动画不支持或降级时绝不永久透明
    expect(styles).toMatch(/\.toc-panel\s*\{[^}]*opacity:\s*1;/s);
    expect(styles).toMatch(/\.menu-panel\s*\{[^}]*opacity:\s*1;/s);
    expect(styles).toMatch(/\.notes-panel\s*\{[^}]*opacity:\s*1;/s);
    expect(styles).toMatch(/\.search-panel\s*\{[^}]*opacity:\s*1;/s);
    expect(styles).toMatch(/\.log-panel\s*\{[^}]*opacity:\s*1;/s);

    // 严禁存在 legacy 的低 z-index 绝对定位 duplicate backdrop
    expect(styles).not.toMatch(/\.toc-backdrop\s*\{[^}]*z-index:\s*29;/);

    // 移动端媒体查询下变形为 Bottom Sheet
    expect(styles).toMatch(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.drawer-drag-handle\s*\{[^}]*display:\s*block;[\s\S]*?\.toc-panel,\s*\.notes-panel,\s*\.search-panel,\s*\.menu-panel,\s*\.font-settings-panel,\s*\.log-panel\s*\{[^}]*bottom:\s*12px\s*!important;[^}]*border-radius:\s*20px\s*!important;/s);
  });

  it("面板结构契约：均具备 drawer-drag-handle 与 1.5px 矢量 CloseIcon，彻底清除原生 ✕/× 字符", () => {
    // 目录面板
    const tocHtml = renderToStaticMarkup(
      createElement(TocPanel, {
        toc: [{ label: "第一章", href: "ch1.xhtml", children: [] }],
        onNavigate: () => {},
        onClose: () => {},
      })
    );
    expect(tocHtml).toContain("drawer-drag-handle");
    expect(tocHtml).toContain("tb-close");
    expect(tocHtml).toContain("reader-svg-icon icon-close");
    expect(tocHtml).not.toContain("✕");
    expect(tocHtml).not.toContain("×");

    // 笔记面板
    const notesHtml = renderToStaticMarkup(
      createElement(NotesPanel, {
        notes: [],
        onClose: () => {},
        onNavigate: () => {},
      })
    );
    expect(notesHtml).toContain("drawer-drag-handle");
    expect(notesHtml).toContain("tb-close");
    expect(notesHtml).toContain("reader-svg-icon icon-close");
    expect(notesHtml).not.toContain("✕");
    expect(notesHtml).not.toContain("×");

    // 日志面板
    const logHtml = renderToStaticMarkup(
      createElement(LogPanel, {
        items: [{ kind: "info", source: "test", message: "测试日志" }],
        onClose: () => {},
      })
    );
    expect(logHtml).toContain("drawer-drag-handle");
    expect(logHtml).toContain("log-backdrop");
    expect(logHtml).toContain("tb-close");
    expect(logHtml).toContain("reader-svg-icon icon-close");
    expect(logHtml).not.toContain("✕");
    expect(logHtml).not.toContain("×");

    // 搜索面板
    const searchHtml = renderToStaticMarkup(
      createElement(SearchPanel, {
        query: "",
        onQueryChange: () => {},
        results: [],
        status: "idle",
        processed: 0,
        total: 0,
        onSelect: () => {},
        onClose: () => {},
      })
    );
    expect(searchHtml).toContain("drawer-drag-handle");
    expect(searchHtml).toContain("search-backdrop");
    expect(searchHtml).toContain("tb-close");
    expect(searchHtml).toContain("reader-svg-icon icon-close");
    expect(searchHtml).not.toContain("✕");
    expect(searchHtml).not.toContain("×");

    // 设置与外观面板
    const menuHtml = renderToStaticMarkup(
      createElement(MenuPanel, {
        fontSize: 16,
        uiScale: 1,
        theme: "light",
        forceHorizontal: false,
        readingMode: "paginated",
        onReadingModeChange: () => {},
        pageOptions: { readingMode: "paginated", columnsPerView: 1, gapPx: 24 },
        pageEffectiveColumns: 1,
        pageFixedLayout: false,
        onPageOptionsChange: () => {},
        userFonts: [],
        fontBusy: false,
        onImportFont: () => {},
        onDeleteFont: () => {},
        onCustomFontNameChange: () => {},
        onCustomCssChange: () => {},
        onOpenFontSettings: () => {},
        onForceHorizontalChange: () => {},
        onOpenFile: () => {},
        onFontDec: () => {},
        onFontInc: () => {},
        onFontSizeChange: () => {},
        onLineHeightDec: () => {},
        onLineHeightInc: () => {},
        onLineHeightChange: () => {},
        onWeightDec: () => {},
        onWeightInc: () => {},
        onWeightChange: () => {},
        onLetterSpacingDec: () => {},
        onLetterSpacingInc: () => {},
        onLetterSpacingChange: () => {},
        onWordSpacingDec: () => {},
        onWordSpacingInc: () => {},
        onWordSpacingChange: () => {},
        onUiScaleChange: () => {},
        onThemeChange: () => {},
        onResetDefaults: () => {},
        onClose: () => {},
      })
    );
    expect(menuHtml).toContain("drawer-drag-handle");
    expect(menuHtml).toContain("tb-close");
    expect(menuHtml).toContain("reader-svg-icon icon-close");
    expect(menuHtml).not.toContain("✕");
    expect(menuHtml).not.toContain("×");
  });

  it("目录滚动容器、完全隐藏滚动条与统一现代极简字体排版契约", async () => {
    const styles = await readStyles();

    // 目录长列表必须拥有独立的 .toc-content 滚动容器，保证向下翻阅不受截断
    const tocHtml = renderToStaticMarkup(
      createElement(TocPanel, {
        toc: [
          { label: "第一章", href: "ch1.xhtml", children: [] },
          { label: "第二章", href: "ch2.xhtml", children: [] },
        ],
        activeHref: "ch2.xhtml",
        onNavigate: () => {},
        onClose: () => {},
      })
    );
    expect(tocHtml).toContain('class="toc-content"');
    expect(tocHtml).toContain("toc-item level-0 active");
    expect(tocHtml).not.toContain("background:var(--accent)"); // 杜绝生硬内联实底蓝块

    // CSS 中 .toc-content 必须具备独立垂直滚动与包含裁剪
    expect(styles).toMatch(/\.toc-content\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/s);

    // 用户明确要求：目录与菜单面板完全看不到滚动条，同时保留滚轮/触控滚动能力
    expect(styles).toMatch(
      /\.toc-panel,\s*\.toc-content,\s*\.menu-panel\s*\{[^}]*scrollbar-width:\s*none\s*!important;[^}]*-ms-overflow-style:\s*none\s*!important;/s
    );
    expect(styles).toMatch(
      /\.toc-panel::-webkit-scrollbar,\s*\.toc-content::-webkit-scrollbar,\s*\.menu-panel::-webkit-scrollbar\s*\{[^}]*display:\s*none\s*!important;[^}]*width:\s*0\s*!important;/s
    );

    // 统一现代极简字体体系与层级微光高亮
    expect(styles).toMatch(/\.toc-panel\s*\{[^}]*font-family:\s*-apple-system/s);
    expect(styles).toMatch(/\.menu-panel\s*\{[^}]*font-family:\s*-apple-system/s);
    expect(styles).toMatch(/\.toc-item\.active\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--accent\) 12%, transparent\);/s);
    expect(styles).toMatch(/\.toc-item\.active\s*\{[^}]*box-shadow:\s*inset 3px 0 0 var\(--accent\);/s);
  });
});
