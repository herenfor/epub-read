import type { Book, Resource } from "../core/types";
import { disposeBook } from "../core/book";
import { ChapterDependencies } from "./chapterDependencies";
import { ArchiveClosedError } from "../core/selectiveArchive";

/** 解压后保留在内存中的资源字节默认预算；可被 ResourceServer 选项覆盖。 */
export const DEFAULT_MEDIA_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export interface ResourceServerOptions {
  textCacheMaxBytes?: number;
  textCacheMaxEntries?: number;
  decoder?: (data: Uint8Array) => string;
  /** 按字节计的已加载资源预算；当前活章节持有者不受淘汰影响。 */
  mediaCacheMaxBytes?: number;
}

export interface MediaCacheStats {
  bytes: number;
  entries: number;
  urls: number;
  holders: number;
  evictions: number;
  maxBytes: number;
  overBudget: boolean;
}

/**
 * 把书内资源映射为 blob URL（同源，iframe 内可自由引用字体/图片/CSS）。
 * 带缓存；书关闭时统一 revoke。
 *
 * 除文本 LRU 外，本轮还给已解压资源增加按字节预算。活章节通过
 * acquireChapter 完成依赖加载并登记持有者；只有没有持有者的资源才会被按 LRU 淘汰，
 * 淘汰时同时撤销 blob URL、清空原始字节并置回 loaded=false。
 */
export class ResourceServer {
  private urls = new Map<string, string>();
  private textCache = new Map<string, { text: string; bytes: number }>();
  private textCacheBytes = 0;
  private textCacheHits = 0;
  private textCacheMisses = 0;

  /** 已加载且计入媒体预算的资源路径。 */
  private countedMediaPaths = new Set<string>();
  private mediaBytes = 0;
  private mediaTicks = new Map<string, number>();
  private mediaTick = 0;
  /** 资源路径 -> 持有者 id 集合。共享资源可能同时属于多个章节。 */
  private holders = new Map<string, Set<number>>();
  /** 持有者 id -> 它登记的资源依赖。释放时按此精确减计数。 */
  private heldDependencies = new Map<number, string[]>();
  private nextHolderId = 1;
  private mediaEvictions = 0;
  private readonly mediaCacheMaxBytes: number;
  private dependencies: ChapterDependencies | null;

  constructor(
    private book: Book | null,
    private options: ResourceServerOptions = {}
  ) {
    this.dependencies = book ? new ChapterDependencies(book, (path) => this.rawTextFor(path)) : null;
    const configured = options.mediaCacheMaxBytes;
    this.mediaCacheMaxBytes =
      typeof configured === "number" && Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : configured === 0
          ? 0
          : DEFAULT_MEDIA_CACHE_MAX_BYTES;
    if (this.book) {
      for (const [path, res] of this.book.resources) {
        if (!isLoadedResource(res)) continue;
        this.countedMediaPaths.add(path);
        this.mediaBytes += res.data.byteLength;
      }
    }
  }

  /** 返回内部路径对应的 blob URL；资源缺失或尚未解压就绪返回 undefined。 */
  urlFor(path: string): string | undefined {
    const cached = this.urls.get(path);
    if (cached) {
      this.touchMedia(path);
      return cached;
    }
    const res = this.book?.resources.get(path);
    if (!res || !isLoadedResource(res)) return undefined;
    const url = URL.createObjectURL(
      new Blob([res.data as BlobPart], { type: res.mediaType || "application/octet-stream" })
    );
    this.urls.set(path, url);
    this.touchMedia(path);
    this.enforceMediaBudget(new Set([path]));
    return url;
  }

  /** 读取资源文本（按 UTF-8；带 BOM 时尊重 BOM 编码）。未解压就绪返回 undefined。 */
  textFor(path: string): string | undefined {
    const res = this.book?.resources.get(path);
    if (!res || !isLoadedResource(res)) return undefined;
    const cached = this.textCache.get(path);
    if (cached) {
      this.textCacheHits++;
      this.textCache.delete(path);
      this.textCache.set(path, cached);
      this.touchMedia(path);
      return cached.text;
    }
    this.textCacheMisses++;
    const text = (this.options.decoder ?? decodeBytes)(res.data);
    const bytes = text.length * 2;
    const maxBytes = this.options.textCacheMaxBytes ?? 4 * 1024 * 1024;
    const maxEntries = this.options.textCacheMaxEntries ?? 32;
    if (bytes <= maxBytes && maxBytes > 0 && maxEntries > 0) {
      while (
        this.textCache.size >= maxEntries ||
        this.textCacheBytes + bytes > maxBytes
      ) {
        const oldest = this.textCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.dropTextCache(oldest);
      }
      this.textCache.set(path, { text, bytes });
      this.textCacheBytes += bytes;
    }
    this.touchMedia(path);
    this.enforceMediaBudget(new Set([path]));
    return text;
  }

