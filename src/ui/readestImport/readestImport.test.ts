import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import { CHAPTER_1, CHAPTER_2, OPF } from "../../render/interop/epubCfi.fixture";
import { parseReadestBookConfig, parseReadestLibrary, type ReadestBookConfig } from "./readestBackup";
import { convertReadestBook, type ReadestImportTarget } from "./readestConvert";

const HASH = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const xml = (source: string, type: string) =>
  new DOMParser().parseFromString(source, type as "text/xml") as unknown as Document;

function target(opf: Document | null = xml(OPF, "text/xml")): ReadestImportTarget & { loads: number[] } {
  const loads: number[] = [];
  const sources = [CHAPTER_1, CHAPTER_2];
  return {
    loads,
    spineIdrefs: ["c1", "c2"],
    chapterPath: (i) => ["OEBPS/Text/c1.xhtml", "OEBPS/Text/c2.xhtml"][i],
    opfDocument: opf,
    loadChapter: async (i) => {
      loads.push(i);
      return sources[i] ? xml(sources[i], "application/xhtml+xml") : null;
    },
  };
}

function config(json: unknown): ReadestBookConfig {
  const parsed = parseReadestBookConfig(JSON.stringify(json));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

const note = (id: string, cfi: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "annotation", cfi, text, note: `注 ${id}`, style: "highlight", color: "yellow", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra });

describe("Readest backup records", () => {
  it("restores directory groups to five levels, without guessing manual group names", () => {
    const parsed = parseReadestLibrary(JSON.stringify([
      { hash: "a".repeat(32), groupName: "Root/第二层/3/4/5/6/7", filePath: "C:\\Books\\Root\\第二层\\3\\4\\5\\6\\7\\book.epub" },
      { hash: "b".repeat(32), groupName: "Science/Fiction", filePath: "/books/book.epub" },
      { hash: "c".repeat(32), groupName: "Other/Child", filePath: "/books/Other/Child/book.epub" },
      { hash: "d".repeat(32) },
    ]));
    expect(parsed.ok && parsed.value.books.map((book) => book.folderPath)).toEqual([
      ["Root", "第二层", "3", "4", "5"], ["Science/Fiction"], ["Other", "Child"], undefined,
    ]);
    // Local paths are evidence for interpreting the source, never output data.
    expect(JSON.stringify(parsed)).not.toContain("filePath");
  });

  it("keeps only valid library rows and flags tombstones without acting on them", () => {
    const result = parseReadestLibrary(JSON.stringify([
      { hash: HASH.toUpperCase(), format: "EPUB", title: "  书名 ", author: "作者", originalFilename: "a.epub", createdAt: 1, updatedAt: 1 },
      { hash: "1".repeat(32), format: "PDF", title: "PDF 书", author: "", deletedAt: 5 },
      { hash: "not-a-hash", title: "x" },
      { hash: HASH, title: "duplicate" },
      "garbage",
    ]));
    expect(result).toEqual({
      ok: true,
      value: {
        books: [
          { hash: HASH, format: "EPUB", title: "书名", author: "作者", originalFilename: "a.epub", deleted: false },
          { hash: "1".repeat(32), format: "PDF", title: "PDF 书", author: "", originalFilename: null, deleted: true },
        ],
        ignored: 3,
      },
    });
    expect(parseReadestLibrary("{")).toEqual({ ok: false, reason: "invalid-json" });
    expect(parseReadestLibrary("{}")).toEqual({ ok: false, reason: "unexpected-shape" });
  });

  it("drops deleted, handwriting and notebook records and keeps the newest copy of an id", () => {
    const parsed = config({
      location: "epubcfi(/6/2!/4/4/2/1:2)",
      progress: [12, 300],
      viewSettings: { ignored: true },
      booknotes: [
        note("a", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { updatedAt: 1 }),
        note("a", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { updatedAt: 2, note: "newer" }),
        { id: "b", type: "bookmark", cfi: "epubcfi(/6/2!/4/2[head-1]/1:0)", note: "", createdAt: 1, updatedAt: 1 },
        { id: "c", type: "ink", cfi: "epubcfi(/6/2!/4)", note: "", createdAt: 1, updatedAt: 1 },
        { id: "d", type: "notebook", cfi: "", note: "free text", createdAt: 1, updatedAt: 1 },
        note("e", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { deletedAt: 9 }),
        note("f", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "   "),
        { id: "bad id with spaces", type: "bookmark", cfi: "x" },
      ],
    });
    expect(parsed.pages).toEqual([12, 300]);
    expect(parsed.records.map((r) => [r.id, r.kind, r.note])).toEqual([["a", "note", "newer"], ["b", "bookmark", ""]]);
    expect(parsed.skipped.map((s) => s.reason).sort()).toEqual(
      ["deleted", "handwriting", "invalid-record", "missing-text", "notebook"],
    );
    expect(parsed.records[0]).toMatchObject({ style: "highlight", color: "yellow" });
  });
});

