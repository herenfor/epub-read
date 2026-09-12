import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export interface ToolbarProps {
  /** 书名（显示在顶部状态栏） */
  title: string;
  issueCount: number;
  /** 阅读视图：返回书架（书架视图不显示） */
  onBackToShelf?: () => void;
  /** 返回跳转前的阅读进度（目录/书内链接跳转后可用） */
  onHistoryBack?: () => void;
  canHistoryBack?: boolean;
  onHistoryForward?: () => void;
  canHistoryForward?: boolean;
  /** 打开目录（一级工具栏图标） */
  onOpenToc?: () => void;
  /** 打开当前书正文搜索（一级工具栏图标） */
  onOpenSearch?: () => void;
  /** 打开当前书笔记页面。 */
  onOpenNotes?: () => void;
  /** AI edition 的 AI 地基面板；Core edition 不传入该入口。 */
  onOpenAssistant?: () => void;
  /** 书签：添加/移除当前页书签 */
  onToggleBookmark?: () => void;
  isBookmarked?: boolean;
  onOpenBookmarks?: () => void;
  onCloseBookmarks?: () => void;
  bookmarkMenuOpen?: boolean;
  bookmarks?: Array<{
    id: string;
    text: string;
    spineIndex: number;
    page: number;
    createdAtMs: number;
    chapterLabel?: string;
  }>;
  onSelectBookmark?: (id: string) => void;
  onToggleMenu?: () => void;
  onToggleLog?: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [sideWidth, setSideWidth] = useState<number | null>(null);

  // Keep the title's grid tracks symmetric without hard-coding button widths.
  // scrollWidth is in the element's layout pixels, so it remains correct when
  // the toolbar is zoomed by the UI scale setting.
  useLayoutEffect(() => {
    const intrinsicFlexWidth = (element: HTMLDivElement): number => {
      const children = Array.from(element.children) as HTMLElement[];
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
      return children.reduce(
        (total, child, index) =>
          total + Math.max(child.scrollWidth, child.getBoundingClientRect().width) +
          (index > 0 ? gap : 0),
        0
      );
    };
    const update = () => {
      const left = leftRef.current;
      const right = rightRef.current;
      if (!left || !right) return;
      // A newly-added nested capsule may be flex-shrunk inside the previous
      // measured side track. Sum each child's intrinsic scroll width so the
      // old CSS variable cannot hide the new control from remeasurement.
      const next = Math.max(intrinsicFlexWidth(left), intrinsicFlexWidth(right));
      setSideWidth((previous) => (previous === next ? previous : next));
    };
    update();
    const observer = new ResizeObserver(update);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    if (leftRef.current) observer.observe(leftRef.current);
    if (rightRef.current) observer.observe(rightRef.current);
    return () => observer.disconnect();
  }, [
    Boolean(props.onBackToShelf),
    Boolean(props.onHistoryBack),
    Boolean(props.onHistoryForward),
    Boolean(props.onToggleMenu),
    Boolean(props.onToggleBookmark),
    Boolean(props.onOpenToc),
    Boolean(props.onOpenSearch),
    Boolean(props.onOpenNotes),
    Boolean(props.onOpenAssistant),
    Boolean(props.onToggleLog),
    props.issueCount > 0,
  ]);

  const toolbarStyle = sideWidth === null
    ? undefined
    : ({ "--toolbar-side-width": `${sideWidth}px` } as CSSProperties);

  return (
    <div ref={toolbarRef} className="toolbar" style={toolbarStyle}>
      <div ref={leftRef} className="tb-left">
        {props.onBackToShelf && (
          <button
            className="tb-btn tb-back"
            onClick={props.onBackToShelf}
            title="返回书架"
          >
            ← 书架
          </button>
        )}
        {(props.onHistoryBack || props.onHistoryForward) && (
          <div className="toolbar-history" role="group" aria-label="阅读位置历史">
            {props.onHistoryBack && (
              <button
                className="tb-btn tb-history-back"
                onClick={props.onHistoryBack}
                disabled={!props.canHistoryBack}
                title="返回跳转前的阅读进度"
                aria-label="后退阅读位置"
              >
                ↩
              </button>
            )}
            {props.onHistoryForward && (
              <button
                className="tb-btn tb-history-forward"
                onClick={props.onHistoryForward}
                disabled={!props.canHistoryForward}
                title="前进到后退前的阅读位置"
                aria-label="前进阅读位置"
              >
                ↪
              </button>
            )}
          </div>
        )}
        {props.onToggleMenu && (
          <button className="tb-btn" onClick={props.onToggleMenu} title="菜单">
            ☰
          </button>
        )}
        {props.onToggleBookmark && (
          <div className="toolbar-bookmark">
            <button
              className={`tb-btn bookmark-toggle${props.isBookmarked ? " active" : ""}`}
              onClick={props.onToggleBookmark}
              title={props.isBookmarked ? "移除当前页书签" : "添加当前页书签"}
            >
              🔖
            </button>
            <button
              className="tb-btn bookmark-dropdown"
              onClick={() => {
                if (props.bookmarkMenuOpen) props.onCloseBookmarks?.();
                else props.onOpenBookmarks?.();
              }}
              title="书签列表"
            >
              ▾
            </button>
            {props.bookmarkMenuOpen && (
              <>
                <div className="bookmark-backdrop" onClick={props.onCloseBookmarks} />
                <div className="bookmark-pop">
                  <div className="bookmark-pop-title">书签</div>
                  {!props.bookmarks || props.bookmarks.length === 0 ? (
                    <div className="bookmark-empty">暂无书签</div>
                  ) : (
                    props.bookmarks.map((bookmark) => (
                      <button
                        key={bookmark.id}
                        className="bookmark-item"
                        onClick={() => props.onSelectBookmark?.(bookmark.id)}
                        title={bookmark.text}
                      >
                        <span className="bookmark-icon">🔖</span>
                        <span className="bookmark-main">
                          <span className="bookmark-text">
                            {bookmark.text || "（无文字）"}
                          </span>
                          <span className="bookmark-chapter">
                            {bookmark.chapterLabel || ""}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {props.onOpenToc && (
          <button className="tb-btn" onClick={props.onOpenToc} title="打开目录">
            📖
          </button>
        )}
        {props.onOpenSearch && (
          <button className="tb-btn" onClick={props.onOpenSearch} title="搜索正文" aria-label="搜索正文">
            🔍
          </button>
        )}
        {props.onOpenNotes && (
          <button className="tb-btn" onClick={props.onOpenNotes} title="笔记" aria-label="打开笔记">
            📝
          </button>
        )}
        {props.onOpenAssistant && (
          <button className="tb-btn" onClick={props.onOpenAssistant} title="AI 地基" aria-label="打开 AI 地基">
            AI
          </button>
        )}
      </div>
      <span className="tb-title" title={props.title}>
        {props.title}
      </span>
      <div ref={rightRef} className="tb-right">
        {props.onToggleLog && (
          <button className="tb-btn" onClick={props.onToggleLog} title="日志与诊断">
            诊断{props.issueCount > 0 ? <span className="issue-badge">{props.issueCount}</span> : null}
          </button>
        )}
      </div>
    </div>
  );
}
