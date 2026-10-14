import { describe, expect, it } from "vitest";
import type { Book } from "../core/types";
import { createLeafChapterClassifier, LEAF_TEXT_MAX_CHARS } from "./leafChapterCandidates";
import { SingleLeafSpreads } from "./singleLeafSpreads";

const html = (body: string) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
const text = (n: number) => "字".repeat(n);

function fixture(bodies: string[], nonLinear = -1, version = 2) {
  const book = {
    version, opfPath: "book.opf",
    spine: bodies.map((_, index) => ({ idref: `${index}`, linear: index !== nonLinear })),
    manifest: new Map(bodies.map((_, index) => [`${index}`, { href: `${index}.xhtml` }])),
  } as Book;
  const reads: string[] = [];
  const classify = createLeafChapterClassifier(book, async (path) => {
    reads.push(path);
    return bodies[Number.parseInt(path)];
  });
  return { book, classify, reads, signal: new AbortController().signal };
}

describe("A13 leaf chapter candidates (XHTML only)", () => {
  it("accepts picture pages and short text pages, rejects long, empty and composed ones", async () => {
    const { classify, signal } = fixture([
      html(`<div><img src="a.png"/></div>`), // 整图章
      html(`<h1>书名</h1><p>作者　著</p>`), // 书名页
      html(`<img src="logo.png"/><p>${text(120)}</p>`), // 一张图加少量文字
      html(`<p>${text(LEAF_TEXT_MAX_CHARS)}</p>`), // 正好到上限
      html(`<p>${text(LEAF_TEXT_MAX_CHARS + 1)}</p>`), // 超过上限：正文
      html(`<p>  \n </p>`), // 空章：走原来的自动前进
      html(`<img src="a.png"/><img src="b.png"/><p>两张图</p>`),
      html(`<table><tr><td>人物</td></tr></table>`),
      html(`<ol>${"<li>一项</li>".repeat(13)}</ol>`), // 长目录
      html(`<style>p{color:red}</style><script>var x = "${text(2000)}";</script><p>献辞</p>`), // 脚本和样式不算字
    ]);
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await classify(i, signal));
    expect(results).toEqual([true, true, true, true, false, false, false, false, false, true]);
  });

  it("reads each chapter once, skips linear=no, and does not cache a cancelled read", async () => {
    const { classify, reads, signal } = fixture([html("<p>短</p>"), html("<p>附录</p>")], 1);
    expect(await classify(0, signal)).toBe(true);
    expect(await classify(0, signal)).toBe(true);
    expect(await classify(1, signal)).toBe(false);
    expect(reads).toEqual(["0.xhtml"]);
    const cancelled = new AbortController();
    cancelled.abort();
    const fresh = fixture([html("<p>短</p>")]);
    await expect(fresh.classify(0, cancelled.signal)).rejects.toThrow();
    expect(await fresh.classify(0, fresh.signal)).toBe(true);
    expect(fresh.reads).toEqual(["0.xhtml", "0.xhtml"]);
  });

  it("drives SingleLeafSpreads: colour plates, title and character pages pair up before the main text", async () => {
    const { book, classify, signal } = fixture([
      html(`<img src="c1.png"/>`), html(`<img src="c2.png"/>`), html(`<img src="c3.png"/>`),
      html(`<h1>书名</h1>`), html(`<p>${text(300)}</p>`),
      html(`<p>${text(5000)}</p>`), // 正文
    ]);
    const spreads = new SingleLeafSpreads(book, classify);
    expect(await spreads.resolve(0, signal)).toEqual({ left: 0, right: 1 });
    expect(await spreads.resolve(3, signal)).toEqual({ left: 2, right: 3 });
    expect(await spreads.resolve(4, signal)).toEqual({ left: 4, right: null });
    expect(await spreads.resolve(5, signal)).toBeNull();
  });
});
