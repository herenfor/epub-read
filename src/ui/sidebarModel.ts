import type { TocNode } from "../core/types";
import { splitHref } from "../core/paths";

/** 递归统计目录项，包含所有层级而不只是顶层章节。 */
export function countTocNodes(nodes: TocNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countTocNodes(node.children), 0);
}

/**
 * 找唯一活动目录项：fragment 精确匹配优先；否则同路径的章首项，再退回
 * 同路径第一项。返回节点引用供渲染层做 identity 比较，避免同章多项同时高亮。
 */
export function findActiveTocNode(
  nodes: TocNode[],
  activeHref?: string
): TocNode | undefined {
  if (!activeHref) return undefined;
  const active = splitHref(activeHref);
  const all: TocNode[] = [];
  const collect = (items: TocNode[]): void => {
    for (const item of items) {
      all.push(item);
      collect(item.children);
    }
  };
  collect(nodes);
  const samePath = all.filter((node) => splitHref(node.href).path === active.path);
  if (samePath.length === 0) return undefined;
  if (active.anchor) {
    const exact = samePath.find((node) => splitHref(node.href).anchor === active.anchor);
    if (exact) return exact;
  }
  return samePath.find((node) => splitHref(node.href).anchor === "") ?? samePath[0];
}

/** 目录不超过此数量时默认全部展开，保持小目录原来的体验。 */
export const TOC_EXPAND_ALL_LIMIT = 30;

/** 目录节点的稳定键：在原始目录中的下标路径，如 "0.2.1"。 */
export function tocNodeKeys(nodes: TocNode[]): Map<TocNode, string> {
  const keys = new Map<TocNode, string>();
  const walk = (items: TocNode[], prefix: string): void => {
    items.forEach((item, index) => {
      const key = prefix ? `${prefix}.${index}` : String(index);
      keys.set(item, key);
      walk(item.children, key);
    });
  };
  walk(nodes, "");
  return keys;
}

/** target 的全部祖先键（不含自身）；不在目录里时返回空数组。 */
export function tocAncestorKeys(nodes: TocNode[], target: TocNode | undefined): string[] {
  if (!target) return [];
  const keys = tocNodeKeys(nodes);
  const key = keys.get(target);
  if (!key) return [];
  const parts = key.split(".");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("."));
}

/**
 * 初始展开状态：小目录全部展开；大目录全部收起，由调用方再展开当前章所在分支。
 */
export function defaultExpandedTocKeys(nodes: TocNode[]): Set<string> {
  if (countTocNodes(nodes) > TOC_EXPAND_ALL_LIMIT) return new Set();
  const expanded = new Set<string>();
  for (const [node, key] of tocNodeKeys(nodes)) {
    if (node.children.length > 0) expanded.add(key);
  }
  return expanded;
}

export interface NoteViewModel {
  id: string;
  content: string;
  selectedText: string;
  chapterTitle: string;
  chapterPath?: string;
  createdAtMs: number;
  updatedAtMs?: number;
}

export function sortNotesNewestFirst(notes: readonly NoteViewModel[]): NoteViewModel[] {
  return [...notes].sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
}

export function limitNotes(
  notes: readonly NoteViewModel[],
  limit: number,
): { items: NoteViewModel[]; limited: boolean } {
  const sorted = sortNotesNewestFirst(notes);
  const safeLimit = Math.max(0, Math.floor(limit));
  return { items: sorted.slice(0, safeLimit), limited: sorted.length > safeLimit };
}
