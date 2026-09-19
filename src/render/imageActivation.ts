/**
 * 正文图片放大：从章内点击目标识别可查看的图片请求。
 *
 * 只负责“这次点击是不是一张可放大的正文图片”，不注册事件、不持有 Book/ResourceServer，
 * 也不自行打开链接。宿主（C）在既有 click 路由里按 脚注 → 选区/拖动 → 图片 → 链接
 * 的优先级调用本函数，拿到的 src 就是 sanitize 已解析的 blob URL。
 *
 * 跨 iframe 的节点来自子文档，宿主 realm 的 `instanceof HTMLImageElement` 不成立，
 * 因此只按 tag/ownerDocument/属性判断。
 */

import { isFootnoteLink } from "./footnotes";

export interface ImageViewRequest {
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  chapterPath: string;
  /** 原书链接原值，只交回既有链接路由，不自行 window.open */
  linkHref?: string;
}

/** 脚注标记语义：sup/note 结构、多看/掌阅样式类，以及 footnotes.ts 的通用识别。 */
const FOOTNOTE_MARKER_SELECTOR = "sup, note, .duokan-footnote, .zhangyue-footnote";

function localName(el: Element): string {
  return (el.tagName ?? "").toLowerCase();
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 解析 SVG 长度属性中的纯数字；百分比/带单位值在这里不算固有尺寸。 */
function numericLength(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  return isPositiveFinite(value) ? value : null;
}

function closest(el: Element, selector: string): Element | null {
  return typeof el.closest === "function" ? el.closest(selector) : null;
}

/** 脚注图标不算正文图片：标记类、sup/note 结构、脚注链接都优先于图片查看。 */
function insideFootnoteMarker(el: Element): boolean {
  if (closest(el, FOOTNOTE_MARKER_SELECTOR)) return true;
  const anchor = closest(el, "a");
  return anchor ? isFootnoteLink(anchor as HTMLAnchorElement) : false;
}

/** 图片所在普通链接的 href；脚注链接已在识别阶段排除。 */
function findLinkHref(el: Element): string | undefined {
  const anchor = closest(el, "a");
  if (!anchor) return undefined;
  const href = (anchor.getAttribute("href") ?? "").trim();
  return href || undefined;
}

/**
 * 取 `<svg>` 内唯一 `<image>` 包装的固有尺寸。
 * 依次尝试 image 自身 width/height、svg 的 viewBox、svg 的 width/height 数字值。
 */
function svgImageSize(imageEl: Element, svg: Element): { width: number; height: number } | null {
  const ownWidth = numericLength(imageEl.getAttribute("width"));
  const ownHeight = numericLength(imageEl.getAttribute("height"));
  if (ownWidth && ownHeight) return { width: ownWidth, height: ownHeight };

  const viewBox = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/);
  if (viewBox.length === 4) {
    const viewWidth = Number(viewBox[2]);
    const viewHeight = Number(viewBox[3]);
    if (isPositiveFinite(viewWidth) && isPositiveFinite(viewHeight)) {
      return { width: viewWidth, height: viewHeight };
    }
  }

  const svgWidth = numericLength(svg.getAttribute("width"));
  const svgHeight = numericLength(svg.getAttribute("height"));
  if (svgWidth && svgHeight) return { width: svgWidth, height: svgHeight };
  return null;
}

function imageRequestFromImg(img: HTMLImageElement, chapterPath: string): ImageViewRequest | null {
  if (insideFootnoteMarker(img)) return null;
  const src = (img.currentSrc || img.src || "").trim();
  if (!src) return null;
  // 未加载成功（失败/尚未解码）不进入浮层，让原链接行为继续可用。
  if (img.complete === false) return null;
  const naturalWidth = Number(img.naturalWidth);
  const naturalHeight = Number(img.naturalHeight);
  if (!isPositiveFinite(naturalWidth) || !isPositiveFinite(naturalHeight)) return null;
  return {
    src,
    alt: img.getAttribute("alt") ?? "",
    naturalWidth,
    naturalHeight,
    chapterPath,
    linkHref: findLinkHref(img),
  };
}

/**
 * 多看常见的整页包装 `<svg viewBox=...><image xlink:href=.../></svg>`。
 * 只处理 svg 唯一元素子节点就是该 image 的简单包装；复杂内联 SVG 不导出。
 */
function imageRequestFromSvgImage(imageEl: Element, chapterPath: string): ImageViewRequest | null {
  if (insideFootnoteMarker(imageEl)) return null;
  const svg = imageEl.parentElement;
  if (!svg || localName(svg) !== "svg") return null;
  const elementChildren = Array.from(svg.children ?? []).filter((child) => child.nodeType === 1);
  if (elementChildren.length !== 1 || elementChildren[0] !== imageEl) return null;

  // sanitize 会把 xlink:href 改写成 blob URL；SVG2 裸 href 不会被资源改写，仅作回退。
  const src = (imageEl.getAttribute("xlink:href") || imageEl.getAttribute("href") || "").trim();
  if (!src) return null;
  const size = svgImageSize(imageEl, svg);
  if (!size) return null;
  return {
    src,
    alt: imageEl.getAttribute("alt") ?? "",
    naturalWidth: size.width,
    naturalHeight: size.height,
    chapterPath,
    linkHref: findLinkHref(imageEl),
  };
}

/**
 * 从章内点击目标构造图片查看请求；不是可放大的正文图片时返回 null。
 * 只读取目标的 tag/ownerDocument/属性，可安全传入 iframe 子文档节点。
 */
export function imageRequestFromTarget(target: Element, chapterPath: string): ImageViewRequest | null {
  if (!target || target.nodeType !== 1) return null;
  const tag = localName(target);
  if (tag === "img") return imageRequestFromImg(target as HTMLImageElement, chapterPath);
  if (tag === "image") return imageRequestFromSvgImage(target, chapterPath);
  return null;
}
