/** 阅读器设置（渲染相关）。 */

import type { PageMarginsPx, ReadingMode, SpreadGapMode } from "./pageLayout";

export type { PageMarginsPx, ReadingMode, SpreadGapMode };

export type Theme = "light" | "dark" | "sepia" | "gray";

export interface ReaderSettings {
  fontSizePx: number;
  theme: Theme;
  /** 用户指定字体族；为空表示不覆盖书的字体 */
  fontFamily?: string;
  /** 用户选择的已上传自定义字体 family（优先于 fontFamily 与书字体） */
  customFontName?: string;
  /** 选定字体也覆盖书在正文后代（div/p 等）上的字体声明；undefined/false =
   * 只作缺省（body 级）字体，作者的后代声明优先。代码/SVG/MathML 始终保留。 */
  forceFontOverride?: boolean;
  /** 字体来源；缺省时兼容旧版 customFontName。 */
  fontSource?: "system" | "imported";
  /** fontSource=imported 时对应的本地字体元数据 id。 */
  customFontId?: string;
  /** 已上传字体在本次会话中的 @font-face 资源（App 构造并传入渲染层） */
  customFonts?: Array<{ family: string; url: string }>;
  /** 用户自定义 CSS（高级设置内输入，注入在阅读器覆盖样式之后，允许覆盖） */
  customCss?: string;
  /** 列间距 px（页面选项里的“额外边距”） */
  gapPx: number;
  /** 阅读方式；undefined = 分页 */
  readingMode?: ReadingMode;
  /** 阅读器视口四边留白；未设置的边沿用旧默认 */
  pageMarginsPx?: PageMarginsPx;
  /** 一屏显示的列数；undefined = 1 */
  columnsPerView?: 1 | 2;
  /** 双页中缝模式；undefined = 旧设置，读取边界会迁移为 auto/manual。 */
  spreadGapMode?: SpreadGapMode;
  /** 行高倍率；undefined = 跟随书 */
  lineHeight?: number;
  /** 字重 400/500/700；undefined = 跟随书 */
  fontWeight?: number;
  /** 字间距 px；undefined = 跟随书 */
  letterSpacingPx?: number;
  /** 字符（词）间距 px；undefined = 跟随书 */
  wordSpacingPx?: number;
  /** 将可重排章节中的竖排书写模式强制转换为横排；undefined/false = 跟随书 */
  forceHorizontal?: boolean;
  /** 预先准备下一章以加快顺序切换；undefined/false = 按需加载 */
  preloadNextChapter?: boolean;
  /** 分页翻页动画；undefined = 滑动。只影响绘制，不参与重排比较。 */
  turnAnimation?: TurnAnimation;
  /** 翻页方向：book 跟随书籍的 page-progression-direction；ltr 始终从左往右。undefined = book。 */
  pageDirection?: PageDirectionSetting;
}

export type PageDirectionSetting = "book" | "ltr";

export function normalizePageDirection(value: unknown): PageDirectionSetting {
  return value === "ltr" ? "ltr" : "book";
}

/**
 * The direction pages actually turn in. A right-to-left book turns right to
 * left unless the reader asked for left-to-right, or forced vertical text into
 * horizontal lines (horizontal text read right-to-left would be backwards).
 */
export function effectivePageProgression(
  bookProgression: "ltr" | "rtl" | undefined,
  settings: Pick<ReaderSettings, "pageDirection" | "forceHorizontal">,
  fixedLayout = false,
): "ltr" | "rtl" {
  if (bookProgression !== "rtl" || normalizePageDirection(settings.pageDirection) === "ltr") return "ltr";
  // forceHorizontal never applies to fixed layout, so such pages keep the book's direction.
  return settings.forceHorizontal === true && !fixedLayout ? "ltr" : "rtl";
}

/** ← and → follow the page direction; PageUp, PageDown and Space keep their meaning. */
export function arrowKeyDirection(dir: 1 | -1, key: string | undefined, progression: "ltr" | "rtl"): 1 | -1 {
  if (progression !== "rtl" || (key !== "ArrowLeft" && key !== "ArrowRight")) return dir;
  return dir === 1 ? -1 : 1;
}

/** slide：内容跟手平移；fade：落位轻推淡入；none：瞬翻。 */
export type TurnAnimation = "slide" | "fade" | "none";

export function normalizeTurnAnimation(value: unknown): TurnAnimation {
  return value === "fade" || value === "none" ? value : "slide";
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSizePx: 16,
  theme: "light",
  fontFamily: undefined,
  gapPx: 24,
  readingMode: "paginated",
  columnsPerView: 1,
  spreadGapMode: "auto",
  forceHorizontal: false,
  forceFontOverride: false,
  preloadNextChapter: false,
  turnAnimation: "slide",
  pageDirection: "book",
};

/**
 * 行文版式（参考一般书籍/日轻文库本版心习惯）：
 * - maxEm：行宽上限（em，按正文字号计），默认 40em ≈ 一般书籍每行 40 字；
 *   宽屏/全屏时正文按此封顶居中
 * - vTopEm/vBottomEm：页面上下留白（em，上大下小，类实体书版心）
 */
/** 标准页：固定 1000 字/页（千字页口径），用于按内容字数推算阅读进度。 */
export const STANDARD_PAGE_CHARS = 1000;

export const TEXT_MEASURE = {
  maxEm: 40,
  vTopEm: 2.2,
  vBottomEm: 1.6,
  /** 窄屏（手机竖屏）分页“自动”上下留白。 */
  compactTopEm: 2.6,
  compactBottomEm: 2.1,
};
