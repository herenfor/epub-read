import { describe, expect, it } from "vitest";
import type { TocNode } from "../core/types";
import { activeTocEntry, indexToc, tocOffsets, tocWindow, visibleTocRows } from "./sidebarToc";

const node = (label: string, href: string, children: TocNode[] = []): TocNode => ({ label, href, children });

describe("indexed and windowed TOC", () => {
  it("keeps original node identity, ancestors and sibling positions while filtering", () => {
    const leaf = node("needle", "b.xhtml#two");
    const roots = [node("other", "a.xhtml"), node("volume", "b.xhtml", [node("first", "b.xhtml#one"), leaf])];
    const index = indexToc(roots), active = activeTocEntry(index, "b.xhtml#two")!;
    expect(active.node).toBe(leaf);
    expect(active.key).toBe("1.1");
    expect(active.parent?.node).toBe(roots[1]);
    const rows = visibleTocRows(index, new Set(), "needle");
    expect(rows.map(r => r.entry.key)).toEqual(["1", "1.1"]);
    expect(rows[1].entry).toBe(active);
    expect(rows[0].open).toBe(true);
    expect(rows[1].siblings).toBe(1);
    expect(visibleTocRows(index, new Set(["1"]), "")[3].position).toBe(2);
  });

  it("preserves fragment, chapter-start and first-entry fallback ordering", () => {
    const first = node("first", "b.xhtml#a"), exact = node("exact", "b.xhtml#b"), start = node("start", "b.xhtml");
    const index = indexToc([first, exact, start, node("duplicate", "b.xhtml#b")]);
    expect(activeTocEntry(index, "b.xhtml#b")?.node).toBe(exact);
    expect(activeTocEntry(index, "b.xhtml#missing")?.node).toBe(start);
    expect(activeTocEntry(index, "b.xhtml")?.node).toBe(start);
    expect(activeTocEntry(indexToc([first, exact]), "b.xhtml#missing")?.node).toBe(first);
    expect(activeTocEntry(index, "missing.xhtml")).toBeUndefined();
  });

  it("keeps collapsed branches out of the window without dropping their directory entries", () => {
    const index = indexToc([node("root", "a.xhtml", [node("nested", "a.xhtml#n", [node("leaf", "a.xhtml#l")])])]);
    expect(index.entries).toHaveLength(3);
    expect(visibleTocRows(index, new Set(), "").map(r => r.entry.key)).toEqual(["0"]);
    expect(visibleTocRows(index, new Set(["0", "0.0"]), "").map(r => r.entry.key)).toEqual(["0", "0.0", "0.0.0"]);
  });

  it("covers the viewport with fractional heights and bounded DOM at both ends of a long list", () => {
    const rows = visibleTocRows(indexToc(Array.from({ length: 1400 }, (_, i) => node(String(i), `${i}.xhtml`))), new Set(), "");
    const offsets = tocOffsets(rows, [31.5, 30.8, 30.1, 30.1]);
    for (const top of [0, 31.5, 20000.1, offsets.at(-1)! - 600]) {
      const window = tocWindow(offsets, top, 600);
      expect(window.end - window.start).toBeLessThan(45);
      expect(offsets[window.start]).toBeLessThanOrEqual(top);
      expect(offsets[window.end]).toBeGreaterThanOrEqual(Math.min(offsets.at(-1)!, top + 600));
    }
    expect(tocWindow([0], 0, 600)).toEqual({ start: 0, end: 0 });
    const depths = visibleTocRows(indexToc([node("a", "a", [node("b", "b")])]), new Set(["0"]), "");
    expect(tocOffsets(depths, [31.5, 30.8, 30.1, 30.1])).toEqual([0, 31.5, 62.3]);
  });
});
