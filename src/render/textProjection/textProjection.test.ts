import { describe, expect, it } from "vitest";
import {
  compileReplacementStage,
  codePointBoundary,
  mapBoundary,
  projectPipeline,
  utf16Boundaries,
} from "./core";
import { compileTextProjection, projectText } from "./compile";
import { createNodeProjection, sourceRangeForDisplayRange } from "./nodeProjection";
import { parseOpenCCDictionary } from "./opencc";
import { createDisplaySearchSession } from "./displaySearch";
import type { Book } from "../../core/types";
import type { TextProjectionPreferences } from "./types";

const original = (rules: Array<{ from: string; to: string }>): TextProjectionPreferences => ({
  mode: "original",
  rules: rules.map((rule, index) => ({ id: `r${index}`, enabled: true, ...rule })),
});

function fakeBook(chapters: string[]): Book {
  const spine = chapters.map((_, index) => ({ idref: `c${index}`, linear: true }));
  const manifest = new Map(chapters.map((_, index) => [
    `c${index}`,
    { id: `c${index}`, href: `Text/c${index}.xhtml`, mediaType: "application/xhtml+xml", properties: [] },
  ]));
  return {
    version: 3,
    opfPath: "OEBPS/content.opf",
    metadata: { title: "测试", identifier: "test", language: "zh" },
    manifest,
    spine,
    guide: [],
    toc: chapters.map((_, index) => ({ label: `第${index + 1}章`, href: `OEBPS/Text/c${index}.xhtml`, children: [] })),
    resources: new Map(chapters.map((content, index) => [
      `OEBPS/Text/c${index}.xhtml`,
      { path: `OEBPS/Text/c${index}.xhtml`, data: new TextEncoder().encode(content), mediaType: "application/xhtml+xml" },
    ])),
    fixedLayout: false,
    issues: [],
    drmProtected: false,
  };
}

