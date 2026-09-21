import type { Book } from "../core/types";
import { disposeBook } from "../core/book";

/**
 * 把书内资源映射为 blob URL（同源，iframe 内可自由引用字体/图片/CSS）。
 * 带缓存；书关闭时统一 revoke。
 */
export class ResourceServer {
  private urls = new Map<string, string>();
  private textCache = new Map<string, { text: string; bytes: number }>();
  private textCacheBytes = 0;
  private textCacheHits = 0;
  private textCacheMisses = 0;

  constructor(
    private book: Book | null,
    private textOptions: {
      textCacheMaxBytes?: number;
      textCacheMaxEntries?: number;
      decoder?: (data: Uint8Array) => string;
    } = {}
  ) {}

  /** 返回内部路径对应的 blob URL；资源缺失返回 undefined。 */
  urlFor(path: string): string | undefined {
    const cached = this.urls.get(path);
    if (cached) return cached;
    const res = this.book?.resources.get(path);
    if (!res) return undefined;
    const url = URL.createObjectURL(
      new Blob([res.data as BlobPart], { type: res.mediaType || "application/octet-stream" })
    );
    this.urls.set(path, url);
    return url;
  }

  /** 读取资源文本（按 UTF-8；带 BOM 时尊重 BOM 编码）。 */
  textFor(path: string): string | undefined {
    const res = this.book?.resources.get(path);
    if (!res) return undefined;
    const cached = this.textCache.get(path);
    if (cached) {
      this.textCacheHits++;
      this.textCache.delete(path);
      this.textCache.set(path, cached);
      return cached.text;
    }
    this.textCacheMisses++;
    const text = (this.textOptions.decoder ?? decodeBytes)(res.data);
    const bytes = text.length * 2;
    const maxBytes = this.textOptions.textCacheMaxBytes ?? 4 * 1024 * 1024;
    const maxEntries = this.textOptions.textCacheMaxEntries ?? 32;
    if (bytes <= maxBytes && maxBytes > 0 && maxEntries > 0) {
      while (
        this.textCache.size >= maxEntries ||
        this.textCacheBytes + bytes > maxBytes
      ) {
        const oldest = this.textCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const removed = this.textCache.get(oldest);
        this.textCache.delete(oldest);
        this.textCacheBytes -= removed?.bytes ?? 0;
      }
      this.textCache.set(path, { text, bytes });
      this.textCacheBytes += bytes;
    }
    return text;
  }

  get textCacheStats(): Readonly<{ hits: number; misses: number; entries: number; bytes: number }> {
    return Object.freeze({
      hits: this.textCacheHits,
      misses: this.textCacheMisses,
      entries: this.textCache.size,
      bytes: this.textCacheBytes,
    });
  }

  revokeAll(): void {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.textCache.clear();
    this.textCacheBytes = 0;
    if (this.book) {
      disposeBook(this.book);
      this.book = null;
    }
    // Hit/miss counters are diagnostic lifetime totals; only entries/bytes reset.
  }
}

export function decodeBytes(data: Uint8Array): string {
  // UTF-16 BOM 检测（老书偶见）
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(data.slice(2));
    }
    if (data[0] === 0xfe && data[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(data.slice(2));
    }
  }
  return new TextDecoder("utf-8").decode(data);
}
