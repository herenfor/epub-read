import { useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "./pagedSlide";
import { RIBBON_WIDTH_PX, type RibbonCue, type RibbonMark } from "./bookmarkRibbons";
import "./bookmarkRibbons.css";

/**
 * 提示的有效期：跳转提示要等跨章加载，可以晚到；放入、收回、悬停是当场的，
 * 过了就不再播（否则重建的视图，例如图片双页翻回来，会把刚才的放入再播一遍）。
 */
const CUE_TTL_MS: Record<RibbonCue["kind"], number> = { peek: 6000, drop: 1500, lift: 1500, hint: 1500 };
const ANIMATIONS = ["ribbon-drop", "ribbon-lift", "ribbon-peek", "ribbon-hint"] as const;
/** 动画类在 React 重渲染时保留到播完；之后同一位置重新挂上不再重播。 */
const ANIMATION_MS: Record<RibbonCue["kind"], number> = { drop: 1250, lift: 900, peek: 1250, hint: 500 };

interface Props {
  marks: readonly RibbonMark[];
  cue: (RibbonCue & { at: number }) | null;
  /** 翻页途中先淡出。 */
  motion?: boolean;
}

/** 纯显示层：不接收点击，不参与排版；位置由视图算好传入。 */
export function BookmarkRibbonLayer({ marks, cue, motion }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef(new Set<string>());
  const runningRef = useRef(new Map<string, { cls: string; until: number }>());

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || !cue || Date.now() - cue.at > CUE_TTL_MS[cue.kind]) return;
    for (const mark of marks) {
      const id = mark.ids.find((candidate) => cue.ids.includes(candidate));
      if (!id) continue;
      const played = `${cue.nonce}:${id}`;
      if (playedRef.current.has(played)) continue;
      playedRef.current.add(played);
      const el = layer.querySelector<HTMLElement>(`[data-ribbon-key="${CSS.escape(mark.key)}"]`);
      if (!el) continue;
      el.classList.remove(...ANIMATIONS);
      void el.offsetWidth;
      el.classList.add(`ribbon-${cue.kind}`);
      runningRef.current.set(mark.key, { cls: `ribbon-${cue.kind}`, until: Date.now() + ANIMATION_MS[cue.kind] });
      if (cue.kind === "peek" && !prefersReducedMotion()) addGlow(layer, mark);
    }
  }, [cue, marks]);

  const animated = (mark: RibbonMark) => {
    const running = runningRef.current.get(mark.key);
    return running && Date.now() < running.until ? running.cls : "";
  };

  return <div ref={layerRef} className="bookmark-ribbon-layer" aria-hidden="true" data-motion={motion ? "true" : undefined}>
    {marks.map((mark) => <div
      key={mark.key}
      data-ribbon-key={mark.key}
      className={`bookmark-ribbon is-${mark.kind} side-${mark.side} ${animated(mark)}`.trim()}
      style={{ left: mark.x, top: mark.y }}
    />)}
  </div>;
}

function addGlow(layer: HTMLElement, mark: RibbonMark): void {
  const parts = mark.kind === "page" ? ["is-trail", "is-bloom"] : ["is-bloom is-line"];
  const nodes = parts.map((part) => {
    const node = document.createElement("i");
    node.className = `bookmark-ribbon-glow ${part}`;
    if (mark.kind === "page") {
      node.style.left = `${mark.x + RIBBON_WIDTH_PX / 2}px`;
      node.style.top = `${mark.y}px`;
    } else {
      node.style.left = `${mark.kind === "tab" ? mark.x + 8 : mark.x + 24}px`;
      node.style.top = `${mark.y}px`;
    }
    layer.appendChild(node);
    return node;
  });
  window.setTimeout(() => nodes.forEach((node) => node.remove()), 1400);
}