describe("Readest → SeLis preview", () => {
  it("places progress, bookmarks and notes exactly when CFI and captured text agree", async () => {
    const t = target();
    const preview = await convertReadestBook(HASH, config({
      location: "epubcfi(/6/2!/4/4,/2/1:2,/6/1:3)",
      progress: [30, 300],
      booknotes: [
        { id: "bm", type: "bookmark", cfi: "epubcfi(/6/2!/4/2[head-1]/1:0)", text: "第一章 开头文字", note: "", createdAt: 1_700_000_000_000, updatedAt: 1 },
        note("n1", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词"),
        note("n2", "epubcfi(/6/4[ref-c2]!/4/8[p2],/1:11,/1:15)", "同一句话"),
      ],
    }), t, NOW);

    expect(preview.progress).toMatchObject({
      sourceKey: `readest:${HASH}:progress`,
      grade: "exact",
      value: {
        progressPctHint: 10,
        locator: {
          locatorVersion: 1, chapterPath: "OEBPS/Text/c1.xhtml", spineIndexHint: 0,
          target: { kind: "text", textProfile: "visible-codepoints-no-whitespace-v1", offset: 8 },
        },
      },
    });
    expect(preview.bookmarks[0]).toMatchObject({
      sourceKey: `readest:${HASH}:bm`, grade: "exact",
      value: { text: "第一章 开头文字", createdAtMs: 1_700_000_000_000, locator: { target: { offset: 0, snippet: expect.stringMatching(/^第一章开头/) } } },
    });
    expect(preview.notes.map((n) => [n.grade, n.value?.startTextOffset, n.value?.endTextOffset])).toEqual([
      ["exact", 17, 20],
      ["exact", 11, 15],
    ]);
    expect(preview.notes[0].value).toMatchObject({
      chapterPath: "OEBPS/Text/c1.xhtml", selectedText: "重复词", content: "注 n1",
      startTextSnippet: "重复词。第二段强调结尾。", endTextSnippet: expect.stringMatching(/重复词与重复词$/),
    });
    // Each chapter is parsed once however many records point into it.
    expect(t.loads.sort()).toEqual([0, 1]);
  });

  it("relocates by text only to a unique or nearest occurrence and reports it", async () => {
    const preview = await convertReadestBook(HASH, config({
      booknotes: [
        // Range drifted by one character: text wins, nearest 重复词 to the CFI (17), not the first (13).
        note("drift", "epubcfi(/6/2!/4/4,/3:8,/3:11)", "重复词"),
        // CFI node gone, text unique in the chapter.
        note("gone", "epubcfi(/6/2!/4/40,/1:0,/1:2)", "强调"),
        // CFI node gone, text occurs twice: refuse instead of taking the first.
        note("ambiguous", "epubcfi(/6/4!/4/40,/1:0,/1:4)", "同一句话"),
        // Text absent from the chapter: a different edition.
        note("edition", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "完全不同"),
        // CFI lands at 15, exactly between 重复词 at 13 and 17: no unique nearest, refuse.
        note("tie", "epubcfi(/6/2!/4/4,/3:5,/3:8)", "重复词"),
      ],
    }), target(), NOW);
    expect(preview.notes.map((n) => [n.sourceKey.split(":").at(-1), n.grade, n.reasons, n.value?.startTextOffset ?? null])).toEqual([
      ["drift", "approximate", ["text-relocated"], 17],
      ["gone", "approximate", ["text-relocated"], 24],
      ["ambiguous", "approximate", ["anchored"], 0],
      ["edition", "approximate", ["cfi-only"], 17],
      ["tie", "approximate", ["cfi-only"], 15],
    ]);
  });

  it("converts highlights without a written note as pure highlights with empty content", async () => {
    const preview = await convertReadestBook(HASH, config({
      location: "epubcfi(/6/2!/4/4,/3:7,/3:10)",
      progress: [1, 3],
      booknotes: [note("plain", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { note: "  ", style: "squiggly", color: "red" })],
    }), target(), NOW);
    expect(preview.notes).toEqual([
      expect.objectContaining({
        grade: "exact",
        reasons: [],
        value: expect.objectContaining({
          content: "",
          selectedText: "重复词",
          style: "squiggly",
          color: "red",
        }),
      }),
    ]);
    expect(preview.progress?.value?.progressPctHint).toBe(33);
  });

  it("cuts long bookmark labels by code point, not inside a surrogate pair", async () => {
    // 79 BMP chars then 😀 straddles UTF-16 index 79/80.
    const text = `${"字".repeat(79)}😀尾`;
    const preview = await convertReadestBook(HASH, config({
      booknotes: [{ id: "long", type: "bookmark", cfi: "epubcfi(/6/2!/4/2[head-1]/1:0)", text, note: "", createdAt: 1, updatedAt: 1 }],
    }), target(), NOW);
    const label = preview.bookmarks[0].value!.text;
    expect(label).toBe(`${"字".repeat(79)}😀`);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("keeps missing chapters unresolved but clamps an overflowing progress offset", async () => {
    const preview = await convertReadestBook(HASH, config({
      location: "epubcfi(/6/2!/4/4/2/1:99)",
      booknotes: [
        { id: "b1", type: "bookmark", cfi: "epubcfi(/6/20!/4/2/1:0)", note: "", createdAt: 1, updatedAt: 1 },
        { id: "b2", type: "bookmark", cfi: "not a cfi", note: "", createdAt: 1, updatedAt: 1 },
      ],
    }), target(), NOW);
    expect(preview.progress).toMatchObject({ grade: "approximate", reasons: ["cfi-clamped"], value: { locator: { target: { offset: 10 } } } });
    expect(preview.bookmarks.map((b) => [b.grade, b.reasons])).toEqual([
      ["unresolved", ["chapter-missing"]],
      ["unresolved", ["bad-cfi"]],
    ]);
  });

  it("marks spine guesses and id corrections as approximate, and keeps a mismatched bookmark excerpt visible", async () => {
    const preview = await convertReadestBook(HASH, config({
      location: "epubcfi(/6/4!/4/99[p2]/1:5)",
      booknotes: [
        { id: "bm", type: "bookmark", cfi: "epubcfi(/6/2!/4/2[head-1]/1:0)", text: "别的版本的开头", note: "", createdAt: NOW * 2, updatedAt: 1 },
      ],
    }), target(null), NOW);
    expect(preview.progress).toMatchObject({
      grade: "approximate", reasons: ["spine-guessed", "id-corrected"],
      value: { locator: { spineIndexHint: 1, target: { offset: 5, snippet: "中间的内容。同一句话。" } } },
    });
    // Future timestamps from another device's clock fall back to import time.
    expect(preview.bookmarks[0]).toMatchObject({ grade: "approximate", reasons: ["spine-guessed", "text-differs"], value: { createdAtMs: NOW } });
  });
});

describe("ER-0110: Readest highlight migration (style, color, pure highlight, excerpt)", () => {
  it("imports pure highlights, annotated highlights, all five palette colors, custom hex, and excerpts as valid NoteValues", async () => {
    const t = target();
    const preview = await convertReadestBook(HASH, config({
      booknotes: [
        // 1. 纯高亮: 空白 note 成为 content: ""
        note("pure", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { note: "   ", style: "highlight", color: "yellow" }),
        // 2. 带笔记高亮: 保留 note 正文、样式与颜色
        note("annotated", "epubcfi(/6/4[ref-c2]!/4/8[p2],/1:11,/1:15)", "同一句话", { note: "重要批注", style: "underline", color: "blue" }),
        // 3. 五色: red, yellow, green, blue, violet
        note("c_red", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { color: "red", style: "highlight" }),
        note("c_yellow", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { color: "yellow", style: "highlight" }),
        note("c_green", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { color: "green", style: "highlight" }),
        note("c_blue", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { color: "blue", style: "highlight" }),
        note("c_violet", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { color: "violet", style: "highlight" }),
        // 4. 自定义 hex: 大写 #AABBCC 归一化为小写 #aabbcc
        note("hex", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { style: "squiggly", color: "#AABBCC" }),
        // 5. excerpt: 无论 note 是否存在，均按纯高亮迁入（content: ""）
        {
          id: "ex1",
          type: "excerpt",
          cfi: "epubcfi(/6/4[ref-c2]!/4/8[p2],/1:11,/1:15)",
          text: "同一句话",
          note: "摘录自带文字",
          style: "highlight",
          color: "green",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
        // 6. 非法颜色: 按丢弃颜色处理（保留笔记正文与样式，color 为 undefined，使用主题默认色）
        note("bad_color", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { note: "合法批注", style: "underline", color: "purple" }),
        // 7. global 高亮只标原位置，不全章扩散
        note("global_hl", "epubcfi(/6/2!/4/4,/3:7,/3:10)", "重复词", { global: true, style: "highlight", color: "yellow" }),
      ],
    }), t, NOW);

    // 纯高亮
    const pure = preview.notes.find((n) => n.sourceKey.endsWith(":pure"));
    expect(pure?.grade).toBe("exact");
    expect(pure?.value).toMatchObject({ content: "", selectedText: "重复词", style: "highlight", color: "yellow" });

    // 带笔记高亮
    const annotated = preview.notes.find((n) => n.sourceKey.endsWith(":annotated"));
    expect(annotated?.grade).toBe("exact");
    expect(annotated?.value).toMatchObject({ content: "重要批注", selectedText: "同一句话", style: "underline", color: "blue" });

    // 五色
    for (const name of ["red", "yellow", "green", "blue", "violet"]) {
      const entry = preview.notes.find((n) => n.sourceKey.endsWith(`:c_${name}`));
      expect(entry?.value?.color).toBe(name);
    }

    // 自定义 hex 小写归一化
    const hex = preview.notes.find((n) => n.sourceKey.endsWith(":hex"));
    expect(hex?.value).toMatchObject({ style: "squiggly", color: "#aabbcc" });

    // excerpt 迁入为纯高亮
    const excerpt = preview.notes.find((n) => n.sourceKey.endsWith(":ex1"));
    expect(excerpt?.grade).toBe("exact");
    expect(excerpt?.value).toMatchObject({ content: "", selectedText: "同一句话", style: "highlight", color: "green" });

    // 非法颜色被丢弃，笔记保留
    const badColor = preview.notes.find((n) => n.sourceKey.endsWith(":bad_color"));
    expect(badColor?.grade).toBe("exact");
    expect(badColor?.value?.content).toBe("合法批注");
    expect(badColor?.value?.style).toBe("underline");
    expect(badColor?.value?.color).toBeUndefined();

    // global 只产生 1 个 note，不扩散
    const globals = preview.notes.filter((n) => n.sourceKey.endsWith(":global_hl"));
    expect(globals).toHaveLength(1);
    expect(globals[0].grade).toBe("exact");
    expect(globals[0].value?.startTextOffset).toBe(17);
  });
});

it("keeps a ruby annotation as an approximate canonical range, independently of clamped progress", async () => {
  const doc = xml('<html><head/><body><p><ruby>伊武圣兰<rp>（</rp><rt>Ibu Seira</rt><rp>）</rp></ruby>后</p></body></html>', "text/xml");
  const t: ReadestImportTarget = { spineIdrefs: ["c1", "c2"], chapterPath: () => "c.xhtml", opfDocument: xml(OPF, "text/xml"), loadChapter: async () => doc };
  const preview = await convertReadestBook(HASH, config({
    location: "epubcfi(/6/2!/4/2/2/1:99)", progress: [7, 100],
    booknotes: [note("ruby", "epubcfi(/6/2!/4/2,/2/1:0,/2/4/1:9)", "伊武圣兰（）")],
  }), t, NOW);
  expect(preview.progress).toMatchObject({ grade: "approximate", reasons: ["cfi-clamped"] });
  const n = preview.notes[0];
  expect(n).toMatchObject({ grade: "approximate", reasons: ["text-reconciled", "ruby-annotation"] });
  expect(n.value?.selectedText).toBe("伊武圣兰IbuSeira");
  expect(Array.from(n.value!.selectedText).length).toBe(n.value!.endTextOffset - n.value!.startTextOffset);
});

it("marks a range-end progress fallback as approximate even when the end needs no clamp", async () => {
  const preview = await convertReadestBook(HASH, config({
    location: "epubcfi(/6/2!/4,/40/1:0,/4/3:7)",
    progress: [12, 300],
  }), target(), NOW);
  expect(preview.progress).toMatchObject({
    grade: "approximate",
    reasons: ["anchored"],
    value: { locator: { chapterPath: "OEBPS/Text/c1.xhtml" } },
  });
});

it("keeps a bookmark whose offset is past the text, marked approximate", async () => {
  const preview = await convertReadestBook(HASH, config({
    booknotes: [{ id: "bm-clamped", type: "bookmark", cfi: "epubcfi(/6/2!/4/2[head-1]/1:99)", note: "", createdAt: 1_700_000_000_000, updatedAt: 1 }],
  }), target(), NOW);
  expect(preview.bookmarks[0]).toMatchObject({
    grade: "approximate",
    reasons: ["anchored"],
    value: { locator: { chapterPath: "OEBPS/Text/c1.xhtml" } },
  });
});
