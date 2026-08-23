import { sanitizeChapter, VIEWER_ID } from "./sanitize";
import { resolvePath, isExternalUrl, isFragmentOnly, splitHref } from "../core/paths";
import { getFootnoteHoverAnchor, isFootnoteLink, resolveFootnote, type FootnoteInfo } from "./footnotes";
import type { ResourceServer } from "./resources";
import { OwnedBlobUrls } from "./blobOwnership";
import { TEXT_MEASURE, type ReaderSettings } from "./settings";
import { VisibilityGate } from "./displayGate";
import { hasAuthoredCssProperty } from "./cssRewrite";
import { clearDocumentSelection, isSelectAllShortcut } from "./selectionGuard";
import { applyDarkThemeContrast } from "./darkThemeContrast";
import { FootnoteHoverGate } from "./footnoteHoverGate";
import { waitForDoubleRaf, waitForFontsReady } from "./asyncWait";
import {
  buildVisibleTextIndex,
  captureTextSelection,
  resolveTextAnchorOffset,
  resolveTextRangeOffsets,
  sanitizePersistedTextAnchor,
  type TextAnchorData,
  type TextRangeAnchorData,
  type TextSelectionPayload,
  type VisibleTextIndex,
} from "./textAnchor";

/** 常规布局应远早于此完成；极端字体/引擎停滞时只解除隐藏，不伪造 ready。 */
const INITIAL_RENDER_GATE_TIMEOUT_MS = 20_000;

export type ChapterState =
  | { status: "loading" }
  | { status: "measuring" }
  | { status: "ready"; pageCount: number; currentPage: number; empty: boolean }
  | { status: "error"; message: string };

export interface ChapterMeasurementToken {
  disposed: boolean;
  loadSeq: number;
  expectedLoadSeq: number;
  contentDoc: Document | null;
  expectedDoc: Document;
  viewer: HTMLElement | null;
  expectedViewer: HTMLElement;
}

/** 异步字体/rAF边界后的统一过期检查，阻止旧文档进入后续布局补偿。 */
export function isChapterMeasurementCurrent(token: ChapterMeasurementToken): boolean {
  return (
    !token.disposed &&
    token.loadSeq === token.expectedLoadSeq &&
    token.contentDoc === token.expectedDoc &&
    token.viewer === token.expectedViewer
  );
}

/** True only for an authored inline width declaration (comments are inert). */
export function hasAuthoredInlineWidth(styleText: string): boolean {
  return hasAuthoredCssProperty(styleText, "width");
}

/** 脚注弹层数据（由分页器发往 UI 层）。 */
export interface FootnotePayload {
  text: string;
  /** 图片注释/富文本注释的 HTML；无则为 undefined */
  html?: string;
  /** 标记在 iframe 内视口的矩形 */
  rect: { left: number; top: number; right: number; bottom: number };
  /** 点击标记固定（不再随鼠标移出关闭） */
  pinned: boolean;
}

export interface ReaderNoteForPaginator extends TextRangeAnchorData {
  id: string;
  selectedText?: string;
}

export interface SelectionContextPayload extends TextSelectionPayload {
  chapterPath: string;
}

export interface LoadOptions {
  /** 跳转到页内锚点（目录跳转用） */
  anchor?: string;
  /**
   * 显式章节跳转：同章重新加载也从开头开始（清空旧页号与旧阅读锚点）。
   * 目录里点击“当前章节”时使用；设置重载/窗口重排不传，继续保留位置。
   */
  resetPage?: boolean;
  /**
   * 进入章节后停在最后一页（向前回翻上一章时使用）。
   * paginator 会在新内容布局完成、翻到最后一页之后才显示内容，
   * 避免先渲染第一页再跳到最后页的闪页。
   */
  startAtEnd?: boolean;
  /** Persisted content position. It is applied before layout, never by DOM offset. */
  readingAnchor?: ReadingAnchor | null;
  /** Saved page for records that have no valid content anchor. */
  fallbackPage?: number | null;
}

/** Synchronous navigation that reuses the currently completed chapter layout. */
export interface WithinChapterNavigationOptions {
  /** Encoded fragment without the leading `#`; empty string clears :target. */
  fragment?: string;
  /** Persisted content anchor to restore in the current chapter. */
  readingAnchor?: {
    index: number;
    ratio: number;
    anchorTextOffset: number | null;
    anchorTextSnippet: string | null;
  } | null;
  /** Page fallback used only when content/legacy anchors cannot be resolved. */
  fallbackPage?: number | null;
  /** Navigate to the natural first column and clear the old fragment. */
  toStart?: boolean;
}

export interface ReadingAnchor extends TextAnchorData {
  index: number;
  ratio: number;
  charsRead: number;
  totalChars: number;
  mediaUnits?: number;
}

/** Pure restore precedence shared by initial layout and tests. */
export function resolveRestoredPage({
  pageCount,
  anchorCol,
  fallbackPage,
  currentPage,
}: {
  pageCount: number;
  anchorCol: number | null;
  fallbackPage: number | null;
  currentPage: number;
}): { page: number; consumeFallback: boolean } {
  const last = Math.max(0, pageCount - 1);
  if (anchorCol !== null) {
    // A saved fallback belongs only to this load. Consume it even when the
    // higher-priority text/legacy anchor wins, so later image reflow cannot
    // jump back to the old page.
    return { page: Math.min(Math.max(0, anchorCol), last), consumeFallback: fallbackPage !== null };
  }
  if (fallbackPage !== null) {
    return { page: Math.min(Math.max(0, fallbackPage), last), consumeFallback: true };
  }
  return { page: Math.min(Math.max(0, currentPage), last), consumeFallback: false };
}

type ResolvedAnchorColumn = { col: number; source: "text" | "legacy" };

/**
 * 单章分页控制器：把一章 XHTML 渲染进 iframe，用 CSS 多栏布局分页。
 *
 * 核心机制（同源 blob iframe，父窗口可直接操作内容 DOM）：
 * 1. sanitizeChapter 产出注入过阅读器样式/CSP 的 HTML，blob URL 赋给 iframe.src
 * 2. iframe load 后（子资源已就绪），等待 document.fonts.ready
 * 3. 容器全宽，列宽 = 页宽；正文版心由注入 CSS 的 em 上限居中控制
 * 4. 页数 = 内容占据的列数；翻页 = 调 scrollLeft
 * 5. 阅读位置用文本内容锚点保留：成功排版后以 code-point offset/snippet
 *    通过 Range 选择新列；页面中心仅作只读 caret 采样，legacy 元素/页码兜底。
 */
/** 页内 fragment 的原始 hash 与用于 getElementById 的解码锚点。 */
export interface FragmentNavigation {
  hash: string;
  anchor: string;
}

/**
 * 纯 fragment 链接才由当前章节处理。保留原始编码 hash 给 location，
 * 同时把可解码值用于 DOM id 查找；畸形百分号编码则沿用原始值，避免点击报错。
 */
export function getFragmentNavigation(href: string): FragmentNavigation | null {
  if (!isFragmentOnly(href)) return null;
  const encodedAnchor = href.slice(1);
  if (!encodedAnchor) return null;
  let anchor = encodedAnchor;
  try {
    anchor = decodeURIComponent(encodedAnchor);
  } catch {
    // 使用原值：某些不规范 EPUB 可能真的以 `%` 作为 id 的一部分。
  }
  return { hash: `#${encodedAnchor}`, anchor };
}

/**
 * `history.replaceState` 不会激活 :target；只有 location.hash 导航会。
 * blob iframe 理应同源，但在章节卸载或权限变化时访问 location 仍可能抛异常，
 * 因此同步失败不能阻断分页器的显式列定位。
 */
export function syncFragmentHash(win: Window | null | undefined, hash: string): void {
  if (hash !== "" && (hash.length < 2 || !hash.startsWith("#"))) return;
  try {
    const iframeLocation = win?.location;
    if (iframeLocation && iframeLocation.hash !== hash) iframeLocation.hash = hash;
  } catch {
    // iframe 已卸载/不可访问时仍继续 jumpToAnchor；不让链接点击抛到 UI。
  }
}

type BoxWidthStyle = Pick<
  CSSStyleDeclaration,
  | "width"
  | "boxSizing"
  | "paddingLeft"
  | "paddingRight"
  | "borderLeftWidth"
  | "borderRightWidth"
>;

/** computed width 转为与水平 margin 布局一致的 border-box 宽度。 */
export function getBorderBoxWidth(style: BoxWidthStyle): number {
  const width = parseFloat(style.width);
  if (!Number.isFinite(width)) return 0;
  if (style.boxSizing === "border-box") return width;
  return (
    width +
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0)
  );
}

type MarginStyle = Pick<CSSStyleDeclaration, "margin" | "marginLeft" | "marginRight">;

/** 作者 inline style 是否明确使用了水平百分比 margin。 */
export function hasPercentageHorizontalMargin(style: MarginStyle): boolean {
  if (style.marginLeft.includes("%") || style.marginRight.includes("%")) return true;
  const values = style.margin.trim().split(/\s+/).filter(Boolean);
  if (values.length === 0) return false;
  const horizontal =
    values.length === 1
      ? [values[0]]
      : values.length === 2 || values.length === 3
        ? [values[1]]
        : [values[1], values[3]];
  return horizontal.some((value) => value.includes("%"));
}

function styleHasPercentageHorizontalMargin(style: CSSStyleDeclaration): boolean {
  if (style.marginLeft.includes("%") || style.marginRight.includes("%")) return true;
  const values = style.margin.trim().split(/\s+/).filter(Boolean);
  if (values.length === 0) return false;
  const horizontal =
    values.length === 1
      ? [values[0]]
      : values.length === 2 || values.length === 3
        ? [values[1]]
        : [values[1], values[3]];
  return horizontal.some((value) => value.includes("%"));
}

const HORIZONTAL_MARGIN_PROPERTIES = [
  "margin",
  "margin-left",
  "margin-right",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
] as const;

/**
 * 当前元素是否在注释外的 inline style 中明确声明了任一水平 margin。
 * `margin` 简写即使只写为 0 也算作者意图：这里判断的是来源而非数值。
 */
function hasAuthoredInlineHorizontalMargin(el: HTMLElement): boolean {
  const styleText = el.getAttribute("style") ?? "";
  return HORIZONTAL_MARGIN_PROPERTIES.some((property) =>
    hasAuthoredCssProperty(styleText, property)
  );
}

type AuthoredHorizontalMarginResult = boolean | undefined;

function ruleHasHorizontalMargin(style: CSSStyleDeclaration): boolean {
  return HORIZONTAL_MARGIN_PROPERTIES.some(
    (property) => style.getPropertyValue(property).trim() !== ""
  );
}

/**
 * 判断当前元素有没有作者/用户明确声明的水平 margin。
 *
 * 调用时 L3 `.reader-top` 的 auto margin 已临时移除，因此同一
 * `data-reader=overrides` 样式表末尾的 customCss 仍可作为用户意图读取，
 * 而内建 auto margin 不会造成假阳性。无法读取的 stylesheet、未知条件或
 * 未来 grouping rule 不能安全否定，返回 undefined 维持 C-04 的旧保守行为。
 */
export function hasAuthoredHorizontalMargin(
  doc: Document,
  el: HTMLElement
): AuthoredHorizontalMarginResult {
  if (hasAuthoredInlineHorizontalMargin(el)) return true;

  let unknownSource = false;
  const walk = (rules: CSSRuleList): boolean => {
    for (const rule of Array.from(rules)) {
      const active = getActiveCssCondition(rule, doc.defaultView);
      if (active === false) continue;
      if (active === undefined) {
        unknownSource = true;
        continue;
      }

      if (rule.type === 1) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText ?? "";
        if (selector && ruleHasHorizontalMargin(styleRule.style)) {
          try {
            if (el.matches(selector)) return true;
          } catch {
            // Invalid/unavailable selector matching cannot prove that the
            // computed nonzero margin comes from UA CSS.
            unknownSource = true;
          }
        }
      }

      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules && walk(nested.cssRules)) return true;
      } catch {
        unknownSource = true;
      }
    }
    return false;
  };

  for (const sheet of Array.from(doc.styleSheets ?? [])) {
    try {
      if (walk(sheet.cssRules)) return true;
    } catch {
      unknownSource = true;
    }
  }
  return unknownSource ? undefined : false;
}

const HORIZONTAL_SIZING_PROPERTIES = ["width", "min-width", "max-width"] as const;
type AuthoredSizingIntentResult = boolean | undefined;

function ruleHasHorizontalSizing(style: CSSStyleDeclaration): boolean {
  return HORIZONTAL_SIZING_PROPERTIES.some(
    (property) => style.getPropertyValue(property).trim() !== ""
  );
}

/**
 * 判断直接子元素是否存在作者/用户的 width/min-width/max-width sizing intent。
 *
 * reader overrides 中唯一已知的默认 sizing 是 L3 的 `max-width:40rem`；它
 * 不应阻止 C-40。其余 reader stylesheet 命中规则无法和 customCss 在旧引擎
 * 中可靠区分，因此返回 undefined，宁可保守保留 C-04，也不吞掉用户 sizing。
 */
export function hasAuthoredSizingIntent(
  doc: Document,
  el: HTMLElement
): AuthoredSizingIntentResult {
  const inlineStyle = el.getAttribute("style") ?? "";
  if (HORIZONTAL_SIZING_PROPERTIES.some((property) => hasAuthoredCssProperty(inlineStyle, property))) {
    return true;
  }
  if (el.hasAttribute("width")) return true;

  let unknownSource = false;
  const walk = (rules: CSSRuleList, readerSheet: boolean): boolean => {
    for (const rule of Array.from(rules)) {
      const active = getActiveCssCondition(rule, doc.defaultView);
      if (active === false) continue;
      if (active === undefined) {
        // Keyframes declarations are not selector-applied sizing sources;
        // their cssRules must not make an otherwise complete static cascade
        // probe unknown (a separate animation layout issue is out of scope).
        if (rule.type === 7) continue;
        unknownSource = true;
        continue;
      }

      if (rule.type === 1) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText ?? "";
        if (selector && ruleHasHorizontalSizing(styleRule.style)) {
          let matches = false;
          try {
            matches = el.matches(selector);
          } catch {
            unknownSource = true;
          }
          if (matches) {
            if (
              readerSheet &&
              selector.includes("#epub-viewer") &&
              selector.includes(".reader-top") &&
              styleRule.style.getPropertyValue("width").trim() === "" &&
              styleRule.style.getPropertyValue("min-width").trim() === "" &&
              styleRule.style.getPropertyValue("max-width").trim() === `${TEXT_MEASURE.maxEm}rem`
            ) {
              // Known L3 reader default; it is not author sizing intent.
            } else {
              // customCss is appended to the same reader stylesheet in the
              // current sanitizer. Without declaration provenance, a match
              // there is unknown rather than proof of author sizing.
              if (readerSheet) {
                unknownSource = true;
              } else {
                return true;
              }
            }
          }
        }
      }

      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules && walk(nested.cssRules, readerSheet)) return true;
      } catch {
        unknownSource = true;
      }
    }
    return false;
  };

  for (const sheet of Array.from(doc.styleSheets ?? [])) {
    const owner = sheet.ownerNode as Element | null;
    const readerSheet = owner?.hasAttribute?.("data-reader") || owner?.getAttribute?.("data-reader") != null;
    try {
      if (walk(sheet.cssRules, readerSheet)) return true;
    } catch {
      unknownSource = true;
    }
  }
  return unknownSource ? undefined : false;
}

/** Only a known UA-only margin may bypass C-04; unknown sources preserve legacy behavior. */
export function shouldApplyBookMarginCompensation(
  authoredHorizontalMargin: AuthoredHorizontalMarginResult
): boolean {
  return authoredHorizontalMargin !== false;
}

/**
 * Mirrors the C-04 candidate gate: resolved zero/auto margins cannot trigger
 * compensation, while an unparsed expression remains conservative/meaningful.
 */
export function isMeaningfulHorizontalMargin(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "auto" && parseFloat(normalized) !== 0;
}

/** C-16 percentage margins never reach C-37/C-04, so they need no CSSOM source probe. */
export function shouldProbeAuthoredHorizontalMargin(
  percentageMargin: boolean | undefined,
  left: string,
  right: string
): boolean {
  return (
    percentageMargin !== true &&
    (isMeaningfulHorizontalMargin(left) || isMeaningfulHorizontalMargin(right))
  );
}

type TypedStyleMapHost = {
  computedStyleMap?: () => {
    get(property: string): { toString(): string } | undefined;
  };
};

/**
 * CSS Typed OM 保留最终获胜 margin 的百分比/calc 表达式；传统
 * getComputedStyle() 则已将它解析为 px。调用方必须先解除阅读器的
 * reader-top auto margin，避免读到 L3 默认值而不是作者最终级联。
 * 返回 undefined 表示当前引擎不支持或读取失败，供兼容回退使用。
 */
export function hasComputedPercentageHorizontalMargin(el: Element): boolean | undefined {
  try {
    const styleMap = (el as Element & TypedStyleMapHost).computedStyleMap?.();
    if (!styleMap) return undefined;
    return ["margin-left", "margin-right"].some((property) =>
      styleMap.get(property)?.toString().includes("%")
    );
  } catch {
    return undefined;
  }
}

type PercentageWidthValue = number | null | undefined;

function parsePercentageWidthValue(value: string): number | null {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/u);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

type TypedWidthStyleMapHost = {
  computedStyleMap?: () => {
    get(property: string): { toString(): string } | undefined;
  };
};

type WidthCascadeCandidate = {
  value: string;
  important: boolean;
  specificity: number;
  order: number;
};

