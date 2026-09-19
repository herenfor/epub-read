import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  BookmarkIcon,
  ChevronDownIcon,
  HistoryBackIcon,
  HistoryForwardIcon,
  MenuHamburgerIcon,
  PencilIcon,
  PinIcon,
  SearchIcon,
  SparklesIcon,
} from "./readerIcons";

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
  /** 当阅读器二级面板或模态框打开时为 true，彻底抑制所有边缘感应与悬浮胶囊 */
  isPanelOpen?: boolean;
}

type CapsuleDirection = "none" | "top" | "bottom" | "left" | "right";

export function Toolbar(props: ToolbarProps) {
  // Bookmark popover smooth exit transition
  const [closingBookmarks, setClosingBookmarks] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shelfBackLockRef = useRef(false);

  // Pin state & 500ms debounce cooldown
  const [isPinned, setIsPinned] = useState(() => {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem("reader_toolbar_pinned") === "true";
    } catch {
      return false;
    }
  });
  const lastPinClickTimeRef = useRef<number>(0);

  // 单胶囊互斥状态：4 个方向无论何时最多只能同时存在 1 个胶囊
  const [activeDir, setActiveDir] = useState<CapsuleDirection>("none");
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  // 当存在打开的二级面板或模态框时，完全抑制工具栏所有方向胶囊与感应
  useEffect(() => {
    if (props.isPanelOpen) {
      clearHideTimer();
      setActiveDir("none");
    }
  }, [props.isPanelOpen]);

  const scheduleHide = (delay = 1000) => {
    clearHideTimer();
    if (props.isPanelOpen || props.bookmarkMenuOpen) return;
    hideTimerRef.current = setTimeout(() => {
      setActiveDir("none");
    }, delay);
  };

  const showDirection = (dir: CapsuleDirection) => {
    if (props.isPanelOpen) return;
    if (props.bookmarkMenuOpen && dir !== "top") return;
    clearHideTimer();
    // 切换到新方向，其它方向立即收起
    setActiveDir(dir);
  };

  const handleMouseLeave = () => {
    scheduleHide(1000); // 自然缩回延时 1 秒
  };

  // 修复 Bug：当鼠标移出浏览器视口或窗口失焦时，保证无论如何都能触发收起
  useEffect(() => {
    const handleDocumentMouseLeave = (e: MouseEvent) => {
      // 鼠标光标跨出 document 视口边缘（往上/往下/往左/往右移出浏览器窗口）
      const toEl = (e as unknown as { toElement?: EventTarget | null }).toElement;
      if (!e.relatedTarget && !toEl) {
        scheduleHide(1000);
      }
    };
    const handleWindowBlur = () => {
      // 窗口失焦（切换至其它程序或窗口）
      scheduleHide(500);
    };

    document.addEventListener("mouseleave", handleDocumentMouseLeave);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("mouseleave", handleDocumentMouseLeave);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  // 500ms 物理防抖锁固定常驻切换
  const togglePin = () => {
    const now = Date.now();
    if (now - lastPinClickTimeRef.current < 500) {
      return; // 500ms 物理防抖冷却中，杜绝高频连击
    }
    lastPinClickTimeRef.current = now;

    setIsPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("reader_toolbar_pinned", String(next));
      } catch {}
      if (next) {
        clearHideTimer();
        setActiveDir("top");
      } else {
        scheduleHide(1000);
      }
      return next;
    });
  };

  useEffect(() => {
    if (isPinned) {
      setActiveDir("top");
    } else {
      // 首次开启闪现 1.6 秒提示入口位置，随后从容自动收起
      setActiveDir("top");
      scheduleHide(1600);
    }
    return () => clearHideTimer();
  }, [isPinned]);

  const requestCloseBookmarks = () => {
    if (closingBookmarks || !props.bookmarkMenuOpen) return;
    setClosingBookmarks(true);
    closeTimeoutRef.current = setTimeout(() => {
      setClosingBookmarks(false);
      props.onCloseBookmarks?.();
    }, 150);
  };

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const handleBackToShelf = () => {
    if (shelfBackLockRef.current) return;
    shelfBackLockRef.current = true;
    props.onBackToShelf?.();
    setTimeout(() => {
      shelfBackLockRef.current = false;
    }, 400);
  };

  // 单胶囊互斥生效逻辑：
  // 1. 若当前二级面板或模态框打开，强制为 "none"（完全静音隐退）；
  // 2. 若当前有用户主动触发的活动方向（activeDir !== "none"），以当前方向为唯一展示胶囊；
  // 3. 若当前空闲（activeDir === "none"），若开启了 Pin 或书签面板展开中，则恢复顶部状态岛常驻；否则全隐。
  const effectiveDir: CapsuleDirection =
    props.isPanelOpen
      ? "none"
      : activeDir !== "none"
        ? activeDir
        : isPinned || props.bookmarkMenuOpen
          ? "top"
          : "none";

  const isTopOpen = effectiveDir === "top";
  const isBottomOpen = effectiveDir === "bottom";
  const isLeftOpen = effectiveDir === "left";
  const isRightOpen = effectiveDir === "right";

  return (
    <div className={`toolbar-root${props.isPanelOpen ? " is-suppressed" : ""}`}>
      {/* 仅在无二级面板打开时挂载四方感应区 */}
      {!props.isPanelOpen && (
        <>
          {/* 顶部隐形感应区（0~20px）：触碰仅唤出顶部状态岛，其余方向立即收起 */}
          <div
            className="toolbar-sensor top-sensor"
            onMouseEnter={() => showDirection("top")}
            onMouseLeave={handleMouseLeave}
            onClick={() => showDirection("top")}
            aria-hidden="true"
          />

          {/* 底部隐形感应区（底部 0~22px）：触碰仅唤出底部操作坞，其余方向立即收起 */}
          <div
            className="toolbar-sensor bottom-sensor"
            onMouseEnter={() => showDirection("bottom")}
            onMouseLeave={handleMouseLeave}
            onClick={() => showDirection("bottom")}
            aria-hidden="true"
          />

          {/* 左侧隐形感应区（左侧 0~22px）：触碰仅唤出目录微手柄，其余方向立即收起 */}
          {props.onOpenToc && (
            <div
              className="toolbar-sensor left-sensor"
              onMouseEnter={() => showDirection("left")}
              onMouseLeave={handleMouseLeave}
              onClick={() => showDirection("left")}
              aria-hidden="true"
            />
          )}

          {/* 右侧隐形感应区（右侧 0~22px）：触碰仅唤出笔记微手柄，其余方向立即收起 */}
          {props.onOpenNotes && (
            <div
              className="toolbar-sensor right-sensor"
              onMouseEnter={() => showDirection("right")}
              onMouseLeave={handleMouseLeave}
              onClick={() => showDirection("right")}
              aria-hidden="true"
            />
          )}
        </>
      )}

      {/* 左侧微手柄（目录） */}
      {props.onOpenToc && (
        <aside
          className={`toolbar-side-handle left-handle ${isLeftOpen ? "is-visible" : "is-hidden"}`}
          onMouseEnter={() => showDirection("left")}
          onMouseLeave={handleMouseLeave}
          aria-label="快速展开目录"
        >
          <button
            className="tb-side-btn tb-side-toc"
            onClick={() => {
              setActiveDir("none");
              props.onOpenToc?.();
            }}
            title="快速展开目录"
            aria-label="快速展开目录"
          >
            <BookOpenIcon size={18} />
            <span className="tb-side-text">目录</span>
          </button>
        </aside>
      )}

      {/* 右侧微手柄（笔记） */}
      {props.onOpenNotes && (
        <aside
          className={`toolbar-side-handle right-handle ${isRightOpen ? "is-visible" : "is-hidden"}`}
          onMouseEnter={() => showDirection("right")}
          onMouseLeave={handleMouseLeave}
          aria-label="快速打开笔记"
        >
          <button
            className="tb-side-btn tb-side-notes"
            onClick={() => {
              setActiveDir("none");
              props.onOpenNotes?.();
            }}
            title="快速打开笔记"
            aria-label="快速打开笔记"
          >
            <PencilIcon size={18} />
            <span className="tb-side-text">笔记</span>
          </button>
        </aside>
      )}

      {/* ---- 顶部状态岛：身份与阅读状态（书架返回、书籍标题、书签胶囊、常驻图钉） ---- */}
      <header
        className={`toolbar-top-island ${isTopOpen ? "is-visible" : "is-hidden"} ${isPinned ? "is-pinned" : ""}`}
        onMouseEnter={() => showDirection("top")}
        onMouseLeave={handleMouseLeave}
        role="region"
        aria-label="阅读状态与导航"
      >
        <div className="top-island-left">
          {props.onBackToShelf && (
            <button
              className="tb-btn tb-back"
              onClick={handleBackToShelf}
              title="返回书架"
              aria-label="返回书架"
            >
              <ArrowLeftIcon size={16} />
              <span className="tb-btn-text">书架</span>
            </button>
          )}
        </div>

        <div className="top-island-center">
          <span className="tb-title" title={props.title}>
            {props.title}
          </span>
        </div>

        <div className="top-island-right">
          {props.onToggleBookmark && (
            <div className="toolbar-bookmark">
              <button
                className={`tb-btn bookmark-toggle${props.isBookmarked ? " active" : ""}`}
                onClick={props.onToggleBookmark}
                title={props.isBookmarked ? "移除当前页书签" : "添加当前页书签"}
                aria-label={props.isBookmarked ? "移除当前页书签" : "添加当前页书签"}
              >
                <BookmarkIcon size={16} active={props.isBookmarked} />
              </button>
              <button
                className={`tb-btn bookmark-dropdown${props.bookmarkMenuOpen ? " active" : ""}`}
                onClick={() => {
                  if (props.bookmarkMenuOpen) requestCloseBookmarks();
                  else props.onOpenBookmarks?.();
                }}
                title="书签列表"
                aria-label="书签列表"
              >
                <ChevronDownIcon size={12} className={props.bookmarkMenuOpen ? "chevron-open" : ""} />
              </button>
              {(props.bookmarkMenuOpen || closingBookmarks) && (
                <>
                  <div
                    className={`bookmark-backdrop${closingBookmarks ? " closing" : ""}`}
                    onClick={requestCloseBookmarks}
                  />
                  <div className={`bookmark-pop${closingBookmarks ? " closing" : ""}`}>
                    <div className="bookmark-pop-title">
                      <span>书签</span>
                      {props.bookmarks && props.bookmarks.length > 0 ? (
                        <span className="bookmark-pop-count">{props.bookmarks.length}</span>
                      ) : null}
                    </div>
                    {!props.bookmarks || props.bookmarks.length === 0 ? (
                      <div className="bookmark-empty">暂无书签</div>
                    ) : (
                      props.bookmarks.map((bookmark) => (
                        <button
                          key={bookmark.id}
                          className="bookmark-item"
                          onClick={() => {
                            requestCloseBookmarks();
                            props.onSelectBookmark?.(bookmark.id);
                          }}
                          title={bookmark.text}
                        >
                          <span className="bookmark-icon">
                            <BookmarkIcon size={14} active={true} />
                          </span>
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
          <button
            className={`tb-btn tb-pin${isPinned ? " active" : ""}`}
            onClick={togglePin}
            title={isPinned ? "取消常驻（自动隐藏，不遮挡正文）" : "常驻顶端显示"}
            aria-label={isPinned ? "取消常驻" : "常驻顶端显示"}
          >
            <PinIcon size={15} pinned={isPinned} />
          </button>
        </div>
      </header>

      {/* ---- 底部操作坞：核心操作工具（历史前进后退、目录、搜索、笔记、设置/菜单、AI、诊断） ---- */}
      <nav
        className={`toolbar-bottom-dock ${isBottomOpen ? "is-visible" : "is-hidden"} ${isPinned ? "is-pinned" : ""}`}
        onMouseEnter={() => showDirection("bottom")}
        onMouseLeave={handleMouseLeave}
        role="toolbar"
        aria-label="阅读操作控制台"
      >
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
                <HistoryBackIcon size={18} />
              </button>
            )}
            {props.onHistoryForward && (
              <button
                className="tb-btn tb-history-forward"
                onClick={props.onHistoryForward}
                disabled={!props.canHistoryForward}
                title="前进到后退前的阅读进度"
                aria-label="前进阅读位置"
              >
                <HistoryForwardIcon size={18} />
              </button>
            )}
          </div>
        )}

        {(props.onHistoryBack || props.onHistoryForward) && <div className="dock-divider" />}

        {props.onOpenToc && (
          <button className="tb-btn tb-dock-btn tb-toc" onClick={props.onOpenToc} title="打开目录" aria-label="打开目录">
            <BookOpenIcon size={20} />
          </button>
        )}

        {props.onOpenSearch && (
          <button className="tb-btn tb-dock-btn tb-search" onClick={props.onOpenSearch} title="搜索正文" aria-label="搜索正文">
            <SearchIcon size={20} />
          </button>
        )}

        {props.onOpenNotes && (
          <button className="tb-btn tb-dock-btn tb-notes" onClick={props.onOpenNotes} title="笔记" aria-label="打开笔记">
            <PencilIcon size={20} />
          </button>
        )}

        {props.onToggleMenu && (
          <button className="tb-btn tb-dock-btn tb-menu" onClick={props.onToggleMenu} title="设置与外观" aria-label="设置与外观">
            <MenuHamburgerIcon size={20} />
          </button>
        )}

        {props.onOpenAssistant && (
          <button className="tb-btn tb-dock-btn tb-assistant" onClick={props.onOpenAssistant} title="AI 地基" aria-label="打开 AI 地基">
            <SparklesIcon size={18} />
            <span className="tb-btn-text">AI</span>
          </button>
        )}
      </nav>
    </div>
  );
}
