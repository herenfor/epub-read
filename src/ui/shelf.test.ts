import { describe, expect, it } from "vitest";
import {
  applyShelfProgressPatch,
  filterShelfEntries,
  buildShelfFilterFacets,
  createShelfFilterModel,
  formatShelfTime,
  markShelfEntryOpened,
  normalizeShelfEntryTextAnchors,
  normalizeShelfAuthor,
  normalizeShelfLanguage,
  readingAnchorFromShelfEntry,
  shelfIdFor,
  sortShelfEntries,
  type ShelfEntry,
} from "./shelf";
import { hasReadPosition } from "./readEvidence";

function entry(over: Partial<ShelfEntry>): ShelfEntry {
  return {
    id: "id",
    title: "书",
    creator: "作者",
    fileName: "book.epub",
    fileSize: 100,
    coverMime: "",
    addedAtMs: 1,
    lastReadAtMs: 2,
    spineIndex: 0,
    page: 0,
    progressPct: 0,
    anchorIndex: null,
    anchorRatio: null,
    isNew: false,
    ...over,
  };
}

describe("shelfIdFor", () => {
  it("同标识/文件名/大小得到同一 id，任一字段变化则变化", () => {
    const a = shelfIdFor("urn:uuid:x", "book.epub", 123);
    expect(a).toBe(shelfIdFor("urn:uuid:x", "book.epub", 123));
    expect(a).not.toBe(shelfIdFor("urn:uuid:y", "book.epub", 123));
    expect(a).not.toBe(shelfIdFor("urn:uuid:x", "book2.epub", 123));
    expect(a).not.toBe(shelfIdFor("urn:uuid:x", "book.epub", 124));
  });

  it("只包含 16 进制字符（后端路径安全）", () => {
    expect(shelfIdFor("中文 书名:测试", "book (1).epub", 999)).toMatch(/^[0-9a-f]+$/);
  });
});