  /**
   * 异步读取单个正文资源：按需解压该 XHTML 后解码。只持有这一个路径（不像
   * acquireChapter 那样加载图片/字体/CSS）；空串是合法空章，不当成失败。
   * 未就绪/读取失败抛错，调用方不能把它当作“没有正文”缓存。
   */
  async readTextFor(path: string, signal?: AbortSignal): Promise<string> {
    const checkAbort = () => {
      if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    };
    checkAbort();
    const book = this.book;
    if (!book) throw new ArchiveClosedError();
    if (!book.resources.has(path)) throw new Error("章节正文资源不存在");
    const holderId = this.nextHolderId++;
    this.heldDependencies.set(holderId, []);
    this.pinPaths(holderId, [path]);
    try {
      await this.ensureResources([path]);
      checkAbort();
      // ensureResources 已验证会话；解码期间 holder 防止并发预算回收该资源。
      const text = this.textFor(path);
      if (text === undefined) throw new Error("章节正文读取失败");
      return text;
    } finally {
      this.releaseHolder(holderId);
    }
  }

  /** 按需确保指定资源已解压加载。会话关闭后以统一关闭错误结束。 */
  async ensureResources(paths: Iterable<string>): Promise<void> {
    const book = this.book;
    if (!book) throw new ArchiveClosedError();
    const wanted = [...new Set(paths)];
    if (wanted.length === 0) return;
    await book.ensureResources?.(wanted);
    if (this.book !== book) throw new ArchiveClosedError();
    for (const path of wanted) {
      const res = book.resources.get(path);
      if (!res || !isLoadedResource(res)) continue;
      if (!this.countedMediaPaths.has(path)) {
        this.countedMediaPaths.add(path);
        this.mediaBytes += res.data.byteLength;
      }
      this.touchMedia(path);
    }
    this.enforceMediaBudget(new Set(wanted));
  }

  /**
   * 一次取得章节持有者：先登记本批路径，再按需解压；每批加载后重新发现
   * 依赖，直到没有新的 @import/url()/样式/字体/图片路径。返回的 id
   * 必须在换章、失败或过期时由调用方 releaseHolder 释放。
   */
  async acquireChapter(chapterPath: string): Promise<number> {
    const book = this.book;
    const dependencies = this.dependencies;
    if (!book || !dependencies) throw new ArchiveClosedError();
    const holderId = this.nextHolderId++;
    this.heldDependencies.set(holderId, []);
    const required = new Set<string>([chapterPath]);
    const attempted = new Set<string>();
    try {
      while (true) {
        this.pinPaths(holderId, required);
        const batch = [...required].filter((path) => !attempted.has(path));
        if (batch.length === 0) {
          this.enforceMediaBudget();
          return holderId;
        }
        for (const path of batch) attempted.add(path);
        await this.ensureResources(batch);
        if (this.book !== book) throw new ArchiveClosedError();
        for (const path of batch) {
          const resource = book.resources.get(path);
          if (!resource || !isLoadedResource(resource)) throw new Error(`书内资源读取未完成：${path}`);
        }
        const discovered = await dependencies.collect(chapterPath);
        // Parsing can yield too: a closed book must never acquire new holders.
        if (this.book !== book) throw new ArchiveClosedError();
        for (const dep of discovered) {
          required.add(dep);
        }
      }
    } catch (error) {
      this.releaseHolder(holderId);
      throw error;
    }
  }

  /** 释放某个章节/浮层持有者；释放后预算内的无主资源可按 LRU 淘汰。 */
  releaseHolder(holderId: number): void {
    const paths = this.heldDependencies.get(holderId);
    if (!paths) return;
    this.heldDependencies.delete(holderId);
    for (const path of paths) {
      const set = this.holders.get(path);
      if (!set) continue;
      set.delete(holderId);
      if (set.size === 0) this.holders.delete(path);
    }
    this.enforceMediaBudget();
  }

  get textCacheStats(): Readonly<{ hits: number; misses: number; entries: number; bytes: number }> {
    return Object.freeze({
      hits: this.textCacheHits,
      misses: this.textCacheMisses,
      entries: this.textCache.size,
      bytes: this.textCacheBytes,
    });
  }

