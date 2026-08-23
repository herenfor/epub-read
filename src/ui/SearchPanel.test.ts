import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SEARCH_RESULT_RENDER_LIMIT,
  getSearchStatusLabel,
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
