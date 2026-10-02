import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookOpenIcon, MenuHamburgerIcon, SearchIcon } from "./readerIcons";
import "./whisperFooter.css";
import {
  displayedScrubRatio,
  labelProgressPct,
  type ContentAxis,
  type ScrubUiState,
} from "./readerProgressAxis";

export interface WhisperFooterChapterTick {
  spineIndex: number;
  title: string;
  positionPct: number; // 0 到 100
  startRatio?: number;
  endRatio?: number;
}

export interface WhisperFooterProps {
  currentPage: number;
  pageCount: number;
  readingMode: "paginated" | "scroll";
  scrollProgress?: number; // 0 到 1
  /** 叶页范围，如 { first: 3, last: 4, total: 5 } */
  leafRange?: { first: number; last: number; total: number } | null;

  chapterTitle?: string;
  chapterIndex: number;
  totalChapters: number;

  estimatedMinutesLeft?: number;
  bookProgressPct?: number;
  /** 连续滚动模式下整本书 0..1 的精确宏观几何位置 */
  totalScrollProgress?: number;

  onSeekPage?: (page: number) => void;
  onSeekChapter?: (chapterIndex: number) => void;
  /** 连续滚动模式下按整书比例 (0..1) 滚动 */
  onSeekRatio?: (ratio: number) => void;

  chapterTicks?: WhisperFooterChapterTick[];
  zenMode?: boolean;

  /** 新增：受控或外置 Scrubber 状态与内容轴（Zen UI 核心接线） */
  scrubState?: ScrubUiState;
  contentAxis?: ContentAxis | null;
  onCommitSeek?: (ratio: number) => void;
  onPreviewChange?: (ratio: number | null) => void;

  /** 触摸优先布局：底部条与顶栏共享 toolsVisible，进度轴直接可拖。 */
  mobile?: boolean;
  toolsVisible?: boolean;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  onOpenSearch?: () => void;
  searchOpen?: boolean;
  onToggleAppearance?: () => void;
  appearanceOpen?: boolean;
  onOpenMore?: () => void;
  moreOpen?: boolean;
}

const HIDE_DELAY_MS = 1800;
const READING_KEYS = new Set([
  "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight",
  "PageDown", "PageUp", " ", "[", "]",
]);

function useDesktopFooterReveal(enabled: boolean) {
  const [revealed, setRevealed] = useState(false);
  const heldRef = useRef({ hovered: false, dragging: false });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    if (!enabled || heldRef.current.hovered || heldRef.current.dragging) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!heldRef.current.hovered && !heldRef.current.dragging) {
        setRevealed(false);
      }
    }, HIDE_DELAY_MS);
  }, [enabled, clearHideTimer]);

  const reveal = useCallback(() => {
    if (!enabled) return;
    setRevealed(true);
    scheduleHide();
  }, [enabled, scheduleHide]);

  const hide = useCallback(() => {
    clearHideTimer();
    if (!heldRef.current.hovered && !heldRef.current.dragging) {
      setRevealed(false);
    }
  }, [clearHideTimer]);

  const setHovered = useCallback((hovered: boolean) => {
    heldRef.current.hovered = hovered;
    if (hovered) {
      clearHideTimer();
      if (enabled) setRevealed(true);
    } else {
      scheduleHide();
    }
  }, [enabled, clearHideTimer, scheduleHide]);

  const setDragging = useCallback((dragging: boolean, hovered = heldRef.current.hovered) => {
    heldRef.current.dragging = dragging;
    heldRef.current.hovered = hovered;
    if (dragging) {
      clearHideTimer();
      if (enabled) setRevealed(true);
    } else {
      scheduleHide();
    }
  }, [enabled, clearHideTimer, scheduleHide]);

  const reset = useCallback(() => {
    clearHideTimer();
    heldRef.current.hovered = false;
    heldRef.current.dragging = false;
    setRevealed(false);
  }, [clearHideTimer]);

  useEffect(() => {
    clearHideTimer();
    setRevealed(false);
    if (!enabled) return;

    const onMouseMove = (event: MouseEvent) => {
      if (window.innerHeight - event.clientY < 40) {
        reveal();
      } else if (timerRef.current === null) {
        scheduleHide();
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY > 10) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (READING_KEYS.has(event.key)) hide();
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      clearHideTimer();
    };
  }, [enabled, clearHideTimer, reveal, scheduleHide, hide]);

  return { revealed, reveal, setHovered, setDragging, reset };
}

