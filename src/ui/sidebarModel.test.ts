import { describe, expect, it } from "vitest";
import type { TocNode } from "../core/types";
import {
  TOC_EXPAND_ALL_LIMIT,
  countTocNodes,
  defaultExpandedTocKeys,
  findActiveTocNode,
  limitNotes,
  sortNotesNewestFirst,
  tocAncestorKeys,
  tocNodeKeys,
  type NoteViewModel,
} from "./sidebarModel";

const item = (label: string, href: string, children: TocNode[] = []): TocNode => ({
  label,
  href,
  children,
});

describe("sidebar TOC helpers", () => {
  it("递归统计全部目录层级", () => {
    const nodes = [
      item("章", "OEBPS/ch.xhtml", [
        item("节", "OEBPS/ch.xhtml#s1", [item("小节", "OEBPS/ch.xhtml#s2")]),
      ]),
      item("后记", "OEBPS/end.xhtml"),
    ];
    expect(countTocNodes(nodes)).toBe(4);
  });

  it("fragment 精确匹配优先", () => {
    const root = item("章首", "OEBPS/ch.xhtml", [
      item("小节一", "OEBPS/ch.xhtml#s1"),
      item("小节二", "OEBPS/ch.xhtml#s2"),
    ]);
    expect(findActiveTocNode([root], "OEBPS/ch.xhtml#s2")?.label).toBe("小节二");
  });

  it("没有精确 fragment 时优先章首，同路径始终只返回一个引用", () => {
    const first = item("同路径第一项", "OEBPS/ch.xhtml#missing");
    const root = item("章首", "OEBPS/ch.xhtml", [first, item("另一节", "OEBPS/ch.xhtml#s2")]);
    expect(findActiveTocNode([root], "OEBPS/ch.xhtml#unknown")).toBe(root);
    expect(findActiveTocNode([root], "OEBPS/ch.xhtml")).toBe(root);
  });

  it("支持在同章节多个子小节锚点之间连续切换高亮选中项", () => {
    // 模拟《ePub指南》第2.1节的真实结构：主章节与多个同文件不同 fragment 的子节
    const sec21_9 = item("2.1.9 代码排版", "OEBPS/Text/Chapter2-1.xhtml#html_block_code");
    const sec21_10 = item("2.1.10 预格式文本", "OEBPS/Text/Chapter2-1.xhtml#html_block_pre");
    const sec21_11 = item("2.1.11 引用内容", "OEBPS/Text/Chapter2-1.xhtml#html_block_next");
    const chap21 = item("2.1 基本排版元素", "OEBPS/Text/Chapter2-1.xhtml", [
      sec21_9,
      sec21_10,
      sec21_11,
    ]);

    // 1. 点击 2.1.10
    expect(findActiveTocNode([chap21], "OEBPS/Text/Chapter2-1.xhtml#html_block_pre")?.label).toBe("2.1.10 预格式文本");

    // 2. 连续点击 2.1.11：高亮必须精确跟随移动到 2.1.11，不能停留在 2.1.10
    expect(findActiveTocNode([chap21], "OEBPS/Text/Chapter2-1.xhtml#html_block_next")?.label).toBe("2.1.11 引用内容");

    // 3. 点击回主章 2.1：高亮移回主章节
    expect(findActiveTocNode([chap21], "OEBPS/Text/Chapter2-1.xhtml")?.label).toBe("2.1 基本排版元素");
  });
});

const batchSize = 200;
const note = (id: string, createdAtMs: number): NoteViewModel => ({
  id,
  content: id,
  selectedText: id,
  chapterTitle: "第一章",
  createdAtMs,
});

describe("sidebar TOC collapse helpers", () => {
  const leaf = item("1.1", "a.xhtml#1");
  const toc = [item("卷一", "a.xhtml", [item("第一章", "a.xhtml#c", [leaf])]), item("卷二", "b.xhtml")];

  it("keys nodes by their index path in the original TOC", () => {
    const keys = tocNodeKeys(toc);
    expect(keys.get(toc[0])).toBe("0");
    expect(keys.get(toc[0].children[0])).toBe("0.0");
    expect(keys.get(leaf)).toBe("0.0.0");
    expect(keys.get(toc[1])).toBe("1");
  });

  it("lists every ancestor of the active entry, not the entry itself", () => {
    expect(tocAncestorKeys(toc, leaf)).toEqual(["0", "0.0"]);
    expect(tocAncestorKeys(toc, toc[1])).toEqual([]);
    expect(tocAncestorKeys(toc, item("外来", "x.xhtml"))).toEqual([]);
    expect(tocAncestorKeys(toc, undefined)).toEqual([]);
  });

  it("expands every branch of a small TOC and none of a large one", () => {
    expect([...defaultExpandedTocKeys(toc)].sort()).toEqual(["0", "0.0"]);
    const large = Array.from({ length: 4 }, (_, v) =>
      item(`卷${v}`, `v${v}.xhtml`, Array.from({ length: 10 }, (_, c) => item(`第${c}章`, `v${v}.xhtml#${c}`))));
    expect(countTocNodes(large)).toBeGreaterThan(TOC_EXPAND_ALL_LIMIT);
    expect(defaultExpandedTocKeys(large).size).toBe(0);
  });
});

describe("sidebar note helpers", () => {
  it("sorts newest first with a deterministic tie breaker", () => {
    expect(sortNotesNewestFirst([note("a", 1), note("c", 3), note("b", 3)]).map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("bounds rendered cards for a large note collection", () => {
    const notes = Array.from({ length: batchSize + 3 }, (_, index) => note(String(index), index));
    const result = limitNotes(notes, batchSize);
    expect(result.items).toHaveLength(batchSize);
    expect(result.limited).toBe(true);
    expect(result.items[0]?.id).toBe(String(batchSize + 2));
  });

  it("can expose every note through successive batches", () => {
    const notes = Array.from({ length: batchSize * 2 + 1 }, (_, index) => note(String(index), index));
    const first = limitNotes(notes, batchSize);
    const second = limitNotes(notes, batchSize * 2);
    const final = limitNotes(notes, batchSize * 3);
    expect(first.limited).toBe(true);
    expect(second.items).toHaveLength(batchSize * 2);
    expect(final.items).toHaveLength(notes.length);
    expect(final.limited).toBe(false);
  });
});