describe("sortShelfEntries", () => {
  const a = entry({ id: "a", title: "乙", addedAtMs: 1, lastReadAtMs: 3 });
  const b = entry({ id: "b", title: "甲", addedAtMs: 3, lastReadAtMs: 1 });
  const c = entry({ id: "c", title: "丙", addedAtMs: 2, lastReadAtMs: 2 });
  const all = [a, b, c];

  it("recent 按最近阅读排序", () => {
    expect(sortShelfEntries(all, "recent").map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
  it("recent 对未读导入记录回退到 addedAt", () => {
    const imported = entry({ id: "imported", addedAtMs: 10, lastReadAtMs: 0, isNew: true });
    const read = entry({ id: "read", addedAtMs: 1, lastReadAtMs: 2, isNew: false });
    expect(sortShelfEntries([read, imported], "recent").map((e) => e.id)).toEqual(["imported", "read"]);
  });
  it("added 按最近添加排序", () => {
    expect(sortShelfEntries(all, "added").map((e) => e.id)).toEqual(["b", "c", "a"]);
  });
  it("title 按书名排序（拼音序）且不改原数组", () => {
    const sorted = sortShelfEntries(all, "title");
    expect(sorted.map((e) => e.title)).toEqual(["丙", "甲", "乙"]);
    expect(all.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
  it("progress 按阅读进度降序排序", () => {
    const p1 = entry({ id: "p1", progressPct: 15 });
    const p2 = entry({ id: "p2", progressPct: 90 });
    const p3 = entry({ id: "p3", progressPct: 0 });
    expect(sortShelfEntries([p1, p2, p3], "progress").map((e) => e.id)).toEqual(["p2", "p1", "p3"]);
  });
});

describe("filterShelfEntries", () => {
  const list = [
    entry({ id: "1", title: "命定之人是妻子的妹妹", creator: "逢緣奇演" }),
    entry({ id: "2", title: "诡屋", creator: "Ameku Takao" }),
  ];
  it("按书名匹配", () => {
    expect(filterShelfEntries(list, "诡").map((e) => e.id)).toEqual(["2"]);
  });
  it("按作者匹配（大小写不敏感）", () => {
    expect(filterShelfEntries(list, "ameku").map((e) => e.id)).toEqual(["2"]);
  });
  it("空查询返回全部", () => {
    expect(filterShelfEntries(list, "  ")).toHaveLength(2);
  });
});

describe("shelf filter metadata", () => {
  it("normalizes CJK whitespace/format characters but preserves western name spaces", () => {
    expect(normalizeShelfAuthor("七菜　なな\u200b\u2060なな")).toBe("七菜なななな");
    expect(normalizeShelfAuthor("ＡＢＣ１２３")).toBe("ABC123");
    expect(normalizeShelfAuthor("John Smith")).toBe("John Smith");
    expect(normalizeShelfAuthor("Alice\u200bSmith")).toBe("Alice\u200bSmith");
    expect(normalizeShelfAuthor("　")).toBe("未知作者");
  });

  it("groups BCP-47 languages and treats omitted legacy values as unknown", () => {
    expect(normalizeShelfLanguage("zh-CN")).toBe("中文");
    expect(normalizeShelfLanguage("ja_JP")).toBe("日语");
    expect(normalizeShelfLanguage("en-US")).toBe("英语");
    expect(normalizeShelfLanguage()).toBe("未知语言");
  });

  it("filters by intersection and reports cross-filtered facet counts", () => {
    const now = new Date(2026, 7, 23, 12).getTime();
    const day = 24 * 60 * 60 * 1000;
    const books = [
      entry({ id: "a", creator: "七菜　なな", title: "甲", language: "zh-CN", addedAtMs: now - 1_000 }),
      entry({ id: "b", creator: "七菜\u200bなな", title: "乙", language: "ja-JP", addedAtMs: now - 2 * day }),
      entry({ id: "c", creator: "John Smith", title: "甲", addedAtMs: now - 40 * day }),
      entry({ id: "d", creator: "其他", title: "丙", language: "en", addedAtMs: new Date(2025, 1, 1).getTime() }),
    ];
    const model = createShelfFilterModel(books, { authors: ["七菜なな"], titles: ["乙"] }, now);
    expect(model.entries.map((book) => book.id)).toEqual(["b"]);
    expect(model.facets.titles.counts["甲"]).toBe(1);
    expect(model.facets.titles.counts["乙"]).toBe(1);
    expect(model.facets.languages.counts["中文"]).toBe(0);
    expect(model.facets.languages.counts["日语"]).toBe(1);
    expect(model.facets.languages.counts["未知语言"]).toBe(0);
    expect(buildShelfFilterFacets(books, {}, now).timeSegments.counts.today).toBe(1);
  });
});

describe("formatShelfTime", () => {
  it("无效值返回空串", () => {
    expect(formatShelfTime(0)).toBe("");
  });
});

describe("progress entry merge", () => {
  it("recognizes a real saved position even when the rounded percentage is zero", () => {
    expect(hasReadPosition(entry({ progressPct: 0, page: 4, isNew: true }))).toBe(true);
    expect(hasReadPosition(entry({ progressPct: 0, page: 0, spineIndex: 0, isNew: true, anchorTextOffset: 8 }))).toBe(true);
    expect(hasReadPosition(entry({ progressPct: 0, page: 0, spineIndex: 0, isNew: true, lastReadAtMs: 0 }))).toBe(false);
    expect(hasReadPosition(entry({ progressPct: 0, page: 0, spineIndex: 0, isNew: false }))).toBe(true);
  });

  it("清除新书标记不会覆盖刚写入的页码与锚点", () => {
    const original = entry({ id: "book", page: 2, progressPct: 10, isNew: true });
    const progressed = applyShelfProgressPatch([original], "book", {
      lastReadAtMs: 99,
      spineIndex: 3,
      page: 7,
      progressPct: 42,
      anchorIndex: 10,
      anchorRatio: 0.5,
      anchorTextOffset: 123,
      anchorTextSnippet: "正文",
    });
    const opened = markShelfEntryOpened(progressed, "book")[0];
    expect(opened).toMatchObject({
      isNew: false,
      lastReadAtMs: 99,
      spineIndex: 3,
      page: 7,
      progressPct: 42,
      anchorIndex: 10,
      anchorRatio: 0.5,
      anchorTextOffset: 123,
      anchorTextSnippet: "正文",
    });
  });

  it("normalizes omitted legacy text fields to null and drops invalid snippets", () => {
    expect(normalizeShelfEntryTextAnchors(entry({}))).toMatchObject({
      anchorTextOffset: null,
      anchorTextSnippet: null,
    });
    expect(
      normalizeShelfEntryTextAnchors(entry({ anchorTextOffset: 8, anchorTextSnippet: "bad space" }))
    ).toMatchObject({ anchorTextOffset: null, anchorTextSnippet: null });
  });

  it("keeps legacy-only shelf anchors and exposes text-only anchors without persisting -1", () => {
    expect(readingAnchorFromShelfEntry(entry({ anchorIndex: 8, anchorRatio: 0.25 }))).toEqual({
      index: 8,
      ratio: 0.25,
      anchorTextOffset: null,
      anchorTextSnippet: null,
    });
    expect(
      readingAnchorFromShelfEntry(entry({ anchorIndex: null, anchorRatio: null, anchorTextOffset: 9, anchorTextSnippet: "正文" }))
    ).toMatchObject({ index: -1, anchorTextOffset: 9, anchorTextSnippet: "正文" });
  });

  it("keeps a media-only shelf anchor for image progress restore", () => {
    const mediaAnchor = { index: 2, tag: "img", signature: "img|mid", ratio: 0.6 };
    expect(
      readingAnchorFromShelfEntry(entry({ anchorIndex: null, anchorRatio: null, mediaAnchor }))
    ).toMatchObject({
      index: -1,
      anchorTextOffset: null,
      anchorTextSnippet: null,
      mediaAnchor,
    });
  });
});
