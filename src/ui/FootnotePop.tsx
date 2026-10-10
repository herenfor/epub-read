import { useLayoutEffect, useRef, useState } from "react";
import { placeFootnote } from "./footnotePlacement";
import { useUiText } from "./localization/UiLanguageProvider";

export interface FootnotePopProps {
  text: string;
  /** 图片注释/富文本注释的 HTML（书内已消毒内容） */
  html?: string;
  /** 点击固定：不随鼠标移出关闭，显示“已固定” */
  pinned: boolean;
  /** 标记在阅读区（.main）坐标系的矩形 */
  rect: { left: number; top: number; right: number; bottom: number };
  onClose(): void;
  /** 点按卡片固定（触摸预览 → 固定）；已固定时不再调用。 */
  onPin?(): void;
  /** 注释内外部链接：交给阅读器用系统默认浏览器打开 */
  onExternalLink?(url: string): void;
  /** 注释内返回链接（#锚点）：滚动到正文对应标记并关闭弹层 */
  onAnchor?(anchor: string): void;
  /** 指针进入/离开浮层：供阅读器暂停翻页键等全局输入 */
  onHoverChange(over: boolean): void;
}

/**
 * 注释弹层：锚定在标记右上方，不遮挡当前行。
 * 优先显示在标记上方；上方空间不足时显示在下方。
 * 内容可滚动（超长注释），滚轮在弹层内不会触发翻页。
 */
export function FootnotePop(props: FootnotePopProps) {
  const { t } = useUiText();
  const cardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 120 });
  const [containerSize, setContainerSize] = useState(() => {
    if (typeof document === "undefined") return { w: 0, h: 0 };
    const main = document.querySelector<HTMLElement>(".main");
    return { w: main?.clientWidth ?? 0, h: main?.clientHeight ?? 0 };
  });

  useLayoutEffect(() => {
    const el = cardRef.current;
    const main = el?.closest<HTMLElement>(".main") ?? document.querySelector<HTMLElement>(".main");
    if (!el || !main) return;
    const syncSizes = (): void => {
      const nextCard = { w: el.offsetWidth, h: el.offsetHeight };
      const nextContainer = { w: main.clientWidth, h: main.clientHeight };
      setSize((current) => (current.w === nextCard.w && current.h === nextCard.h ? current : nextCard));
      setContainerSize((current) =>
        current.w === nextContainer.w && current.h === nextContainer.h ? current : nextContainer,
      );
    };
    syncSizes();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncSizes) : null;
    observer?.observe(el);
    observer?.observe(main);
    window.addEventListener("resize", syncSizes);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncSizes);
    };
  }, [props.text, props.html, props.rect]);

  const placement = placeFootnote({
    anchor: props.rect,
    containerWidth: containerSize.w,
    containerHeight: containerSize.h,
    cardWidth: size.w,
    cardHeight: size.h,
  });

  return (
    <div className={`footnote-pop${props.pinned ? " pinned" : ""}`} onWheel={(e) => e.stopPropagation()}>
      <div
        ref={cardRef}
        className="footnote-card"
        style={{
          left: placement.left,
          top: placement.top,
          width: placement.cardWidth,
          maxHeight: placement.maxHeight,
          boxSizing: "border-box",
        }}
        onMouseEnter={() => props.onHoverChange(true)}
        onMouseLeave={() => props.onHoverChange(false)}
        onClick={(e) => {
          e.stopPropagation();
          const a = (e.target as HTMLElement | null)?.closest("a");
          if (!a) {
            if (!props.pinned && !(e.target as HTMLElement | null)?.closest("button")) props.onPin?.();
            return;
          }
          e.preventDefault();
          const href = (a.getAttribute("href") ?? "").trim();
          if (/^(https?|mailto|tel):/i.test(href) || href.startsWith("//")) {
            props.onExternalLink?.(href);
            return;
          }
          if (href.startsWith("#")) {
            let anchor = href.slice(1);
            try {
              anchor = decodeURIComponent(anchor);
            } catch {
              /* 保留原样 */
            }
            if (anchor) props.onAnchor?.(anchor);
          }
          // 其他书内链接不在弹层里导航
        }}
      >
        <div className="footnote-head">
          <span>{props.pinned ? t("readerMisc.footnote.pinned") : props.onPin ? t("readerMisc.footnote.tapToPin") : t("readerMisc.footnote")}</span>
          <button className="tb-btn" onClick={props.onClose} title={t("readerMisc.footnote.close")}>
            ✕
          </button>
        </div>
        <div className="footnote-text">
          {props.html ? (
            <div className="footnote-html" dangerouslySetInnerHTML={{ __html: props.html }} />
          ) : (
            props.text
          )}
        </div>
      </div>
    </div>
  );
}
