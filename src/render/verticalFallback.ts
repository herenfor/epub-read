import type { ReaderSettings } from "./settings";

/**
 * A10s：分页器还不能排竖排（A10 尚未上线），竖排正文按原样渲染会挤压叠字。
 * 在此之前，从右往左翻页的中日韩可重排书按“强制竖排转横排”显示。只看 OPF
 * 元数据，开书时即可确定，不会首屏后再换版式；阿拉伯语等横排从右往左的书
 * 不受影响。A10 上线后删除本文件及调用处。
 */
const CJK_LANGUAGES = new Set(["zh", "ja", "ko", "zho", "chi", "jpn", "kor"]);

export interface VerticalFallbackBook {
  readonly fixedLayout: boolean;
  readonly pageProgression?: "ltr" | "rtl";
  readonly metadata: { readonly language: string };
}

export function looksLikeVerticalBook(book: VerticalFallbackBook): boolean {
  if (book.fixedLayout || book.pageProgression !== "rtl") return false;
  const primary = book.metadata.language.trim().toLowerCase().split(/[-_]/)[0];
  return CJK_LANGUAGES.has(primary);
}

/** 需要自动转横排时返回打开 forceHorizontal 的新设置，否则原样返回同一对象。 */
export function withVerticalFallback(settings: ReaderSettings, book: VerticalFallbackBook | null): ReaderSettings {
  if (!book || settings.forceHorizontal === true || !looksLikeVerticalBook(book)) return settings;
  return { ...settings, forceHorizontal: true };
}