export const WhisperFooter: React.FC<WhisperFooterProps> = ({
  currentPage,
  pageCount,
  readingMode,
  scrollProgress = 0,
  leafRange,
  totalScrollProgress,
  chapterTitle,
  chapterIndex,
  totalChapters,
  estimatedMinutesLeft,
  bookProgressPct,
  onSeekPage,
  onSeekChapter,
  onSeekRatio,
  chapterTicks = [],
  zenMode = false,
  scrubState,
  contentAxis,
  onCommitSeek,
  onPreviewChange,
  mobile = false,
  toolsVisible = true,
  onToggleSidebar,
  sidebarOpen = false,
  onOpenSearch,
  searchOpen = false,
  onToggleAppearance,
  appearanceOpen = false,
  onOpenMore,
  moreOpen = false,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // 独立的 hover 与 drag 预览
  const [hoverTooltip, setHoverTooltip] = useState<{
    pct: number;
    text: string;
  } | null>(null);
  const [dragTooltip, setDragTooltip] = useState<{
    pct: number;
    text: string;
  } | null>(null);

  const footerRef = useRef<HTMLElement>(null);
  const footerReveal = useDesktopFooterReveal(!mobile && zenMode);
  const trackRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);

  const handleMouseEnter = () => {
    setIsHovered(true);
    footerReveal.setHovered(true);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    setHoverTooltip(null);
    footerReveal.setHovered(false);
  };

  // 全局失去焦点时清理拖拽状态与拦截罩
  useEffect(() => {
    const handleBlur = () => {
      if (pointerIdRef.current !== null) {
        pointerIdRef.current = null;
        setIsDragging(false);
        setDragTooltip(null);
        onPreviewChange?.(null);
      }
      setIsHovered(false);
      setHoverTooltip(null);
      footerReveal.reset();
    };
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("blur", handleBlur);
    };
  }, [onPreviewChange, footerReveal.reset]);

  // ---- 准确宏观与微观进度计算 ----
  const intraProgress =
    readingMode === "scroll"
      ? Math.min(1, Math.max(0, scrollProgress))
      : pageCount > 0
        ? Math.min(1, Math.max(0, (currentPage + 1) / pageCount))
        : 0;

  const currentChapterProgressPct = Math.round(intraProgress * 100);

  // 回退的宏观全书百分比（仅在未接入 scrubState 时兜底）
  const fallbackWholeBookPct = (() => {
    if (readingMode === "scroll" && typeof totalScrollProgress === "number" && totalScrollProgress >= 0) {
      return Math.min(100, Math.max(0, Math.round(totalScrollProgress * 100)));
    }
    if (typeof bookProgressPct === "number" && bookProgressPct > 0) {
      return bookProgressPct;
    }
    if (chapterTicks.length > 0 && totalChapters > 0) {
      const currentTick = chapterTicks.find((t) => t.spineIndex === chapterIndex) || chapterTicks[0];
      const nextTick = chapterTicks.find((t) => t.spineIndex === chapterIndex + 1);
      const startPct = currentTick ? currentTick.positionPct : 0;
      const endPct = nextTick ? nextTick.positionPct : 100;
      const span = Math.max(0, endPct - startPct);
      return Math.min(100, Math.max(0, startPct + span * intraProgress));
    }
    if (totalChapters > 0) {
      const chapterWeight = 100 / totalChapters;
      return Math.min(100, Math.max(0, (chapterIndex + intraProgress) * chapterWeight));
    }
    return currentChapterProgressPct;
  })();

  // 核心展示百分比：由 scrubState 唯一驱动
  const activeRatio = scrubState ? displayedScrubRatio(scrubState) : fallbackWholeBookPct / 100;
  const activePct = activeRatio !== null ? Math.max(0, Math.min(100, activeRatio * 100)) : 0;

  // 根据进度比率计算 tooltip 文本与目标信息
  const computeTooltip = (ratio: number) => {
    const rawPct = Math.max(0, Math.min(1, ratio));
    const pct100 = rawPct * 100;

    if (contentAxis) {
      const point = contentAxis.locate(rawPct);
      if (point) {
        const tick = chapterTicks.find((t) => t.spineIndex === point.spineIndex);
        const title = tick?.title || (point.spineIndex === chapterIndex ? chapterTitle : `第 ${point.spineIndex + 1} 章`);
        if (readingMode === "scroll") {
          return {
            pct: pct100,
            text: `${title || `第 ${point.spineIndex + 1} 章`} · 全书 ${Math.round(pct100)}%`,
          };
        }
        if (point.spineIndex === chapterIndex && pageCount > 1) {
          const pageInChapter = Math.min(pageCount - 1, Math.max(0, Math.round(point.fraction * (pageCount - 1))));
          return {
            pct: pct100,
            text: `第 ${pageInChapter + 1} / ${pageCount} 页 · ${title || ""}`,
          };
        }
        return {
          pct: pct100,
          text: `${title || `第 ${point.spineIndex + 1} 章`} · 全书 ${Math.round(pct100)}%`,
        };
      }
    }

    // 回退根据 ticks 计算
    let targetTick: WhisperFooterChapterTick | undefined;
    if (chapterTicks.length > 0) {
      for (let i = chapterTicks.length - 1; i >= 0; i--) {
        if (pct100 >= chapterTicks[i].positionPct - 0.5) {
          targetTick = chapterTicks[i];
          break;
        }
      }
      if (!targetTick) targetTick = chapterTicks[0];
    }
    const targetSpine = targetTick?.spineIndex ?? Math.min(Math.max(0, totalChapters - 1), Math.floor(rawPct * Math.max(1, totalChapters)));
    const targetTitle = targetTick?.title || (targetSpine === chapterIndex ? chapterTitle : `第 ${targetSpine + 1} 章`);

    return {
      pct: pct100,
      text: `${targetTitle || `第 ${targetSpine + 1} 章`} · 全书 ${Math.round(pct100)}%`,
    };
  };

  // 单一提交入口：指针释放或键盘提交
  const commitSeek = (ratio: number) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    if (onCommitSeek) {
      onCommitSeek(clamped);
      return;
    }
    if (readingMode === "scroll" && onSeekRatio) {
      onSeekRatio(clamped);
    } else if (contentAxis) {
      const target = contentAxis.locate(clamped);
      if (target) {
        if (target.spineIndex === chapterIndex && onSeekPage && pageCount > 1) {
          const p = Math.min(pageCount - 1, Math.max(0, Math.round(target.fraction * (pageCount - 1))));
          onSeekPage(p);
        } else if (onSeekChapter) {
          onSeekChapter(target.spineIndex);
        }
      }
    } else if (onSeekChapter) {
      const targetSpine = Math.min(totalChapters - 1, Math.max(0, Math.floor(clamped * totalChapters)));
      onSeekChapter(targetSpine);
    }
  };

  // Pointer Events: 原生 pointer capture 机制
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;

    e.preventDefault();
    e.stopPropagation();

    pointerIdRef.current = e.pointerId;
    footerReveal.setDragging(true);
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      // 容错
    }
    setIsDragging(true);

    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const tooltip = computeTooltip(ratio);
    setDragTooltip(tooltip);
    onPreviewChange?.(ratio);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    if (isDragging && pointerIdRef.current === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      const tooltip = computeTooltip(ratio);
      setDragTooltip(tooltip);
      onPreviewChange?.(ratio);
    } else if (!isDragging) {
      const tooltip = computeTooltip(ratio);
      setHoverTooltip(tooltip);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || pointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const track = trackRef.current;
    const footerRect = footerRef.current!.getBoundingClientRect();
    const overFooter =
      e.clientX >= footerRect.left &&
      e.clientX <= footerRect.right &&
      e.clientY >= footerRect.top &&
      e.clientY <= footerRect.bottom;

    pointerIdRef.current = null;
    setIsDragging(false);
    setIsHovered(overFooter);
    footerReveal.setDragging(false, overFooter);

    if (track) {
      try {
        track.releasePointerCapture(e.pointerId);
      } catch {
        // 容错
      }
    }
    setDragTooltip(null);

    const rect = track?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      commitSeek(ratio);
    }
    onPreviewChange?.(null);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    const track = trackRef.current;
    pointerIdRef.current = null;
    setIsDragging(false);
    setIsHovered(false);
    setDragTooltip(null);
    footerReveal.setDragging(false, false);
    if (track) {
      try {
        track.releasePointerCapture(e.pointerId);
      } catch {
        // 容错
      }
    }
    onPreviewChange?.(null);
  };

  const handleLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setIsDragging(false);
    setIsHovered(false);
    setDragTooltip(null);
    footerReveal.setDragging(false, false);
    onPreviewChange?.(null);
  };

  // 键盘无障碍跳页
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = activeRatio ?? 0;
    let step = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      step = -0.01;
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      step = 0.01;
    } else if (e.key === "PageDown") {
      step = -0.05;
    } else if (e.key === "PageUp") {
      step = 0.05;
    } else if (e.key === "Home") {
      e.preventDefault();
      commitSeek(0);
      return;
    } else if (e.key === "End") {
      e.preventDefault();
      commitSeek(1);
      return;
    }
    if (step !== 0) {
      e.preventDefault();
      commitSeek(current + step);
    }
  };

  // 极简微弱文案
  const textContent = (() => {
    const parts: string[] = [];
    if (readingMode === "scroll") {
      parts.push(`本章 ${currentChapterProgressPct}%`);
    } else if (leafRange) {
      if (leafRange.first === leafRange.last) {
        parts.push(`本章 ${leafRange.first} / ${leafRange.total} 页`);
      } else {
        parts.push(`本章 ${leafRange.first}–${leafRange.last} / ${leafRange.total} 页`);
      }
    } else {
      parts.push(`第 ${currentPage + 1} / ${pageCount || 1} 页`);
    }

    if (totalChapters > 1) {
      parts.push(`章 ${chapterIndex + 1}/${totalChapters}`);
    }

    if (typeof estimatedMinutesLeft === "number" && estimatedMinutesLeft > 0) {
      parts.push(`本章剩余约 ${estimatedMinutesLeft} 分钟`);
    }

    if (scrubState) {
      if (scrubState.actual) {
        parts.push(`全书 ${labelProgressPct(scrubState.actual)}%`);
      } else if (activeRatio !== null) {
        const atEnd = typeof bookProgressPct === "number" && bookProgressPct >= 100;
        parts.push(`全书 ${atEnd ? 100 : Math.min(99, Math.round(activeRatio * 100))}%`);
      } else {
        parts.push("准备进度…");
      }
    } else {
      parts.push(`全书 ${Math.round(fallbackWholeBookPct)}%`);
    }

    return parts.join(" · ");
  })();

  const isVisible = mobile
    ? toolsVisible
    : (!zenMode || footerReveal.revealed || isHovered || isDragging);
  const activeTooltip = isDragging ? dragTooltip : isHovered ? hoverTooltip : null;

  return (
    <>
      {/* 拖动专属全屏拦截罩：屏蔽所有其他选择、点击与交互，杜绝拖拽时抽搐或失焦 */}
      {isDragging && (
        <div
          className="whisper-drag-veil"
          aria-hidden="true"
        />
      )}

      {!mobile && zenMode && !isVisible && (
        <div
          className="whisper-footer-reveal-sensor"
          aria-hidden="true"
          onMouseEnter={footerReveal.reveal}
        />
      )}

      <footer
        ref={footerRef}
        className={`whisper-footer${mobile ? " is-mobile" : ""}${isVisible ? " is-visible" : " is-hidden"}${isHovered || isDragging ? " is-hovered" : ""}`}
        onMouseEnter={mobile ? undefined : handleMouseEnter}
        onMouseLeave={mobile ? undefined : handleMouseLeave}
        role="contentinfo"
        aria-label={mobile ? "阅读工具与进度" : "阅读进度与导览"}
      >
        {/* 悬停展开的 Scrubber 互动条（24px 宽幅热区） */}
        <div className="whisper-scrubber-wrap">
          <div
            ref={trackRef}
            className={`whisper-scrubber-track${isDragging ? " is-dragging" : ""}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handleLostPointerCapture}
            onKeyDown={handleKeyDown}
            role="slider"
            aria-label="全书阅读进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(activePct)}
            tabIndex={0}
          >
            {/* 全书进度填色 */}
            <div
              className="whisper-scrubber-fill"
              style={{ width: `${activePct}%` }}
            />

            {/* 章节刻度点（仅展示，点击穿透至 track 由单一 commit 入口提交） */}
            {chapterTicks.map((tick) => (
              <div
                key={tick.spineIndex}
                className={`whisper-chapter-tick${tick.spineIndex === chapterIndex ? " current" : ""}`}
                style={{ left: `${tick.positionPct}%` }}
                title={tick.title}
                aria-hidden="true"
              />
            ))}

            {/* 滑块按钮（指示当前位置并可拖拽） */}
            <div
              className={`whisper-scrubber-thumb${isDragging ? " is-dragging" : ""}`}
              style={{ left: `${activePct}%` }}
              aria-hidden="true"
            />
          </div>

          {/* 悬停/拖拽预览浮窗提示 */}
          {(isHovered || isDragging) && activeTooltip && (
            <div
              className="whisper-scrub-tooltip"
              style={{ left: `${activeTooltip.pct}%` }}
            >
              {activeTooltip.text}
            </div>
          )}
        </div>

        {/* 底部克制平静文本：手机也保留精简阅读位置。 */}
        <div className="whisper-meta-line">
          <span className="whisper-calm-text" title={chapterTitle || "阅读进度"}>
            {textContent}
          </span>
        </div>

        {/* 手机/平板触摸底部动作行；由 App 与顶栏共用 toolsVisible。 */}
        {mobile && (
          <nav className="mobile-reader-actions" aria-label="阅读工具">
            <button
              type="button"
              className={`mobile-reader-action${sidebarOpen ? " active" : ""}`}
              onClick={onToggleSidebar}
              aria-label="目录、书签与笔记"
              aria-expanded={sidebarOpen}
              disabled={!onToggleSidebar}
            >
              <BookOpenIcon size={19} />
              <span>目录</span>
            </button>
            <button
              type="button"
              className={`mobile-reader-action${searchOpen ? " active" : ""}`}
              onClick={onOpenSearch}
              aria-label="搜索正文"
              aria-expanded={searchOpen}
              disabled={!onOpenSearch}
            >
              <SearchIcon size={19} />
              <span>搜索</span>
            </button>
            <button
              type="button"
              className={`mobile-reader-action${appearanceOpen ? " active" : ""}`}
              onClick={onToggleAppearance}
              aria-label="外观与排版设置"
              aria-expanded={appearanceOpen}
              disabled={!onToggleAppearance}
            >
              <span className="mobile-reader-aa" aria-hidden="true">Aa</span>
              <span>Aa</span>
            </button>
            <button
              type="button"
              className={`mobile-reader-action${moreOpen ? " active" : ""}`}
              onClick={onOpenMore}
              aria-label="更多阅读操作"
              aria-expanded={moreOpen}
              disabled={!onOpenMore}
            >
              <MenuHamburgerIcon size={19} />
              <span>更多</span>
            </button>
          </nav>
        )}
      </footer>
    </>
  );
};
