import { unzipEpub, bytesToText } from "./zip";
import { parseOpf, renditionInfo, type ParsedOpf } from "./opf";
import { parseNcx } from "./ncx";
import { parseNav, isUsableHref } from "./nav";
import { findElements } from "./xml";
import { parseXmlText, hasParserError } from "./parseXml";
import { normalizePath, resolvePath, isExternalUrl, isFragmentOnly, splitHref } from "./paths";
import { isFontMediaType, guessMediaType } from "./mime";
import { deobfuscateFont } from "./fonts";
import type {
  Book,
  BookIssue,
  BookOptions,
  ManifestItem,
  Resource,
  TocNode,
} from "./types";

export class DrmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrmError";
  }
}

/** 从文件 Map 取内容；缺失返回 undefined。 */
function getText(
  files: Map<string, { name: string; data: Uint8Array }>,
  path: string
): string | undefined {
  const f = files.get(path);
  return f ? bytesToText(f.data) : undefined;
}

/** Manifest href 可以带锚点/查询串；资源 ZIP 路径不能带它们。 */
function manifestResourcePath(opfPath: string, href: string): string {
  const suffix = href.search(/[?#]/);
  return resolvePath(opfPath, suffix < 0 ? href : href.slice(0, suffix));
}

function inferredCoverMediaType(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}

function isSupportedCoverCandidate(item: ManifestItem, path: string): boolean {
  return item.mediaType.toLowerCase().startsWith("image/") || Boolean(inferredCoverMediaType(path));
}

function hasCoverFilename(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  return stem.toLowerCase() === "cover";
}

/**
 * 与桌面 Rust 后端保持相同候选契约。候选按 OPF manifest 源顺序检查，
 * 但只有实际存在、并且可作为图片处理的资源才能成为封面。
 */
function selectCoverHref(
  manifest: Map<string, ManifestItem>,
  metaPairs: Array<{ name: string; content: string }>,
  opfPath: string,
  resources: Map<string, Resource>
): string | undefined {
  const items = [...manifest.values()];
  const candidates: ManifestItem[] = [];
  candidates.push(...items.filter((item) => item.properties.includes("cover-image")));
  const coverMeta = metaPairs.find((meta) => meta.name === "cover");
  if (coverMeta?.content) {
    const item = manifest.get(coverMeta.content);
    if (item) candidates.push(item);
  }
  candidates.push(
    ...items.filter((item) => hasCoverFilename(manifestResourcePath(opfPath, item.href)))
  );

  for (const item of candidates) {
    const path = manifestResourcePath(opfPath, item.href);
    if (!resources.has(path) || !isSupportedCoverCandidate(item, path)) continue;
    return path;
  }
  return undefined;
}

/**
 * 解析目录 href 并标记"无法使用"的条目：
 * - 空 / javascript:/mailto:/http(s): 等外部协议 → disabled
 * - 纯 # 锚点：仅当当前 nav/NCX 基准文档在 spine 中时绑定为同文档目标，否则 disabled
 * - 目标不在 spine 阅读流中 → disabled（UI 置灰提示）
 */
export function resolveTocHrefs(
  nodes: TocNode[],
  basePath: string,
  issues: BookIssue[],
  source: string,
  canNavigate: (resolvedHref: string) => boolean
): TocNode[] {
  return nodes.map((n) => {
    const rawHref = (n.href ?? "").trim();
    let href = rawHref;
    let disabled = false;
    const fragmentOnly = isFragmentOnly(rawHref);
    const usable = isUsableHref(rawHref);
    if (fragmentOnly) {
      // nav/NCX 中允许用 #id 指向目录文档自身；只有该文档本身位于
      // spine 时才有稳定的章节目标，避免把无上下文的 # 全局放行。
      if (canNavigate(basePath)) {
        const fragment = rawHref.slice(1);
        href = fragment ? `${basePath}#${fragment}` : basePath;
      } else {
        disabled = true;
      }
    } else if (!usable) {
      disabled = true;
    } else {
      href = resolvePath(basePath, href);
      if (!href) {
        disabled = true;
        issues.push({
          kind: "book_error",
          source,
          message: `目录条目 "${n.label}" 的 href 无效`,
        });
      } else if (!canNavigate(href)) {
        disabled = true;
      }
    }
    return {
      ...n,
      href,
      disabled: disabled || undefined,
      children: resolveTocHrefs(n.children, basePath, issues, source, canNavigate),
    };
  });
}

/** 解析 META-INF/encryption.xml：返回受保护资源路径与算法，识别字体混淆与 DRM。 */
async function parseEncryption(
  files: Map<string, { name: string; data: Uint8Array }>,
  issues: BookIssue[]
): Promise<{ obfuscated: string[]; drm: boolean }> {
  const xml = getText(files, "META-INF/encryption.xml");
  if (!xml) return { obfuscated: [], drm: false };
  const doc = await parseXmlText(xml);
  if (hasParserError(doc)) {
    issues.push({
      kind: "book_error",
      source: "encryption.xml",
      message: "encryption.xml 解析失败，按无加密处理",
    });
    return { obfuscated: [], drm: false };
  }
  const obfuscated: string[] = [];
  let drm = false;
  const dataEls = findElements(doc.documentElement, "EncryptedData");
  for (const ed of dataEls) {
    const methodEl = findElements(ed, "EncryptionMethod")[0];
    const algo = methodEl?.getAttribute("Algorithm") ?? "";
    const refEl = findElements(ed, "CipherReference")[0];
    const uri = refEl?.getAttribute("URI") ?? "";
    const path = uri ? normalizePath(uri) : "";
    if (!path) continue;
    if (/idpf\.org\/2008\/embedding/i.test(algo)) {
      obfuscated.push(path);
    } else if (/adept|9c5c/i.test(algo)) {
      drm = true;
      issues.push({
        kind: "book_error",
        source: "encryption.xml",
        message: `资源 "${path}" 使用 DRM 加密（${algo}），无法读取`,
      });
    } else {
      issues.push({
        kind: "book_error",
        source: "encryption.xml",
        message: `资源 "${path}" 使用未知加密算法（${algo}），已跳过`,
      });
    }
  }
  return { obfuscated, drm };
}
function fallbackTocFromSpine(
  parsed: ParsedOpf,
  opfPath: string,
  issues: BookIssue[]
): TocNode[] {
  const nodes: TocNode[] = [];
  for (const item of parsed.spine) {
    if (!item.linear) continue;
    const mi = parsed.manifest.get(item.idref);
    if (!mi) continue;
    const label = mi.href.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") || mi.id;
    nodes.push({
      label,
      href: resolvePath(opfPath, mi.href),
      children: [],
    });
  }
  if (nodes.length === 0) {
    issues.push({
      kind: "book_error",
      source: "toc",
      message: "书中既没有 nav/NCX 目录，spine 也为空",
    });
  }
  return nodes;
}

async function buildToc(
  files: Map<string, { name: string; data: Uint8Array }>,
  parsed: ParsedOpf,
  opfPath: string,
  issues: BookIssue[]
): Promise<TocNode[]> {
  const manifest = parsed.manifest;
  // 找 nav 与 NCX 的 manifest item（NCX 按媒体类型识别，兼容未声明 spine@toc 的书）
  let navItem: ManifestItem | undefined;
  let ncxItem: ManifestItem | undefined;
  for (const item of manifest.values()) {
    if (item.properties.includes("nav")) navItem ??= item;
    if (item.mediaType === "application/x-dtbncx+xml") ncxItem ??= item;
  }

  // 可导航目标：spine 中各章的书内路径（目录条目目标必须在阅读流中）
  const spinePaths = new Set(
    parsed.spine
      .map((s) => manifest.get(s.idref))
      .filter((m): m is ManifestItem => Boolean(m))
      .map((m) => resolvePath(opfPath, m.href))
  );
  const canNavigate = (href: string): boolean => spinePaths.has(splitHref(href).path);

  const tryNav = async (): Promise<TocNode[] | undefined> => {
    if (!navItem) return undefined;
    const path = resolvePath(opfPath, navItem.href);
    const xml = getText(files, path);
    if (!xml) {
      issues.push({ kind: "book_error", source: "nav", message: "nav 文档缺失" });
      return undefined;
    }
    const doc = await parseXmlText(xml, "text/html");
    const nodes = parseNav(doc.documentElement);
    return resolveTocHrefs(nodes, path, issues, "nav", canNavigate);
  };

  const tryNcx = async (): Promise<TocNode[] | undefined> => {
    if (!ncxItem) return undefined;
    const path = resolvePath(opfPath, ncxItem.href);
    const xml = getText(files, path);
    if (!xml) {
      issues.push({ kind: "book_error", source: "ncx", message: "NCX 文档缺失" });
      return undefined;
    }
    const doc = await parseXmlText(xml, "application/xml");
    if (hasParserError(doc)) {
      issues.push({ kind: "book_error", source: "ncx", message: "NCX 解析失败" });
      return undefined;
    }
    const nodes = parseNcx(doc.documentElement);
    return resolveTocHrefs(nodes, path, issues, "ncx", canNavigate);
  };

  // EPUB 3：nav 优先；EPUB 2：NCX 优先；两者都缺失则用 spine 兜底
  const [navNodes, ncxNodes] = await Promise.all([tryNav(), tryNcx()]);
  if (parsed.version === 3) {
    if (navNodes && navNodes.length > 0) return navNodes;
    if (ncxNodes && ncxNodes.length > 0) return ncxNodes;
  } else {
    if (ncxNodes && ncxNodes.length > 0) return ncxNodes;
    if (navNodes && navNodes.length > 0) return navNodes;
  }
  return fallbackTocFromSpine(parsed, opfPath, issues);
}

/**
 * 加载 EPUB：解压 → 容器 → OPF → 资源清单 → 目录 → 字体混淆还原。
 * 抛错：文件损坏/非 EPUB → Error；DRM → DrmError。
 */
export async function loadBook(bytes: Uint8Array, options: BookOptions = {}): Promise<Book> {
  const issues: BookIssue[] = [];
  const files = unzipEpub(bytes);

  const containerXml = getText(files, "META-INF/container.xml");
  if (!containerXml) throw new Error("缺少 META-INF/container.xml");
  const opfPath = normalizePath(parseContainerXmlRef(containerXml));
  if (!opfPath) throw new Error("container.xml 中未指定 OPF 路径");

  const opfXml = getText(files, opfPath);
  if (!opfXml) throw new Error(`OPF 文件不存在：${opfPath}`);
  const opfDoc = await parseXmlText(opfXml, "application/xml");
  if (hasParserError(opfDoc)) {
    throw new Error(`OPF 解析失败：${opfPath}（XML 不合法）`);
  }
  const parsed = parseOpf(opfDoc.documentElement);
  issues.push(...parsed.issues);

  // ---- 资源清单 ----
  const resources = new Map<string, Resource>();
  for (const item of parsed.manifest.values()) {
    // 基准是 OPF 文件本身（其所在目录为相对引用起点）
    const path = manifestResourcePath(opfPath, item.href);
    if (!path) {
      issues.push({
        kind: "book_error",
        source: "opf:manifest",
        message: `item "${item.id}" 的 href 无效`,
      });
      continue;
    }
    const f = files.get(path);
    if (!f) {
      // 远程资源（绝对 URL，或 properties="remote-resources"）不要求容器内有文件；
      // 个别测试书声明 remote 但仍带本地副本，下面有副本时正常收录
      const remote =
        item.properties.includes("remote-resources") || isExternalUrl(item.href);
      if (remote) continue;
      issues.push({
        kind: "book_error",
        source: "opf:manifest",
        message: `manifest 声明的资源缺失：${path}`,
      });
      continue;
    }
    const mediaType = item.mediaType || guessMediaType(path);
    resources.set(path, { path, data: f.data, mediaType });
  }

  // ---- 封面 ----
  const coverHref = selectCoverHref(parsed.manifest, parsed.metaPairs, opfPath, resources);

  // ---- 加密 / 字体混淆 / DRM ----
  const { obfuscated, drm } = await parseEncryption(files, issues);
  if (drm) {
    throw new DrmError("此书受 DRM 保护，无法打开");
  }
  const uniqueId = parsed.metadata.identifier;
  for (const p of obfuscated) {
    const res = resources.get(p);
    if (res && isFontMediaType(res.mediaType)) {
      try {
        res.data = await deobfuscateFont(res.data, uniqueId);
      } catch (e) {
        issues.push({
          kind: "reader_error",
          source: "fonts",
          message: `字体混淆还原失败：${p}（${(e as Error).message}）`,
        });
      }
    } else if (res) {
      issues.push({
        kind: "book_error",
        source: "encryption.xml",
        message: `声明混淆的资源 "${p}" 不是字体，已跳过`,
      });
    }
  }

  // ---- 目录 ----
  const toc =
    options.parseToc === false
      ? []
      : await buildToc(files, parsed, opfPath, issues);

  const { fixedLayout, viewport } = renditionInfo(parsed.metaPairs, parsed.manifest);

  return {
    version: parsed.version,
    opfPath,
    metadata: parsed.metadata,
    manifest: parsed.manifest,
    spine: parsed.spine,
    guide: parsed.guide,
    toc,
    resources,
    coverHref,
    fixedLayout,
    viewport,
    issues,
    drmProtected: false,
  };
}

/** container.xml 的 rootfile full-path 提取（结构固定，正则足够稳健）。 */
function parseContainerXmlRef(xml: string): string {
  const m = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(xml);
  return m ? m[1] : "";
}

/** 由 spine 下标取该章在书内的规范化资源路径；越界返回 undefined。 */
export function spineItemPath(book: Book, index: number): string | undefined {
  const item = book.spine[index];
  if (!item) return undefined;
  const mi = book.manifest.get(item.idref);
  if (!mi) return undefined;
  return resolvePath(book.opfPath, mi.href);
}

/** 由内部路径（可含 #anchor）找对应 spine 下标（用于目录跳转）。 */
export function spineIndexForPath(book: Book, href: string): number {
  const { path } = splitHref(href);
  if (!path) return -1;
  // 已含 OPF 所在目录前缀的视为根路径，否则按相对 OPF 解析
  const opfDir = book.opfPath.includes("/")
    ? book.opfPath.slice(0, book.opfPath.lastIndexOf("/"))
    : "";
  const rooted = opfDir !== "" && (path === opfDir || path.startsWith(opfDir + "/"));
  const target = rooted ? normalizePath(path) : resolvePath(book.opfPath, path);
  for (let i = 0; i < book.spine.length; i++) {
    if (spineItemPath(book, i) === target) return i;
  }
  return -1;
}

/** 找 from 之后/之前最近的 linear（正文）章节；找不到返回 -1。 */
export function nextLinearIndex(book: Book, from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < book.spine.length; i += dir) {
    if (book.spine[i].linear) return i;
  }
  return -1;
}

/**
 * 释放整本书籍的解析资源（主要为解压的原始字节资源），
 * 彻底切断 Uint8Array / ArrayBuffer 引用，避免关书后在长期运行中被意外闭包持有。
 */
export function disposeBook(book: Book | null | undefined): void {
  if (!book) return;
  for (const res of book.resources.values()) {
    res.data = new Uint8Array(0);
  }
  book.resources.clear();
  book.manifest.clear();
  book.spine = [];
  book.guide = [];
  book.toc = [];
}
