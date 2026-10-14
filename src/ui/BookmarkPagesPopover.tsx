import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUiText } from "./localization/UiLanguageProvider";
import type { ScreenBookmarks } from "./bookmarkRibbons";
import "./bookmarkPagesPopover.css";

interface Props {
  screen: ScreenBookmarks;
  onRemove(ids: readonly string[]): void;
  onAdd(lane: 0 | 1): void;
  /** 电脑悬停删除项时，正文里对应的丝带轻轻伸缩一下。 */
  onHint(ids: readonly string[]): void;
  onClose(): void;
}

const TILE_WIDTH_PX = 44;
const POPOVER_FALLBACK_TOP_PX = 60;

/**
 * 双页书签“缩略书页”：两个并排的小页对应真实的左右页。实心丝带 = 有书签（点了删除这一页
 * 全部书签），虚线丝带 + ＋ = 没有（点了添加）。文字只在悬停提示和读屏标签里。
 */
export function BookmarkPagesPopover({ screen, onRemove, onAdd, onHint, onClose }: Props) {
  const { t } = useUiText();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: POPOVER_FALLBACK_TOP_PX, right: 10 });

  useLayoutEffect(() => {
    // 挂在书签按钮下方；按钮不可见（手机收起工具栏）时放在右上角。
    const button = document.querySelector<HTMLElement>(".titlebar-bookmark-btn");
    const rect = button?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.bottom > 0) {
      setPosition({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right - 8) });
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".bookmark-pages-popover, .titlebar-bookmark-btn")) return;
      onClose();
    };
    // 点正文时焦点进入 iframe，宿主只收到 blur。
    const onBlur = () => onClose();
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onBlur);
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  // 物理左右顺序；双页末屏没有第二页时补一张空白小页。
  const tiles = (["left", "right"] as const).map((side) => ({
    side,
    page: screen.pages.find((page) => page.side === side) ?? null,
  }));
  const tileCount = tiles.length;

  return <div
    ref={ref}
    className="bookmark-pages-popover"
    role="group"
    aria-label={t("titlebar.bookmark.spread")}
    style={{ top: position.top, right: position.right, width: tileCount * TILE_WIDTH_PX + (tileCount - 1) * 2 + 16 }}
  >
    {tiles.map(({ side, page }) => {
      const ids = page?.ids ?? [];
      const has = ids.length > 0;
      const left = side === "left";
      const label = !page
        ? t("titlebar.bookmarkPages.emptyPage")
        : has
          ? ids.length > 1
            ? t(left ? "titlebar.bookmarkPages.removeLeftMany" : "titlebar.bookmarkPages.removeRightMany", { count: ids.length })
            : t(left ? "titlebar.bookmarkPages.removeLeft" : "titlebar.bookmarkPages.removeRight")
          : t(left ? "titlebar.bookmarkPages.addLeft" : "titlebar.bookmarkPages.addRight");
      return <button
        key={side}
        type="button"
        className={`bookmark-page-tile is-${side} ${has ? "has" : "empty"}`}
        disabled={!page}
        title={label}
        aria-label={label}
        onPointerEnter={(event) => { if (has && event.pointerType === "mouse") onHint(ids); }}
        onClick={() => {
          if (!page) return;
          if (has) onRemove(ids);
          else onAdd(page.lane);
        }}
      >
        <span className="tile-line" /><span className="tile-line" /><span className="tile-line short" />
        {page && <span className="tile-ribbon" />}
        {ids.length > 1 && <span className="tile-count">{ids.length}</span>}
        {page && (has ? <span className="tile-mark is-remove" aria-hidden="true">×</span>
          : <span className="tile-mark is-add" aria-hidden="true">＋</span>)}
      </button>;
    })}
  </div>;
}