describe("text projection core", () => {
  it("uses longest match, first equal-length rule and a single pass", () => {
    const stage = compileReplacementStage([
      { from: "A", to: "1" },
      { from: "B", to: "1" },
      { from: "AB", to: "2" },
      { from: "ABC", to: "3" },
      { from: "BC", to: "4" },
    ]);
    expect(stage("ABC").display).toBe("3");
    expect(stage("AB").display).toBe("2");
    expect(stage("AXB").display).toBe("1X1");

    const noRecursion = compileReplacementStage([
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ]);
    expect(noRecursion("A").display).toBe("B");
  });

  it("composes two stages without inferring anchors from output length", () => {
    const first = compileReplacementStage([{ from: "AB", to: "中" }]);
    const second = compileReplacementStage([{ from: "中", to: "国" }]);
    const pipeline = projectPipeline("AB", [first, second]);
    expect(pipeline.display).toBe("国");
    expect(pipeline.toDisplay(0, "start")).toBe(0);
    expect(pipeline.toDisplay(2, "end")).toBe(1);
    expect(pipeline.toSource(0, "start")).toBe(0);
    expect(pipeline.toSource(1, "start")).toBe(2);
    expect(pipeline.toSource(1, "end")).toBe(2);
  });

  it("expands non-invertible interiors toward the requested bias", () => {
    const projection = compileReplacementStage([{ from: "AB", to: "XY" }])("AB");
    expect(mapBoundary(projection, 1, "toDisplay", "start")).toBe(0);
    expect(mapBoundary(projection, 1, "toDisplay", "end")).toBe(2);
    expect(mapBoundary(projection, 1, "toSource", "start")).toBe(0);
    expect(mapBoundary(projection, 1, "toSource", "end")).toBe(2);
  });

  it("adapts Unicode code points and UTF-16 surrogate pairs separately", () => {
    const boundaries = utf16Boundaries("甲😀乙");
    expect(boundaries).toEqual([0, 1, 3, 4]);
    expect(codePointBoundary(boundaries, 0)).toBe(0);
    expect(codePointBoundary(boundaries, 1)).toBe(1);
    expect(codePointBoundary(boundaries, 2)).toBe(1);
    expect(codePointBoundary(boundaries, 3)).toBe(2);
    expect(codePointBoundary(boundaries, 4)).toBe(3);

    const compiledPipeline = projectPipeline("😀a", [compileReplacementStage([{ from: "😀a", to: "X" }])]);
    expect(compiledPipeline.toDisplay(0, "start")).toBe(0);
    expect(compiledPipeline.toDisplay(3, "end")).toBe(1);
  });

  it("maps projected raw ranges back to source fragments for search", async () => {
    const compiled = await compileTextProjection(original([{ from: "甲😀", to: "X" }]));
    expect(projectText("甲😀乙", compiled)).toBe("X乙");
    expect(sourceRangeForDisplayRange("甲😀乙", compiled, 0, 1)).toEqual({ start: 0, end: 3 });
    const projection = createNodeProjection("甲😀乙", compiled);
    expect(projection.toSource(1, "start")).toBe(3);
    expect(projection.toSource(1, "end")).toBe(3);
    expect(projection.toDisplay(2, "end")).toBe(1);
  });

  it("parses only valid OpenCC rows and keeps the first candidate", () => {
    expect(parseOpenCCDictionary("# comment\n甲\t乙 丙\n亍\t丌")).toEqual([
      { from: "甲", to: "乙" },
      { from: "亍", to: "丌" },
    ]);
  });

  it("loads the fixed OpenCC subset lazily for simplified display", async () => {
    const compiled = await compileTextProjection({ ...original([]), mode: "simplified" });
    expect(projectText("一目瞭然", compiled)).toBe("一目了然");
    expect(projectText("甲", compiled)).toBe("甲");
  });

  it("searches projected display text and keeps canonical original hits without reverse-converting the query", async () => {
    const compiled = await compileTextProjection(original([{ from: "甲😀", to: "X" }]));
    const book = fakeBook(["<html><body><p>甲😀乙</p></body></html>"]);
    const session = createDisplaySearchSession(book, compiled, { yieldToHost: async () => {} });
    const display = await session.search("X");
    expect(display).toHaveLength(1);
    expect(display[0]).toMatchObject({
      snippet: "X乙",
      matchedText: "X",
      textOffset: 0,
      textSnippet: "甲😀乙",
      textHits: [{ start: 0, end: 2, exactText: "甲😀" }],
      display: {
        range: { start: 0, end: 1 },
        matchedText: "X",
      },
    });
    expect(await session.search("甲")).toHaveLength(0);
    session.dispose();
  });

  it("projects display search per text node so phrase rules do not merge across inline spans", async () => {
    const compiled = await compileTextProjection(original([{ from: "甲😀", to: "X" }]));
    const book = fakeBook(["<html><body><p>甲<span>😀乙</span></p></body></html>"]);
    const session = createDisplaySearchSession(book, compiled, { yieldToHost: async () => {} });
    expect(await session.search("X")).toHaveLength(0);
    const uncollapsed = await session.search("甲😀");
    expect(uncollapsed).toHaveLength(1);
    expect(uncollapsed[0].snippet).toBe("甲😀乙");
    session.dispose();
  });

  it("keeps pre/code search text original while projecting normal body text", async () => {
    const compiled = await compileTextProjection(original([{ from: "甲", to: "X" }]));
    const book = fakeBook(["<html><body><p>甲</p><pre>甲</pre></body></html>"]);
    const session = createDisplaySearchSession(book, compiled, { yieldToHost: async () => {} });
    const projected = await session.search("X");
    expect(projected).toHaveLength(1);
    expect(projected[0].matchedText).toBe("X");
    const untouched = await session.search("甲");
    expect(untouched).toHaveLength(1);
    expect(untouched[0].matchedText).toBe("甲");
    session.dispose();
  });
});
