import type { TocNode } from "../core/types";
import { splitHref } from "../core/paths";

export interface IndexedTocNode {
  key: string;
  node: TocNode;
  level: number;
  parent?: IndexedTocNode;
  children: IndexedTocNode[];
}
export interface TocIndex {
  roots: IndexedTocNode[];
  entries: IndexedTocNode[];
  paths: Map<string, { first: IndexedTocNode; start?: IndexedTocNode; anchors: Map<string, IndexedTocNode> }>;
  nested: boolean;
}

/** Index original nodes once; filtering must not manufacture another node identity. */
export function indexToc(nodes: readonly TocNode[]): TocIndex {
  const entries: IndexedTocNode[] = [], paths: TocIndex["paths"] = new Map();
  const walk = (nodes: readonly TocNode[], parent?: IndexedTocNode): IndexedTocNode[] => nodes.map((node, i) => {
    const entry: IndexedTocNode = { key: parent ? `${parent.key}.${i}` : String(i), node, level: parent ? parent.level + 1 : 0, parent, children: [] };
    entries.push(entry);
    const href = splitHref(node.href);
    let group = paths.get(href.path);
    if (!group) { group = { first: entry, anchors: new Map() }; paths.set(href.path, group); }
    if (!href.anchor && !group.start) group.start = entry;
    if (!group.anchors.has(href.anchor)) group.anchors.set(href.anchor, entry);
    entry.children = walk(node.children, entry);
    return entry;
  });
  const roots = walk(nodes);
  return { roots, entries, paths, nested: entries.some(e => e.children.length > 0) };
}

export function activeTocEntry(index: TocIndex, href?: string): IndexedTocNode | undefined {
  if (!href) return undefined;
  const { path, anchor } = splitHref(href), group = index.paths.get(path);
  return group && ((anchor ? group.anchors.get(anchor) : undefined) ?? group.start ?? group.first);
}

export interface TocRow {
  entry: IndexedTocNode;
  parent: boolean;
  open: boolean;
  position: number;
  siblings: number;
}

export function visibleTocRows(index: TocIndex, expanded: ReadonlySet<string>, filter: string): TocRow[] {
  const query = filter.trim().toLowerCase();
  let included: Set<IndexedTocNode> | undefined;
  if (query) {
    included = new Set();
    for (const entry of index.entries) {
      if (!entry.node.label.toLowerCase().includes(query)) continue;
      for (let cursor: IndexedTocNode | undefined = entry; cursor && !included.has(cursor); cursor = cursor.parent) included.add(cursor);
    }
  }
  const rows: TocRow[] = [];
  const walk = (siblings: IndexedTocNode[]) => {
    const present = included ? siblings.filter(e => included!.has(e)) : siblings;
    present.forEach((entry, i) => {
      const children = included ? entry.children.filter(e => included!.has(e)) : entry.children;
      const parent = children.length > 0, open = parent && (Boolean(query) || expanded.has(entry.key));
      rows.push({ entry, parent, open, position: i + 1, siblings: present.length });
      if (open) walk(children);
    });
  };
  walk(index.roots);
  return rows;
}

export function tocOffsets(rows: readonly TocRow[], heights: readonly number[]): number[] {
  const offsets = [0];
  for (const row of rows) offsets.push(offsets[offsets.length - 1] + heights[Math.min(row.entry.level, 3)]);
  return offsets;
}

function lowerBound(a: readonly number[], value: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

export function tocWindow(offsets: readonly number[], top: number, height: number, extra = 10) {
  const count = offsets.length - 1;
  if (!count) return { start: 0, end: 0 };
  const first = Math.min(count - 1, Math.max(0, lowerBound(offsets, top) - 1));
  return { start: Math.max(0, first - extra), end: Math.min(count, Math.max(first + 1, lowerBound(offsets, top + height)) + extra) };
}
