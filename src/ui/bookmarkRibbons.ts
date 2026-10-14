import type { MediaReadingAnchor } from "../render/paginator";

/**
 * A15 书签丝带：书签挂在所在那一页的上缘，按钮只是放和取的入口。
 * 这里只放纯规则；位置由各阅读视图用已有的书签解析和跳转定位算出。
 */

/** 视图解析书签用到的字段（书签数据格式不变）。 */
export interface RibbonBookmark {
  readonly id: string;
  readonly spineIndex: number;
  readonly page: number;
  readonly anchorIndex?: number | null;
  readonly anchorRatio?: number | null;
  readonly anchorTextOffset?: number | null;
  readonly anchorTextSnippet?: string | null;
  readonly mediaAnchor?: MediaReadingAnchor | null;
}

/** 当前屏上的一页：阅读顺序 lane、物理左右，以及挂在这一页上的书签。 */
export interface ScreenBookmarkPage {
  readonly lane: 0 | 1;
  readonly side: "left" | "right";
  readonly spineIndex: number;
  readonly ids: readonly string[];
}

export interface ScreenBookmarks {
  readonly kind: "paged" | "scroll";
  /** 这一屏按几页显示；双页末屏右页没有正文时 pages 只有一项。 */
  readonly columns: 1 | 2;
  /** 分页：这一屏的页；滚动：一项，含屏上能看到丝带的全部书签。 */
  readonly pages: readonly ScreenBookmarkPage[];
}

/** 一条要画出来的丝带。坐标相对丝带层（视图容器）。 */
export interface RibbonMark {
  /** 稳定键：分页为 spine:lane，滚动为首个书签 id。 */
  readonly key: string;
  readonly ids: readonly string[];
  readonly x: number;
  readonly y: number;
  /** page：挂在页上缘；scroll：电脑横挂左页边；tab：手机右缘小角标。 */
  readonly kind: "page" | "scroll" | "tab";
  readonly side: "left" | "right";
}

/** 宿主发给丝带层的一次动画；nonce 递增，同一条丝带只播一次。 */
export interface RibbonCue {
  readonly kind: "drop" | "lift" | "peek";
  readonly ids: readonly string[];
  readonly nonce: number;
}

export type BookmarkButtonAction =
  | { readonly kind: "pages"; readonly addFirst: boolean }
  | { readonly kind: "add" }
  | { readonly kind: "remove"; readonly ids: readonly string[] };

export function screenBookmarkIds(screen: ScreenBookmarks | null): string[] {
  return screen ? screen.pages.flatMap((page) => page.ids) : [];
}

/**
 * 最终点击规则：双页总是弹出缩略书页（本屏没有书签时先放在第一页）；
 * 单页、滚动：没有就加，有就删掉本屏全部。
 */
export function bookmarkButtonAction(screen: ScreenBookmarks | null): BookmarkButtonAction {
  const ids = screenBookmarkIds(screen);
  if (screen?.kind === "paged" && screen.columns === 2) {
    return { kind: "pages", addFirst: ids.length === 0 };
  }
  return ids.length === 0 ? { kind: "add" } : { kind: "remove", ids };
}

/** 丝带默认中号：宽 14、长 48、离页外缘 14。 */
export const RIBBON_WIDTH_PX = 14;
export const RIBBON_LENGTH_PX = 48;
export const RIBBON_EDGE_INSET_PX = 14;
/** 收回动画时长；删除在它播完后才落地。 */
export const RIBBON_LIFT_MS = 300;

/** 分页丝带的左上角：外缘向内 14px，左页从外缘起算，右页丝带右边对齐。 */
export function pageRibbonLeft(side: "left" | "right", outerX: number): number {
  return side === "left"
    ? outerX + RIBBON_EDGE_INSET_PX
    : outerX - RIBBON_EDGE_INSET_PX - RIBBON_WIDTH_PX;
}

/** 删除后可撤销的一组书签（一次删除一起恢复）。 */
export interface BookmarkUndo<T> {
  readonly bookmarks: readonly T[];
  readonly at: number;
}

/** 焦点在可编辑处时 Ctrl+Z 让给输入框。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el !== "object" || !("tagName" in el)) return false;
  const tag = String(el.tagName).toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = String((el as HTMLInputElement).type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file", "image"].includes(type);
  }
  return el.isContentEditable === true;
}