function selectorSpecificity(selector: string, el: Element): number | undefined {
  const matching = selector
    .split(",")
    .map((part) => part.trim())
    .filter((part) => {
      try {
        return part !== "" && el.matches(part);
      } catch {
        return false;
      }
    });
  const candidate = matching.length > 0 ? matching : [selector];
  let best = 0;
  for (const part of candidate) {
    // These pseudo-classes have selector-specific specificity rules which
    // this small fallback parser intentionally does not implement.  A legacy
    // engine must not guess their cascade order and accidentally exempt C-31.
    if (/(?::where|:is|:not|:has)\s*\(/u.test(part)) return undefined;
    const withoutStrings = part.replace(/(["']).*?\1/gu, "");
    const ids = (withoutStrings.match(/#[\w-]+/gu) ?? []).length;
    const classes = (withoutStrings.match(/(?:\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?)/gu) ?? []).length;
    const elements = (withoutStrings
      .replace(/#[\w-]+/gu, " ")
      .replace(/(?:\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?)/gu, " ")
      .match(/(?:^|[ >+~])([a-zA-Z][\w-]*)/gu) ?? []).length;
    best = Math.max(best, ids * 1_000_000 + classes * 1_000 + elements);
  }
  return best;
}

function getActiveCssCondition(
  rule: CSSRule,
  win: Window | null | undefined
): boolean | undefined {
  const conditional = rule as CSSRule & {
    conditionText?: string;
    media?: { mediaText?: string };
  };
  if (rule.type === 4) {
    const query = conditional.media?.mediaText;
    if (!query || !win || typeof win.matchMedia !== "function") return undefined;
    try {
      return win.matchMedia(query).matches;
    } catch {
      return undefined;
    }
  }
  if (rule.type === 12) {
    const query = conditional.conditionText;
    const css = (win as Window & { CSS?: { supports?: (condition: string) => boolean } } | null | undefined)?.CSS;
    if (!query || typeof css?.supports !== "function") return undefined;
    try {
      return css.supports(query);
    } catch {
      return undefined;
    }
  }
  // @layer, @container and future grouping rules have cascade/condition
  // semantics that this fallback intentionally does not model.  @import is
  // safe to recurse into as a source-order container; other unknown groups
  // must remain conservative.
  if (rule.type !== 1 && rule.type !== 3 && (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules) {
    return undefined;
  }
  return true;
}

/**
 * 读取页面元素最终获胜的作者 width 是否是明确百分比。
 *
 * Typed OM 在支持的引擎中提供当前最终值；旧 WebView 只能读取 CSSOM，
 * 因此回退只按简单选择器的基础重要性/特异性/源顺序排序，而不是宣称
 * 实现完整 CSS cascade。返回 null 表示已知不是百分比，undefined 表示
 * CSSOM 不完整/不可读，调用方必须对后者保持 C-31 原行为。
 */
export function getAuthoredPercentageWidth(el: Element, doc: Document): PercentageWidthValue {
  try {
    const typedMap = (el as Element & TypedWidthStyleMapHost).computedStyleMap?.();
    const typed = typedMap?.get("width");
    if (typed) {
      // A present Typed OM value is the final computed value.  If it is px,
      // do not resurrect an earlier author percentage from CSSOM.
      const typedText = typed.toString();
      if (typedText.trim() !== "") return parsePercentageWidthValue(typedText);
    }
  } catch {
    // Fall through to the CSSOM/inline cascade fallback.
  }

  const inlineStyle = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  const inlineValue = inlineStyle?.getPropertyValue?.("width") ?? "";
  const inlinePriority = inlineStyle?.getPropertyPriority?.("width") ?? "";
  let best: WidthCascadeCandidate | null = inlineValue
    ? {
        value: inlineValue,
        important: inlinePriority === "important",
        specificity: 1_000_000_000,
        order: Number.MAX_SAFE_INTEGER,
      }
    : null;
  let order = 0;
  let unknownSheet = false;
  let readerSheetHasMatchingWidth = false;
  const isBetter = (next: WidthCascadeCandidate, current: WidthCascadeCandidate | null): boolean => {
    if (!current) return true;
    if (next.important !== current.important) return next.important;
    if (next.specificity !== current.specificity) return next.specificity > current.specificity;
    return next.order >= current.order;
  };
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      order += 1;
      const active = getActiveCssCondition(rule, doc.defaultView);
      if (active === false) continue;
      if (active === undefined) {
        unknownSheet = true;
        continue;
      }
      if (rule.type === 1) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText ?? "";
        if (selector) {
          let matches = false;
          try {
            matches = el.matches(selector);
          } catch {
            unknownSheet = true;
            matches = false;
          }
          const value = styleRule.style.getPropertyValue("width");
          if (matches && value) {
            const specificity = selectorSpecificity(selector, el);
            if (specificity === undefined) {
              unknownSheet = true;
              continue;
            }
            const candidate: WidthCascadeCandidate = {
              value,
              important: styleRule.style.getPropertyPriority("width") === "important",
              specificity,
              order,
            };
            if (isBetter(candidate, best)) best = candidate;
          }
        }
      }
      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules) walk(nested.cssRules);
      } catch {
        unknownSheet = true;
      }
    }
  };

  for (const sheet of Array.from(doc.styleSheets ?? [])) {
    const owner = sheet.ownerNode as Element | null;
    const isReaderSheet = owner?.hasAttribute?.("data-reader") || owner?.getAttribute?.("data-reader") != null;
    try {
      if (isReaderSheet) {
        // `customCss` is appended to this same reader stylesheet.  In an old
        // WebView we cannot distinguish it from built-in overrides reliably;
        // a matching explicit width therefore makes the author-only fallback
        // unknown instead of letting an earlier EPUB rule form a false group.
        const inspectReaderWidth = (rules: CSSRuleList): void => {
          for (const rule of Array.from(rules)) {
            const active = getActiveCssCondition(rule, doc.defaultView);
            if (active === undefined) {
              unknownSheet = true;
              continue;
            }
            if (active === false) continue;
            if (rule.type === 1) {
              const styleRule = rule as CSSStyleRule;
              const selector = styleRule.selectorText ?? "";
              const value = styleRule.style.getPropertyValue("width");
              if (selector && value) {
                try {
                  if (el.matches(selector)) readerSheetHasMatchingWidth = true;
                } catch {
                  unknownSheet = true;
                }
              }
            }
            const nested = rule as CSSRule & { cssRules?: CSSRuleList };
            try {
              if (nested.cssRules) inspectReaderWidth(nested.cssRules);
            } catch {
              unknownSheet = true;
            }
          }
        };
        inspectReaderWidth(sheet.cssRules);
      } else {
        walk(sheet.cssRules);
      }
    } catch {
      unknownSheet = true;
    }
  }

  // An inline !important declaration wins over every author stylesheet.  It
  // remains usable even when an unrelated external sheet is unreadable.
  if ((unknownSheet || readerSheetHasMatchingWidth) && inlinePriority !== "important") return undefined;
  if (!best) return null;
  return parsePercentageWidthValue(best.value);
}

export interface PercentageFloatGroupEntry {
  eligible: boolean;
  readerTop: boolean;
  float: string;
  clear: string;
  /** null = known non-percentage (e.g. px); undefined = unreadable/unknown. */
  percentageWidth: PercentageWidthValue;
  marginLeft?: string;
  marginRight?: string;
  position?: string;
  writingMode?: string;
  direction?: string;
  authorFullWidthIntent?: boolean;
  percentageMargin?: boolean | undefined;
}

/**
 * C-31 的连续作者栅格门控。只对至少两个直接 sibling、同方向、明确为
 * 百分比且总和约等于一整行的 float 组返回 true；其他元素逐项保持旧补偿。
 */
export function getPercentageFloatGroupMembers(
  entries: readonly PercentageFloatGroupEntry[]
): boolean[] {
  const result = entries.map(() => false);
  let index = 0;
  while (index < entries.length) {
    const first = entries[index];
    const direction = first.float.trim().toLowerCase();
    if (
      !first.eligible ||
      !first.readerTop ||
      first.clear.trim().toLowerCase() !== "none" ||
      !/^(?:left|right)$/u.test(direction) ||
      typeof first.percentageWidth !== "number" ||
      first.percentageWidth <= 0 ||
      first.percentageWidth > 100
    ) {
      index += 1;
      continue;
    }
    const group: number[] = [index];
    let sum = first.percentageWidth;
    let cursor = index + 1;
    while (cursor < entries.length) {
      const entry = entries[cursor];
      const width = entry.percentageWidth;
      if (
        !entry.eligible ||
        !entry.readerTop ||
        entry.clear.trim().toLowerCase() !== "none" ||
        entry.float.trim().toLowerCase() !== direction ||
        typeof width !== "number" ||
        width <= 0 ||
        width > 100
      ) {
        break;
      }
      group.push(cursor);
      sum += width;
      cursor += 1;
    }
    if (group.length >= 2 && sum >= 99 && sum <= 101) {
      for (const member of group) result[member] = true;
    }
    index = Math.max(cursor, index + 1);
  }
  return result;
}

/**
 * 阶段 2 的完整安全门。粗粒度 C-31 组还必须是物理水平、静态/相对定位、
 * 无全宽意图，且最终级联 margin 已经解析为有限近零值；任何信息缺失都
 * 保守回退到作者原始 float，不尝试以百分比猜测布局。
 */
export function getSafePercentageFloatGroupMembers(
  entries: readonly PercentageFloatGroupEntry[]
): boolean[] {
  const coarse = getPercentageFloatGroupMembers(entries);
  const safe = coarse.map(() => false);
  const finiteNearZero = (value: string | undefined): boolean => {
    if (value === undefined) return false;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && Math.abs(parsed) <= 0.5;
  };
  let index = 0;
  while (index < coarse.length) {
    if (!coarse[index]) {
      index += 1;
      continue;
    }
    const group: number[] = [];
    while (index < coarse.length && coarse[index]) group.push(index++);
    const valid = group.every((member) => {
      const entry = entries[member];
      return (
        /^(?:static|relative)$/u.test((entry.position ?? "").trim().toLowerCase()) &&
        (entry.writingMode ?? "").trim().toLowerCase() === "horizontal-tb" &&
        (entry.direction ?? "").trim().toLowerCase() === "ltr" &&
        entry.authorFullWidthIntent === false &&
        entry.percentageMargin === false &&
        finiteNearZero(entry.marginLeft) &&
        finiteNearZero(entry.marginRight)
      );
    });
    if (valid) for (const member of group) safe[member] = true;
  }
  return safe;
}

/** 将完整百分比组投影到当前包含块与 40rem 版心中的较小宽度。 */
export function getPercentageFloatGroupTargetWidths(
  percentages: readonly number[],
  parentWidth: number,
  contentWidth: number
): number[] | null {
  if (
    percentages.length < 2 ||
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(contentWidth) ||
    parentWidth <= 0 ||
    contentWidth <= 0 ||
    percentages.some((value) => !Number.isFinite(value) || value <= 0 || value > 100)
  ) return null;
  const total = percentages.reduce((sum, value) => sum + value, 0);
  if (total < 99 || total > 101) return null;
  const targetParent = Math.min(parentWidth, contentWidth);
  return percentages.map((percentage) =>
    Math.min(parentWidth * percentage / 100, targetParent * percentage / 100)
  );
}

export interface PercentageFloatGroupRect {
  left: number;
  right: number;
  top: number;
  width: number;
}

/** 组写回后的事务式几何门，失败时调用方必须恢复整组。 */
export function isPercentageFloatGroupGeometryValid({
  rects,
  viewerLeft,
  scrollLeft,
  step,
  parentWidth,
  contentWidth,
  epsilon = 0.75,
}: {
  rects: readonly (readonly PercentageFloatGroupRect[])[];
  viewerLeft: number;
  scrollLeft: number;
  step: number;
  parentWidth: number;
  contentWidth: number;
  epsilon?: number;
}): boolean {
  if (
    rects.length < 2 ||
    !Number.isFinite(viewerLeft) ||
    !Number.isFinite(scrollLeft) ||
    !Number.isFinite(step) ||
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(contentWidth) ||
    step <= 0 ||
    parentWidth <= 0 ||
    contentWidth <= 0
  ) return false;
  if (rects.some((memberRects) => memberRects.length !== 1)) return false;
  const first = rects[0][0];
  if (!first || first.width <= 0) return false;
  const expectedParentWidth = Math.min(parentWidth, contentWidth);
  const firstColumn = Math.floor((first.left - viewerLeft + scrollLeft + epsilon) / step);
  if (firstColumn < 0) return false;
  const columnStart = viewerLeft + firstColumn * step - scrollLeft;
  const columnLeft = columnStart + (parentWidth - expectedParentWidth) / 2;
  const columnRight = columnLeft + expectedParentWidth;
  return rects.every((memberRects) => {
    const rect = memberRects[0];
    if (!rect || rect.width <= 0) return false;
    const column = Math.floor((rect.left - viewerLeft + scrollLeft + epsilon) / step);
    return (
      column === firstColumn &&
      Math.abs(rect.top - first.top) <= epsilon &&
      rect.left >= columnLeft - epsilon &&
      rect.right <= columnRight + epsilon
    );
  });
}

/**
 * 兼容不支持 Typed OM 的旧 WebView：从可读样式表中寻找百分比声明。
 * 任何一个外链样式表不可读时，负结果都不可靠，返回 undefined 交给
 * 几何兜底；单个 SecurityError 不得中断整章测量。
 */
export function hasPercentageHorizontalMarginInRules(
  doc: Document,
  el: Element
): boolean | undefined {
  const walk = (rules: CSSRuleList): boolean => {
    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText === "string") {
        const selector = styleRule.selectorText ?? "";
        if (!selector) continue;
        try {
          if (el.matches(selector) && styleHasPercentageHorizontalMargin(styleRule.style)) {
            return true;
          }
        } catch {
          /* 复杂/伪类选择器匹配失败时忽略 */
        }
      }
      // @media/@supports/@layer 等嵌套规则都可能携带作者 margin 声明。
      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules && walk(nested.cssRules)) return true;
      } catch {
        // 当前 sheet 已经可读时，单条嵌套规则的失败只代表该分支不可判定；
        // 继续扫描其他规则，外层 sheet 的不可读标记由调用处统一处理。
      }
    }
    return false;
  };

  let unreadableSheet = false;
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      if (walk(sheet.cssRules)) return true;
    } catch {
      unreadableSheet = true;
    }
  }
  return unreadableSheet ? undefined : false;
}

/** 百分比声明只有解析出实际水平偏移时才进入页面相对布局分支。 */
export function isPercentageMarginLayout(
  hasPercentage: boolean,
  computedLeft: string,
  computedRight: string
): boolean {
  if (!hasPercentage) return false;
  return (parseFloat(computedLeft) || 0) !== 0 || (parseFloat(computedRight) || 0) !== 0;
}

/**
 * 最后一道跨引擎兜底：未知来源的 margin 在作者原位仍留有明确余量，但
 * C-04 再叠加正文版心会越出包含块时，保留作者原位。仅接受有限、非负、
 * 非 auto-like 的显式 margin；普通 2em 缩进与作者原位本就越列不命中。
 */
export function shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
  parentWidth,
  width,
  marginLeft,
  marginRight,
}: {
  parentWidth: number;
  width: number;
  marginLeft: number;
  marginRight: number;
}): boolean {
  if (
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(width) ||
    !Number.isFinite(marginLeft) ||
    !Number.isFinite(marginRight) ||
    parentWidth <= 0 ||
    width < 0 ||
    marginLeft < 0 ||
    marginRight < 0
  ) {
    return false;
  }
  const base = (parentWidth - width) / 2;
  if (
    isAutoLikeHorizontalMargin({ parentWidth, width, marginLeft, marginRight })
  ) {
    return false;
  }
  const epsilon = 0.5;
  // CSS auto margin 会在 getComputedStyle 中变成“恰好填满剩余空间”的 px。
  // 只有作者原位仍留出明确余量，才能证明不是这类 auto-resolved 布局。
  const originalHasRoom = marginLeft + width + marginRight < parentWidth - epsilon;
  const withReaderBaseOverflows =
    base + marginLeft + width + marginRight > parentWidth + epsilon;
  return originalHasRoom && withReaderBaseOverflows;
}

/**
 * 正对称水平 margin 表达的是双侧留白，而不是向某一侧缩进。
 * 仅接受正有限值；负 margin 即使相等也可能是作者有意的双侧出血。
 */
export function isSymmetricHorizontalMargin(left: string, right: string): boolean {
  const ml = parseFloat(left);
  const mr = parseFloat(right);
  return (
    Number.isFinite(ml) &&
    Number.isFinite(mr) &&
    ml > 0 &&
    mr > 0 &&
    Math.abs(ml - mr) < 0.5
  );
}

export interface ReaderTopUaSymmetricInsetInput {
  /** 只允许阅读器版心的直接子元素。 */
  readerTop: boolean;
  /** 只有 C-37 已证明没有作者/用户水平 margin 时才可进入。 */
  authoredHorizontalMargin: AuthoredHorizontalMarginResult;
  /** UA inset 不参与 float/fullpage 等已有更高优先级路径。 */
  float: string;
  fullpage: boolean;
  percentageMargin: boolean | undefined;
  parentWidth: number;
  /** getBorderBoxWidth() 的当前 border-box 宽度。 */
  borderBoxWidth: number;
  /** getComputedStyle().width；用于把 border-box 结果换回 max-width。 */
  cssWidth: number;
  boxSizing: string;
  marginLeft: string;
  marginRight: string;
}

/**
 * C-37 follow-up：UA 默认的 blockquote 等对称水平 margin 是盒内双侧留白，
 * 不是 C-04 的单侧版心偏移。将其折算为居中的有效 max-width；返回值按
 * 当前 box-sizing 表示（content-box 返回内容宽度，border-box 返回外框宽度）。
 *
 * 该纯函数只接受 reader-top、明确 UA-only、非浮动/非全页、非百分比且有限
 * 的正对称 margin。目标宽度同时受包含块限制，避免窄视口出现负宽或溢出。
 */
