import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  ChapterTextIndex,
  collapseCfi,
  parseEpubCfi,
  resolveCfiInDocument,
  resolveCfiSpine,
  type ParsedCfi,
} from "./epubCfi";
import { CHAPTER_1, CHAPTER_2, OPF } from "./epubCfi.fixture";

// Generated from these exact fixtures by Readest v0.12.20's pinned foliate-js
// (readest/foliate-js b34a0aa, epubcfi.js fromElements/fromRange/joinIndir).
const REF = {
  c1PointAfterExt: "epubcfi(/6/2!/4/4/2/1:2)",
  c1RangeSecondRepeat: "epubcfi(/6/2!/4/4,/3:7,/3:10)",
  c1RangeFirstRepeat: "epubcfi(/6/2!/4/4,/3:3,/3:6)",
  c1RangeCross: "epubcfi(/6/2!/4,/4/1:2,/6/2/1:1)",
  c1PointHeading: "epubcfi(/6/2!/4/2[head-1]/1:0)",
  c2RangeSecondSame: "epubcfi(/6/4[ref-c2]!/4/8[p2],/1:11,/1:15)",
  c2PointP2Start: "epubcfi(/6/4[ref-c2]!/4/8[p2]/1:0)",
};

const xml = (source: string, type: string) =>
  new DOMParser().parseFromString(source, type as "text/xml") as unknown as Document;
const opf = xml(OPF, "text/xml");
const chapters = [xml(CHAPTER_1, "application/xhtml+xml"), xml(CHAPTER_2, "application/xhtml+xml")];
const SPINE = ["c1", "c2"];

function locate(cfi: string, toEnd = false) {
  const parsed = parseEpubCfi(cfi) as ParsedCfi;
  const [packageSteps, contentSteps] = collapseCfi(parsed, toEnd);
  const spine = resolveCfiSpine(packageSteps, SPINE, opf);
  if (!spine) return null;
  const doc = chapters[spine.spineIndex];
  const resolved = resolveCfiInDocument(doc, contentSteps);
  if (!resolved) return { spine, offset: null };
  return { spine, offset: new ChapterTextIndex(doc).offsetAt(resolved.point), idCorrected: resolved.idCorrected };
}

describe("parseEpubCfi", () => {
  it("parses points, ranges, id assertions and escapes", () => {
    expect(parseEpubCfi(REF.c1PointHeading)).toEqual({
      kind: "point",
      path: [[{ index: 6 }, { index: 2 }], [{ index: 4 }, { index: 2, id: "head-1" }, { index: 1, offset: 0 }]],
    });
    const range = parseEpubCfi(REF.c2RangeSecondSame);
    expect(range?.kind).toBe("range");
    expect(collapseCfi(range!, true)[1]).toEqual([{ index: 4 }, { index: 8, id: "p2" }, { index: 1, offset: 15 }]);
    expect(parseEpubCfi("epubcfi(/6/2!/4/2[a^]b;s=a]/1:0)")?.kind).toBe("point");
    expect((parseEpubCfi("epubcfi(/6/2!/4/2[a^]b;s=a]/1:0)") as { path: unknown[][] }).path[1][1]).toEqual({ index: 2, id: "a]b" });
  });

  it("rejects malformed or oversized input instead of guessing", () => {
    for (const bad of ["", "epubcfi()", "epubcfi(4/2)", "epubcfi(/6/2!/4/x)", "epubcfi(/6/2!/4[unclosed)",
      "epubcfi(/6/2!/4,/1:1)", "epubcfi(/6/2!/4/1:1:2)", `epubcfi(/6/2!${"/4".repeat(3000)})`,
      // Media offsets are not text positions; dropping them would fake an exact point.
      "epubcfi(/6/2!/4/4/2/1:2~3.5)", "epubcfi(/6/2!/4/4/2@10:20)", "epubcfi(/6/2!/4/4,/3:7@1:2,/3:10)"]) {
      expect(parseEpubCfi(bad), bad).toBeNull();
    }
  });
});

