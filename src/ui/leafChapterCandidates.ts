import { spineItemPath } from "../core/book";
import type { Book } from "../core/types";
import { findElements, type XmlNodeLike } from "../core/xml";
import { parseChapterDocument } from "../render/chapterDocument";
import { isImageChapterLeaf } from "../render/fullPageImage";

/**
 * A13 小范围版第 2 步：“候选一页章”的便宜判断，只读 XHTML，不排版。
 *
 * 结果不随窗口、字号变化，所以拖动窗口时分段和左右配对都不变；候选章实际是否
 * 只占一页，由显示时确认（不是一页就退回单章显示）。阈值宁紧勿松：候选章排出
 * 两页时那一组会退回单章，可能留一个空白页。
 */

/** 可见字数上限（不含空白）。书名页、版权页、人物介绍、献辞通常远少于此。 */
export const LEAF_TEXT_MAX_CHARS = 600;
/** 列表项上限：长目录、长清单不算一页章。 */
export const LEAF_LIST_MAX_ITEMS = 12;

const NON_VISIBLE = new Set(["script", "style", "template", "noscript"]);
const MEDIA = ["img", "svg", "video", "audio", "object", "embed", "iframe"];

function visibleTextLength(node: XmlNodeLike): number {
  if (node.nodeType === 3) return ((node as unknown as { data?: string }).data ?? "").replace(/\s+/g, "").length;
  const name = (node.localName ?? node.nodeName).toLowerCase();
  if (node.nodeType === 1 && NON_VISIBLE.has(name)) return 0;
  let total = 0;
  const kids = node.childNodes;
  if (kids) for (let i = 0; i < kids.length; i++) total += visibleTextLength(kids[i]);
  return total;
}

/** 整图章沿用原图片双页判断；文字章：有字、字少、最多一张图、无表格、无长列表。 */
export function isLeafChapterCandidate(body: Parameters<typeof isImageChapterLeaf>[0]): boolean {
  if (isImageChapterLeaf(body)) return true;
  const chars = visibleTextLength(body);
  // 空章走原来的自动前进，不参与配对。
  if (chars === 0 || chars > LEAF_TEXT_MAX_CHARS) return false;
  const media = MEDIA.reduce((count, tag) => count + findElements(body, tag).length, 0);
  if (media > 1) return false;
  if (findElements(body, "table").length > 0) return false;
  return findElements(body, "li").length <= LEAF_LIST_MAX_ITEMS;
}

/**
 * SingleLeafSpreads 注入用的判断：每章读一次 XHTML 并缓存。被取消的读取不缓存，
 * 与原图片双页的读取方式相同（EPUB3 按 HTML 解析）。
 */
export function createLeafChapterClassifier(
  book: Book,
  readText: (path: string, signal: AbortSignal) => Promise<string>,
): (index: number, signal: AbortSignal) => Promise<boolean> {
  const cache = new Map<number, boolean>();
  return async (index, signal) => {
    if (index < 0 || index >= book.spine.length || !book.spine[index].linear) return false;
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const path = spineItemPath(book, index);
    if (!path) return false;
    const html = await readText(path, signal);
    if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
    const { doc } = await parseChapterDocument(html, book.version === 2);
    const body = findElements(doc, "body")[0];
    const candidate = body !== undefined && isLeafChapterCandidate(body);
    cache.set(index, candidate);
    return candidate;
  };
}