export function getReaderTopUaSymmetricInsetMaxWidth(
  input: ReaderTopUaSymmetricInsetInput
): number | null {
  if (
    !input.readerTop ||
    input.authoredHorizontalMargin !== false ||
    input.fullpage ||
    input.float.trim().toLowerCase() !== "none" ||
    input.percentageMargin === true
  ) {
    return null;
  }
  if (
    !Number.isFinite(input.parentWidth) ||
    !Number.isFinite(input.borderBoxWidth) ||
    !Number.isFinite(input.cssWidth) ||
    input.parentWidth <= 0 ||
    input.borderBoxWidth <= 0 ||
    input.cssWidth < 0
  ) {
    return null;
  }
  const marginLeft = Number.parseFloat(input.marginLeft);
  const marginRight = Number.parseFloat(input.marginRight);
  if (
    !Number.isFinite(marginLeft) ||
    !Number.isFinite(marginRight) ||
    marginLeft <= 0 ||
    marginRight <= 0 ||
    Math.abs(marginLeft - marginRight) > 0.5
  ) {
    return null;
  }

  const currentBorderBox = Math.min(input.borderBoxWidth, input.parentWidth);
  const targetBorderBox = Math.max(
    0,
    Math.min(input.parentWidth, currentBorderBox - marginLeft - marginRight)
  );
  const extraBox = Math.max(0, input.borderBoxWidth - input.cssWidth);
  const borderBoxSizing = input.boxSizing.trim().toLowerCase() === "border-box";
  const target = borderBoxSizing ? targetBorderBox : targetBorderBox - extraBox;
  if (!Number.isFinite(target) || target < 0) return null;
  return target;
}

/**
 * getComputedStyle 会把 `margin:auto` 解析为实际 px。只有两侧余量都等于
 * 当前盒子的居中余量时，才能把它当作作者/阅读器的 auto 居中，而不是
 * 显式写出的相等 margin。
 */
export function isAutoLikeHorizontalMargin({
  parentWidth,
  width,
  marginLeft,
  marginRight,
}: {
  parentWidth: number;
  width: number;
  marginLeft: number;
  marginRight: number;
}): boolean {
  if (
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(width) ||
    !Number.isFinite(marginLeft) ||
    !Number.isFinite(marginRight)
  ) {
    return false;
  }
  const autoCenter = (parentWidth - width) / 2;
  return (
    autoCenter > 0 &&
    marginLeft > 0 &&
    Math.abs(marginLeft - marginRight) < 0.5 &&
    Math.abs(marginLeft - autoCenter) < 0.5
  );
}

/**
 * C-18 的正对称 margin 豁免只属于 fit/max-content 这类 intrinsic-size
 * 容器。普通 width:auto/固定宽度元素仍由 C-04 把作者 margin 映射到正文
 * 版心；否则目录标题的显式左右缩进会再次被 L3 auto margin 吞掉。
 */
export function shouldKeepSymmetricMarginsCentered(
  left: string,
  right: string,
  hasIntrinsicSizeIntent: boolean
): boolean {
  return hasIntrinsicSizeIntent && isSymmetricHorizontalMargin(left, right);
}

export interface CenteredAuthorMarginInput {
  readerTop: boolean;
  float: string;
  writingMode: string;
  fullpage: boolean;
  intrinsicSize: boolean;
  percentageMargin: boolean | undefined;
  authoredHorizontalMargin: AuthoredHorizontalMarginResult;
  authoredSizingIntent: AuthoredSizingIntentResult;
  textAlign: string;
  marginLeft: string;
  marginRight: string;
}

/**
 * C-40：普通页面级居中块的显式对称 margin 是双侧留白，不是 C-04 单向
 * 版心偏移。只有 margin/sizing 来源都已知为作者声明且没有 sizing intent
 * 时才跳过 C-04；未知 CSSOM、固定宽度盒、float、fit/fullpage 和百分比
 * margin 全部保留旧路径。
 */
export function shouldKeepCenteredAuthorMargins(
  input: CenteredAuthorMarginInput
): boolean {
  return (
    input.readerTop &&
    input.float.trim().toLowerCase() === "none" &&
    input.writingMode.trim().toLowerCase() === "horizontal-tb" &&
    !input.fullpage &&
    !input.intrinsicSize &&
    input.percentageMargin !== true &&
    input.authoredHorizontalMargin === true &&
    input.authoredSizingIntent === false &&
    input.textAlign.trim().toLowerCase() === "center" &&
    isSymmetricHorizontalMargin(input.marginLeft, input.marginRight)
  );
}

export interface ReaderTopFloatContainmentInput {
  /** 只允许 viewer 的直接子页面级元素进入。 */
  readerTop: boolean;
  /** 必须是浏览器最终计算出的物理方向 float。 */
  float: string;
  /** `.illus` 等整页布局不能被版心补偿改变。 */
  fullpage: boolean;
  parentWidth: number;
  width: number;
  /** 阅读器默认版心的 border-box 上限（通常为 40rem）。 */
  contentWidth: number;
  marginLeft: string;
  marginRight: string;
  /** 作者明确要求全宽/突破版心时保持原布局。 */
  authorFullWidthIntent: boolean;
}

export interface ReaderTopFloatLayoutInput extends ReaderTopFloatContainmentInput {
  /** 作者 margin 来源；undefined 表示无法证明安全级联。 */
  authoredHorizontalMargin: AuthoredHorizontalMarginResult;
  /** true/undefined 都不能安全地重写百分比或未知 margin。 */
  percentageMargin: boolean | undefined;
  position: string;
  writingMode: string;
  direction: string;
}

/**
 * 统一的顶层浮动布局单元门控。
 *
 * 只有物理水平书写、静态/相对定位、有限非负 margin 且没有明确突破
 * 版心意图的单项 float 才能投影到阅读器版心。返回的两侧 margin 是
 * border-box 外侧 margin：浮动侧加上阅读器版心 inset，另一侧保留书值。
 * 百分比、未知级联、负值、绝对定位和非水平书写全部返回 null，由调用方
 * 以原始测量值保留书籍布局，绝不落入 C-04/C-18。
 */
export function getReaderTopFloatLayoutMargins(
  input: ReaderTopFloatLayoutInput
): { left: number; right: number } | null {
  const float = input.float.trim().toLowerCase();
  const position = input.position.trim().toLowerCase();
  const writingMode = input.writingMode.trim().toLowerCase();
  const direction = input.direction.trim().toLowerCase();
  if (
    !input.readerTop ||
    input.fullpage ||
    !/^(?:left|right)$/u.test(float) ||
    !/^(?:static|relative)$/u.test(position) ||
    writingMode !== "horizontal-tb" ||
    direction !== "ltr"
  ) return null;
  if (
    !Number.isFinite(input.parentWidth) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.contentWidth) ||
    input.parentWidth <= 0 ||
    input.width < 0 ||
    input.contentWidth <= 0 ||
    input.width > input.contentWidth + 0.5 ||
    input.authorFullWidthIntent ||
    input.percentageMargin === true
  ) return null;

  // A failed CSSOM probe is intentionally conservative when the element has
  // an actual margin. A zero-margin element does not need the author-source
  // distinction and can still use the legacy C-31 projection.
  const parseMargin = (value: string): number | null => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "auto") return 0;
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const marginLeft = parseMargin(input.marginLeft);
  const marginRight = parseMargin(input.marginRight);
  if (marginLeft === null || marginRight === null || marginLeft < 0 || marginRight < 0) return null;
  if (
    input.authoredHorizontalMargin === undefined &&
    (marginLeft > 0.5 || marginRight > 0.5)
  ) return null;

  const inset = Math.max(
    0,
    (input.parentWidth - Math.min(input.parentWidth, input.contentWidth)) / 2
  );
  const left = float === "left" ? inset + marginLeft : marginLeft;
  const right = float === "right" ? inset + marginRight : marginRight;
  // Never create a new overflow while containing an otherwise valid float.
  if (left + input.width + right > input.parentWidth + 0.5) return null;
  return { left, right };
}

/**
 * L3/L4 浮动页面级元素的版心内缩纯决策门。
 *
 * Chromium 会让没有作者 margin 的顶层 float 直接贴在多栏 viewer 的窗口
 * 边缘；普通 reader-top 则由 L3 auto margin 居中。这里仅给“窄于 40rem、
 * 没有作者水平 margin、也没有全宽意图”的页面级 float 恢复同一版心边缘。
 * 纯函数不触碰 DOM，供 applyBookMargins 与稳定回归测试共同使用。
 */
export function getReaderTopFloatContainmentMargins(
  input: ReaderTopFloatContainmentInput
): { left: number; right: number } | null {
  const epsilon = 0.5;
  const float = input.float.trim().toLowerCase();
  if (!input.readerTop || input.fullpage || !/^(?:left|right)$/u.test(float)) {
    return null;
  }
  if (
    !Number.isFinite(input.parentWidth) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.contentWidth) ||
    input.parentWidth <= 0 ||
    input.width < 0 ||
    input.contentWidth <= 0 ||
    input.width > input.contentWidth + epsilon ||
    input.authorFullWidthIntent
  ) {
    return null;
  }
  const meaningful = (value: string): boolean => {
    if (!value || value.trim().toLowerCase() === "auto") return false;
    const parsed = parseFloat(value);
    // Unknown expressions (`calc`, `var`, env-dependent values) are treated as
    // meaningful so a conservative fallback never overwrites author layout.
    return !Number.isFinite(parsed) || Math.abs(parsed) > epsilon;
  };
  if (meaningful(input.marginLeft) || meaningful(input.marginRight)) return null;

  const inset = Math.max(0, (input.parentWidth - Math.min(input.parentWidth, input.contentWidth)) / 2);
  // Match the physical float side: a right float gets right margin to move its
  // right edge inward; a left float gets left margin to move its left edge in.
  return float === "right" ? { left: 0, right: inset } : { left: inset, right: 0 };
}

/**
 * 只把明确的全宽/突破表达式视为作者意图；`max-width` 本身是上限，不能
 * 证明作者要求突破版心。`min()/max()/clamp()` 混合表达式也不作猜测，
 * 除非它明确包含 viewport 单位（例如 `calc(100vw - 2rem)`）。
 */
export function isAuthorFullWidthValue(
  value: string,
  property: "width" | "max-width" | "min-width"
): boolean {
  const compact = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!compact || compact === "auto" || property === "max-width") return false;
  if (/^100(?:\.0+)?%$/u.test(compact)) return true;
  // A plain calc with a page-relative 100% base is an explicit full-page
  // expression; bounded min/max/clamp forms intentionally do not qualify.
  if (/^calc\(100%[+-]/u.test(compact)) return true;
  // Viewport units express page-relative/full-page intent even when a narrow
  // window makes their current computed width happen to fit inside 40rem.
  return /(?:dvw|svw|lvw|vw|vi|vmin|vmax)(?:$|[^a-z])/u.test(compact);
}

type FullWidthRuleResult = boolean | undefined;

/** 只在当前生效的 author CSSOM 条件分支中寻找明确全宽意图。 */
export function hasAuthoredFullWidthIntentInRules(
  doc: Document,
  el: HTMLElement
): FullWidthRuleResult {
  const win = doc.defaultView;
  const conditionState = (rule: CSSRule): FullWidthRuleResult => {
    const conditional = rule as CSSRule & {
      conditionText?: string;
      media?: { mediaText?: string };
    };
    if (rule.type === 4) {
      const query = conditional.media?.mediaText;
      if (!query || !win || typeof win.matchMedia !== "function") return undefined;
      try {
        return win.matchMedia(query).matches;
      } catch {
        return undefined;
      }
    }
    if (rule.type === 12) {
      const query = conditional.conditionText;
      const css = (win as Window & { CSS?: { supports?: (condition: string) => boolean } }).CSS;
      if (!query || typeof css?.supports !== "function") return undefined;
      try {
        return css.supports(query);
      } catch {
        return undefined;
      }
    }
    return true;
  };

  const walk = (rules: CSSRuleList): FullWidthRuleResult => {
    let unknownCondition = false;
    for (const rule of Array.from(rules)) {
      const active = conditionState(rule);
      if (active === false) continue;
      if (active === undefined) {
        unknownCondition = true;
        continue;
      }
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText === "string" && styleRule.selectorText) {
        try {
          if (
            el.matches(styleRule.selectorText) &&
            (["width", "max-width", "min-width"] as const).some((property) =>
              isAuthorFullWidthValue(styleRule.style.getPropertyValue(property), property)
            )
          ) {
            return true;
          }
        } catch {
          /* 复杂选择器匹配失败时继续扫描其他规则。 */
        }
      }
      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules) {
          const nestedResult = walk(nested.cssRules);
          if (nestedResult === true) return true;
          if (nestedResult === undefined) unknownCondition = true;
        }
      } catch {
        // 对无法识别的条件/规则保守不推断，调用方会跳过本次补偿。
        unknownCondition = true;
      }
    }
    return unknownCondition ? undefined : false;
  };
  let unknownSheet = false;
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = sheet.ownerNode as Element | null;
    // Reader-injected overrides contain the L3 max-width rules themselves;
    // they are not author intent and must not veto this compatibility fix.
    const readerMarker = owner?.getAttribute?.("data-reader");
    if (owner?.hasAttribute?.("data-reader") || readerMarker != null) {
      continue;
    }
    try {
      const result = walk(sheet.cssRules);
      if (result === true) return true;
      if (result === undefined) unknownSheet = true;
    } catch {
      // An unreadable author sheet is an unknown source; do not infer intent.
      unknownSheet = true;
    }
  }
  return unknownSheet ? undefined : false;
}

function hasAuthorFullWidthIntent(doc: Document, el: HTMLElement): boolean {
  const inline = el.style;
  if (
    (["width", "max-width", "min-width"] as const).some((property) =>
      isAuthorFullWidthValue(inline.getPropertyValue(property), property)
    )
  ) {
    return true;
  }
  // Unknown author CSS conditions are treated as intent for this gate: the
  // layout fix must not overwrite a rule whose full-width meaning we cannot
  // reliably determine in the current engine.
  return hasAuthoredFullWidthIntentInRules(doc, el) !== false;
}

interface InlineStyleValue {
  value: string;
  priority: string;
}

