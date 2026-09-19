/** 阅读器设置（渲染相关）。 */

import type { PageMarginsPx, ReadingMode } from "./pageLayout";

export type { PageMarginsPx, ReadingMode };

export type Theme = "light" | "dark" | "sepia";

export interface ReaderSettings {
  fontSizePx: number;
  theme: Theme;
  /** 用户指定字体族；为空表示不覆盖书的字体 */
  fontFamily?: string;
  /** 用户选择的已上传自定义字体 family（优先于 fontFamily 与书字体） */
  customFontName?: string;
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
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSizePx: 16,
  theme: "light",
  fontFamily: undefined,
  gapPx: 24,
  readingMode: "paginated",
  columnsPerView: 1,
  forceHorizontal: false,
  preloadNextChapter: false,
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
};