describe("resolveCfiSpine", () => {
  it("follows the OPF itemref like foliate-js, then the itemref id, then nothing", () => {
    const steps = (cfi: string) => collapseCfi(parseEpubCfi(cfi)!)[0];
    expect(resolveCfiSpine(steps(REF.c1PointHeading), SPINE, opf)).toEqual({ spineIndex: 0, via: "path" });
    expect(resolveCfiSpine(steps(REF.c2PointP2Start), SPINE, opf)).toEqual({ spineIndex: 1, via: "path" });
    expect(resolveCfiSpine(steps("epubcfi(/6/8[ref-c2]!/4)"), SPINE, opf)).toEqual({ spineIndex: 1, via: "id" });
    expect(resolveCfiSpine(steps("epubcfi(/6/8!/4)"), SPINE, opf)).toBeNull();
    expect(resolveCfiSpine(steps("epubcfi(/4/2!/4)"), SPINE, opf)).toBeNull();
  });

  it("without an OPF only guesses the conventional /6/N numbering and labels it", () => {
    const steps = (cfi: string) => collapseCfi(parseEpubCfi(cfi)!)[0];
    expect(resolveCfiSpine(steps("epubcfi(/6/4!/4)"), SPINE, null)).toEqual({ spineIndex: 1, via: "index-guess" });
    expect(resolveCfiSpine(steps("epubcfi(/6/6!/4)"), SPINE, null)).toBeNull();
  });
});

describe("CFI → visible-codepoints-no-whitespace-v1", () => {
  it("maps Readest reference CFIs to the reader's code-point offsets", () => {
    // 第一章 | 开头文字 𠀀字😀 后面，重复词与重复词。| 第二段 强调 结尾。
    expect(locate(REF.c1PointHeading)).toMatchObject({ offset: 0, idCorrected: false });
    // UTF-16 offset 2 sits after the astral 𠀀: one code point, not two.
    expect(locate(REF.c1PointAfterExt)).toMatchObject({ offset: 8, idCorrected: false });
    expect(locate(REF.c1RangeFirstRepeat)?.offset).toBe(13);
    expect(locate(REF.c1RangeFirstRepeat, true)?.offset).toBe(16);
    expect(locate(REF.c1RangeSecondRepeat)?.offset).toBe(17);
    expect(locate(REF.c1RangeSecondRepeat, true)?.offset).toBe(20);
    expect(locate(REF.c1RangeCross)?.offset).toBe(5);
    expect(locate(REF.c1RangeCross, true)?.offset).toBe(25);
    const index = new ChapterTextIndex(chapters[0]);
    expect(index.slice(17, 20)).toBe("重复词");
    expect(index.occurrences("重复词")).toEqual([13, 17]);
    expect(index.snippetAt(8)?.startsWith("字😀后面")).toBe(true);
  });

  it("skips script, hidden and footnote text exactly like the reader's structural rules", () => {
    const index = new ChapterTextIndex(chapters[1]);
    expect(index.slice(0, index.totalChars)).toBe("同一句话。中间的内容。同一句话。");
    expect(locate(REF.c2PointP2Start)?.offset).toBe(0);
    expect(locate(REF.c2RangeSecondSame)?.offset).toBe(11);
    expect(locate(REF.c2RangeSecondSame, true)?.offset).toBe(15);
  });

  it("uses an asserted id only when the index path misses it, and reports the correction", () => {
    const moved = resolveCfiInDocument(chapters[1], collapseCfi(parseEpubCfi("epubcfi(/6/4!/4/99[p2]/1:11)")!)[1]);
    expect(moved?.idCorrected).toBe(true);
    expect(new ChapterTextIndex(chapters[1]).offsetAt(moved!.point)).toBe(11);
  });

  it("returns nothing for missing nodes or offsets past the text instead of clamping", () => {
    const content = (cfi: string) => collapseCfi(parseEpubCfi(cfi)!)[1];
    expect(resolveCfiInDocument(chapters[1], content("epubcfi(/6/4!/4/8[p2]/1:999)"))).toBeNull();
    expect(resolveCfiInDocument(chapters[0], content("epubcfi(/6/2!/4/40/1:0)"))).toBeNull();
    expect(resolveCfiInDocument(chapters[0], content("epubcfi(/6/2!/2/2/1:0)"))).not.toBeNull();
    // A point in <head> is outside the reader's body text.
    const head = resolveCfiInDocument(chapters[0], content("epubcfi(/6/2!/2/2/1:0)"))!;
    expect(new ChapterTextIndex(chapters[0]).offsetAt(head.point)).toBeNull();
  });
});