function snapshotInlineStyleProperty(
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

/** 书籍常用全角空格/NBSP 把行内色块补到指定视觉列，不应继续参与行尾悬挂空白。 */
export function hasTrailingManualPaddingWhitespace(text: string): boolean {
  // 允许全角/NBSP 后再跟少量普通空格（EPUB 编辑器常混用），但必须
  // 至少出现一个不可折叠宽空白，避免把普通英文行尾空格误判为视觉补齐。
  return /[\u3000\u00a0 ]*[\u3000\u00a0][\u3000\u00a0 ]*$/u.test(text);
}

type InlineBoxVisualStyle = Pick<
  CSSStyleDeclaration,
  | "backgroundColor"
  | "borderLeftStyle"
  | "borderRightStyle"
  | "borderLeftWidth"
  | "borderRightWidth"
  | "paddingLeft"
  | "paddingRight"
>;

/** 是否存在足以让行尾空白具备视觉意义的盒子外观。 */
export function hasVisibleInlineBox(style: InlineBoxVisualStyle): boolean {
  const background = style.backgroundColor.trim().toLowerCase();
  const transparentBackground =
    background === "" ||
    background === "transparent" ||
    /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/u.test(background);
  const hasBorder =
    (style.borderLeftStyle !== "none" && (parseFloat(style.borderLeftWidth) || 0) > 0) ||
    (style.borderRightStyle !== "none" && (parseFloat(style.borderRightWidth) || 0) > 0);
  const hasPadding =
    (parseFloat(style.paddingLeft) || 0) > 0 || (parseFloat(style.paddingRight) || 0) > 0;
  return !transparentBackground || hasBorder || hasPadding;
}

/**
 * 行内盒原子化的纯决策门控。实际 DOM 写回前后都必须通过它：初始条件
 * 防止普通文字被处理，after 条件防止 inline-block 自身仍然越界时留下坏写回。
 */
export function shouldApplyInlineBoxOverflowFix({
  display,
  trailingPaddingWhitespace,
  visibleBox,
  textAlign,
  rectRight,
  containerRight,
  fixedRectRight,
  fixedWidth,
  containerWidth,
}: {
  display: string;
  trailingPaddingWhitespace: boolean;
  visibleBox: boolean;
  textAlign: string;
  rectRight: number;
  containerRight: number;
  fixedRectRight: number;
  fixedWidth: number;
  containerWidth: number;
}): boolean {
  const epsilon = 0.5;
  // `end` is direction-dependent (RTL ends on the left).  This compensation
  // is deliberately conservative until the line direction is part of the
  // geometry contract, so only an explicit physical right alignment qualifies.
  const rightAligned = textAlign.trim().toLowerCase() === "right";
  return (
    display === "inline" &&
    trailingPaddingWhitespace &&
    visibleBox &&
    rightAligned &&
    Number.isFinite(rectRight) &&
    Number.isFinite(containerRight) &&
    rectRight > containerRight + epsilon &&
    Number.isFinite(fixedRectRight) &&
    Number.isFinite(fixedWidth) &&
    Number.isFinite(containerWidth) &&
    fixedRectRight <= containerRight + epsilon &&
    fixedWidth <= containerWidth + epsilon
  );
}

export class ChapterPaginator {
  private blobUrl?: string;
  /** sanitize 本章外链 CSS 产生的局部 Blob URL；不包含 ResourceServer 共享资源。 */
  private chapterCssUrls = new OwnedBlobUrls();
  /** 尚未提交给 iframe 的 sanitize 任务；换章时也必须取消其 URL 所有权。 */
  private pendingCssUrls = new Set<OwnedBlobUrls>();
  private viewer: HTMLElement | null = null;
  private contentDoc: Document | null = null;
  private step = 0;
  private pageWidth = 0;
  /** 最近一次完整 measure 使用的 iframe 视口；过滤 ResizeObserver 空转。 */
  private measuredViewport = { width: -1, height: -1 };
  private metrics = { pageCount: 1, currentPage: 0 };
  private loadSeq = 0;
  private disposed = false;
  /** Each measure owns its controller; lifecycle aborts all without cross-killing. */
  private measureControllers = new Set<AbortController>();
  private reflowTimer: number | undefined;
  private imgHandler = (): void => this.scheduleReflow();
  private linkHandler = (e: Event): void => this.handleLinkClick(e);
  private wheelHandler = (e: WheelEvent): void => this.handleWheel(e);
  private wheelAcc = 0;
  private keyHandler = (e: KeyboardEvent): void => this.handleKey(e);
  private footnoteHoverInHandler = (e: Event): void => this.handleFootnoteHoverIn(e);
  private footnoteHoverOutHandler = (e: MouseEvent): void => this.handleFootnoteHoverOut(e);
  private pendingAnchor: string | undefined;
  private pendingFallbackPage: number | null = null;
  /** Built once after current chapter layout is stable; never spans documents. */
  private textIndex: VisibleTextIndex | null = null;
  private notes: ReaderNoteForPaginator[] = [];
  private selectionContextMenuHandler?: (payload: SelectionContextPayload | null) => void;
  private contextMenuHandler = (e: MouseEvent): void => this.handleContextMenu(e);
  private selectionChangeHandler = (): void => this.handleSelectionChange();
  private selectionContextMenuOpen = false;
  /** 本次加载需要“停在最后一页且翻好页再显示”（回翻上一章防闪页） */
  private pendingStartAtEnd = false;
  private lastState: ChapterState = { status: "loading" };
  /** 最终 display-ready（而非中途 status=ready）结果，供预加载槽位等待。 */
  private displayReadySeq = -1;
  private displayReadyResult = false;
  private displayReadyPromise: Promise<boolean> = Promise.resolve(false);
  private resolveDisplayReady: ((ready: boolean) => void) | null = null;
  private recomputeRetries = 0;
  /** reflow 序号：丢弃过期测量结果，防快速缩放时旧布局覆盖新布局 */
  private reflowSeq = 0;
  /** 最近点击的脚注标记元素（供弹层随重排重新定位） */
  private lastFootnoteEl: HTMLElement | null = null;
  /** 当前脚注是否被点击固定（固定时不随 hover 移出关闭） */
  private footnotePinned = false;
  /** iframe 标记与宿主弹层共享的短暂 hover 交接窗口。 */
  private footnoteHoverGate: FootnoteHoverGate;
  /** 第二遍 margin 处理写回过的元素与原始 inline 值（下次测量前恢复） */
  private marginFixes: Array<{
    el: HTMLElement;
    left: InlineStyleValue;
    right: InlineStyleValue;
    maxWidth?: InlineStyleValue;
  }> = [];
  /** fit-content 补偿写回过的元素与原始 inline max-width（下次测量前恢复） */
  private fitContentFixes: Array<{ el: HTMLElement; maxWidth: string }> = [];
  /** float 收缩补偿写回过的元素（下次测量前清除 width） */
  private floatFixes: HTMLElement[] = [];
  /**
   * 顶层浮动布局单元的完整事务快照。与 C-08 的 width 补偿分离，确保
   * margin/max-width/priority 和 marker 在重排、换章、异常路径都可恢复。
   */
  private floatLayoutFixes: Array<{
    el: HTMLElement;
    left: InlineStyleValue;
    right: InlineStyleValue;
    width: InlineStyleValue;
    maxWidth: InlineStyleValue;
  }> = [];
  /** 末尾媒体 float 的临时负 margin-top 写回（每轮测量前恢复）。 */
  private trailingFloatFixes: Array<{ el: HTMLElement; marginTop: InlineStyleValue }> = [];
  /** 行尾悬挂空白导致越过 computed-right 包含块的可见行内盒写回。 */
  private inlineBoxFixes: Array<{
    el: HTMLElement;
    display: InlineStyleValue;
    textIndent: InlineStyleValue;
  }> = [];
  /** 首次布局显示门；token 与 loadSeq 一致，旧章不能揭示新章。 */
  private displayGate: VisibilityGate;

  /** 阅读位置锚点：中心只是采样坐标，不参与任何分页样式或结构。 */
  private anchor: ReadingAnchor | null = null;
  private anchorPath: string | undefined;

  constructor(
    private iframe: HTMLIFrameElement,
    private server: ResourceServer,
    private settings: ReaderSettings,
    private strictXml: boolean,
    private onState: (s: ChapterState) => void,
    private onIssues?: (issues: string[]) => void,
    /** 固定版式书：不做行宽自适应，整页显示 */
    private fixedLayout = false,
    /** 书内链接点击回调（已解析为书内路径，含可选锚点），供阅读器跳转 */
    private onNavigate?: (href: string) => void,
    /** 有效书内链接真正改变位置前通知 UI 记录一次可撤销快照。 */
    private onBeforeInternalNavigate?: (href: string) => void,
    /** 不需要重载章节的同章锚点跳转已同步完成。 */
    private onInternalNavigationSettled?: () => void,
    /** 滚轮翻页回调（累积阈值后触发，1=下一页 -1=上一页） */
    private onWheelNavigate?: (dir: 1 | -1) => void,
    /** 键盘翻页回调（焦点在书页内时也有效） */
    private onKeyNavigate?: (dir: 1 | -1) => void,
    /** 脚注弹层回调（含文本/HTML/固定状态），由阅读器 UI 显示 */
    private onFootnote?: (payload: FootnotePayload) => void,
    /** 桌面端 hover 离开脚注标记时关闭弹层（移动端无 hover，弹层由点击/✕ 关闭） */
    private onFootnoteClose?: () => void,
    /** 外部链接（http/https/mailto/tel）点击回调，由 App 层调系统默认浏览器打开 */
    private onExternalLink?: (url: string) => void,
    /** 首次测量、分页与最终入口定位全部完成，iframe 已可安全交互。 */
    private onDisplayReady?: () => void,
    /** 有效正文选区的现代右键菜单数据；通过 setter 可保持最新 UI 回调。 */
    onSelectionContextMenu?: (payload: SelectionContextPayload | null) => void
  ) {
    this.selectionContextMenuHandler = onSelectionContextMenu;
    this.displayGate = new VisibilityGate(this.iframe, {
      timeoutMs: INITIAL_RENDER_GATE_TIMEOUT_MS,
    });
    this.footnoteHoverGate = new FootnoteHoverGate(() => this.onFootnoteClose?.());
  }

  setSelectionContextMenuHandler(handler?: (payload: SelectionContextPayload | null) => void): void {
    this.selectionContextMenuHandler = handler;
  }

  /** 清除 iframe 内原生文本选区（关闭选区菜单或进入笔记编辑时使用）。 */
  clearTextSelection(): void {
    this.selectionContextMenuOpen = false;
    this.contentDoc?.getSelection()?.removeAllRanges();
    this.selectionContextMenuHandler?.(null);
  }

  /** 更新当前书籍笔记；只刷新当前章节的 Highlight，不触发重排或重新测量。 */
  setNotes(notes: ReaderNoteForPaginator[]): "applied" | "unsupported" | "deferred" {
    this.notes = notes.slice();
    if (!this.contentDoc || !this.viewer || !this.textIndex) return "deferred";
    return this.applyNoteHighlights();
  }

  /** 加载一章。path 为规范化内部路径。 */
  async load(path: string, opts: LoadOptions = {}): Promise<void> {
    this.abortMeasureWaits();
    const seq = ++this.loadSeq;
    this.displayReadySeq = -1;
    this.displayReadyResult = false;
    this.resolveDisplayReady?.(false);
    this.displayReadyPromise = new Promise<boolean>((resolve) => {
      this.resolveDisplayReady = resolve;
    });
    this.disposed = false;
    this.recomputeRetries = 0;
    // 换章加载：丢弃旧锚点与旧页号（页号只对同章重排有意义，
    // 否则新章会沿袭上一章的页号，如"上一章13页→下一章也跳到第13页"）。
    // 目录里点击当前章（同章 + resetPage）：同样从开头/锚点重新开始。
    if (path !== this._currentPath || opts.resetPage) {
      this.anchor = null;
      this.anchorPath = undefined;
      this.metrics.currentPage = 0;
    }
    if (opts.readingAnchor) {
      this.setReadingAnchor({ path, ...opts.readingAnchor });
    }
    this._currentPath = path;
    this.pendingAnchor = opts.anchor;
    this.pendingStartAtEnd = opts.startAtEnd === true;
    // blob 文档可能在下一个绘制帧立刻出现；先隐藏整个 iframe，既保留
    // 布局测量，又避免普通入口先显示二阶段补偿前的中间位置。
    this.displayGate.hold(seq);
    this.emit({ status: "loading" });
    this.iframe.removeEventListener("load", this.onIframeLoad);
    this.cleanupDoc();
    this.pendingFallbackPage =
      typeof opts.fallbackPage === "number" && Number.isSafeInteger(opts.fallbackPage) && opts.fallbackPage >= 0
        ? opts.fallbackPage
        : null;
    this.iframe.src = "about:blank";

    const htmlText = this.server.textFor(path);
    if (htmlText === undefined) {
      this.emit({ status: "error", message: `章节资源缺失：${path}` });
      this.finishDisplayReady(seq, false);
      this.displayGate.release(seq);
      return;
    }

    // CSS Blob URL 的所有权只在本次 sanitize/load 内；提交 iframe 前仍属于
    // 局部任务，任何过期/异常路径都必须在这里回收。
    const ownedCssUrls = new OwnedBlobUrls();
    this.pendingCssUrls.add(ownedCssUrls);
    let sanitized;
    try {
      sanitized = await sanitizeChapter(htmlText, {
        basePath: path,
        strictXml: this.strictXml,
        urlFor: (p) => this.server.urlFor(p),
        getText: (p) => this.server.textFor(p),
        makeUrl: (text, mediaType) =>
          ownedCssUrls.add(URL.createObjectURL(new Blob([text], { type: mediaType }))),
        settings: this.settings,
      });
    } catch (e) {
      this.pendingCssUrls.delete(ownedCssUrls);
      ownedCssUrls.revokeAll();
      if (seq === this.loadSeq) {
        this.emit({ status: "error", message: `章节渲染失败：${(e as Error).message}` });
        this.finishDisplayReady(seq, false);
        this.displayGate.release(seq);
      }
      return;
    }
    if (seq !== this.loadSeq || this.disposed) {
      this.pendingCssUrls.delete(ownedCssUrls);
      ownedCssUrls.revokeAll();
      return;
    }
    let nextBlobUrl: string | undefined;
    try {
      nextBlobUrl = URL.createObjectURL(
        new Blob([sanitized.html], { type: "text/html; charset=utf-8" })
      );
      // iframe.src 提交是本次局部 CSS URL 转为当前章节所有权的边界。
      this.pendingCssUrls.delete(ownedCssUrls);
      this.chapterCssUrls = ownedCssUrls;
      this.blobUrl = nextBlobUrl;
      this.iframe.addEventListener("load", this.onIframeLoad);
      this.iframe.src = nextBlobUrl;
      if (sanitized.issues.length > 0) this.onIssues?.(sanitized.issues);
    } catch (e) {
      this.pendingCssUrls.delete(ownedCssUrls);
      ownedCssUrls.revokeAll();
      if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
      this.iframe.removeEventListener("load", this.onIframeLoad);
      if (this.blobUrl === nextBlobUrl) this.blobUrl = undefined;
      if (this.chapterCssUrls === ownedCssUrls) this.chapterCssUrls = new OwnedBlobUrls();
      if (seq === this.loadSeq && !this.disposed) {
        this.emit({ status: "error", message: `章节渲染失败：${(e as Error).message}` });
        this.finishDisplayReady(seq, false);
        this.displayGate.release(seq);
      }
      return;
    }
    // sanitize 较慢或快速换章时重新计算兜底时间；原 visibility 快照保持不变。
    this.displayGate.hold(seq);
  }

  private onIframeLoad = (): void => {
    const seq = this.loadSeq;
    if (!this.blobUrl || !this.iframe.src.startsWith("blob:")) return; // 忽略 about:blank 的 load
    const doc = this.iframe.contentDocument;
    if (!doc) {
      this.emit({ status: "error", message: "无法访问章节内容" });
      this.finishDisplayReady(seq, false);
      this.displayGate.release(seq);
      return;
    }
    this.contentDoc = doc;
    const viewer = doc.getElementById(VIEWER_ID);
    if (!viewer) {
      this.emit({ status: "error", message: "章节缺少阅读器容器" });
      this.finishDisplayReady(seq, false);
      this.displayGate.release(seq);
      return;
    }
    this.viewer = viewer;
    const atEnd = this.pendingStartAtEnd;
    // 从真实 iframe load 重新开始兜底计时。显示门挂在 iframe 而非 viewer，
    // 可保证 blob 文档的第一帧也不会漏出，同时 visibility:hidden 仍可测量。
    this.displayGate.hold(seq);
    this.emit({ status: "measuring" });
    if (this.settings.theme === "dark") {
      try {
        applyDarkThemeContrast(doc, { theme: this.settings.theme });
      } catch {
        // Contrast repair is conservative and must never block chapter display.
      }
    }
    doc.addEventListener("load", this.imgHandler, true);
    // 拦截书内链接：防止 iframe 自身导航导致内容丢失
    doc.addEventListener("click", this.linkHandler, true);
    // 固定脚注：点击正文空白处关闭（标记点击由 linkHandler 处理）
    doc.addEventListener("click", this.handleDocClick, true);
    // 桌面 hover 弹注（script.js 的鼠标行为）；移动端无 hover，走 click/touch
    doc.addEventListener("mouseover", this.footnoteHoverInHandler, true);
    doc.addEventListener("mouseout", this.footnoteHoverOutHandler, true);
    // 滚轮翻页（内容不可滚动，事件冒泡到文档即可捕获）
    doc.addEventListener("wheel", this.wheelHandler, { passive: false });
    // 键盘翻页：焦点在书页内时，方向键事件不会冒泡到主窗口，需在此监听
    doc.addEventListener("keydown", this.keyHandler);
    // 阅读器内始终屏蔽浏览器原生右键菜单；只有有效正文选区才回调 UI。
    doc.addEventListener("contextmenu", this.contextMenuHandler);
    doc.addEventListener("selectionchange", this.selectionChangeHandler);
    void this.prepareChapterForDisplay(seq, atEnd)
      .then((prepared) => {
        if (!prepared || seq !== this.loadSeq || this.disposed) {
          if (seq === this.loadSeq && this.disposed === false) this.finishDisplayReady(seq, false);
          return;
        }
        // 先解除显示门，再通知 UI 消费加载期输入；这样缓冲翻页不会在
        // 锚点/章末定位之前执行，也不会依赖中途的 ready 状态事件。
        this.displayGate.release(seq);
        this.finishDisplayReady(seq, true);
        this.onDisplayReady?.();
      })
      .catch((error: unknown) => {
        if (seq === this.loadSeq && !this.disposed) {
          this.emit({
            status: "error",
            message: `章节布局失败：${error instanceof Error ? error.message : String(error)}`,
          });
          this.finishDisplayReady(seq, false);
        }
      })
      .finally(() => this.displayGate.release(seq));
  };

  /**
   * 首次章节 ready 边界：后续预渲染可以复用同一顺序，但本轮仍只准备主 iframe。
   * 返回前已经完成自愈重试与最终入口定位，调用方随后才可揭示内容。
   */
  private async prepareChapterForDisplay(seq: number, atEnd: boolean): Promise<boolean> {
    if (!(await this.measure(seq))) return false;
    if (seq !== this.loadSeq || this.disposed) return false;
    this.rebuildTextIndexForCurrentDoc();
    const ready = await this.recompute(true, seq);
    if (!ready || seq !== this.loadSeq || this.disposed) return false;

    // 目录跳转：最终页数稳定后定位到锚点所在页。
    if (this.pendingAnchor) {
      this.jumpToAnchor(this.pendingAnchor);
      this.pendingAnchor = undefined;
    }
    if (atEnd) {
      this.pendingStartAtEnd = false;
      this.setPage(Math.max(0, this.metrics.pageCount - 1));
    }
    return true;
  }

  /** 最终显示门已解除且入口定位完成。 */
  get isDisplayReady(): boolean {
    return this.displayReadySeq === this.loadSeq && this.displayReadyResult;
  }

  /** 等待当前（或指定代次）章节完成最终 display-ready。 */
  waitForDisplayReady(expectedLoadSeq: number = this.loadSeq): Promise<boolean> {
    if (expectedLoadSeq !== this.loadSeq) return Promise.resolve(false);
    if (this.displayReadySeq === expectedLoadSeq) return Promise.resolve(this.displayReadyResult);
    return this.displayReadyPromise;
  }

  /** 加载并等待最终 display-ready；预加载器不得只等待 iframe load。 */
  async loadAndWaitForDisplay(path: string, opts: LoadOptions = {}): Promise<boolean> {
    const loading = this.load(path, opts);
    const expectedLoadSeq = this.loadSeq;
    await loading;
    return this.waitForDisplayReady(expectedLoadSeq);
  }

  private finishDisplayReady(seq: number, ready: boolean): void {
    if (seq !== this.loadSeq || this.displayReadySeq === seq) return;
    this.displayReadySeq = seq;
    this.displayReadyResult = ready;
    const resolve = this.resolveDisplayReady;
    this.resolveDisplayReady = null;
    resolve?.(ready);
  }

  /** 设置分栏并等待字体就绪后测量（带超时保护：任何一步挂起都不能阻塞 ready）。 */
  private async measure(expectedLoadSeq: number = this.loadSeq): Promise<boolean> {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (
      !doc ||
      !viewer ||
      !isChapterMeasurementCurrent({
        disposed: this.disposed,
        loadSeq: this.loadSeq,
        expectedLoadSeq,
        contentDoc: this.contentDoc,
        expectedDoc: doc,
        viewer: this.viewer,
        expectedViewer: viewer,
      })
    ) {
      return false;
    }
    const measuredWidth = this.iframe.clientWidth;
    const measuredHeight = this.iframe.clientHeight;
    // 第二遍 margin / fit-content 处理写回的 inline 值要先恢复，
    // 避免字号/窗口变化后按旧值布局
    this.restoreInlineBoxFixes();
    this.restoreFloatLayoutFixes();
    this.restoreBookMargins();
    this.restoreFitContentFix();
    this.restoreFloatWidths();
    this.restoreTrailingFloatFixes();
    const parent = viewer.parentElement;
    const parentCs = parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
    const baseW = parent?.clientWidth || this.iframe.clientWidth || viewer.clientWidth;
    // 书可能声明 body padding（如 LK 的 0 5px），分页宽度要用内容区宽度，
    // 否则 viewer 会溢出 body 右侧，出现横向滚动条。
    const pageW = Math.max(
      0,
      baseW -
        (parseFloat(parentCs?.paddingLeft ?? "") || 0) -
        (parseFloat(parentCs?.paddingRight ?? "") || 0)
    );
    const em = this.settings.fontSizePx;
    // 容器全宽：正文版心由注入 CSS 的 em 上限居中控制，
    // 全页图块（.illus 等）豁免限制、占满整页
    const w = pageW;
    // 纯图片页（封面/插图，无文字）：不加上下留白，整页显示
    const hasText = (viewer.textContent ?? "").trim().length > 0;
    const hasImg = viewer.querySelector("img") !== null;
    const gap = this.settings.gapPx;
    this.pageWidth = w;
    this.step = w + gap;
    viewer.style.width = `${w}px`;
    if (this.fixedLayout || (!hasText && hasImg)) {
      viewer.style.paddingTop = "0px";
      viewer.style.paddingBottom = "0px";
    } else {
      viewer.style.paddingTop = `${TEXT_MEASURE.vTopEm * em}px`;
      viewer.style.paddingBottom = `${TEXT_MEASURE.vBottomEm * em}px`;
    }
    viewer.style.columnWidth = `${w}px`;
    viewer.style.columnGap = `${gap}px`;
    viewer.style.columnFill = "auto";
    viewer.style.height = "100%";
    // 同步回流一次，确保 scrollWidth 反映新布局
    void viewer.scrollWidth;
    const waitController = new AbortController();
    this.measureControllers.add(waitController);
    try {
      // fonts.ready 极端情况下可能挂起（字体请求异常），5s 超时兜底
      const fonts = await waitForFontsReady(doc.fonts?.ready ?? Promise.resolve(), {
        signal: waitController.signal,
        timeoutMs: 5000,
      });
      if (fonts === "aborted") return false;
      if (
        !isChapterMeasurementCurrent({
          disposed: this.disposed,
          loadSeq: this.loadSeq,
          expectedLoadSeq,
          contentDoc: this.contentDoc,
          expectedDoc: doc,
          viewer: this.viewer,
          expectedViewer: viewer,
        })
      ) {
        return false;
      }
      // 布局稳定后再读一次（rAF 同样加超时兜底）
      const frames = await waitForDoubleRaf({
        signal: waitController.signal,
        timeoutMs: 2000,
        requestAnimationFrame: doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView),
        cancelAnimationFrame: doc.defaultView?.cancelAnimationFrame?.bind(doc.defaultView),
      });
      if (frames === "aborted") return false;
      if (
        !isChapterMeasurementCurrent({
          disposed: this.disposed,
          loadSeq: this.loadSeq,
          expectedLoadSeq,
          contentDoc: this.contentDoc,
          expectedDoc: doc,
          viewer: this.viewer,
          expectedViewer: viewer,
        })
      ) {
        return false;
      }
      // [L5-C18] fit-content 会改变最终 border-box 宽度，必须先稳定宽度再计算
      // 页面级 margin；反过来会把多栏中的异常旧宽度固化成错误横向位置。
      this.applyFitContentFix();
      this.applyBookMargins();
      this.applyFloatShrinkFix();
      this.applyTrailingFloatMarginFix();
      this.applyInlineBoxOverflowFix();
      // 只在整轮测量与二阶段补偿完成后提交尺寸；若测量期间窗口又变化，
      // ResizeObserver 仍会发现新尺寸并发起下一轮。
      this.measuredViewport = { width: measuredWidth, height: measuredHeight };
      return isChapterMeasurementCurrent({
        disposed: this.disposed,
        loadSeq: this.loadSeq,
        expectedLoadSeq,
        contentDoc: this.contentDoc,
        expectedDoc: doc,
        viewer: this.viewer,
        expectedViewer: viewer,
      });
    } finally {
      this.measureControllers.delete(waitController);
      waitController.abort();
    }
  }

  /** 恢复上一轮 margin 后处理写回的 inline 值。 */
  private restoreBookMargins(): void {
    for (const fix of this.marginFixes) {
      fix.el.removeAttribute("data-reader-margin-fixed");
      restoreInlineStyleProperty(fix.el.style, "margin-left", fix.left);
      restoreInlineStyleProperty(fix.el.style, "margin-right", fix.right);
      if (fix.maxWidth) {
        restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
      }
    }
    this.marginFixes = [];
  }

  /**
   * 第二遍 margin 处理（C-04）：
   * 先让阅读器默认居中规则渲染（第一遍已发生），再检查页面直接子元素
   * 在“纯书 CSS”下是否有非零左右 margin；有则写回书的真实 margin，
   * 否则保持阅读器默认居中。书的通用 reset（div{margin:0}）得到的是 0，
   * 不会进入写回，因此不会被误判为具体布局。
   */
  private applyBookMargins(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
    // applyFitContentFix 先于本阶段执行；记录原始 fit-content 意图，避免
    // inline 40rem 写回后丢失“无 margin 时左对齐正文列”的既有语义。
    const fitContentElements = new Set(this.fitContentFixes.map((fix) => fix.el));

    const readerSheet = Array.from(doc.styleSheets).find(
      (s) => (s.ownerNode as Element | null)?.getAttribute?.("data-reader") === "overrides"
    );
    const candidates = Array.from(viewer.children).filter(
      (c): c is HTMLElement =>
        c.nodeType === 1 &&
        !c.classList.contains("illus") &&
        !c.classList.contains("kuchie") &&
        !c.classList.contains("cover") &&
        !c.classList.contains("duokan-image-fullscreen")
    );
    if (candidates.length === 0) return;
    const candidateSet = new Set(candidates);

    // 先暂时移除 L3 auto margin，再读取“作者/用户最终获胜的级联”。
    // getComputedStyle 会把百分比解析成 px，必须优先用 Typed OM 保留
    // 70% / calc(...%) 这类指定值；旧 WebView 才回退到 CSSOM 扫描。
    // 注意：多栏里元素若跨列碎片，getBoundingClientRect().width 会把碎片
    // 并成一个超宽矩形，必须用 computed width。
    const widths = new Map<HTMLElement, number>();
    const maxWidths = new Map<HTMLElement, string>();
    const percentageMargins = new Map<
      HTMLElement,
      {
        percentage: boolean | undefined;
        maxWidth?: InlineStyleValue;
        relaxedReaderMaxWidth: boolean;
      }
    >();
    const authoredHorizontalMargins = new Map<HTMLElement, AuthoredHorizontalMarginResult>();
    const authoredSizingIntents = new Map<HTMLElement, AuthoredSizingIntentResult>();
    const restoreReaderMargins = readerSheet
      ? this.disableReaderTopMarginRules(readerSheet)
      : () => {};
    try {
      for (const el of candidates) {
        void el.offsetWidth;
        let cs = win.getComputedStyle(el);
        maxWidths.set(el, cs.maxWidth);

        const typedPercentage = hasComputedPercentageHorizontalMargin(el);
        const percentage =
          typedPercentage ??
          (hasPercentageHorizontalMargin(el.style) ||
            hasPercentageHorizontalMarginInRules(doc, el));
        const marginProbe: {
          percentage: boolean | undefined;
          maxWidth?: InlineStyleValue;
          relaxedReaderMaxWidth: boolean;
        } = { percentage, relaxedReaderMaxWidth: false };

        // 水平百分比 margin 是相对包含块的页面布局。若作者没有自己的 inline
        // max-width，暂时解除 L3 的 40rem 默认值，才能读到作者原本的剩余宽度。
        if (percentage === true) {
          const maxWidth = snapshotInlineStyleProperty(el.style, "max-width");
          const relaxedReaderMaxWidth = maxWidth.value === "";
          marginProbe.maxWidth = maxWidth;
          marginProbe.relaxedReaderMaxWidth = relaxedReaderMaxWidth;
          if (relaxedReaderMaxWidth) {
            el.style.setProperty("max-width", "none");
            void el.offsetWidth;
            cs = win.getComputedStyle(el);
          }
        }
        // The source probe walks CSSOM. C-16 percentage margins return before
        // C-37/C-04, so only non-percentage candidates with an actual margin
        // can reach that branch. Zero/auto direct children intentionally
        // avoid an O(children × rules) scan here.
        if (shouldProbeAuthoredHorizontalMargin(percentage, cs.marginLeft, cs.marginRight)) {
          // Run while the L3 auto rules are removed. This distinguishes a UA
          // default (for example blockquote's 40px/40px) from an actual book
          // or customCss declaration before C-04 sees resolved px margins.
          authoredHorizontalMargins.set(el, hasAuthoredHorizontalMargin(doc, el));
          if (
            cs.textAlign.trim().toLowerCase() === "center" &&
            isSymmetricHorizontalMargin(cs.marginLeft, cs.marginRight)
          ) {
            // Fixed/unknown sizing intent must keep the conservative C-04 path;
            // only a definite absence can authorize the C-40 natural-centering
            // exemption below.
            authoredSizingIntents.set(el, hasAuthoredSizingIntent(doc, el));
          }
        }
        percentageMargins.set(el, marginProbe);

        const borderBoxW = getBorderBoxWidth(cs);
        widths.set(el, borderBoxW > 0 ? borderBoxW : el.getBoundingClientRect().width);
      }

      const preserveFloatLayout = (el: HTMLElement, leftValue: string, rightValue: string): void => {
        const toPx = (value: string): string => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? `${parsed}px` : "0px";
        };
        this.floatLayoutFixes.push({
          el,
          left: snapshotInlineStyleProperty(el.style, "margin-left"),
          right: snapshotInlineStyleProperty(el.style, "margin-right"),
          width: snapshotInlineStyleProperty(el.style, "width"),
          maxWidth: snapshotInlineStyleProperty(el.style, "max-width"),
        });
        el.setAttribute("data-reader-float-layout-fixed", "1");
        el.style.setProperty("margin-left", toPx(leftValue), "important");
        el.style.setProperty("margin-right", toPx(rightValue), "important");
      };

      // C-31 must inspect the complete direct-child sequence rather than the
      // filtered candidate list: an excluded fullscreen element or any normal
      // block between two floats is a real sibling boundary and must end the
      // percentage grid group.
      const groupEntries: PercentageFloatGroupEntry[] = Array.from(viewer.children).map((child) => {
        const el = child as HTMLElement;
        const cs = win.getComputedStyle(el);
        const fullpage =
          el.classList.contains("illus") ||
          el.classList.contains("kuchie") ||
          el.classList.contains("cover") ||
          el.classList.contains("duokan-image-fullscreen");
        const eligible = candidateSet.has(el) && !fullpage;
        return {
          eligible,
          readerTop: el.classList.contains("reader-top"),
          float: cs.float,
          clear: cs.clear,
          percentageWidth:
            eligible && /^(?:left|right)$/u.test(cs.float.trim().toLowerCase())
              ? getAuthoredPercentageWidth(el, doc)
              : null,
          marginLeft: cs.marginLeft,
          marginRight: cs.marginRight,
          position: cs.position,
          writingMode: cs.writingMode,
          direction: cs.direction,
          authorFullWidthIntent: eligible ? hasAuthorFullWidthIntent(doc, el) : false,
          percentageMargin: percentageMargins.get(el)?.percentage,
        };
      });
      const percentageFloatGroupMembers = new Set<HTMLElement>();
      getPercentageFloatGroupMembers(groupEntries).forEach((member, index) => {
        if (member) percentageFloatGroupMembers.add(viewer.children[index] as HTMLElement);
      });
      const safePercentageFloatGroupMembers = new Set<HTMLElement>();
      getSafePercentageFloatGroupMembers(groupEntries).forEach((member, index) => {
        if (member) safePercentageFloatGroupMembers.add(viewer.children[index] as HTMLElement);
      });

      // Stage 2: process each safe complete percentage group as one layout
      // unit. No wrapper is inserted; only existing direct children receive
      // temporary inline width/margin declarations.
      const groupEntriesByElement = new Map<HTMLElement, PercentageFloatGroupEntry>();
      groupEntries.forEach((entry, index) => {
        groupEntriesByElement.set(viewer.children[index] as HTMLElement, entry);
      });
      const children = Array.from(viewer.children) as HTMLElement[];
      let groupIndex = 0;
      while (groupIndex < children.length) {
        const first = children[groupIndex];
        if (!percentageFloatGroupMembers.has(first)) {
          groupIndex += 1;
          continue;
        }
        const members: HTMLElement[] = [];
        while (
          groupIndex < children.length &&
          percentageFloatGroupMembers.has(children[groupIndex])
        ) {
          members.push(children[groupIndex++]);
        }
        if (!members.every((member) => safePercentageFloatGroupMembers.has(member))) continue;

        const firstEntry = groupEntriesByElement.get(members[0]);
        if (!firstEntry) continue;
        const parent = members[0].parentElement;
        const parentCs = parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
        const parentW =
          (parent?.clientWidth ?? viewer.clientWidth) -
          (parseFloat(parentCs?.paddingLeft ?? "") || 0) -
          (parseFloat(parentCs?.paddingRight ?? "") || 0);
        const contentWidth = TEXT_MEASURE.maxEm * this.settings.fontSizePx;
        const targetWidths = getPercentageFloatGroupTargetWidths(
          members.map((member) => groupEntriesByElement.get(member)?.percentageWidth ?? NaN),
          parentW,
          contentWidth
        );
        if (!targetWidths) continue;
        const inset = Math.max(0, (parentW - Math.min(parentW, contentWidth)) / 2);
        const originalMargins = members.map((member) => {
          const cs = win.getComputedStyle(member);
          return { left: cs.marginLeft, right: cs.marginRight };
        });
        const snapshotStart = this.floatLayoutFixes.length;
        const floatDirection = firstEntry.float.trim().toLowerCase();
        members.forEach((member, index) => {
          const snapshot = {
            el: member,
            left: snapshotInlineStyleProperty(member.style, "margin-left"),
            right: snapshotInlineStyleProperty(member.style, "margin-right"),
            width: snapshotInlineStyleProperty(member.style, "width"),
            maxWidth: snapshotInlineStyleProperty(member.style, "max-width"),
          };
          this.floatLayoutFixes.push(snapshot);
          member.setAttribute("data-reader-float-layout-fixed", "1");
          member.style.setProperty("width", `${targetWidths[index]}px`, "important");
          const sideInset = index === 0 ? inset : 0;
          member.style.setProperty(
            "margin-left",
            `${floatDirection === "left" ? sideInset : 0}px`,
            "important"
          );
          member.style.setProperty(
            "margin-right",
            `${floatDirection === "right" ? sideInset : 0}px`,
            "important"
          );
        });
        void viewer.offsetWidth;
        const viewerRect = viewer.getBoundingClientRect();
        const rects = members.map((member) =>
          Array.from(member.getClientRects()).map((rect) => ({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          }))
        );
        const validGeometry = isPercentageFloatGroupGeometryValid({
          rects,
          viewerLeft: viewerRect.left,
          scrollLeft: viewer.scrollLeft,
          step: this.step,
          parentWidth: parentW,
          contentWidth,
        });
        if (!validGeometry) {
          for (let index = snapshotStart; index < this.floatLayoutFixes.length; index += 1) {
            const fix = this.floatLayoutFixes[index];
            fix.el.removeAttribute("data-reader-float-layout-fixed");
            restoreInlineStyleProperty(fix.el.style, "margin-left", fix.left);
            restoreInlineStyleProperty(fix.el.style, "margin-right", fix.right);
            restoreInlineStyleProperty(fix.el.style, "width", fix.width);
            restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
          }
          this.floatLayoutFixes.splice(snapshotStart);
          // Keep the Stage 1 firewall in place after a failed group trial.
          members.forEach((member, index) =>
            preserveFloatLayout(member, originalMargins[index].left, originalMargins[index].right)
          );
        }
      }

      for (const el of candidates) {
        // 同一测量周期内已修正过则跳过，避免把上次写回的 margin
        // 再当成书 margin 叠加一次（导致 namebox 732/-32 这类错误）。
        if (
          el.hasAttribute("data-reader-margin-fixed") ||
          el.hasAttribute("data-reader-float-layout-fixed")
        ) continue;
        void el.offsetWidth;
        const cs = win.getComputedStyle(el);
        const left = cs.marginLeft;
        const right = cs.marginRight;
        const parent = el.parentElement;
        const parentCs = parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
        const parentW =
          (parent?.clientWidth ?? viewer.clientWidth) -
          (parseFloat(parentCs?.paddingLeft ?? "") || 0) -
          (parseFloat(parentCs?.paddingRight ?? "") || 0);
        const width = widths.get(el) ?? el.getBoundingClientRect().width;
        const meaningful = isMeaningfulHorizontalMargin;
        const originalMaxWidth = maxWidths.get(el) ?? "";
        const hadFitContent =
          fitContentElements.has(el) || /(?:fit-content|max-content)/.test(originalMaxWidth);
        const percentage = percentageMargins.get(el);
        const fullpage =
          el.classList.contains("illus") ||
          el.classList.contains("kuchie") ||
          el.classList.contains("cover") ||
          el.classList.contains("duokan-image-fullscreen");
        const isTopFloat =
          el.classList.contains("reader-top") && /^(?:left|right)$/u.test(cs.float.trim().toLowerCase());


        // Float is a separate layout unit. It must never fall through to the
        // ordinary block margin compensator, even when a conservative gate
        // decides that the original book geometry cannot be projected.
        if (isTopFloat) {
          const floatGroupMember = percentageFloatGroupMembers.has(el);
          const floatMargins = floatGroupMember
            ? null
            : getReaderTopFloatLayoutMargins({
                readerTop: true,
                float: cs.float,
                fullpage,
                parentWidth: parentW,
                width,
                contentWidth: TEXT_MEASURE.maxEm * this.settings.fontSizePx,
                marginLeft: left,
                marginRight: right,
                authorFullWidthIntent: hasAuthorFullWidthIntent(doc, el),
                authoredHorizontalMargin: authoredHorizontalMargins.get(el),
                percentageMargin: percentage?.percentage,
                position: cs.position,
                writingMode: cs.writingMode,
                direction: cs.direction,
              });
          if (floatMargins) {
            preserveFloatLayout(el, `${floatMargins.left}px`, `${floatMargins.right}px`);
          } else if (floatGroupMember || !fullpage) {
            // Preserve the measured author/UA result through restoration of
            // L3 auto margins. This is deliberately a px snapshot for this
            // measure cycle; the next cycle restores and re-measures it.
            preserveFloatLayout(el, left, right);
          }
          continue;
        }

        // [L4-C16] 百分比水平 margin 已经以包含块为基准，不能再叠加版心
        // base。此时 max-width 已按需解除，computed width/margin 就是书的
        // 原始页面布局；用 inline important 穿过 L3 margin 默认值写回。
        if (isPercentageMarginLayout(percentage?.percentage === true, left, right)) {
          const ml = parseFloat(left) || 0;
          const mr = parseFloat(right) || 0;
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
            maxWidth: percentage?.relaxedReaderMaxWidth ? percentage.maxWidth : undefined,
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("margin-left", `${ml}px`, "important");
          el.style.setProperty("margin-right", `${mr}px`, "important");
          continue;
        }

        // 有百分比声明但实际水平值为 0：不属于流体定位，撤销上面为测量
        // 临时写入的 max-width，继续走普通版心逻辑。
        if (percentage?.relaxedReaderMaxWidth && percentage.maxWidth) {
          restoreInlineStyleProperty(el.style, "max-width", percentage.maxWidth);
        }

        // 书明确写了“收缩到内容宽度”（fit-content / max-content）且没有
        // 左右 margin：这是左对齐的内容容器，应放到版心列左缘，而不是
        // 被 L3 强制居中或贴在窗口最左。
        if (
          !meaningful(left) &&
          !meaningful(right) &&
          hadFitContent
        ) {
          const columnW = TEXT_MEASURE.maxEm * this.settings.fontSizePx;
          const desiredLeft = Math.max(0, (parentW - columnW) / 2);
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("margin-left", `${desiredLeft}px`, "important");
          el.style.setProperty(
            "margin-right",
            `${parentW - desiredLeft - width}px`,
            "important"
          );
          continue;
        }

        // [L3/L4-C31] Chromium may let a top-level float escape the reader's
        // 40rem containing block: with the reader auto margin temporarily
        // removed, restore only the physical float-side inset. Keep this
        // branch after the intrinsic-size path so C-18 retains precedence.
        // Explicit author margins, full-page classes, a box wider than the
        // reader measure, or authored full-width/breakout intent all remain
        // in the book's original layout.
        // [L3/L4-C37] UA blockquote margins describe symmetric inner留白.
        // Preserve that meaning by shrinking the effective max-width while
        // leaving reader-top auto centering in charge after this transaction.
        // This must stay after C-31 and before C-04; authored/unknown margins,
        // floats, full-page elements and intrinsic-size paths never enter it.
        const uaSymmetricMaxWidth =
          !hadFitContent
            ? getReaderTopUaSymmetricInsetMaxWidth({
                readerTop: el.classList.contains("reader-top"),
                authoredHorizontalMargin: authoredHorizontalMargins.get(el),
                float: cs.float,
                fullpage:
                  el.classList.contains("illus") ||
                  el.classList.contains("kuchie") ||
                  el.classList.contains("cover") ||
                  el.classList.contains("duokan-image-fullscreen"),
                percentageMargin: percentage?.percentage,
                parentWidth: parentW,
                borderBoxWidth: width,
                cssWidth: Number.parseFloat(cs.width),
                boxSizing: cs.boxSizing,
                marginLeft: left,
                marginRight: right,
              })
            : null;
        if (uaSymmetricMaxWidth !== null) {
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
            maxWidth: snapshotInlineStyleProperty(el.style, "max-width"),
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("max-width", `${uaSymmetricMaxWidth}px`, "important");
          continue;
        }

        // [L3/L4-C40] Explicit positive symmetric author margins on a normal
        // centered block are bilateral whitespace. Keep the restored reader
        // auto margins instead of translating the left value into C-04's
        // one-sided indentation. Fixed/unknown sizing intent stays conservative.
        if (
          shouldKeepCenteredAuthorMargins({
            readerTop: el.classList.contains("reader-top"),
            float: cs.float,
            writingMode: cs.writingMode,
            fullpage,
            intrinsicSize: hadFitContent,
            percentageMargin: percentage?.percentage,
            authoredHorizontalMargin: authoredHorizontalMargins.get(el),
            authoredSizingIntent: authoredSizingIntents.get(el),
            textAlign: cs.textAlign,
            marginLeft: left,
            marginRight: right,
          })
        ) {
          continue;
        }

        if (!meaningful(left) && !meaningful(right)) continue;

        // [L3/L4-C37] getComputedStyle exposes UA blockquote margins as px.
        // They are not author indentation and must retain the restored L3
        // reader-top auto centering instead of being reinterpreted by C-04.
        // `undefined` intentionally retains the old compatibility path.
        if (!shouldApplyBookMarginCompensation(authoredHorizontalMargins.get(el))) {
          continue;
        }

        const ml = parseFloat(left) || 0;
        const mr = parseFloat(right) || 0;
        // 作者/阅读器真正的 auto margin 即使在 computed style 中已变成 px，
        // 仍应保持居中；显式相等 margin 不会恰好等于全部剩余空间。
        if (
          isAutoLikeHorizontalMargin({
            parentWidth: parentW,
            width,
            marginLeft: ml,
            marginRight: mr,
          })
        ) {
          continue;
        }

        // [L3/L4-C18] fit/max-content 盒的 margin:1em 是双侧留白，经过
        // intrinsic-size 补偿后保持 reader auto 居中。普通 width:auto 或
        // 固定宽度元素仍走 C-04，保留作者相对正文版心的显式缩进。
        if (shouldKeepSymmetricMarginsCentered(left, right, hadFitContent)) continue;

        // [L3/L4-C16] Typed OM 和 CSSOM 都无法证明 margin 来源时，只在
        // 作者原位留有余量、叠加正文版心必越列的严格情形保留原位。
        // 这不是按尺寸猜百分比；普通 2em 缩进和原位本就越列都不会命中。
        if (
          percentage?.percentage === undefined &&
          shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
            parentWidth: parentW,
            width,
            marginLeft: ml,
            marginRight: mr,
          })
        ) {
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("margin-left", `${ml}px`, "important");
          el.style.setProperty("margin-right", `${mr}px`, "important");
          continue;
        }

        // 把书的不对称 margin 解释为“相对居中版心列的缩进”：
        // 正文列左缘 = (parent - width)/2；书 margin-left:2em 意味着
        // 元素左缘再缩进 2em，与正文首行 text-indent 对齐。
        const base = (parentW - width) / 2;
        let desiredLeft: number;
        let desiredRight: number;
        if (ml > 0) {
          desiredLeft = base + ml;
          desiredRight = parentW - desiredLeft - width;
        } else if (mr > 0) {
          desiredRight = base + mr;
          desiredLeft = parentW - desiredRight - width;
        } else {
          continue;
        }

        this.marginFixes.push({
          el,
          left: snapshotInlineStyleProperty(el.style, "margin-left"),
          right: snapshotInlineStyleProperty(el.style, "margin-right"),
        });
        el.setAttribute("data-reader-margin-fixed", "1");
        el.style.setProperty("margin-left", `${desiredLeft}px`, "important");
        el.style.setProperty("margin-right", `${desiredRight}px`, "important");
      }
    } finally {
      restoreReaderMargins();
    }
  }

  /**
   * 临时移除阅读器注入的 `.reader-top` margin auto 规则（C-04 纯书 margin 测量）。
   * 只动这两条 margin 规则，不禁用整个阅读器样式表：
   * 否则 L2 的 html{font-size} 也一起失效，em 宽度会在两次测量间跳变
   * （如目录容器 width:10.6em，18px 字号下被误判成不对称 margin）。
   */
  private disableReaderTopMarginRules(sheet: CSSStyleSheet): () => void {
    const saved: Array<{
      style: CSSStyleDeclaration;
      left: string;
      leftPriority: string;
      right: string;
      rightPriority: string;
    }> = [];
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule.type !== CSSRule.STYLE_RULE) continue;
      const style = (rule as CSSStyleRule).style;
      const selector = (rule as CSSStyleRule).selectorText ?? "";
      if (!selector.includes("reader-top")) continue;
      if (style.marginLeft !== "auto" && style.marginRight !== "auto") continue;
      saved.push({
        style,
        left: style.getPropertyValue("margin-left"),
        leftPriority: style.getPropertyPriority("margin-left"),
        right: style.getPropertyValue("margin-right"),
        rightPriority: style.getPropertyPriority("margin-right"),
      });
      style.removeProperty("margin-left");
      style.removeProperty("margin-right");
    }
    return () => {
      for (const item of saved) {
        item.style.setProperty("margin-left", item.left, item.leftPriority);
        item.style.setProperty("margin-right", item.right, item.rightPriority);
      }
    };
  }

  /** 恢复上一轮 fit-content 补偿写回的 inline max-width。 */
  private restoreFitContentFix(): void {
    for (const fix of this.fitContentFixes) {
      fix.el.style.setProperty("max-width", fix.maxWidth);
    }
    this.fitContentFixes = [];
  }

  /**
   * L5-C09：CSS 多栏里 max-width:fit-content 计算异常（简介等会塌成
   * 逐字窄条或拉成整页宽）。统一把这类元素的上限改为版心 40rem，
   * 宽容器时得到正常版心宽度，窄容器时仍受父容器约束。
   */
  private applyFitContentFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
    for (const el of Array.from(viewer.querySelectorAll("*")) as HTMLElement[]) {
      if (el.closest(".illus, .kuchie, .cover, .duokan-image-fullscreen")) {
        continue;
      }
      const mw = win.getComputedStyle(el).maxWidth;
      if (!mw.includes("fit-content")) continue;
      this.fitContentFixes.push({ el, maxWidth: el.style.maxWidth });
      el.style.setProperty("max-width", `${TEXT_MEASURE.maxEm}rem`);
    }
  }

  /** 清除上一轮 float 收缩补偿写回的 width。 */
  private restoreFloatWidths(): void {
    for (const el of this.floatFixes) el.style.removeProperty("width");
    this.floatFixes = [];
  }

  private restoreFloatLayoutFixes(): void {
    for (const fix of this.floatLayoutFixes) {
      fix.el.removeAttribute("data-reader-float-layout-fixed");
      restoreInlineStyleProperty(fix.el.style, "margin-left", fix.left);
      restoreInlineStyleProperty(fix.el.style, "margin-right", fix.right);
      restoreInlineStyleProperty(fix.el.style, "width", fix.width);
      restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
    }
    this.floatLayoutFixes = [];
  }

  private restoreTrailingFloatFixes(): void {
    for (const fix of this.trailingFloatFixes) {
      restoreInlineStyleProperty(fix.el.style, "margin-top", fix.marginTop);
    }
    this.trailingFloatFixes = [];
  }

  /** 恢复上一轮行尾行内盒原子化写回的 inline 值及优先级。 */
  private restoreInlineBoxFixes(): void {
    for (const fix of this.inlineBoxFixes) {
      // The marker is only a per-measure guard.  It must not survive the
      // restore phase or a later resize/reflow would skip the candidate.
      fix.el.removeAttribute("data-reader-inline-box-fixed");
      restoreInlineStyleProperty(fix.el.style, "display", fix.display);
      restoreInlineStyleProperty(fix.el.style, "text-indent", fix.textIndent);
    }
    this.inlineBoxFixes = [];
  }

  /**
   * L5-C25：Chromium computed right 对齐行中的尾随全角空白会挂在可见 inline
   * 盒外，导致目录色块越过其段落 inline-end，窄视口时还会制造残余列。
   * 仅在可见盒、手工补齐空白、实际几何越界且原子化后确实消除越界时写回；
   * 普通文字、无外观 span、链接/ruby/脚注语义节点都保持原样。
   */
  private applyInlineBoxOverflowFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
    const epsilon = 0.5;

    const isExcludedSemanticNode = (el: HTMLElement): boolean => {
      const tag = el.tagName.toLowerCase();
      if (tag === "a" || tag === "ruby" || tag === "rt" || tag === "rp" || tag === "sup") {
        return true;
      }
      return Boolean(el.closest("ruby, rt, rp, sup, .duokan-footnote, .zhangyue-footnote"));
    };

    const lineContainer = (
      el: HTMLElement,
      rect: DOMRect
    ): { rect: DOMRect; textAlign: string } | null => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const cs = win.getComputedStyle(parent);
        if (/^(?:inline|ruby)$/u.test(cs.display)) continue;
        const rects = Array.from(parent.getClientRects());
        const matching =
          rects.find((r) => r.bottom > rect.top + epsilon && r.top < rect.bottom - epsilon) ??
          parent.getBoundingClientRect();
        return { rect: matching, textAlign: cs.textAlign };
      }
      return null;
    };

    for (const el of Array.from(viewer.querySelectorAll("*")) as HTMLElement[]) {
      // Most chapter nodes do not carry manual padding whitespace.  Check
      // text before getComputedStyle to avoid forcing style/layout work for
      // every element on every measure pass.
      if (!hasTrailingManualPaddingWhitespace(el.textContent ?? "")) continue;
      if (el.hasAttribute("data-reader-inline-box-fixed") || isExcludedSemanticNode(el)) {
        continue;
      }
      const cs = win.getComputedStyle(el);
      if (cs.display !== "inline") continue;
      const originalDisplay = cs.display;
      if (!hasVisibleInlineBox(cs)) continue;

      const before = el.getBoundingClientRect();
      const container = lineContainer(el, before);
      if (!container || container.textAlign.trim().toLowerCase() !== "right") {
        continue;
      }
      if (before.right <= container.rect.right + epsilon) continue;

      const original = {
        display: snapshotInlineStyleProperty(el.style, "display"),
        textIndent: snapshotInlineStyleProperty(el.style, "text-indent"),
      };
      el.style.setProperty("display", "inline-block", "important");
      el.style.setProperty("text-indent", "0", "important");
      void el.offsetWidth;
      const after = el.getBoundingClientRect();
      const afterContainer = lineContainer(el, after) ?? container;
      const effective = shouldApplyInlineBoxOverflowFix({
        display: originalDisplay,
        trailingPaddingWhitespace: true,
        visibleBox: true,
        textAlign: container.textAlign,
        rectRight: before.right,
        containerRight: container.rect.right,
        fixedRectRight: after.right,
        fixedWidth: after.width,
        containerWidth: afterContainer.rect.width,
      });
      if (!effective) {
        restoreInlineStyleProperty(el.style, "display", original.display);
        restoreInlineStyleProperty(el.style, "text-indent", original.textIndent);
        continue;
      }
      el.setAttribute("data-reader-inline-box-fixed", "1");
      this.inlineBoxFixes.push({ el, ...original });
    }
  }

  /**
   * L5-C08：CSS 多栏里浮动元素的 shrink-to-fit 异常（气泡塌成逐字宽）。
   * 用 Canvas 逐文本节点测量 max-content，按父容器可用宽度收缩并写回 px，
   * 恢复“短内容包住文字、长内容到边换行”。只处理纯 inline 内容的浮动
   * 元素；测量不到字体宽度（无可用字体）时跳过。
   */
  private applyFloatShrinkFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
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
      this.floatFixes.push(el);
    }
  }

  /**
   * L5-C30：Chromium 可把章节末尾的纯图片 float 拆到下一列，制造只有装饰
   * 内容的错误第 2 页。只试探最后一个直接子元素，并用事务式负 margin-top
   * 把它收回上一列；任何单列、边界或兄弟重叠条件失败都立即恢复原值。
   */
  private applyTrailingFloatMarginFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView || this.step <= 0 || this.pageWidth <= 0) return;
    const children = Array.from(viewer.children) as HTMLElement[];
    const candidate = children.at(-1);
    if (!candidate) return;
    const win = doc.defaultView;
    const cs = win.getComputedStyle(candidate);
    if (!/^(?:left|right)$/u.test(cs.float) || !/^(?:static|relative)$/u.test(cs.position)) return;
    if (!isMediaOnlyFloatSubtree(candidate.childNodes)) return;

    const viewerRect = viewer.getBoundingClientRect();
    const paddingBottom = parseFloat(win.getComputedStyle(viewer).paddingBottom) || 0;
    const contentBottom = viewerRect.bottom - paddingBottom;
    const epsilon = 0.5;
    const toRect = (r: DOMRect): FloatFixRect => ({
      left: r.left,
      right: r.right,
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
      Math.floor((x + viewer.scrollLeft - viewerRect.left + epsilon) / this.step);
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
      viewerLeft: viewerRect.left,
      scrollLeft: viewer.scrollLeft,
      step: this.step,
      pageWidth: this.pageWidth,
      epsilon,
    });
    if (!accepted) {
      restoreInlineStyleProperty(candidate.style, "margin-top", originalMarginTop);
      return;
    }
    this.trailingFloatFixes.push({ el: candidate, marginTop: originalMarginTop });
  }

  /**
   * 重算分页；首次显示需要 await 到内部自愈重试真正结束。
   * 返回 false 表示章节已过期/销毁或当前 DOM 不可计算。
   */
  private async recompute(
    useAnchor: boolean,
    loadSeq: number = this.loadSeq
  ): Promise<boolean> {
    // 章节代号校验：切章后旧章的延迟重排（图片加载防抖等）一律丢弃，
    // 否则旧 DOM 的锚点/页数会污染新章（表现：卡死在上一章末页）
    if (this.disposed || loadSeq !== this.loadSeq) return false;
    const viewer = this.viewer;
    if (!viewer || this.step <= 0) return false;
    // 自愈：viewer 为空但 body 里还有内容（内容落在容器外）时，重新包裹
    if (viewer.children.length === 0) {
      const doc = this.contentDoc;
      const body = doc?.body;
      let moved = 0;
      if (body) {
        const nodes = Array.from(body.childNodes);
        for (const n of nodes) {
          if (n === viewer) continue;
          viewer.appendChild(n);
          moved++;
        }
      }
      if (moved > 0) {
        this.textIndex = null;
        if (!(await this.measure(loadSeq))) return false;
        if (this.disposed || loadSeq !== this.loadSeq) return false;
        this.rebuildTextIndexForCurrentDoc();
        return this.recompute(useAnchor, loadSeq);
      }
    }
    const sw = viewer.scrollWidth;
    const hasContent =
      viewer.children.length > 0 || (viewer.textContent ?? "").trim().length > 0;
    if (sw <= 0 || !hasContent) {
      this.metrics = { pageCount: 1, currentPage: 0 };
      this.emit({ status: "ready", pageCount: 1, currentPage: 0, empty: true });
      return true;
    }
    // 纵向裁剪检测：分栏未生效时内容会被 overflow:hidden 裁掉（scrollHeight > 高），
    // 重新应用分栏一次（最多重试 2 次，防死循环）
    if (viewer.scrollHeight > viewer.clientHeight + 1) {
      if (this.recomputeRetries < 2) {
        this.recomputeRetries++;
        if (!(await this.measure(loadSeq))) return false;
        if (this.disposed || loadSeq !== this.loadSeq) return false;
        this.rebuildTextIndexForCurrentDoc();
        return this.recompute(useAnchor, loadSeq);
      }
    }
    this.recomputeInner(useAnchor, loadSeq);
    return !this.disposed && loadSeq === this.loadSeq;
  }

  private recomputeInner(useAnchor: boolean, loadSeq: number): void {
    if (loadSeq !== this.loadSeq) return; // 过期章节：丢弃
    const viewer = this.viewer;
    if (!viewer || this.step <= 0) return;
    // 用内容实际占用的列范围计算页数（不依赖视口，elementFromPoint 对
    // 视口外列返回 null 会导致整列被误判为空）
    const extent = this.contentExtent();
    if (!Number.isFinite(extent.maxX) || extent.maxX <= 0) {
      this.metrics = { pageCount: 1, currentPage: 0 };
      this.emit({ status: "ready", pageCount: 1, currentPage: 0, empty: true });
      return;
    }
    const contentCols = Math.max(1, Math.ceil(extent.maxX / this.step));
    let pageCount = contentCols;
    // 前置空列：page-break-before:always 的首元素会把内容推到第 2 列
    const leadShift = Math.floor(extent.minX / this.step);
    if (leadShift > 0) {
      pageCount = Math.max(1, contentCols - leadShift);
    }
    // 阅读位置保留：窗口缩放/设置变化用内容锚点定位；
    // 图片加载等内容变化保留当前页号（否则内容下移会把人拉到后几页）
    const resolvedAnchor = useAnchor ? this.resolveAnchorCol() : null;
    const anchorCol = resolvedAnchor?.col ?? null;
    const restored = resolveRestoredPage({
      pageCount,
      anchorCol,
      fallbackPage: this.pendingFallbackPage,
      currentPage: this.metrics.currentPage,
    });
    const current = restored.page;
    this.metrics = { pageCount, currentPage: current };
    // 关键：重排（图片加载/窗口缩放）后对齐页边界，否则显示半页偏移错位
    viewer.scrollLeft = (leadShift + current) * this.step;
    // A legacy element anchor only chooses the column. Once there, observe
    // the current page centre to upgrade it to the text anchor used by new
    // progress writes; no layout rule is changed.
    if (resolvedAnchor?.source === "legacy") this.captureAnchor();
    this.emit({ status: "ready", pageCount, currentPage: current, empty: false });
    // 粘性锚点：使用锚点恢复时不重新取样（否则恢复后页心可能是下一段，
    // 反复缩放会逐段漂移）；仅当无锚点（首次加载）时建立
    if (anchorCol === null) this.captureAnchor();
    // A failed content/legacy anchor must consume the saved page only after it
    // has really been applied. It cannot be overwritten by the fresh centre
    // sample above before this point.
    if (restored.consumeFallback) this.pendingFallbackPage = null;
  }

  /** 内容在列方向上的实际占用范围（内容坐标，视口无关）。 */
  private contentExtent(): { minX: number; maxX: number } {
    const viewer = this.viewer;
    let minX = Infinity;
    let maxX = -Infinity;
    if (!viewer) return { minX: 0, maxX: 0 };
    const scrollLeft = viewer.scrollLeft;
    for (const el of Array.from(viewer.querySelectorAll("*"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // display:none 等零尺寸元素
      const x0 = r.left + scrollLeft;
      const x1 = r.right + scrollLeft;
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
    }
    return { minX, maxX };
  }

  /** Rebuild only after a successful measure of the currently owned document. */
  private rebuildTextIndexForCurrentDoc(): void {
    if (!this.contentDoc || !this.viewer || this.disposed) {
      this.textIndex = null;
      return;
    }
    this.textIndex = buildVisibleTextIndex(this.contentDoc, this.viewer);
    this.applyNoteHighlights();
  }

  private handleContextMenu(e: MouseEvent): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !viewer.contains(e.target as Node | null)) return;
    e.preventDefault();
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const payload = captureTextSelection(doc, viewer, index);
    this.selectionContextMenuOpen = Boolean(payload);
    this.selectionContextMenuHandler?.(payload ? { ...payload, chapterPath: this._currentPath } : null);
  }

  private handleSelectionChange(): void {
    if (!this.selectionContextMenuOpen) return;
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer) return;
    const selection = doc.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.selectionContextMenuOpen = false;
      this.selectionContextMenuHandler?.(null);
      return;
    }
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const payload = captureTextSelection(doc, viewer, index, selection);
    if (!payload) {
      this.selectionContextMenuOpen = false;
      this.selectionContextMenuHandler?.(null);
      return;
    }
    this.selectionContextMenuHandler?.({ ...payload, chapterPath: this._currentPath });
  }

  private clearNoteHighlights(): void {
    const css = this.contentDoc?.defaultView?.CSS as
      | (typeof CSS & { highlights?: { delete(name: string): boolean } })
      | undefined;
    const highlights = css?.highlights;
    if (!highlights) {
      return;
    }
    highlights.delete("reader-notes");
  }

  private applyNoteHighlights(): "applied" | "unsupported" | "deferred" {
    const doc = this.contentDoc;
    const index = this.textIndex;
    if (!doc || !this.viewer || !index) return "deferred";
    const css = doc.defaultView?.CSS as
      | (typeof CSS & {
          highlights?: { set(name: string, value: Highlight): unknown; delete(name: string): boolean };
        })
      | undefined;
    const highlights = css?.highlights;
    const HighlightCtor = (doc.defaultView as (Window & { Highlight?: typeof Highlight }) | null)?.Highlight;
    if (!highlights || !HighlightCtor) {
      return "unsupported";
    }
    this.clearNoteHighlights();
    const ranges: Range[] = [];
    for (const note of this.notes) {
      const resolved = resolveTextRangeOffsets(index, note, note.selectedText);
      if (!resolved) continue;
      const range = index.rangeForOffsets(doc, resolved.start, resolved.end);
      if (range) ranges.push(range);
    }
    if (ranges.length > 0) {
      highlights.set("reader-notes", new HighlightCtor(...ranges));
    }
    return "applied";
  }

  /**
   * Observe the current page centre only. This method never inserts spacers or
   * changes styles: pagination has already happened and remains natural from
   * the chapter's first page.
   */
  private captureAnchor(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || this.step <= 0 || viewer.clientWidth <= 0) return;
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const x = Math.min(viewer.clientWidth * 0.5, viewer.clientWidth - 2);
    const mid = Math.max(2, Math.min(viewer.clientHeight - 2, viewer.clientHeight * 0.5));
    const samples = [mid, mid - 40, mid + 40, mid - 80, mid + 80]
      .filter((y) => y >= 2 && y <= viewer.clientHeight - 2);
    let textNode: Text | null = null;
    let rawOffset = 0;
    for (const y of samples) {
      const modern = (doc as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      }).caretPositionFromPoint?.(x, y);
      if (modern?.offsetNode.nodeType === 3) {
        textNode = modern.offsetNode as Text;
        rawOffset = modern.offset;
        break;
      }
      const range = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
        .caretRangeFromPoint?.(x, y);
      if (range?.startContainer.nodeType === 3) {
        textNode = range.startContainer as Text;
        rawOffset = range.startOffset;
        break;
      }
    }
    const textOffset = textNode ? index.offsetForNode(textNode, rawOffset) : null;
    // Keep legacy data only as a compatibility fallback for images and old
    // engines without a caret API. It is never used to count text.
    let el: Element | null = null;
    for (const y of samples) {
      const hit = doc.elementFromPoint(x, y);
      if (hit && hit !== viewer && hit !== doc.body && hit !== doc.documentElement) {
        el = hit;
        break;
      }
    }
    const all = Array.from(viewer.querySelectorAll("*"));
    const idx = el ? all.indexOf(el as HTMLElement) : -1;
    const rect = el ? (el as HTMLElement).getBoundingClientRect() : null;
    const ratio = rect && rect.width > 0 ? Math.min(1, Math.max(0, (x - rect.left) / rect.width)) : 0;
    this.anchor = {
      index: idx,
      ratio,
      charsRead: textOffset ?? 0,
      totalChars: index.totalChars,
      mediaUnits: index.mediaUnits,
      textOffset,
      textSnippet: textOffset === null ? null : index.snippetAt(textOffset),
    };
    this.anchorPath = this._currentPath;
  }

  /** Resolve a text Range to its current column after the chapter is laid out. */
  private resolveTextAnchorCol(index: VisibleTextIndex, textOffset: number): number | null {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || this.step <= 0) return null;
    const start = index.positionForOffset(textOffset);
    const end = index.positionForOffset(Math.min(index.totalChars, textOffset + 1));
    if (!start || !end) return null;
    try {
      const range = doc.createRange();
      range.setStart(start.node, start.rawOffset);
      range.setEnd(end.node, end.rawOffset);
      const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 || candidate.height > 0);
      if (!rect) return null;
      return Math.max(0, Math.floor((rect.left + viewer.scrollLeft) / this.step));
    } catch {
      return null;
    }
  }

  /** Text anchor wins; an invalid legacy index is invalid rather than clamped. */
  private resolveAnchorCol(): ResolvedAnchorColumn | null {
    const viewer = this.viewer;
    if (!viewer || !this.anchor || this.step <= 0 || this.anchorPath !== this._currentPath) return null;
    const index = this.textIndex;
    if (this.anchor.textOffset !== null) {
      if (index) {
        const offset = resolveTextAnchorOffset(index, this.anchor);
        if (offset !== null) {
          const col = this.resolveTextAnchorCol(index, offset);
          if (col !== null) {
            this.anchor.textOffset = offset;
            this.anchor.textSnippet = index.snippetAt(offset);
            this.anchor.charsRead = offset;
            this.anchor.totalChars = index.totalChars;
            this.anchor.mediaUnits = index.mediaUnits;
            return { col, source: "text" };
          }
        }
      }
      // A stale/ambiguous text anchor must not remain sticky after legacy
      // fallback succeeds. It would otherwise keep preventing the upgrade.
      this.anchor.textOffset = null;
      this.anchor.textSnippet = null;
      this.anchor.charsRead = 0;
    }
    const all = Array.from(viewer.querySelectorAll("*"));
    if (!Number.isSafeInteger(this.anchor.index) || this.anchor.index < 0 || this.anchor.index >= all.length) return null;
    const el = all[this.anchor.index] as HTMLElement;
    const rect = el.getBoundingClientRect();
    const absX = rect.left + viewer.scrollLeft + this.anchor.ratio * rect.width;
    return { col: Math.max(0, Math.floor(absX / this.step)), source: "legacy" };
  }

  /** Commit a page without treating the center sample as a layout input. */
  private commitWithinChapterPage(
    page: number,
    candidate: ReadingAnchor | null
  ): void {
    const viewer = this.viewer;
    if (!viewer) return;
    this.metrics.currentPage = page;
    viewer.scrollLeft = page * this.step;
    if (candidate) {
      this.anchor = candidate;
      this.anchorPath = this._currentPath;
    } else {
      this.anchor = null;
      this.anchorPath = undefined;
    }
    // Commit the page before the read-only center observation. If caret is
    // unavailable, preserve the successful text/legacy candidate.
    const preserved = candidate ? { ...candidate } : null;
    this.captureAnchor();
    if (preserved && (!this.anchor || this.anchor.textOffset === null)) {
      this.anchor = preserved;
      this.anchorPath = this._currentPath;
    }
    this.emit({
      status: "ready",
      pageCount: this.metrics.pageCount,
      currentPage: page,
      empty: false,
    });
  }

  /** Read-only fragment preflight shared by the iframe click path and commit. */
  private getWithinChapterFragmentPage(fragmentValue: string): { hash: string; page: number } | null {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (!viewer || !doc || this.step <= 0 || this.lastState.status !== "ready") return null;
    const encoded = fragmentValue.startsWith("#") ? fragmentValue.slice(1) : fragmentValue;
    if (encoded.length === 0) return { hash: "", page: 0 };
    const fragment = getFragmentNavigation(`#${encoded}`);
    if (!fragment) return null;
    const target = doc.getElementById(fragment.anchor);
    if (!target) return null;
    const rect = (target as HTMLElement).getBoundingClientRect();
    const page = Math.floor((rect.left + viewer.scrollLeft) / this.step);
    if (!Number.isFinite(page) || page < 0 || page >= this.metrics.pageCount) return null;
    return { hash: fragment.hash, page };
  }

  /**
   * Navigate inside the currently laid-out chapter. This is intentionally a
   * synchronous, no-measure path: failed candidates are evaluated on a local
   * anchor copy and leave the current page/anchor/hash untouched.
   */
  navigateWithinCurrentChapter(options: WithinChapterNavigationOptions = {}): boolean {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (
      this.disposed ||
      !this._currentPath ||
      !doc ||
      !viewer ||
      this.step <= 0 ||
      this.metrics.pageCount <= 0 ||
      this.lastState.status !== "ready"
    ) {
      return false;
    }

    if (options.fragment !== undefined) {
      const resolved = this.getWithinChapterFragmentPage(options.fragment);
      if (!resolved) return false;
      syncFragmentHash(this.iframe.contentWindow, resolved.hash);
      this.commitWithinChapterPage(resolved.page, null);
      return true;
    }

    if (options.toStart) {
      syncFragmentHash(this.iframe.contentWindow, "");
      this.commitWithinChapterPage(0, null);
      return true;
    }

    let fallback: number | null = null;
    if (options.fallbackPage !== undefined && options.fallbackPage !== null) {
      if (!Number.isSafeInteger(options.fallbackPage) || options.fallbackPage < 0) return false;
      fallback = Math.min(options.fallbackPage, this.metrics.pageCount - 1);
    }

    let candidate: ReadingAnchor | null = null;
    if (options.readingAnchor) {
      const text = sanitizePersistedTextAnchor(options.readingAnchor);
      candidate = {
        index:
          Number.isSafeInteger(options.readingAnchor.index) && options.readingAnchor.index >= 0
            ? options.readingAnchor.index
            : -1,
        ratio:
          Number.isFinite(options.readingAnchor.ratio) &&
          options.readingAnchor.ratio >= 0 &&
          options.readingAnchor.ratio <= 1
            ? options.readingAnchor.ratio
            : 0,
        charsRead: text.textOffset ?? 0,
        totalChars: 0,
        textOffset: text.textOffset,
        textSnippet: text.textSnippet,
      };
      // Resolve on a temporary candidate. resolveAnchorCol may clear a stale
      // text anchor while attempting legacy fallback; the live anchor is not
      // touched until the result is known to be usable.
      const previousAnchor = this.anchor;
      const previousPath = this.anchorPath;
      let resolved: ResolvedAnchorColumn | null = null;
      let resolvedCandidate: ReadingAnchor | null = null;
      let resolveFailed = false;
      try {
        this.anchor = { ...candidate };
        this.anchorPath = this._currentPath;
        resolved = this.resolveAnchorCol();
        resolvedCandidate = this.anchor ? { ...this.anchor } : null;
      } catch {
        resolveFailed = true;
      } finally {
        this.anchor = previousAnchor;
        this.anchorPath = previousPath;
      }
      if (resolveFailed) return false;
      if (resolved && resolvedCandidate && resolved.col >= 0 && resolved.col < this.metrics.pageCount) {
        syncFragmentHash(this.iframe.contentWindow, "");
        this.commitWithinChapterPage(resolved.col, resolvedCandidate);
        return true;
      }
      candidate = null;
    }
    if (fallback === null) return false;
    syncFragmentHash(this.iframe.contentWindow, "");
    this.commitWithinChapterPage(fallback, null);
    return true;
  }

  /** 翻到第 i 页（自动夹紧）。 */
  setPage(i: number): void {
    if (!this.viewer) return;
    const { pageCount } = this.metrics;
    const target = Math.max(0, Math.min(pageCount - 1, Math.floor(i)));
    this.viewer.scrollLeft = target * this.step;
    this.metrics.currentPage = target;
    // 空章判定只由 recompute 负责（此处标记 false，避免误触发自动跳章）
    this.emit({ status: "ready", pageCount, currentPage: target, empty: false });
    this.captureAnchor();
  }

  /** 跳到页内锚点（元素所在列）。 */
  jumpToAnchor(anchor: string): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer) return;
    const el = doc.getElementById(anchor);
    if (!el || this.step <= 0) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + viewer.scrollLeft;
    this.setPage(Math.floor(x / this.step));
  }

  /** 当前阅读锚点（供阅读记录持久化与内容进度推算）。 */
  getReadingAnchor(): {
    path: string;
    index: number;
    ratio: number;
    charsRead: number;
    totalChars: number;
    mediaUnits: number;
    textOffset: number | null;
    textSnippet: string | null;
  } | null {
    if (!this.anchor || !this.anchorPath) return null;
    return {
      path: this.anchorPath,
      index: this.anchor.index,
      ratio: this.anchor.ratio,
      charsRead: this.anchor.charsRead,
      totalChars: this.anchor.totalChars,
      mediaUnits: this.anchor.mediaUnits ?? 0,
      textOffset: this.anchor.textOffset,
      textSnippet: this.anchor.textSnippet,
    };
  }

  /** 当前锚点元素的行文本（书签列表展示用）。 */
  getAnchorText(): string | null {
    if (!this.contentDoc || !this.viewer || !this.anchor) return null;
    if (this.textIndex && this.anchor.textOffset !== null) {
      const pos = this.textIndex.positionForOffset(this.anchor.textOffset);
      const text = pos?.node.parentElement?.textContent?.replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 80);
    }
    const all = Array.from(this.viewer.querySelectorAll("*"));
    if (!Number.isSafeInteger(this.anchor.index) || this.anchor.index < 0 || this.anchor.index >= all.length) return null;
    const el = all[this.anchor.index] as HTMLElement | undefined;
    if (!el) return null;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 80) : null;
  }

  /** 恢复阅读锚点（打开书时定位到上次阅读处）。 */
  setReadingAnchor(
    a:
      | ({ path: string; index: number; ratio: number; charsRead?: number; totalChars?: number } & Partial<TextAnchorData>)
      | null
      | undefined
  ): void {
    if (a && a.path) {
      const text = sanitizePersistedTextAnchor(a);
      this.anchor = {
        index: Number.isSafeInteger(a.index) && a.index >= 0 ? a.index : -1,
        ratio: Number.isFinite(a.ratio) && a.ratio >= 0 && a.ratio <= 1 ? a.ratio : 0,
        charsRead: text.textOffset ?? 0,
        totalChars:
          typeof a.totalChars === "number" && Number.isSafeInteger(a.totalChars) && a.totalChars >= 0
            ? a.totalChars
            : 0,
        mediaUnits: 0,
        textOffset: text.textOffset,
        textSnippet: text.textSnippet,
      };
      this.anchorPath = a.path;
    } else {
      this.anchor = null;
      this.anchorPath = undefined;
    }
  }

  get pageCount(): number {
    return this.metrics.pageCount;
  }

  get currentPage(): number {
    return this.metrics.currentPage;
  }

  /** 预渲染调度器只读快照；不得据此绕过 display-ready 准备边界。 */
  getStateSnapshot(): ChapterState {
    return { ...this.lastState };
  }

  /** 当前已提交章节路径，用于槽位命中校验。 */
  getCurrentPath(): string {
    return this._currentPath;
  }

  /** 设置变更（字号/主题）后整体重载（保留阅读位置）。 */
  async reloadWithSettings(settings: ReaderSettings, anchor?: string): Promise<void> {
    this.settings = settings;
    const path = this.currentPath;
    if (!path) return;
    // Capture once, synchronously, before any load/cleanup can detach the old
    // document.  Pass a value copy so the new load never observes the mutable
    // anchor object while an older reload is being torn down.
    this.captureAnchor();
    const readingAnchor = this.anchor && this.anchorPath === path ? { ...this.anchor } : null;
    const fallbackPage = this.metrics.currentPage;
    await this.load(path, { anchor, readingAnchor, fallbackPage });
  }

  private get currentPath(): string {
    return this._currentPath;
  }

  private _currentPath = "";

  private scheduleReflow(): void {
    if (this.reflowTimer !== undefined) window.clearTimeout(this.reflowTimer);
    const seq = this.loadSeq;
    this.reflowTimer = window.setTimeout(() => {
      this.reflowTimer = undefined;
      if (!this.disposed && seq === this.loadSeq) void this.recompute(false, seq);
    }, 200);
  }

  /** 外部触发重排（窗口尺寸变化等）。
   *  不捕获锚点：直接使用上一次稳定状态存下的锚点（缩放前的位置）。 */
  reflow(): void {
    if (this.disposed) return;
    // ResizeObserver 在组件挂载和章节切换时也可能回调，即使 iframe 尺寸
    // 完全没变。重复 measure 会先恢复二阶段补偿，造成已稳定盒子短暂跳位。
    if (
      this.iframe.clientWidth === this.measuredViewport.width &&
      this.iframe.clientHeight === this.measuredViewport.height
    ) {
      return;
    }
    const seq = ++this.reflowSeq;
    const loadSeq = this.loadSeq;
    void this.measure(loadSeq).then((measured) => {
      // 过期测量（更早发起、更晚完成/切章后）直接丢弃，防布局/位置被覆写
      if (measured && !this.disposed && seq === this.reflowSeq && loadSeq === this.loadSeq) {
        this.rebuildTextIndexForCurrentDoc();
        void this.recompute(true, loadSeq);
      }
    });
  }

  /** 键盘翻页（书页内焦点）。 */
  private handleKey(e: KeyboardEvent): void {
    if (isSelectAllShortcut(e)) {
      e.preventDefault();
      clearDocumentSelection(this.contentDoc);
      return;
    }
    const k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " ") {
      e.preventDefault();
      this.onKeyNavigate?.(1);
    } else if (k === "ArrowLeft" || k === "PageUp") {
      e.preventDefault();
      this.onKeyNavigate?.(-1);
    }
  }

  /** 滚轮翻页：累积 deltaY，超过阈值翻一页（触控板连续小增量也能工作）。 */
  private handleWheel(e: WheelEvent): void {
    if (e.deltaY === 0) return;
    this.wheelAcc += e.deltaY;
    const threshold = 80;
    if (this.wheelAcc >= threshold) {
      this.wheelAcc = 0;
      e.preventDefault();
      this.onWheelNavigate?.(1);
    } else if (this.wheelAcc <= -threshold) {
      this.wheelAcc = 0;
      e.preventDefault();
      this.onWheelNavigate?.(-1);
    }
  }

  /** 书内链接点击处理：阻止 iframe 导航，路由到阅读器跳转。 */
  private handleLinkClick(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const a = t.closest<HTMLAnchorElement>("a");
    if (!a) return;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href) return;
    // 一律拦截：书内链接走阅读器，外部链接不跳转（防 iframe 被导航走）
    e.preventDefault();
    e.stopPropagation();
    if (isExternalUrl(href) || href.startsWith("//")) {
      const url = href.startsWith("//") ? `https:${href}` : href;
      // 只放行可由系统默认应用安全打开的协议；data:/blob:/file: 等保持忽略
      if (/^(https?|mailto|tel):/i.test(url)) this.onExternalLink?.(url);
      return;
    }
    // 脚注标记：多看/掌阅式 + script.js 的 <note><sup><a href="#asideId"> 通用模式
    if (isFootnoteLink(a) && this.contentDoc) {
      const info = resolveFootnote(this.contentDoc, a);
      if (info) {
        // 点击 = 固定弹窗；再次点击同一标记 = 取消固定并关闭
        if (this.footnotePinned && this.lastFootnoteEl === a) {
          this.footnotePinned = false;
          this.footnoteHoverGate.reset();
          this.onFootnoteClose?.();
          return;
        }
        this.showFootnote(a, info, true);
        return;
      }
    }
    if (isFragmentOnly(href)) {
      // 脚注已在上方提前返回；这里只处理普通同章锚点。先通过原生 hash
      // 激活 :target，再由分页器将目标元素定位到对应分页列。
      const fragment = getFragmentNavigation(href);
      if (fragment) {
        // 缺失目标只同步 hash，不制造一条“已跳转”的假历史；step/viewer
        // 检查保证通知发生在实际可执行 jumpToAnchor 之前。
        const target = this.contentDoc?.getElementById(fragment.anchor);
        if (!target || !this.viewer || this.step <= 0) {
          syncFragmentHash(this.iframe.contentWindow, fragment.hash);
          return;
        }
        this.onBeforeInternalNavigate?.(href);
        syncFragmentHash(this.iframe.contentWindow, fragment.hash);
        this.jumpToAnchor(fragment.anchor);
        this.onInternalNavigationSettled?.();
      } else if (href === "#" && this.lastState.status === "ready") {
        // An empty fragment is an explicit return to the natural chapter
        // start; clear the old :target state without creating a fake target.
        if (this.navigateWithinCurrentChapter({ fragment: "" })) {
          this.onInternalNavigationSettled?.();
        }
      }
      return;
    }
    const { path, anchor } = splitHref(href);
    const resolved = resolvePath(this._currentPath, path);
    const destination = anchor ? `${resolved}#${anchor}` : resolved;
    if (resolved === this._currentPath) {
      // Same-chapter links never leave the iframe. Preflight before notifying
      // App so an invalid fragment cannot pollute navigation history.
      const fragmentPage = anchor ? this.getWithinChapterFragmentPage(anchor) : null;
      if (anchor ? !fragmentPage : this.lastState.status !== "ready") return;
      this.onBeforeInternalNavigate?.(destination);
      const navigated = this.navigateWithinCurrentChapter(
        anchor ? { fragment: anchor } : { toStart: true }
      );
      if (navigated) this.onInternalNavigationSettled?.();
      return;
    }
    this.onBeforeInternalNavigate?.(destination);
    this.onNavigate?.(destination);
  }

  /** 显示脚注弹层：记录标记（供重排重定位）并通知阅读器。 */
  private showFootnote(a: HTMLAnchorElement, info: FootnoteInfo, pinned: boolean): void {
    this.lastFootnoteEl = a;
    this.footnotePinned = pinned;
    this.footnoteHoverGate.show(pinned);
    const r = a.getBoundingClientRect();
    this.onFootnote?.({
      text: info.text,
      html: info.html,
      pinned,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  }

  /** 桌面 hover 弹注（script.js 的 mouseover 行为）；已固定时不切换。 */
  private handleFootnoteHoverIn(e: Event): void {
    if (this.footnotePinned) return;
    const doc = this.contentDoc;
    const a = getFootnoteHoverAnchor(e.target, doc);
    if (!a || !doc) return;
    this.footnoteHoverGate.markerEnter();
    if (this.lastFootnoteEl === a && this.footnoteHoverGate.isVisible()) return;
    const info = resolveFootnote(doc, a);
    if (info) this.showFootnote(a, info, false);
  }

  /** hover 移出标记时关闭弹层；在标记内部移动不关闭；固定状态不关闭。 */
  private handleFootnoteHoverOut(e: MouseEvent): void {
    if (this.footnotePinned) return;
    const a = (e.target as Element | null)?.closest<HTMLAnchorElement>("a");
    if (!a || !isFootnoteLink(a)) return;
    const rel = e.relatedTarget as Node | null;
    if (rel && a.contains(rel)) return;
    this.footnoteHoverGate.markerLeave();
  }

  /** 固定脚注后点击正文空白处关闭。 */
  private handleDocClick = (e: Event): void => {
    if (!this.footnotePinned) return;
    const a = (e.target as Element | null)?.closest<HTMLAnchorElement>("a");
    if (a && isFootnoteLink(a)) return; // 标记点击由 linkHandler 处理并 stopPropagation
    this.footnotePinned = false;
    this.footnoteHoverGate.reset();
    this.onFootnoteClose?.();
  };

  /** UI 层主动关闭固定脚注后，同步分页器状态（避免 hover 被锁住）。 */
  dismissFootnote(): void {
    this.footnotePinned = false;
    this.footnoteHoverGate.reset();
  }

  /** 宿主脚注卡片 hover 进入/离开时，同步 iframe 内 marker 的关闭 gate。 */
  setFootnoteOverlayHover(over: boolean): void {
    if (over) this.footnoteHoverGate.overlayEnter();
    else this.footnoteHoverGate.overlayLeave();
  }

  /** 当前脚注标记在 iframe 内的视口矩形（弹层随重排重定位用）；无则 null。 */
  getFootnoteMarkerRect(): { left: number; top: number; right: number; bottom: number } | null {
    if (!this.lastFootnoteEl || !this.lastFootnoteEl.isConnected) return null;
    const r = this.lastFootnoteEl.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  /** 渲染诊断：输出当前章节的分页/布局关键数据（浏览器内调试用）。 */
  diagnose(): string {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    const lines: string[] = [];
    lines.push(`state=${JSON.stringify(this.lastState)}`);
    lines.push(
      `step=${this.step} pageWidth=${this.pageWidth} metrics=${JSON.stringify(this.metrics)}`
    );
    lines.push(
      `iframe=${this.iframe.clientWidth}x${this.iframe.clientHeight} src=${String(this.iframe.src).slice(0, 36)}`
    );
    if (doc && viewer) {
      const cs = doc.defaultView ? doc.defaultView.getComputedStyle(viewer) : null;
      lines.push(
        `viewer=${viewer.clientWidth}x${viewer.clientHeight} sw=${viewer.scrollWidth} sh=${viewer.scrollHeight} scrollLeft=${viewer.scrollLeft}`
      );
      if (cs) {
        lines.push(
          `colW=${cs.columnWidth} colCount=${cs.columnCount} colFill=${cs.columnFill} overflow=${cs.overflow}`
        );
      }
      lines.push(`children=${viewer.children.length} textLen=${(viewer.textContent ?? "").trim().length}`);
      const imgs = Array.from(viewer.querySelectorAll("img"))
        .slice(0, 6)
        .map((im) => {
          const r = (im as HTMLElement).getBoundingClientRect();
          return `${im.getAttribute("alt") || "-"}:${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
        })
        .join(" ");
      lines.push(`imgs=${imgs || "none"}`);
      // 布局排障辅助：fit-content 在多栏里常异常；宽出栏宽的元素也需要列出来
      const fitContentEls = Array.from(viewer.querySelectorAll("*"))
        .filter((el) => {
          const mw = doc.defaultView?.getComputedStyle(el as Element).maxWidth ?? "";
          return mw.includes("fit-content");
        })
        .slice(0, 5)
        .map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return `${(el as Element).tagName.toLowerCase()}.${(el as Element).getAttribute("class") ?? ""}:${Math.round(r.width)}px`;
        })
        .join(" ");
      lines.push(`fitContentEls=${fitContentEls || "none"}`);
      const wideEls = Array.from(viewer.querySelectorAll("*"))
        .filter((el) => {
          // 多栏里 getBoundingClientRect 会把跨列碎片并成一个超宽矩形，
          // 用 computed width 判断“真实盒宽”是否超栏，避免碎片误报。
          const w = parseFloat(doc.defaultView?.getComputedStyle(el as Element).width ?? "");
          return Number.isFinite(w) && w > this.step + 1;
        })
        .slice(0, 5)
        .map((el) => {
          const w = parseFloat(doc.defaultView?.getComputedStyle(el as Element).width ?? "");
          return `${(el as Element).tagName.toLowerCase()}.${(el as Element).getAttribute("class") ?? ""}:${Math.round(w)}px`;
        })
        .join(" ");
      lines.push(`wideEls=${wideEls || "none"}`);
      lines.push(`sheets=${doc.styleSheets.length}`);
      const fonts = (doc as unknown as { fonts?: { status?: string } }).fonts;
      lines.push(`fontsStatus=${fonts?.status ?? "n/a"}`);
      const anchorInfo = this.anchor
        ? `anchor idx=${this.anchor.index} ratio=${this.anchor.ratio.toFixed(3)} path=${this.anchorPath}`
        : "anchor=null";
      lines.push(anchorInfo);
      const body = doc.body;
      if (body) {
        lines.push(`bodyChildren=${body.children.length}`);
        lines.push(`bodyHtml=${body.outerHTML.replace(/\s+/g, " ").slice(0, 300)}`);
      }
      lines.push(`viewerHtml=${viewer.outerHTML.replace(/\s+/g, " ").slice(0, 200)}`);
      const links = Array.from(doc.getElementsByTagName("link"))
        .map((l) => (l as HTMLLinkElement).getAttribute("href"))
        .join(" , ");
      lines.push(`linkHrefs=${links}`);
    } else {
      lines.push("viewer=null（章节尚未加载）");
    }
    return lines.join("\n");
  }

  private cleanupDoc(): void {
    this.abortMeasureWaits();
    this.lastFootnoteEl = null;
    this.footnotePinned = false;
    this.footnoteHoverGate.reset();
    this.selectionContextMenuOpen = false;
    this.selectionContextMenuHandler?.(null);
    this.restoreInlineBoxFixes();
    this.restoreFloatLayoutFixes();
    this.restoreTrailingFloatFixes();
    this.contentDoc?.removeEventListener("load", this.imgHandler, true);
    this.contentDoc?.removeEventListener("click", this.linkHandler, true);
    this.contentDoc?.removeEventListener("click", this.handleDocClick, true);
    this.contentDoc?.removeEventListener("wheel", this.wheelHandler);
    this.contentDoc?.removeEventListener("keydown", this.keyHandler);
    this.contentDoc?.removeEventListener("mouseover", this.footnoteHoverInHandler, true);
    this.contentDoc?.removeEventListener("mouseout", this.footnoteHoverOutHandler, true);
    this.contentDoc?.removeEventListener("contextmenu", this.contextMenuHandler);
    this.contentDoc?.removeEventListener("selectionchange", this.selectionChangeHandler);
    this.clearNoteHighlights();
    this.contentDoc = null;
    this.viewer = null;
    this.textIndex = null;
    this.pendingFallbackPage = null;
    this.chapterCssUrls.revokeAll();
    for (const owned of this.pendingCssUrls) owned.revokeAll();
    this.pendingCssUrls.clear();
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.loadSeq++;
    this.resolveDisplayReady?.(false);
    this.resolveDisplayReady = null;
    this.abortMeasureWaits();
    window.clearTimeout(this.reflowTimer);
    this.displayGate.dispose();
    this.iframe.removeEventListener("load", this.onIframeLoad);
    this.cleanupDoc();
    this.footnoteHoverGate.dispose();
    this.iframe.src = "about:blank";
  }

  private abortMeasureWaits(): void {
    for (const controller of this.measureControllers) controller.abort();
    this.measureControllers.clear();
  }

  private emit(s: ChapterState): void {
    this.lastState = s;
    if (!this.disposed) this.onState(s);
  }
}
