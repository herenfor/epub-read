import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarDrawer, type SidebarDrawerProps } from "./SidebarDrawer";
import type { TocNode } from "../core/types";

const sampleToc: TocNode[] = [
  {
    label: "第一章 起航",
    href: "chapter1.xhtml",
    children: [
      { label: "1.1 港口", href: "chapter1.xhtml#port", children: [] },
      { label: "1.2 水手", href: "chapter1.xhtml#sailors", children: [] },
    ],
  },
  {
    label: "第二章 大海",
    href: "chapter2.xhtml",
    children: [],
  },
];

const sampleBookmarks = [
  {
    id: "bm1",
    spineIndex: 0,
    page: 2,
    anchorIndex: null,
    anchorRatio: null,
    text: "书签文字记录 1",
    chapterLabel: "第一章 起航",
    createdAtMs: 1700000000000,
  },
];

const sampleNotes = [
  {
    id: "note1",
    spineIndex: 0,
    chapterTitle: "第一章 起航",
    content: "我的读书笔记",
    selectedText: "这是选中的精彩文句",
    createdAtMs: 1700000000000,
  },
];

describe("Zen UI SidebarDrawer 组件与交互契约（Packet B）", () => {
  const baseProps: SidebarDrawerProps = {
    open: true,
    activeTab: "toc",
    onTabChange: vi.fn(),
    mode: "overlay",
    onModeChange: vi.fn(),
    onClose: vi.fn(),
    toc: sampleToc,
    activeHref: "chapter1.xhtml#port",
    onNavigateToc: vi.fn(),
    bookmarks: sampleBookmarks,
    onSelectBookmark: vi.fn(),
    notes: sampleNotes,
    onNavigateNote: vi.fn(),
  };

  it("关闭状态且为 overlay 模式时不渲染内容", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, open: false, mode: "overlay" })
    );
    expect(html).toBe("");
  });

  it("目录 Tab 正确渲染树形层级、活动项和 Segmented 选项卡", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, activeTab: "toc" })
    );
    expect(html).toContain("sidebar-drawer");
    expect(html).toContain("is-overlay");
    expect(html).toContain("is-open");
    expect(html).toContain("sidebar-tab active");
    expect(html).toContain("第一章 起航");
    expect(html).toContain("1.1 港口");
    expect(html).toContain("1.2 水手");
    expect(html).toContain("level-0");
    expect(html).toContain("level-1");
    // 活动项高亮
    expect(html).toContain("active");
  });

  it("书签 Tab 正确渲染书签列表与所属章节", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, activeTab: "bookmarks" })
    );
    expect(html).toContain("sidebar-bookmark-card");
    expect(html).toContain("书签文字记录 1");
    expect(html).toContain("第一章 起航");
  });

  it("笔记 Tab 正确渲染笔记内容、原文引用与所属章节", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, activeTab: "notes" })
    );
    expect(html).toContain("sidebar-note-card");
    expect(html).toContain("我的读书笔记");
    expect(html).toContain("这是选中的精彩文句");
    expect(html).toContain("第一章 起航");
  });

  it("固定驻留（Docked）模式渲染 is-docked 标识且不渲染 backdrop 遮罩", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, mode: "docked" })
    );
    expect(html).toContain("is-docked");
    expect(html).not.toContain("sidebar-backdrop");
  });

  it("支持左侧 (side-left) 与右侧 (side-right) 方向类，支持左右双向弹出动画契约", () => {
    const leftHtml = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, side: "left" })
    );
    expect(leftHtml).toContain("side-left");

    const rightHtml = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, side: "right" })
    );
    expect(rightHtml).toContain("side-right");
  });

  it("当目录章节数超过 8 个时渲染章节过滤输入框", () => {
    const largeToc: TocNode[] = Array.from({ length: 12 }, (_, i) => ({
      label: `第 ${i + 1} 章 标题`,
      href: `ch${i + 1}.xhtml`,
      children: [],
    }));
    const html = renderToStaticMarkup(
      createElement(SidebarDrawer, { ...baseProps, toc: largeToc, activeTab: "toc" })
    );
    expect(html).toContain("sidebar-toc-filter-input");
    expect(html).toContain("过滤章节...");
  });

  it("书签 Tab 当提供 onDeleteBookmark 时渲染单个书签删除按键", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarDrawer, {
        ...baseProps,
        activeTab: "bookmarks",
        onDeleteBookmark: vi.fn(),
      })
    );
    expect(html).toContain("sidebar-bookmark-del-btn");
    expect(html).toContain("删除此书签");
  });
});
