import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WhisperFooter, type WhisperFooterProps } from "./WhisperFooter";

describe("Zen UI WhisperFooter 微提示状态栏与跳页器契约（Packet B）", () => {
  const baseProps: WhisperFooterProps = {
    currentPage: 11,
    pageCount: 120,
    readingMode: "paginated",
    chapterTitle: "第三章 白鲸",
    chapterIndex: 2,
    totalChapters: 30,
    bookProgressPct: 18,
    onSeekPage: vi.fn(),
    onSeekChapter: vi.fn(),
    chapterTicks: [
      { spineIndex: 0, title: "序章", positionPct: 0 },
      { spineIndex: 1, title: "第一章", positionPct: 20 },
      { spineIndex: 2, title: "第二章", positionPct: 50 },
    ],
    zenMode: false,
  };

  it("正确渲染克制的阅读进度文本，不再显示预估剩余时间", () => {
    const html = renderToStaticMarkup(createElement(WhisperFooter, baseProps));
    expect(html).toContain("whisper-footer");
    expect(html).toContain("whisper-calm-text");
    expect(html).toContain("本章 12 / 120 页");
    expect(html).not.toContain("分钟");
    expect(html).toContain("全书 18%");
  });

  it("滚动模式下正确展示章节滚动进度百分比", () => {
    const html = renderToStaticMarkup(
      createElement(WhisperFooter, {
        ...baseProps,
        readingMode: "scroll",
        scrollProgress: 0.65,
      })
    );
    expect(html).toContain("本章 65%");
  });

  it("正确渲染 Scrubber 进度条外壳与章节刻度点", () => {
    const html = renderToStaticMarkup(createElement(WhisperFooter, baseProps));
    expect(html).toContain("whisper-scrubber-wrap");
    expect(html).toContain("whisper-scrubber-track");
    expect(html).toContain("whisper-scrubber-fill");
    expect(html).toContain("whisper-chapter-tick");
    expect(html).toContain("序章");
    expect(html).toContain("第一章");
    expect(html).toContain("第二章");
  });

  it("全屏禅模式（Zen Mode）默认带有 is-hidden 状态", () => {
    const html = renderToStaticMarkup(
      createElement(WhisperFooter, {
        ...baseProps,
        zenMode: true,
      })
    );
    expect(html).toContain("is-hidden");
  });

  it("切章加载或统计未就绪（bookProgressPct为0）时，依托章节刻度兜底，进度条不归零", () => {
    const html = renderToStaticMarkup(
      createElement(WhisperFooter, {
        ...baseProps,
        readingMode: "scroll",
        chapterIndex: 2,
        scrollProgress: 0,
        bookProgressPct: 0, // 模拟切章加载瞬间
      })
    );
    // 第二章刻度起始为 50%，fill 宽度应为 50% 而不是 0%
    expect(html).toContain('style="width:50%"');
  });

  it("连续滚动模式下，优先以实际整书几何比例 totalScrollProgress 渲染，彻底防止鼠标移开重进后归零", () => {
    const html = renderToStaticMarkup(
      createElement(WhisperFooter, {
        ...baseProps,
        readingMode: "scroll",
        chapterIndex: 0,
        scrollProgress: 0.1,
        totalScrollProgress: 0.68,
        bookProgressPct: 0,
      })
    );
    // 即使 bookProgressPct 为 0，也应精准锁定在 68%
    expect(html).toContain('style="width:68%"');
    expect(html).toContain("全书 68%");
  });

  it("双页模式下按 leafRange 渲染物理页区间与总页数", () => {
    const spreadHtml = renderToStaticMarkup(
      createElement(WhisperFooter, {
        ...baseProps,
        currentPage: 1,
        pageCount: 3,
        leafRange: { first: 3, last: 4, total: 5 },
      })
    );
    expect(spreadHtml).toContain("本章 3–4 / 5 页");

    const lastSpreadHtml = renderToStaticMarkup(
      createElement(WhisperFooter, {
        ...baseProps,
        currentPage: 2,
        pageCount: 3,
        leafRange: { first: 5, last: 5, total: 5 },
      })
    );
    expect(lastSpreadHtml).toContain("本章 5 / 5 页");
  });

  it("手机底栏标明本章页码并给出章节位置，不把章内页码写成全书页码", () => {
    const html = renderToStaticMarkup(
      createElement(WhisperFooter, { ...baseProps, mobile: true, currentPage: 5, pageCount: 11, chapterIndex: 436, totalChapters: 1382 })
    );
    expect(html).toContain("本章 6/11 页 · 437/1382 章 · 全书");
  });
});
