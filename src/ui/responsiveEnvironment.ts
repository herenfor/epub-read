import { useEffect, useState } from "react";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";

export type ViewportLayout = "compact" | "medium" | "wide";

export interface ViewportClassification {
  layout: ViewportLayout;
  /** 可用高度不足时，面板需要按全高可用区处理。 */
  shortViewport: boolean;
}

/**
 * 手机/平板布局只按实际可用窗口空间分层，不按设备名或 UA 锁定。
 * 初始断点来自第三步交接：<600 / 600~839 / >=840 CSS px。
 */
export function classifyViewport(width: number, height: number): ViewportClassification {
  const normalizedWidth = Number.isFinite(width) && width > 0 ? width : 1024;
  const normalizedHeight = Number.isFinite(height) && height > 0 ? height : 768;
  return {
    layout: normalizedWidth < 600 ? "compact" : normalizedWidth < 840 ? "medium" : "wide",
    shortViewport: normalizedHeight < 480,
  };
}

export interface ResponsiveEnvironment extends ViewportClassification {
  /** 触控优先输入：移动 shell 或主指针粗粒度且无 hover。 */
  touchUi: boolean;
  /** 实际 visual viewport 高度，用于 IME/短横屏弹层避免被键盘遮住。 */
  visualViewportHeight: number;
  /** IME 占用的底部空间（layout viewport 与 visual viewport 的差值）。 */
  imeBottom: number;
}

function mediaMatches(query: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  } catch {
    return false;
  }
}

function readEnvironment(shell: string): ResponsiveEnvironment {
  const width = typeof window === "undefined" ? 1024 : window.innerWidth;
  const height = typeof window === "undefined" ? 768 : window.innerHeight;
  const classification = classifyViewport(width, height);
  const visualViewport = typeof window === "undefined" ? null : window.visualViewport;
  const visualViewportHeight = visualViewport?.height ?? height;
  const visualViewportOffsetTop = visualViewport?.offsetTop ?? 0;
  const touchUi =
    shell === "mobile" ||
    (mediaMatches("(pointer: coarse)") && mediaMatches("(hover: none)"));
  return {
    ...classification,
    touchUi,
    visualViewportHeight,
    imeBottom: Math.max(0, height - visualViewportHeight - visualViewportOffsetTop),
  };
}

function sameEnvironment(a: ResponsiveEnvironment, b: ResponsiveEnvironment): boolean {
  return a.layout === b.layout &&
    a.shortViewport === b.shortViewport &&
    a.touchUi === b.touchUi &&
    Math.abs(a.visualViewportHeight - b.visualViewportHeight) < 1 &&
    Math.abs(a.imeBottom - b.imeBottom) < 1;
}

/**
 * 单一布局探测入口：窗口空间 + 输入能力 + visual viewport。
 * 组件只消费该快照，不各自重复判断 Tauri/Android/UA。
 */
export function useResponsiveEnvironment(): ResponsiveEnvironment {
  const shell = getRuntimeCapabilities().shell;
  const [environment, setEnvironment] = useState<ResponsiveEnvironment>(() => readEnvironment(shell));
  useEffect(() => {
    const update = (): void => {
      const next = readEnvironment(shell);
      setEnvironment((current) => (sameEnvironment(current, next) ? current : next));
    };
    update();
    window.addEventListener("resize", update, { passive: true });
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const coarse = typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null;
    const noHover = typeof window.matchMedia === "function" ? window.matchMedia("(hover: none)") : null;
    coarse?.addEventListener?.("change", update);
    noHover?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      coarse?.removeEventListener?.("change", update);
      noHover?.removeEventListener?.("change", update);
    };
  }, [shell]);
  return environment;
}
