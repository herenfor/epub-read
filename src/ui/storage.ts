import { sanitizePersistedTextAnchor } from "../render/textAnchor";
import type { PageMarginsPx, ReadingMode } from "../render/settings";

const PREFIX = "epub-reader:";

export interface SavedProgress {
  spineIndex: number;
  page: number;
  /** 内容锚点（精确恢复阅读位置；页码为兜底） */
  anchor?: {
    index: number;
    ratio: number;
    anchorTextOffset?: number | null;
    anchorTextSnippet?: string | null;
  } | null;
}

export function readProgress(key: string): SavedProgress | null {
  try {
    const raw = localStorage.getItem(PREFIX + "progress:" + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedProgress;
    if (typeof parsed.spineIndex !== "number" || typeof parsed.page !== "number") return null;
    if (
      parsed.anchor &&
      (typeof parsed.anchor.index !== "number" || typeof parsed.anchor.ratio !== "number")
    ) {
      parsed.anchor = null;
    } else if (parsed.anchor) {
      const text = sanitizePersistedTextAnchor({
        textOffset: parsed.anchor.anchorTextOffset,
        textSnippet: parsed.anchor.anchorTextSnippet,
      });
      parsed.anchor.anchorTextOffset = text.textOffset;
      parsed.anchor.anchorTextSnippet = text.textSnippet;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeProgress(key: string, p: SavedProgress): void {
  try {
    localStorage.setItem(PREFIX + "progress:" + key, JSON.stringify(p));
  } catch {
    /* 存储不可用时静默失败 */
  }
}

export interface SavedSettings {
  fontSizePx?: number;
  theme?: "light" | "dark" | "sepia";
  /** UI 界面缩放（0.75–1.5），与正文字号相互独立 */
  uiScale?: number;
  lineHeight?: number;
  fontWeight?: number;
  letterSpacingPx?: number;
  wordSpacingPx?: number;
  /** 用户自定义字体（已上传字体 family） */
  customFontName?: string;
  fontSource?: "system" | "imported";
  customFontId?: string;
  /** 用户自定义 CSS 文本 */
  customCss?: string;
  /** 可重排章节是否强制覆盖为横排；旧设置缺省为 false */
  forceHorizontal?: boolean;
  /** 是否预先准备下一章以加快顺序切换；旧设置缺省为 false */
  preloadNextChapter?: boolean;
  /** 阅读方式；旧设置缺省为分页 */
  readingMode?: ReadingMode;
  /** 阅读器视口四边留白；未设置的边沿用旧默认 */
  pageMarginsPx?: PageMarginsPx;
  /** 一屏列数；旧设置缺省为 1 */
  columnsPerView?: 1 | 2;
  /** 列间距 px（页面选项“额外边距”），与渲染设置同源 */
  gapPx?: number;
}

export function readSavedSettings(): SavedSettings {
  try {
    const raw = localStorage.getItem(PREFIX + "settings");
    return raw ? (JSON.parse(raw) as SavedSettings) : {};
  } catch {
    return {};
  }
}

export function writeSavedSettings(s: SavedSettings): void {
  try {
    localStorage.setItem(PREFIX + "settings", JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