  get mediaCacheStats(): Readonly<MediaCacheStats> {
    let holders = 0;
    for (const set of this.holders.values()) {
      if (set.size > 0) holders++;
    }
    return Object.freeze({
      bytes: this.mediaBytes,
      entries: this.countedMediaPaths.size,
      urls: this.urls.size,
      holders,
      evictions: this.mediaEvictions,
      maxBytes: this.mediaCacheMaxBytes,
      overBudget: this.mediaCacheMaxBytes > 0 && this.mediaBytes > this.mediaCacheMaxBytes,
    });
  }

  /** 预算已超且当前无主资源不足以回到预算内时为 true；调用方可据此收缩后台预读窗口。 */
  get mediaCacheBudgetExceeded(): boolean {
    return this.mediaCacheMaxBytes > 0 && this.mediaBytes > this.mediaCacheMaxBytes;
  }

  revokeAll(): void {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.textCache.clear();
    this.textCacheBytes = 0;
    this.countedMediaPaths.clear();
    this.mediaTicks.clear();
    this.holders.clear();
    this.heldDependencies.clear();
    this.dependencies = null;
    this.mediaBytes = 0;
    if (this.book) {
      disposeBook(this.book);
      this.book = null;
    }
    // Hit/miss/eviction counters are diagnostic lifetime totals; only live state resets.
  }

  /** 把一批路径登记到 holder 下；重复路径不会重复计数。 */
  private pinPaths(holderId: number, paths: Iterable<string>): void {
    const held = this.heldDependencies.get(holderId);
    if (!held) return;
    for (const path of paths) {
      let owners = this.holders.get(path);
      if (!owners) {
        owners = new Set();
        this.holders.set(path, owners);
      }
      if (owners.has(holderId)) continue;
      owners.add(holderId);
      held.push(path);
      this.touchMedia(path);
    }
  }

  /**
   * 仅用于依赖发现：读取当前已加载资源的文本，但不更新文本 LRU，
   * 也不触发媒体预算淘汰，避免在登记持有者之前把本章 CSS/图片清掉。
   */
  private rawTextFor(path: string): string | undefined {
    const res = this.book?.resources.get(path);
    if (!res || !isLoadedResource(res)) return undefined;
    return (this.options.decoder ?? decodeBytes)(res.data);
  }

  private touchMedia(path: string): void {
    this.mediaTicks.set(path, ++this.mediaTick);
  }

  private dropTextCache(path: string): void {
    const cached = this.textCache.get(path);
    if (!cached) return;
    this.textCache.delete(path);
    this.textCacheBytes -= cached.bytes;
  }

  /**
   * 在预算内按 LRU 淘汰无主、非本次保护路径的资源。
   * 当前活章节（holders）和单个超预算资源不会被强制清掉。
   */
  private enforceMediaBudget(protectedPaths: ReadonlySet<string> = new Set()): void {
    if (!this.book || this.mediaCacheMaxBytes <= 0) return;
    if (this.mediaBytes <= this.mediaCacheMaxBytes) return;
    const candidates: string[] = [];
    for (const [path, res] of this.book.resources) {
      if (!isLoadedResource(res) || !this.countedMediaPaths.has(path)) continue;
      if (protectedPaths.has(path)) continue;
      const set = this.holders.get(path);
      if (set && set.size > 0) continue;
      candidates.push(path);
    }
    candidates.sort((left, right) => {
      const byUse = (this.mediaTicks.get(left) ?? 0) - (this.mediaTicks.get(right) ?? 0);
      return byUse !== 0 ? byUse : left.localeCompare(right);
    });
    for (const path of candidates) {
      if (this.mediaBytes <= this.mediaCacheMaxBytes) break;
      this.evictMedia(path);
    }
  }

  private evictMedia(path: string): void {
    const res = this.book?.resources.get(path);
    if (!res || !isLoadedResource(res)) return;
    const bytes = res.data.byteLength;
    const url = this.urls.get(path);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(path);
    }
    this.dropTextCache(path);
    res.data = new Uint8Array(0);
    res.loaded = false;
    this.countedMediaPaths.delete(path);
    this.mediaTicks.delete(path);
    this.mediaBytes = Math.max(0, this.mediaBytes - bytes);
    this.mediaEvictions++;
  }
}

function isLoadedResource(res: Resource): boolean {
  return res.loaded !== false;
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
