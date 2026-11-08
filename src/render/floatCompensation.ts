import { hasAuthoredCssProperty } from "./cssRewrite";
import { readPageScroll, type PageProgression } from "./pagedDirection";

export interface InlineStyleValue {
  value: string;
  priority: string;
}

export function snapshotInlineStyleProperty(
  style: CSSStyleDeclaration,
  property: string
): InlineStyleValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

/** 恢复 inline 属性时同时恢复 !important，空值则彻底移除 longhand。 */
export function restoreInlineStyleProperty(
  style: CSSStyleDeclaration,
  property: string,
  original: InlineStyleValue
): void {
  if (original.value === "") style.removeProperty(property);
  else style.setProperty(property, original.value, original.priority);
}

/** True only for an authored inline width declaration (comments are inert). */
export function hasAuthoredInlineWidth(styleText: string): boolean {
  return hasAuthoredCssProperty(styleText, "width");
}

/**
 * 只有直接 img/svg 与源码格式化空白的 float 是正常的媒体浮动，不属于
 * C-08 要修复的文字 shrink-to-fit。注释等非渲染节点不影响判断。
 */
export function isMediaOnlyFloatContent(nodes: Iterable<Node>): boolean {
  let hasMedia = false;
  for (const node of nodes) {
    if (node.nodeType === 3) {
      if ((node.textContent ?? "").trim() !== "") return false;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = (node as Element).tagName.toLowerCase();
    if (tag !== "img" && tag !== "svg") return false;
    hasMedia = true;
  }
  return hasMedia;
}

const MEDIA_ONLY_TAGS = new Set(["img", "svg", "image", "video", "audio", "canvas"]);

/**
 * Recursive variant used only for the trailing decorative-float guard. Wrapper
 * elements and comments are allowed, while any non-whitespace text vetoes the
 * media-only classification. A media element itself counts as the payload;
 * SVG descendants are still visited so embedded visible text is not hidden.
 */
export function isMediaOnlyFloatSubtree(nodes: Iterable<Node>): boolean {
  let hasMedia = false;
  const visit = (node: Node): boolean => {
    if (node.nodeType === 3) return (node.textContent ?? "").trim() === "";
    if (node.nodeType === 8) return true;
    if (node.nodeType !== 1) return true;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (MEDIA_ONLY_TAGS.has(tag)) hasMedia = true;
    const children = (el as unknown as { childNodes?: Iterable<Node> }).childNodes;
    if (!children) return true;
    for (const child of children) if (!visit(child)) return false;
    return true;
  };
  for (const node of nodes) if (!visit(node)) return false;
  return hasMedia;
}

export interface FloatWidthSession {
  /** Apply the C-08 width fix; pending fixes from earlier applies are kept. */
  apply(doc: Document | null | undefined, viewer: HTMLElement | null | undefined): void;
  /** Remove the widths written by this session; safe to call repeatedly. */
  restore(): void;
}

/**
 * Holds the text-float width fixes so the paginator owns one session field.
 * The apply/restore positions stay in the paginator's existing measure order.
 */
export function createFloatWidthSession(): FloatWidthSession {
  let fixes: HTMLElement[] = [];
  return {
    apply(doc, viewer) {
      if (!doc || !viewer) return;
      const win = doc.defaultView;
      if (!win) return;
      applyFloatWidthFixes(win, doc, viewer, fixes);
    },
    restore() {
      for (const el of fixes) el.style.removeProperty("width");
      fixes = [];
    },
  };
}

function applyFloatWidthFixes(win: Window, doc: Document, viewer: HTMLElement, fixes: HTMLElement[]): void {
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const familiesOf = (fontFamily: string): string[] =>
    fontFamily
      .split(",")
      .map((f) => f.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

  const textWidth = (text: string, parent: Element | null): number => {
    if (!text) return 0;
    const cs = parent ? win.getComputedStyle(parent) : null;
    const families = cs ? familiesOf(cs.fontFamily) : ["sans-serif"];
    const style = cs
      ? `${cs.fontWeight} ${cs.fontSize}`
      : "400 16px";
    for (const family of families) {
      ctx.font = `${style} ${family}`;
      const w = ctx.measureText(text).width;
      if (w > 0) return w;
    }
    return 0;
  };

  const measureNode = (node: Node): number => {
    if (node.nodeType === 3) {
      return textWidth(node.textContent ?? "", node.parentElement);
    }
    if (node.nodeType !== 1) return 0;
    const el = node as HTMLElement;
    if (el.tagName.toLowerCase() === "br") return 0;
    const cs = win.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    if (tag !== "img" && tag !== "svg" && cs.display !== "inline") return 0;
    const r = el.getBoundingClientRect();
    if (r.width > 0) return r.width;
    const img = el as HTMLImageElement;
    if (img.naturalWidth) return img.naturalWidth;
    return 0;
  };

  for (const el of Array.from(viewer.querySelectorAll("*")) as HTMLElement[]) {
    const cs = win.getComputedStyle(el);
    if (cs.float === "none") continue;
    // C-08 measures horizontal inline advance. An orthogonal paragraph's
    // narrow physical width is the intended line thickness, not collapse.
    if (cs.writingMode !== "horizontal-tb") continue;
    if (hasAuthoredInlineWidth(el.getAttribute("style") ?? "")) continue;
    // 只修复“塌缩成逐字宽”的浮动元素；已有明确宽度且正常布局
    // （如目录标题 width:100% + float:left）不处理。
    const currentWidth = parseFloat(cs.width);
    if (!Number.isFinite(currentWidth) || currentWidth > 48) continue;
    // [L5-C23] 小头像等媒体本来就可能窄于 48px；源码缩进空白不是内容，
    // 不能由 Canvas 累加后反向撑宽其 float 容器。
    if (isMediaOnlyFloatContent(el.childNodes)) continue;
    if (
      Array.from(el.children).some((c) => {
        const d = win.getComputedStyle(c as Element).display;
        return (
          d.startsWith("block") ||
          d.startsWith("list-item") ||
          d === "table" ||
          d === "flex"
        );
      })
    ) {
      continue;
    }
    let maxContent = 0;
    let lineWidth = 0;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 1 && (n as HTMLElement).tagName.toLowerCase() === "br") {
        maxContent = Math.max(maxContent, lineWidth);
        lineWidth = 0;
        continue;
      }
      lineWidth += measureNode(n);
    }
    maxContent = Math.max(maxContent, lineWidth);
    if (maxContent <= 0) continue;
    const padding =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const border =
      (parseFloat(cs.borderLeftWidth) || 0) +
      (parseFloat(cs.borderRightWidth) || 0);
    const parent = el.parentElement;
    const parentCs =
      parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
    const avail =
      (parent ? parent.clientWidth : viewer.clientWidth) -
      (parseFloat(parentCs?.paddingLeft ?? "") || 0) -
      (parseFloat(parentCs?.paddingRight ?? "") || 0) -
      (parseFloat(cs.marginLeft) || 0) -
      (parseFloat(cs.marginRight) || 0);
    const target = Math.max(0, Math.min(maxContent + padding + border, avail));
    el.style.setProperty("width", `${target}px`);
    fixes.push(el);
  }
}

