import { hasAuthoredCssProperty } from "./cssRewrite";
import { childElements, findElements, localNameOf, type XmlElementLike } from "../core/xml";

/** An authored full-page picture followed only by its link caption. */
export function linkedImagePage(page: XmlElementLike): XmlElementLike | null {
  if (localNameOf(page) !== "a" || !page.getAttribute("href")) return null;
  const children = childElements(page);
  if (children.length !== 2 || !/^(p|figcaption)$/u.test(localNameOf(children[1]))) return null;
  const media = children[0];
  if (!/(?:^|\s)(?:illus|kuchie|cover|duokan-image-fullscreen)(?:\s|$)/u.test(media.getAttribute("class") ?? "") ||
    !isImageChapterLeaf(media) || findElements(children[1], "img").length || findElements(children[1], "svg").length) return null;
  return media;
}

export function isImageChapterLeaf(body: XmlElementLike): boolean {
  const children = childElements(body);
  // Eligibility to compose two original pages is separate from forcing an
  // image to fill a page. A constrained title image keeps its authored size.
  const singleImg = !(body.textContent ?? "").trim() && findElements(body, "img").length === 1 &&
    findElements(body, "svg").length === 0;
  return singleImg || isFullPageImage(body) || (children.length === 1 && linkedImagePage(children[0]) !== null);
}

/** Shared sanitizer/host eligibility. Does not turn constrained title art into a full page. */
export function isFullPageImage(root: XmlElementLike, bodyText = (root.textContent ?? "").trim()): boolean {
  const images = findElements(root, "img");
  const svgs = findElements(root, "svg");
  const svgImages = findElements(root, "image");
  const hasOwnSize = (el: XmlElementLike): boolean => {
    const st = el.getAttribute("style") ?? "";
    if (
      ["width", "height", "max-width", "max-height", "min-width", "min-height"].some(
        (property) => hasAuthoredCssProperty(st, property)
      )
    ) {
      return true;
    }
    // xmldom 对不存在的属性返回 ""（不是 null），要按空值判断
    return Boolean(el.getAttribute("width")) || Boolean(el.getAttribute("height"));
  };
  // C-54 `width:100%` 是“跟随容器”的流体声明，不是固定限宽：纯图片页的整页
  // contain 保留同一个 100% 语义（样本 学习路线：width:100% 的路线图按版心
  // 640px 缩放成 995px 高，超过一栏后被 Chromium 拆成 3 列，多出两张空
  // 页）。只有这条唯一的流体宽度声明才放行；固定 px/em 宽度、显式高度和
  // max/min 约束仍按书自身排版，限宽 title 图不会被放大到全屏。
  const hasFluidInlineFullWidthOnly = (el: XmlElementLike): boolean => {
    const st = el.getAttribute("style") ?? "";
    const fluidWidth = /(?:^|;)\s*width\s*:\s*100(?:\.0+)?%\s*(?:!\s*important)?\s*(?:;|$)/iu;
    if (!fluidWidth.test(st)) return false;
    if (
      ["height", "max-width", "max-height", "min-width", "min-height"].some((property) =>
        hasAuthoredCssProperty(st, property)
      )
    ) {
      return false;
    }
    if (el.getAttribute("width") || el.getAttribute("height")) return false;
    return !hasAuthoredCssProperty(st.replace(fluidWidth, ";"), "width");
  };
  const svgDirectChildren =
    svgs.length === 1
      ? Array.from((svgs[0] as unknown as Element).childNodes).filter(
          (node): node is Element => node.nodeType === 1
        )
      : [];
  const isPlainImagePage =
    images.length === 1 &&
    svgs.length === 0 &&
    bodyText.length === 0 &&
    (!hasOwnSize(images[0]) || hasFluidInlineFullWidthOnly(images[0]));
  const isInlineSvgImagePage =
    images.length === 0 &&
    svgs.length === 1 &&
    svgImages.length === 1 &&
    svgDirectChildren.length === 1 &&
    svgDirectChildren[0] === (svgImages[0] as unknown as Element) &&
    Boolean(svgs[0].getAttribute("viewBox")) &&
    bodyText.length === 0;
  return isPlainImagePage || isInlineSvgImagePage;
}
