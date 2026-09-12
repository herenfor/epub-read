import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SEARCH_RESULT_RENDER_LIMIT,
  getSearchStatusLabel,
  getSearchIndexPending,
  highlightSearchSnippet,
  limitSearchResults,
  SearchPanel,
} from "./SearchPanel";

describe("search result presentation helpers", () => {
  it("splits original snippet text into highlighted and plain segments", () => {
    expect(highlightSearchSnippet("前文啄木鸟工匠后文", [{ start: 2, end: 7 }])).toEqual([
      { text: "前文", highlighted: false },
      { text: "啄木鸟工匠", highlighted: true },
      { text: "后文", highlighted: false },
    ]);
  });

  it("merges overlapping ranges and ignores invalid ranges", () => {
    expect(highlightSearchSnippet("abcdef", [
      { start: 4, end: 2 },
      { start: 1, end: 4 },
      { start: 3, end: 6 },
      { start: 99, end: 100 },
    ])).toEqual([
      { text: "a", highlighted: false },
      { text: "bcdef", highlighted: true },
    ]);
  });

  it("bounds the number of rendered results", () => {
    const results = Array.from({ length: SEARCH_RESULT_RENDER_LIMIT + 20 }, (_, id) => ({ id }));
    expect(limitSearchResults(results)).toEqual({
      items: results.slice(0, SEARCH_RESULT_RENDER_LIMIT),
      limited: true,
    });
  });

  it("describes search states without inventing progress for idle", () => {
    expect(getSearchStatusLabel("idle", 0, 4)).toBe("");
    expect(getSearchStatusLabel("searching", 2, 4)).toBe("正在搜索 2/4 章");
    expect(getSearchStatusLabel("complete", 4, 4)).toBe("搜索完成");
    expect(getSearchStatusLabel("error", 1, 4)).toBe("搜索失败");
  });

  it("长查询仍使用单行搜索输入并保留自定义清除按钮", () => {
    const query = "这是一个很长的搜索关键词".repeat(20);
    const markup = renderToStaticMarkup(
      createElement(SearchPanel, {
        query,
        onQueryChange: () => undefined,
        results: [],
        status: "idle",
        processed: 0,
        total: 0,
        onSelect: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(markup).toContain('class="search-input"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain(`value="${query}"`);
    expect(markup).toContain('class="search-clear"');
    expect(markup).toContain('aria-label="清空搜索"');
  });

  it("全库索引确认卡会说明硬件开销并显示三项统计", () => {
    const markup = renderToStaticMarkup(createElement(SearchPanel, {
      query: "",
      onQueryChange: () => undefined,
      results: [],
      status: "idle",
      processed: 0,
      total: 0,
      scope: "all",
      indexStatus: "confirmation",
      indexProgress: { total: 33, completed: 12 },
      onStartIndex: () => undefined,
      onDeferIndex: () => undefined,
      concurrencyMode: "automatic",
      detectedCores: 16,
      recommendedConcurrency: 6,
      onConcurrencyChange: () => undefined,
      onSelect: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain("建立全部书籍索引");
    expect(markup).toContain("占用较多 CPU 和内存");
    expect(markup).toContain("书库总数");
    expect(markup).toContain("已可搜索");
    expect(markup).toContain("待处理");
    expect(markup).toContain("开始建立索引");
    expect(markup).toContain("暂不建立");
    expect(markup).toContain("索引并发");
    expect(markup).toContain("检测到 16 个逻辑处理器");
    expect(markup).toContain("自动推荐 6；手动最大 15");
    expect(markup).toContain("自动（推荐 6）");
  });

  it("索引进行中将书名单独省略，并固定取消按钮区域", () => {
    const markup = renderToStaticMarkup(createElement(SearchPanel, {
      query: "",
      onQueryChange: () => undefined,
      results: [],
      status: "idle",
      processed: 0,
      total: 0,
      scope: "all",
      indexStatus: "cancelling",
      indexProgress: { total: 33, completed: 12, currentBookTitle: "一本很长很长的书名" },
      onCancelIndex: () => undefined,
      onSelect: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain("正在取消索引 12/33 本");
    expect(markup).toContain("正在取消…");
    expect(markup).toContain('class="search-index-progress-book"');
    expect(markup).toContain('class="search-index-cancel" type="button" disabled=""');
  });

  it("索引统计的待处理数优先使用调用方提供的工作集", () => {
    expect(getSearchIndexPending({ total: 33, completed: 12 })).toBe(21);
    expect(getSearchIndexPending({ total: 33, completed: 12, pending: 7 })).toBe(7);
  });

  it("全部书籍范围显示独立入口、书籍来源和不可打开原因", () => {
    const markup = renderToStaticMarkup(createElement(SearchPanel, {
      query: "测试",
      onQueryChange: () => undefined,
      results: [{
        id: "all-1",
        bookTitle: "测试书",
        creator: "作者",
        chapterTitle: "第一章",
        snippet: "测试正文",
        disabledReason: "源文件不可用",
      }],
      status: "complete",
      processed: 1,
      total: 1,
      scope: "all",
      onScopeChange: () => undefined,
      onSelect: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain("当前书");
    expect(markup).toContain("全部书籍");
    expect(markup).toContain("测试书 · 作者");
    expect(markup).toContain("源文件不可用");
    expect(markup).toContain("搜索全部书籍正文");
  });
});

async function readStyles(): Promise<string> {
  // The production bundle handles CSS through Vite; this node-only contract
  // test reads source text so the search input selector boundary is covered.
  // @ts-expect-error The project intentionally does not include @types/node.
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../styles.css", import.meta.url), "utf8");
}

describe("搜索输入框视觉契约", () => {
  it("隐藏 Chromium 原生搜索装饰，避免与自定义清除按钮重复", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(
      /\.search-input::-webkit-search-cancel-button,[\s\S]*?\.search-input::-webkit-search-results-decoration\s*\{[^}]*display:\s*none;[^}]*-webkit-appearance:\s*none;[^}]*appearance:\s*none;/s,
    );
  });

  it("长文本保持单行且为清除按钮预留固定右侧空间", async () => {
    const styles = await readStyles();
    expect(styles).toMatch(
      /\.search-input-wrap\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.search-input\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*min-width:\s*0;[^}]*padding:\s*9px 40px 9px 10px;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).toMatch(/\.search-clear\s*\{[^}]*z-index:\s*1;/s);
  });
});