export function contentClientOrigin(
  viewer: HTMLElement | null,
  doc: Document | null,
  progression: PageProgression,
): number {
  if (!viewer) return 0;
  const rect = viewer.getBoundingClientRect();
  const style = doc?.defaultView?.getComputedStyle(viewer);
  return progression === "rtl"
    ? (rect.right ?? rect.left + rect.width) - (parseFloat(style?.borderRightWidth ?? "") || 0) - (parseFloat(style?.paddingRight ?? "") || 0)
    : rect.left + (viewer.clientLeft || 0) + (parseFloat(style?.paddingLeft ?? "") || 0);
}

export function axisClientRect(
  viewer: HTMLElement | null,
  progression: PageProgression,
  rect: { left: number; right: number },
): { left: number; right: number } {
  if (progression !== "rtl" || !viewer) return rect;
  const viewerRect = viewer.getBoundingClientRect();
  const sum = viewerRect.left + viewerRect.right;
  return { left: sum - rect.right, right: sum - rect.left };
}

export function axisContentOrigin(
  viewer: HTMLElement | null,
  doc: Document | null,
  progression: PageProgression,
): number {
  if (progression !== "rtl" || !viewer) return contentClientOrigin(viewer, doc, progression);
  const viewerRect = viewer.getBoundingClientRect();
  return viewerRect.left + viewerRect.right - contentClientOrigin(viewer, doc, progression);
}

