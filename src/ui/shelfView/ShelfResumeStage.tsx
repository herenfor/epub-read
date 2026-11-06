import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUiText } from "../localization/UiLanguageProvider";
import type { ShelfEntry } from "../shelf";
import type { ThumbnailProvider } from "../thumbnail";
import { uiMotionReduced } from "../motionPreference";
import { isShelfProgressPending, shelfProgressLabel, shelfReadingStatus } from "../shelfProgressDisplay";
import { readCachedLinearMask } from "../chapterCountCache";
import { readShelfPlaceLabel } from "../shelfPlaceCache";
import { linearChapterNumber } from "../../core/book";
import { ArrowRightIcon, BookOpenIcon, ChevronDownIcon, ChevronUpIcon } from "./icons";
import { Cover, formatRelativeTime } from "./cards";
import { useShelfSubmenuBack, type ShelfSubmenuBackProps } from "./submenuBack";

/* =========================================================================
 * 续读控制台组件（横向紧凑控制台、3D 书脊阴影、精确锚点与一键开书）
 * ========================================================================= */

interface ShelfResumeStageProps extends ShelfSubmenuBackProps {
  entries: ShelfEntry[];
  provider: ThumbnailProvider;
  busy?: boolean;
  compact?: boolean;
  onOpen(id: string): void;
}

