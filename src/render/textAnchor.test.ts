import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  MAX_ANCHOR_SNIPPET_CODE_POINTS,
  buildVisibleTextIndex,
  captureTextSelection,
  resolveTextRangeOffsets,
  resolveTextAnchorOffset,
  sanitizePersistedTextAnchor,
} from "./textAnchor";

function chapter(markup: string): { document: Document; viewer: HTMLElement } {
  const { document } = parseHTML(`<html><body><epub-viewer id="epub-viewer">${markup}</epub-viewer></body></html>`);
  return { document: document as unknown as Document, viewer: document.getElementById("epub-viewer") as HTMLElement };
}

describe("visible text anchor index", () => {
  it("counts deep p>a>span text exactly once and uses Unicode code points", () => {
    const { document, viewer } = chapter("<p>甲<a><span>😀乙</span></a></p><p> 丙\n丁 </p>");
    const index = buildVisibleTextIndex(document, viewer);
    expect(index.text).toBe("甲😀乙丙丁");
    expect(index.totalChars).toBe(5);
    // UTF-16 raw offset 2 is immediately after 😀, but persisted offset is
    // code-point based: 甲 + 😀 = 2 rather than 3 UTF-16 units.
    expect(index.offsetForNode(document.querySelector("span")!.firstChild!, 2)).toBe(2);
    expect(index.offsetForNode(document.querySelector("span")!.firstChild!, 1)).toBe(1);
  });

  it("excludes hidden/script/style and footnote text without changing chapter DOM or styles", () => {
    const { document, viewer } = chapter(
      '<p style="color:red">正文</p><script>bad()</script><style>.x{display:none}</style><p hidden>隐藏</p><aside epub:type="footnote">脚注</aside>'
    );
    const before = viewer.innerHTML;
    const index = buildVisibleTextIndex(document, viewer);
    expect(index.text).toBe("正文");
    expect(viewer.innerHTML).toBe(before);
    expect(document.querySelector("p")?.getAttribute("style")).toBe("color:red");
  });

  it("counts visible media units once for media-only chapters", () => {
    const { document, viewer } = chapter('<svg><image href="x"/></svg><img src="y"><img hidden src="z">');
    const index = buildVisibleTextIndex(document, viewer);
    expect(index.totalChars).toBe(0);
    expect(index.mediaUnits).toBe(2);
  });

  it("validates original offsets, searches snippets linearly after drift, and chooses the nearest duplicate", () => {
    const { document, viewer } = chapter("<p>甲共享乙共享丙</p>");
    const index = buildVisibleTextIndex(document, viewer);
    expect(resolveTextAnchorOffset(index, { textOffset: 4, textSnippet: "共享" })).toBe(4);
    expect(resolveTextAnchorOffset(index, { textOffset: 5, textSnippet: "共享" })).toBe(4);
    expect(resolveTextAnchorOffset(index, { textOffset: 5, textSnippet: "不存在" })).toBeNull();
  });

  it("stores an exclusive range with a backward end snippet and recovers after bounded drift", () => {
    const { document, viewer } = chapter("<p><span>甲😀乙</span><span>丙丁</span></p>");
    const index = buildVisibleTextIndex(document, viewer);
    expect(index.snippetBefore(index.totalChars)).toBe("甲😀乙丙丁");
    const anchor = {
      startTextOffset: 1,
      endTextOffset: 5,
      startTextSnippet: "😀乙丙丁",
      endTextSnippet: "😀乙丙丁",
    };
    expect(resolveTextRangeOffsets(index, anchor, "😀乙丙丁")).toEqual({ start: 1, end: 5 });
    expect(
      resolveTextRangeOffsets(index, { ...anchor, startTextOffset: 0, endTextOffset: 4 }, "😀乙丙丁")
    ).toEqual({ start: 1, end: 5 });
  });

  it("keeps whitespace and surrogate pairs out of persisted offsets", () => {
    const { document, viewer } = chapter("<p>甲 \n <span>😀</span> 乙</p>");
    const index = buildVisibleTextIndex(document, viewer);
    expect(index.text).toBe("甲😀乙");
    expect(index.totalChars).toBe(3);
    expect(index.snippetBefore(3)).toBe("甲😀乙");
  });

  it("rejects both raw and normalized selections beyond the storage limit", () => {
    const raw = `${" ".repeat(4097)}甲`;
    const { document, viewer } = chapter(`<p>${raw}</p>`);
    const text = document.querySelector("p")!.firstChild!;
    const index = buildVisibleTextIndex(document, viewer);
    const range = {
      collapsed: false,
      startContainer: text,
      endContainer: text,
      startOffset: 0,
      endOffset: raw.length,
      toString: () => raw,
      getClientRects: () => [{ left: 0, top: 0, right: 10, bottom: 10 }],
    } as unknown as Range;
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as unknown as Selection;
    expect(captureTextSelection(document, viewer, index, selection)).toBeNull();
  });

  it("anchors a multi-line selection menu to its terminal visible fragment", () => {
    const { document, viewer } = chapter("<p>第一行<br>第二行</p>");
    const paragraph = document.querySelector("p")!;
    const start = paragraph.firstChild!;
    const end = paragraph.lastChild!;
    const index = buildVisibleTextIndex(document, viewer);
    const range = {
      collapsed: false,
      startContainer: start,
      endContainer: end,
      startOffset: 0,
      endOffset: (end as Text).data.length,
      toString: () => "第一行第二行",
      intersectsNode: () => false,
      getClientRects: () => [
        { left: 400, top: 20, right: 700, bottom: 40 },
        { left: 120, top: 44, right: 210, bottom: 64 },
      ],
    } as unknown as Range;
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as unknown as Selection;
    expect(captureTextSelection(document, viewer, index, selection)?.rect).toEqual({
      left: 120,
      top: 44,
      right: 210,
      bottom: 64,
    });
  });

  it("rejects malformed persisted anchors and code-point snippets over the bounded limit", () => {
    expect(sanitizePersistedTextAnchor({ textOffset: -1, textSnippet: "甲" })).toEqual({ textOffset: null, textSnippet: null });
    expect(sanitizePersistedTextAnchor({ textOffset: 2 ** 53, textSnippet: "甲" })).toEqual({ textOffset: null, textSnippet: null });
    expect(sanitizePersistedTextAnchor({ textOffset: 2, textSnippet: "a b" })).toEqual({ textOffset: null, textSnippet: null });
    expect(
      sanitizePersistedTextAnchor({
        textOffset: 2,
        textSnippet: "😀".repeat(MAX_ANCHOR_SNIPPET_CODE_POINTS + 1),
      })
    ).toEqual({ textOffset: null, textSnippet: null });
  });

  it("indexes elements pre-order and retrieves them in O(1) via elementIndex", () => {
    const { document, viewer } = chapter("<p><span>一</span><span>二</span></p><div>三</div>");
    const index = buildVisibleTextIndex(document, viewer);
    const p = document.querySelector("p")!;
    const spans = document.querySelectorAll("span");
    const div = document.querySelector("div")!;
    expect(index.elementIndex(p)).toBe(0);
    expect(index.elementIndex(spans[0])).toBe(1);
    expect(index.elementIndex(spans[1])).toBe(2);
    expect(index.elementIndex(div)).toBe(3);
    expect(index.elementIndex(document.createElement("div"))).toBe(-1);
  });
});