export interface FloatFixRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TrailingFloatFixGeometry {
  float: string;
  position: string;
  mediaOnly: boolean;
  beforeColumns: readonly number[];
  afterColumns: readonly number[];
  afterRects: readonly FloatFixRect[];
  afterVisualRects: readonly FloatFixRect[];
  previousVisualRects: readonly FloatFixRect[];
  estimatedBeforeBottom: number;
  contentBottom: number;
  viewerLeft: number;
  scrollLeft: number;
  step: number;
  pageWidth: number;
  epsilon?: number;
}

/** Conservative, DOM-independent decision gate for the trailing media float. */
export function shouldApplyTrailingFloatMarginFix(g: TrailingFloatFixGeometry): boolean {
  const epsilon = g.epsilon ?? 0.5;
  if (!/^(?:left|right)$/u.test(g.float) || !/^(?:static|relative)$/u.test(g.position)) return false;
  if (!g.mediaOnly || g.beforeColumns.length < 2 || g.afterColumns.length !== 1) return false;
  if (!Number.isFinite(g.step) || g.step <= 0 || !Number.isFinite(g.pageWidth) || g.pageWidth <= 0) {
    return false;
  }
  if (!g.afterRects.length || !g.afterVisualRects.length) return false;
  if (
    !Number.isFinite(g.estimatedBeforeBottom) ||
    g.estimatedBeforeBottom <= g.contentBottom + epsilon
  ) {
    return false;
  }
  const columnFor = (x: number): number =>
    Math.floor((x + g.scrollLeft - g.viewerLeft + epsilon) / g.step);
  const afterColumn = g.afterColumns[0];
  const columnLeft = g.viewerLeft + afterColumn * g.step - g.scrollLeft;
  const columnRight = columnLeft + g.pageWidth;
  for (const rect of g.afterVisualRects) {
    if (
      rect.width <= epsilon ||
      rect.height <= epsilon ||
      columnFor(rect.left) !== afterColumn ||
      rect.left < columnLeft - epsilon ||
      rect.right > columnRight + epsilon
    ) {
      return false;
    }
  }
  const visualBottom = Math.max(...g.afterVisualRects.map((rect) => rect.bottom));
  if (visualBottom > g.contentBottom + epsilon) return false;
  for (const candidate of g.afterVisualRects) {
    for (const previous of g.previousVisualRects) {
      const overlapW = Math.min(candidate.right, previous.right) - Math.max(candidate.left, previous.left);
      const overlapH = Math.min(candidate.bottom, previous.bottom) - Math.max(candidate.top, previous.top);
      if (overlapW > epsilon && overlapH > epsilon) return false;
    }
  }
  return true;
}

export interface TrailingFloatGeometry {
  step: number;
  pageWidth: number;
  flowProgression: PageProgression;
}

export interface TrailingFloatSession {
  /** Apply the trailing media-float margin fix; pending fixes are kept. */
  apply(
    doc: Document | null | undefined,
    viewer: HTMLElement | null | undefined,
    geometry: TrailingFloatGeometry,
  ): void;
  /** Restore the margin-top values written by this session; safe to repeat. */
  restore(): void;
}

/**
 * Holds the trailing media-float margin fixes so the paginator owns one session
 * field.  The apply/restore positions stay in the paginator's measure order.
 */
export function createTrailingFloatSession(): TrailingFloatSession {
  let fixes: Array<{ el: HTMLElement; marginTop: InlineStyleValue }> = [];
  return {
    apply(doc, viewer, geometry) {
      if (!doc || !viewer || !doc.defaultView || geometry.step <= 0 || geometry.pageWidth <= 0) return;
      const win = doc.defaultView;
      if (!win) return;
      applyTrailingFloatMarginFix(win, doc, viewer, geometry, fixes);
    },
    restore() {
      for (const fix of fixes) {
        restoreInlineStyleProperty(fix.el.style, "margin-top", fix.marginTop);
      }
      fixes = [];
    },
  };
}

