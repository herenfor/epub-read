import { describe, expect, it } from "vitest";
import { parseXmlText } from "./parseXml";
import {
  BLOCK_BOUNDARY,
  CORPUS_NORMALIZER_VERSION,
  CORPUS_PARSER_VERSION,
  buildDocument,
  createCorpusChapter,
  extractSearchText,
  extractVisibleCorpus,
  normalizeCorpusText,
} from "./corpus";

describe("shared visible corpus", () => {
  it("retains structural content types while preserving search text", async () => {
    const source = "<html><head>ignored</head><body><h1>标题</h1><p>甲<span>乙</span></p><aside epub:type='footnote'>注</aside><p>丙</p></body></html>";
    const document = await parseXmlText(source, "application/xml");
    const blocks = extractVisibleCorpus(document);
    expect(blocks.map((block) => [block.contentType, block.originalText])).toEqual([
      ["heading", "标题"], ["paragraph", "甲乙"], ["paragraph", "丙"],
    ]);
    expect(await extractSearchText(source)).toBe(`标题${BLOCK_BOUNDARY}甲乙${BLOCK_BOUNDARY}丙`);
  });

  it("can retain explicit footnotes without changing the search default", async () => {
    const document = await parseXmlText("<body><p>正文</p><aside epub:type='footnote'>注释</aside></body>", "application/xml");
    expect(extractVisibleCorpus(document).map((block) => block.contentType)).toEqual(["paragraph"]);
    expect(extractVisibleCorpus(document, { includeFootnotes: true }).map((block) => block.contentType)).toEqual(["paragraph", "footnote"]);
  });

  it("preserves semantic parent types through nested blocks and line breaks", async () => {
    const document = await parseXmlText(
      "<body><section epub:type='toc'><p>目录一<br/>目录二</p><ul><li>目录三</li></ul></section><section epub:type='copyright-page'><p>版权</p></section></body>",
      "application/xml",
    );
    const blocks = extractVisibleCorpus(document);
    expect(blocks.map((block) => [block.contentType, block.originalText])).toEqual([
      ["toc", "目录一"], ["toc", "目录二"], ["toc", "目录三"], ["copyright", "版权"],
    ]);
  });

  it("normalizes Unicode whitespace to one space and trims it", () => {
    expect(normalizeCorpusText("  Ａ\u00a0 B\n\t C\u00ad ")).toBe("a b c");
  });

  it("omits image-only layout whitespace from the persisted corpus", async () => {
    const document = await parseXmlText(
      "<html><body>\n <div><svg><image href='cover.jpg'/></svg></div>\n </body></html>",
      "application/xml",
    );
    expect(extractVisibleCorpus(document)).toEqual([]);
    const chapter = createCorpusChapter(
      { bookFingerprint: "book", chapterPath: "cover.xhtml", chapterTitle: "封面", spineIndex: 0 },
      [{
        contentType: "body",
        originalText: "\n  \n",
        normalizedText: "",
        originalRange: { start: 0, end: 4 },
        textAnchor: { start: 0, end: 0, snippet: "" },
      }],
    );
    expect(chapter).toMatchObject({ text: "", blocks: [] });
  });

  it("creates global text anchors compatible with the paginator coordinate", () => {
    const chapter = createCorpusChapter(
      { bookFingerprint: "book", chapterPath: "text/ch1.xhtml", chapterTitle: "一", spineIndex: 0 },
      [
        { contentType: "paragraph", originalText: "Ａ b", normalizedText: "", originalRange: { start: 0, end: 0 }, textAnchor: { start: 0, end: 0, snippet: "" } },
        { contentType: "paragraph", originalText: "😀c", normalizedText: "", originalRange: { start: 0, end: 0 }, textAnchor: { start: 0, end: 0, snippet: "" } },
      ],
    );
    expect(chapter.blocks.map((block) => block.textAnchor)).toEqual([
      { start: 0, end: 2, snippet: "Ａb" },
      { start: 2, end: 4, snippet: "😀c" },
    ]);
    expect(buildDocument(chapter.text).anchorStarts[2]).toBe(2);
    expect(chapter.parserVersion).toBe(CORPUS_PARSER_VERSION);
    expect(chapter.normalizerVersion).toBe(CORPUS_NORMALIZER_VERSION);
  });

  it("keeps surrogate-pair UTF-16 ranges correct for long chunks", async () => {
    const text = "😀".repeat(80) + "。" + "尾";
    const document = await parseXmlText(`<body><p>${text}</p></body>`, "application/xml");
    const chapter = createCorpusChapter(
      { bookFingerprint: "book", chapterPath: "text/long.xhtml", chapterTitle: "长", spineIndex: 0 },
      extractVisibleCorpus(document),
    );
    expect(chapter.blocks[0].originalRange).toEqual({ start: 0, end: text.length });
    expect(chapter.blocks[0].textAnchor.end).toBe(Array.from(text).length);
  });
});
