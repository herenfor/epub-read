/** 核心数据模型（解析层输出，渲染层与 UI 层消费）。 */

export type IssueKind = "book_error" | "reader_error" | "platform_error";

export interface BookIssue {
  kind: IssueKind;
  /** 形如 "opf:manifest" 的来源标签 */
  source: string;
  message: string;
}

export interface BookMetadata {
  title: string;
  identifier: string;
  language: string;
  creator?: string;
  publisher?: string;
  contributor?: string;
  date?: string;
  description?: string;
  subject?: string;
  rights?: string;
  modified?: string;
  [k: string]: string | undefined;
}

export interface ManifestItem {
  id: string;
  /** 相对 OPF 所在目录的原始 href */
  href: string;
  mediaType: string;
  /** EPUB 3 properties（空格分隔展开） */
  properties: string[];
  /** EPUB 2 fallback：指向另一 item 的 id */
  fallback?: string;
}

export interface SpineItem {
  /** manifest item id */
  idref: string;
  linear: boolean;
}

export interface GuideRef {
  type: string;
  title?: string;
  /** 相对 OPF 目录的 href */
  href: string;
}

export interface TocNode {
  label: string;
  /** 已解析到书的内部路径（相对根），含可选 #anchor；空串表示无有效跳转 */
  href: string;
  children: TocNode[];
  /** 无法用于跳转的条目（无 href / javascript: / 目标不存在），UI 应置灰 */
  disabled?: boolean;
}

export interface Resource {
  /** 规范化的内部路径（资源查找 key） */
  path: string;
  data: Uint8Array;
  mediaType: string;
  /** 资源字节是否已从归档解压加载就绪 */
  loaded?: boolean;
}

export interface Book {
  version: 2 | 3;
  /** OPF 的规范化内部路径 */
  opfPath: string;
  metadata: BookMetadata;
  /** id -> item */
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  guide: GuideRef[];
  /** 目录树：EPUB3 nav 优先，EPUB2 NCX，都缺失时由 spine 生成 */
  toc: TocNode[];
  /** 规范化路径 -> 资源 */
  resources: Map<string, Resource>;
  coverHref?: string;
  /** 固定版式（rendition:layout=pre-paginated） */
  fixedLayout: boolean;
  /** rendition:viewport，形如 "600x800" */
  viewport?: string;
  issues: BookIssue[];
  /** 是否受 DRM 保护（ADEPT 等），受保护则不应渲染 */
  drmProtected: boolean;
  /** 按需解压指定路径的资源字节 */
  ensureResources?: (paths: Iterable<string>) => Promise<void>;
  /** 读取指定路径的资源字节（若未加载则按需解压） */
  readResource?: (path: string) => Promise<Uint8Array | undefined>;
  /** 选择性归档句柄，关书时释放 */
  archive?: { close: () => void };
}

export interface BookOptions {
  /** 是否解析目录（默认 true） */
  parseToc?: boolean;
  /** 是否使用选择性按需解压（默认 false 保持向后兼容，App 开书时启用） */
  selective?: boolean;
  /** 打开书籍时的初始 spine 下标（用于优先预载初始章节） */
  initialSpineIndex?: number;
  /**
   * Loader bootstrap strategy. `full` keeps the historical all-manifest-text
   * preload; `native` extracts only the first nav/NCX entry buildToc reads.
   */
  bootstrap?: "full" | "native";
  /** Preload the cover candidate after parsing (default true). */
  preloadCover?: boolean;
}