function applyTrailingFloatMarginFix(
  win: Window,
  doc: Document,
  viewer: HTMLElement,
  geometry: TrailingFloatGeometry,
  fixes: Array<{ el: HTMLElement; marginTop: InlineStyleValue }>,
): void {
  const children = Array.from(viewer.children) as HTMLElement[];
  const candidate = children.at(-1);
  if (!candidate) return;
  const cs = win.getComputedStyle(candidate);
  if (!/^(?:left|right)$/u.test(cs.float) || !/^(?:static|relative)$/u.test(cs.position)) return;
  if (!isMediaOnlyFloatSubtree(candidate.childNodes)) return;

  const viewerRect = viewer.getBoundingClientRect();
  const viewerCs = win.getComputedStyle(viewer);
  const paddingBottom = parseFloat(viewerCs.paddingBottom) || 0;
  const contentBottom = viewerRect.bottom - paddingBottom;
  // 列坐标原点是 viewer 内容盒左缘（单页边距写在 viewer 的左右 padding 里）。
  const viewerContentLeft = geometry.flowProgression === "rtl" ? axisContentOrigin(viewer, doc, geometry.flowProgression) : viewerRect.left + (viewer.clientLeft || 0) + (parseFloat(viewerCs.paddingLeft) || 0);
  const epsilon = 0.5;
  const toRect = (r: DOMRect): FloatFixRect => ({
    left: axisClientRect(viewer, geometry.flowProgression, r).left,
    right: axisClientRect(viewer, geometry.flowProgression, r).right,
    top: r.top,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  });
  const rectsOf = (el: Element): FloatFixRect[] =>
    Array.from(el.getClientRects()).map(toRect).filter((r) => r.width > 0 && r.height > 0);
  const beforeRects = rectsOf(candidate);
  if (!beforeRects.length) return;
  const columnFor = (x: number): number =>
    Math.floor((x + readPageScroll(viewer, geometry.flowProgression) - viewerContentLeft + epsilon) / geometry.step);
  const columnsFor = (rects: FloatFixRect[]): number[] =>
    Array.from(
      new Set(
        rects.flatMap((r) => [columnFor(r.left), columnFor(Math.max(r.left, r.right - epsilon))])
      )
    );
  const beforeColumns = columnsFor(beforeRects);
  if (beforeColumns.length < 2) return;
  const firstColumn = Math.min(...beforeColumns);
  const firstColumnTop = Math.min(
    ...beforeRects
      .filter((rect) => columnFor(rect.left) === firstColumn)
      .map((rect) => rect.top)
  );
  const scrollHeight = candidate.scrollHeight;
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0 || !Number.isFinite(firstColumnTop)) {
    return;
  }
  const estimatedBeforeBottom = firstColumnTop + scrollHeight;
  if (estimatedBeforeBottom <= contentBottom + epsilon) return;

  const originalMarginTop = snapshotInlineStyleProperty(candidate.style, "margin-top");
  const computedMarginTop = parseFloat(cs.marginTop);
  const shift = estimatedBeforeBottom - contentBottom + 1;
  if (!Number.isFinite(shift) || shift <= 0) return;
  const baseMargin = Number.isFinite(computedMarginTop) ? computedMarginTop : 0;
  candidate.style.setProperty("margin-top", `${baseMargin - shift}px`, "important");
  void viewer.offsetWidth;
  const afterRects = rectsOf(candidate);
  const visualRectsOf = (root: HTMLElement): FloatFixRect[] =>
    [root, ...Array.from(root.querySelectorAll("*")) as HTMLElement[]]
      .flatMap((el) => rectsOf(el));
  const afterVisualRects = visualRectsOf(candidate);
  const previousVisualRects = children
    .slice(0, -1)
    .flatMap((el) => visualRectsOf(el));
  const afterColumns = columnsFor(afterRects);
  const accepted = shouldApplyTrailingFloatMarginFix({
    float: cs.float,
    position: cs.position,
    mediaOnly: true,
    beforeColumns,
    afterColumns,
    afterRects,
    afterVisualRects,
    previousVisualRects,
    estimatedBeforeBottom,
    contentBottom,
    viewerLeft: viewerContentLeft,
    scrollLeft: readPageScroll(viewer, geometry.flowProgression),
    step: geometry.step,
    pageWidth: geometry.pageWidth,
    epsilon,
  });
  if (!accepted) {
    restoreInlineStyleProperty(candidate.style, "margin-top", originalMarginTop);
    return;
  }
  fixes.push({ el: candidate, marginTop: originalMarginTop });
}
