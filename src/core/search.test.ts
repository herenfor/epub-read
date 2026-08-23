import { describe, expect, it, vi } from "vitest";
import { buildDocument, createSearchSession, extractSearchText, extractVisibleText, normalizeQueryPart, searchBook } from "./search";
import type { Book } from "./types";

function fakeBook(chapters: string[], tocLabels = chapters.map((_, i) => `第${i + 1}章`)): Book {
  const spine = chapters.map((_, i) => ({ idref: `c${i}`, linear: true }));
  const manifest = new Map(chapters.map((_, i) => [
    `c${i}`,
    { id: `c${i}`, href: `Text/c${i}.xhtml`, mediaType: "application/xhtml+xml", properties: [] },
  ]));
  return {
    version: 3,
    opfPath: "OEBPS/content.opf",
    metadata: { title: "测试", identifier: "test", language: "zh" },
    manifest,
    spine,
    guide: [],
    toc: chapters.map((_, i) => ({ label: tocLabels[i], href: `OEBPS/Text/c${i}.xhtml`, children: [] })),
    resources: new Map(chapters.map((content, i) => [
      `OEBPS/Text/c${i}.xhtml`,
      { path: `OEBPS/Text/c${i}.xhtml`, data: new TextEncoder().encode(content), mediaType: "application/xhtml+xml" },
    ])),
    fixedLayout: false,
    issues: [],
    drmProtected: false,
  };
}

describe("current-book search core", () => {
  it("normalizes NFKC, case, soft hyphen and layout whitespace", () => {
    expect(normalizeQueryPart(" ＡＢ\u00ad c\n ")).toBe("abc");
  });

  it("extracts visible text, excludes non-content elements and preserves block boundaries", async () => {
    const text = extractVisibleText(await (await import("./parseXml")).parseXmlText(
      "<html><head>头</head><body><p>甲<span>乙</span></p><script>坏</script><p>丙</p><aside epub:type='footnote'>注</aside><style>坏</style></body></html>",
      "text/html",
    ));
    expect(text.replaceAll("\u0000", "\n")).toBe("甲乙\n丙");
    const doc = buildDocument(text);
    expect(doc.normalized).toContain("甲乙");
    expect(doc.normalized).not.toContain("甲乙丙");
    expect(doc.rawStarts).toBeInstanceOf(Uint32Array);
    expect(doc.rawEnds).toBeInstanceOf(Uint32Array);
    expect(doc.anchorStarts).toBeInstanceOf(Uint32Array);
  });

  it("parses valid EPUB XHTML as XML so self-closing head tags cannot swallow body text", async () => {
    const source = `<?xml version="1.0" encoding="utf-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><head><title/><meta charset="utf-8"/></head>
      <body><p>Windows WebView2 也必须可以搜索</p></body></html>`;
    expect((await extractSearchText(source)).replaceAll("\u0000", "\n").trim()).toBe("Windows WebView2 也必须可以搜索");
    const results = await searchBook(fakeBook([source]), "必须可以搜索", { yieldToHost: async () => {} });
    expect(results).toHaveLength(1);
  });

  it("falls back to the tolerant HTML parser for malformed legacy chapters", async () => {
    const source = "<html><body><p>旧书正文<p>仍能搜索</body></html>";
    const results = await searchBook(fakeBook([source]), "仍能搜索", { yieldToHost: async () => {} });
    expect(results).toHaveLength(1);
  });

  it("returns anchor-coordinate offsets and original ranges", async () => {
    const book = fakeBook(["<body><p>Ａ b<span>c</span></p></body>"], ["目标"]);
    const results = await searchBook(book, "abc", { yieldToHost: async () => {} });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      spineIndex: 0,
      chapterPath: "OEBPS/Text/c0.xhtml",
      chapterTitle: "目标",
      textOffset: 0,
      textSnippet: "Ａbc",
      matchedText: "Ａ bc",
      matchType: "phrase",
      snippetMatchRanges: [{ start: 0, end: 4 }],
    });
    expect(results[0].originalRange.end).toBeGreaterThan(results[0].originalRange.start);
  });

  it("maps surrogate pairs and NFKC expansions without per-character objects", async () => {
    const book = fakeBook(["<body><p>😀ﬃ</p></body>"]);
    const emoji = await searchBook(book, "😀", { yieldToHost: async () => {} });
    const ligature = await searchBook(book, "ffi", { yieldToHost: async () => {} });
    expect(emoji[0]).toMatchObject({ textOffset: 0, matchedText: "😀" });
    expect(ligature[0]).toMatchObject({ textOffset: 1, matchedText: "ﬃ" });
    const document = buildDocument("😀ﬃ");
    expect(document.normalized).toBe("😀ffi");
    expect(document.normalizedUnitToEntry).toBeInstanceOf(Uint32Array);
    expect(document.normalizedUnitToEntry.length).toBe(document.normalized.length);
    expect(document.rawStarts.length).toBe(4);
  });

  it("builds the anchor snippet from the hit onward and caps it at 32 code points", async () => {
    const book = fakeBook([`<body><p>命中${"后".repeat(64)}</p></body>`]);
    const results = await searchBook(book, "命中", { yieldToHost: async () => {} });
    expect(results[0].textSnippet).toBe("命中" + "后".repeat(30));
    expect(Array.from(results[0].textSnippet)).toHaveLength(32);
  });

  it("does keyword AND only within one block, without crossing paragraphs", async () => {
    const book = fakeBook(["<body><p>校园生活有少女</p><p>校园生活</p></body>"]);
    const results = await searchBook(book, "校园 少女", { yieldToHost: async () => {} });
    expect(results.some((result) => result.matchType === "keywords")).toBe(true);
    expect(results.filter((result) => result.matchType === "keywords")).toHaveLength(1);
    expect(results.find((result) => result.matchType === "keywords")?.snippetMatchRanges).toHaveLength(2);
    const cross = await searchBook(fakeBook(["<body><p>校园</p><p>少女</p></body>"]), "校园少女", { yieldToHost: async () => {} });
    expect(cross).toHaveLength(0);
  });

  it("reuses completed chapter documents and prefers phrase over duplicate keywords", async () => {
    const book = fakeBook(["<p>校园少女</p>", "<p>校园生活</p>"]);
    const textFor = vi.fn((path: string) => path.endsWith("c0.xhtml") ? "<p>校园少女</p>" : "<p>校园生活</p>");
    const session = createSearchSession(book, { textFor, yieldToHost: async () => {} });
    const first = await session.search("校园 少女");
    expect(first).toHaveLength(1);
    expect(first[0].matchType).toBe("phrase");
    await session.search("校园");
    expect(textFor).toHaveBeenCalledTimes(2);
    session.dispose();
    await expect(session.search("校园")).rejects.toThrow("搜索会话已释放");
  });

  it("reports progress, yields, respects result limits and aborts", async () => {
    const book = fakeBook(["<p>abc abc</p>", "<p>abc</p>"]);
    const progress: number[] = [];
    const yields = vi.fn(async () => {});
    const results = await searchBook(book, "abc", {
      maxResults: 1,
      onProgress: (value) => progress.push(value.completed),
      yieldToHost: yields,
    });
    expect(results).toHaveLength(1);
    expect(progress).toEqual([1]);
    expect(yields).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(searchBook(book, "abc", { signal: controller.signal, yieldToHost: async () => {} })).rejects.toMatchObject({ name: "AbortError" });
  });
});
