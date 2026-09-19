import { describe, expect, it } from "vitest";
import type { TocNode } from "../core/types";
import { countTocNodes, findActiveTocNode } from "./TocPanel";

const item = (label: string, href: string, children: TocNode[] = []): TocNode => ({
  label,
  href,
  children,
});

describe("TocPanel helpers", () => {
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