export const ShelfResumeStage = memo(function ShelfResumeStage({
  entries,
  provider,
  busy,
  compact,
  onOpen,
  registerSubmenuBackHandler,
  onSubmenuBackActiveChange,
}: ShelfResumeStageProps) {
  const { t } = useUiText();
  const readingBooks = useMemo(() => {
    return entries
      // Same judgement as the cards and filters; the stage additionally needs a
      // timestamp to order books and show "last read".
      .filter((e) => shelfReadingStatus(e) === "reading" && e.lastReadAtMs > 0)
      .sort((a, b) => b.lastReadAtMs - a.lastReadAtMs)
      .slice(0, 10);
  }, [entries]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreDropdownRef = useRef<HTMLDivElement>(null);

  useShelfSubmenuBack(moreOpen, () => setMoreOpen(false), {
    registerSubmenuBackHandler,
    onSubmenuBackActiveChange,
  });

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!moreDropdownRef.current?.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMoreOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem("epub_shelf_resume_collapsed");
      if (stored !== null) {
        return stored === "true";
      }
      return !!compact;
    } catch {
      return !!compact;
    }
  });

  const stageRef = useRef<HTMLDivElement>(null);
  /** Height before a toggle; the layout effect animates from it to the new natural height. */
  const heightBeforeToggleRef = useRef<number | null>(null);
  const settleAnimationRef = useRef<(() => void) | null>(null);

  const toggleCollapse = useCallback(() => {
    const stage = stageRef.current;
    if (stage) {
      // Mid-animation toggles continue from the height currently on screen.
      heightBeforeToggleRef.current = stage.getBoundingClientRect().height;
      settleAnimationRef.current?.();
    }
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("epub_shelf_resume_collapsed", String(next));
      } catch {}
      return next;
    });
  }, []);

  // Real height morph: pin the old height, then transition to the new natural
  // height. The outgoing pane overlays and is clipped as the card shrinks or
  // grows; panes only cross-fade. Height-only, one element, ~280ms.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const from = heightBeforeToggleRef.current;
    heightBeforeToggleRef.current = null;
    if (!stage || from === null || uiMotionReduced()) return;
    const to = stage.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    stage.classList.add("is-animating");
    stage.style.height = `${from}px`;
    void stage.offsetHeight;
    stage.style.height = `${to}px`;
    let timer = 0;
    const settle = () => {
      window.clearTimeout(timer);
      stage.removeEventListener("transitionend", onEnd);
      stage.classList.remove("is-animating");
      stage.style.height = "";
      settleAnimationRef.current = null;
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === stage && event.propertyName === "height") settle();
    };
    stage.addEventListener("transitionend", onEnd);
    timer = window.setTimeout(settle, 450);
    settleAnimationRef.current = settle;
    return settle;
  }, [collapsed]);

  const activeBook = useMemo(() => {
    if (readingBooks.length === 0) return null;
    if (selectedId) {
      const found = readingBooks.find((b) => b.id === selectedId);
      if (found) return found;
    }
    return readingBooks[0];
  }, [readingBooks, selectedId]);
  const activeKey = activeBook ? activeBook.contentHash ?? activeBook.id : null;
  const linearMask = useMemo(() => readCachedLinearMask(activeKey), [activeKey]);

  useEffect(() => {
    if (!activeBook) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (!target || target === document.body || target.classList.contains("shelf-view")) {
          e.preventDefault();
          onOpen(activeBook.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeBook, onOpen]);

  if (!activeBook) return null;

  const barWidth = isShelfProgressPending(activeBook)
    ? "0%"
    : `${Math.max(2, Math.min(100, activeBook.progressPct ?? 0))}%`;
  const spineIndex = activeBook.spineIndex ?? 0;
  // Same numbering as the reader footer; books never opened since this cache existed keep the raw position.
  const chapterNumber = (linearMask ? linearChapterNumber(linearMask, spineIndex) : null) ?? spineIndex + 1;
  // Prefer the table-of-contents name the reader saved for this position.
  const placeName = readShelfPlaceLabel(activeKey, spineIndex);
  const chapterLabel = placeName
    ? t("shelf.resume.place", { chapter: placeName, progress: shelfProgressLabel(activeBook) })
    : t("shelf.resume.chapter", { n: chapterNumber, progress: shelfProgressLabel(activeBook) });

  // Both states stay mounted; the stage animates its grid rows between them so
  // expanding/collapsing is one short height + cross-fade, not a remount jump.
  return (
    <div ref={stageRef} className={`shelf-resume-stage${collapsed ? " is-collapsed" : " is-expanded"}`}>
      <div className="shelf-resume-pane shelf-resume-pane-compact" aria-hidden={!collapsed}>
        <div className="shelf-resume-collapsed">
          <button
            className="shelf-resume-compact-open"
            type="button"
            tabIndex={collapsed ? 0 : -1}
            onClick={() => onOpen(activeBook.id)}
            title={t("shelf.resume.open", { title: activeBook.title })}
          >
            <span className="shelf-resume-mini-cover" aria-hidden="true">
              <Cover entry={activeBook} provider={provider} />
            </span>
            <span className="shelf-resume-compact-text">
              <span className="shelf-resume-compact-title">{activeBook.title}</span>
              <span className="shelf-resume-compact-meta">
                <span>{chapterLabel}</span>
                <span className="shelf-resume-mini-track" aria-hidden="true">
                  <span style={{ width: barWidth }} />
                </span>
              </span>
            </span>
          </button>
          <div className="shelf-resume-collapsed-right">
            <button
              className="shelf-resume-continue"
              type="button"
              tabIndex={collapsed ? 0 : -1}
              onClick={() => onOpen(activeBook.id)}
              disabled={busy}
            >
              <span>{t("shelf.resume.continue")}</span>
              <ArrowRightIcon />
            </button>
            <button
              className="shelf-resume-toggle-btn"
              type="button"
              tabIndex={collapsed ? 0 : -1}
              onClick={toggleCollapse}
              title={t("shelf.resume.expand.tip")}
              aria-label={t("shelf.resume.expand")}
              aria-expanded={false}
            >
              <ChevronDownIcon />
            </button>
          </div>
        </div>
      </div>

      <div className="shelf-resume-pane shelf-resume-pane-full" aria-hidden={collapsed}>
        <div className="shelf-resume-expanded">
          <div className="shelf-resume-main">
            <button
              className="shelf-resume-cover-box"
              type="button"
              tabIndex={collapsed ? -1 : 0}
              onClick={() => onOpen(activeBook.id)}
              title={t("shelf.resume.open", { title: activeBook.title })}
            >
              <Cover entry={activeBook} provider={provider} />
            </button>
            <div className="shelf-resume-info">
              <div className="shelf-resume-meta-row">
                <span className="shelf-resume-tag">
                  <BookOpenIcon />
                  <span>{t("shelf.resume.reading")}</span>
                </span>
                <span className="shelf-resume-time">
                  {formatRelativeTime(activeBook.lastReadAtMs)}
                </span>
              </div>
              <button
                className="shelf-resume-title"
                type="button"
                tabIndex={collapsed ? -1 : 0}
                onClick={() => onOpen(activeBook.id)}
                title={activeBook.title}
              >
                {activeBook.title}
              </button>
              <div className="shelf-resume-author">{activeBook.creator || t("shelf.unknownAuthor")}</div>
              <div className="shelf-resume-anchor-row">
                <div className="shelf-resume-anchor-text">{t("shelf.resume.lastAt", { place: chapterLabel })}</div>
                <div className="shelf-resume-progress-track">
                  <div className="shelf-resume-progress-bar" style={{ width: barWidth }} />
                </div>
              </div>
            </div>
          </div>
          <div className="shelf-resume-actions">
            {readingBooks.length > 1 && (
              <div className="shelf-more-reading-dropdown" ref={moreDropdownRef}>
                <button
                  className="shelf-more-reading-btn"
                  type="button"
                  tabIndex={collapsed ? -1 : 0}
                  onClick={() => setMoreOpen(!moreOpen)}
                  aria-expanded={moreOpen}
                  title={t("shelf.resume.more.tip")}
                >
                  <span>{t("shelf.resume.more", { count: readingBooks.length })}</span>
                  <ChevronDownIcon />
                </button>
                {moreOpen && (
                  <div className="shelf-more-reading-popover">
                    {readingBooks.map((b) => (
                      <div
                        key={b.id}
                        className={`shelf-more-reading-item${b.id === activeBook.id ? " active" : ""}`}
                        onClick={() => {
                          setSelectedId(b.id);
                          setMoreOpen(false);
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="shelf-more-reading-item-title">{b.title}</div>
                          <div className="shelf-more-reading-item-meta">
                            {shelfProgressLabel(b)} · {formatRelativeTime(b.lastReadAtMs)}
                          </div>
                        </div>
                        <button
                          className="shelf-more-reading-open"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(b.id);
                            setMoreOpen(false);
                          }}
                        >
                          {t("shelf.resume.openBook")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              className="shelf-btn-resume"
              type="button"
              tabIndex={collapsed ? -1 : 0}
              onClick={() => onOpen(activeBook.id)}
              disabled={busy}
              title={t("shelf.resume.continueReading.tip")}
            >
              <span>{t("shelf.resume.continueReading")}</span>
              <ArrowRightIcon />
              {!compact && <span className="shelf-resume-key-hint">Enter</span>}
            </button>
            <button
              className="shelf-resume-toggle-btn"
              type="button"
              tabIndex={collapsed ? -1 : 0}
              onClick={toggleCollapse}
              title={t("shelf.resume.collapse.tip")}
              aria-label={t("shelf.resume.collapse")}
              aria-expanded={true}
            >
              <ChevronUpIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
