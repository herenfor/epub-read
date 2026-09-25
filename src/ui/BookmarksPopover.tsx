import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bookmark } from "./shelf";
import { BookmarkIcon } from "./readerIcons";
import { bookmarkPopoverLayout, type BookmarkPopoverLayout } from "./bookmarkPopoverLayout";
import "./bookmarksPopover.css";

export type BookmarksPopoverEntry = Bookmark & { chapterLabel?: string };

export interface BookmarksPopoverProps {
  /** 实际触发本次打开的按钮；若它已被 CSS 隐藏，则退回点击坐标。 */
  anchor: HTMLButtonElement | null;
  /**
   * App 在点击当刻记录的按钮坐标。打开书签面板会让工具栏/标题栏按钮立刻被
   * `is-suppressed` / `display:none` 隐藏，届时实时 rect 归零，只能用它定位。
   */
  fallbackRect?: DOMRect | null;
  bookmarks: BookmarksPopoverEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** closed 祖先或 display:none 的元素 rect 全为 0，不能作为定位基准。 */
function usableRect(rect: DOMRect | null | undefined): DOMRect | null {
  if (!rect) return null;
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

/** 打开当刻真实可用的坐标一定来自按钮或 App 记录；都缺失时贴窗口右上角兜底。 */
function normalizeAnchorRect(rect: DOMRect | null | undefined): DOMRect {
  const usable = usableRect(rect);
  if (usable) return usable;
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  return { right: width, bottom: 0, top: 0, left: width, width: 0, height: 0 } as DOMRect;
}

/** 已挂载且在布局中占位的触发按钮才可用于定位；隐藏的祖先会让 rect 归零。 */
function liveAnchorRect(button: HTMLButtonElement | null): DOMRect | null {
  if (!button || !button.isConnected) return null;
  const computed =
    typeof window !== "undefined" && typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(button)
      : null;
  if (computed && (computed.display === "none" || computed.visibility === "hidden")) return null;
  return usableRect(button.getBoundingClientRect());
}

/**
 * 唯一书签浮层。它不属于任何工具栏：以 fixed 视口坐标渲染，
 * 因此 `.app:has(.titlebar-reader) .toolbar-top-island { display:none }`
 * 这类隐藏重复顶部岛的规则不会再连带隐藏书签列表。
 */
export function BookmarksPopover({
  anchor,
  fallbackRect,
  bookmarks,
  onSelect,
  onClose,
}: BookmarksPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 点击时记录的坐标：浮层挂载后工具栏/标题栏按钮可能立刻被 CSS 隐藏，
  // 此时不能再用归零的实时 rect 定位。
  const savedRectRef = useRef<DOMRect | null>(fallbackRect ?? null);
  const [layout, setLayout] = useState<BookmarkPopoverLayout | null>(null);

  savedRectRef.current = liveAnchorRect(anchor) ?? usableRect(savedRectRef.current);

  useLayoutEffect(() => {
    const update = () => {
      const rect =
        liveAnchorRect(anchor) ??
        usableRect(savedRectRef.current) ??
        normalizeAnchorRect(fallbackRect);
      setLayout(
        bookmarkPopoverLayout(rect, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchor, fallbackRect]);

  // 打开期间移交焦点；不把焦点留在可能立即被隐藏的触发按钮上。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== panel) {
      // 同步派发失焦事件：只调用 blur() 不会让点击过按钮的浏览器
      // 更新 :focus 状态，之后点同一按钮时 click 目标会指向 body。
      active.dispatchEvent(new Event("focusout", { bubbles: true }));
      active.blur();
    }
    panel.focus({ preventScroll: true });
  }, []);

  // Esc 关闭；外部点击由遮罩自身接住。
  const handleKeyDown = useCallback(
    (event: { key: string }) => {
      if (event.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
      <div className="reader-bookmarks-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="reader-bookmarks-popover"
        role="dialog"
        aria-label="书签"
        tabIndex={-1}
        style={
          layout
            ? {
                position: "fixed",
                boxSizing: "border-box",
                left: layout.left,
                top: layout.top,
                width: layout.width,
                maxHeight: layout.maxHeight,
              }
            : { position: "fixed", boxSizing: "border-box", visibility: "hidden" }
        }
      >
        <div className="reader-bookmarks-title">
          <span>书签</span>
          {bookmarks.length > 0 ? (
            <span className="reader-bookmarks-count">{bookmarks.length}</span>
          ) : null}
        </div>
        {bookmarks.length === 0 ? (
          <div className="bookmark-empty">暂无书签</div>
        ) : (
          bookmarks.map((bookmark) => (
            <button
              key={bookmark.id}
              type="button"
              className="bookmark-item"
              onClick={() => onSelect(bookmark.id)}
              title={bookmark.text}
            >
              <span className="bookmark-icon">
                <BookmarkIcon size={14} active={true} />
              </span>
              <span className="bookmark-main">
                <span className="bookmark-text">{bookmark.text || "（无文字）"}</span>
                <span className="bookmark-chapter">{bookmark.chapterLabel || ""}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );
}
