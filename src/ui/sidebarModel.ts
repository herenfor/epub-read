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
