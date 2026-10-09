import { detectArchiveReferences, archiveHref, archiveRootPath, type ArchiveReferences } from "./archiveReferences";
import { unzipEpub, bytesToText } from "./zip";
import { parseOpf, renditionInfo, type ParsedOpf } from "./opf";
import { parseNcx } from "./ncx";
import { parseNav, isUsableHref } from "./nav";
import { findElements } from "./xml";
import { parseXmlText, hasParserError } from "./parseXml";
import { normalizePath, resolvePath, isExternalUrl, isFragmentOnly, splitHref } from "./paths";
import { isFontMediaType, guessMediaType } from "./mime";
import { deobfuscateFont } from "./fonts";
import { createArchiveClient, type ArchiveClient } from "./selectiveArchive";
import { archiveBootstrapPaths } from "./archiveBootstrapPaths";
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

/** Separate href suffixes before decoding; literal ?/# may belong to the ZIP name. */
function manifestResourcePath(opfPath: string, href: string, references?: ArchiveReferences): string {
  if (references) return references.resolve(opfPath, href).path;
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
  resources: Map<string, Resource>,
  references?: ArchiveReferences
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
    ...items.filter((item) => hasCoverFilename(manifestResourcePath(opfPath, item.href, references)))
  );

  for (const item of candidates) {
    const path = manifestResourcePath(opfPath, item.href, references);
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
  canNavigate: (resolvedHref: string) => boolean,
  references?: ArchiveReferences
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
      if (canNavigate(archiveHref(references, basePath))) {
        const fragment = rawHref.slice(1);
        href = references ? references.href(basePath, references.resolve(basePath, rawHref).anchor) : archiveHref(undefined, basePath, fragment);
      } else {
        disabled = true;
      }
    } else if (!usable) {
      disabled = true;
    } else {
      if (references) {
        const target = references.resolve(basePath, href);
        href = target.path ? references.href(target.path, target.anchor) : "";
      } else href = resolvePath(basePath, href);
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
      children: resolveTocHrefs(n.children, basePath, issues, source, canNavigate, references),
    };
  });
}

/** 解析 META-INF/encryption.xml：返回受保护资源路径与算法，识别字体混淆与 DRM。 */
async function parseEncryption(
  files: Map<string, { name: string; data: Uint8Array }>,
  issues: BookIssue[],
  references?: ArchiveReferences
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
    const path = uri ? (archiveRootPath(references, uri) || uri) : "";
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
  issues: BookIssue[],
  references?: ArchiveReferences
): TocNode[] {
  const nodes: TocNode[] = [];
  for (const item of parsed.spine) {
    if (!item.linear) continue;
    const mi = parsed.manifest.get(item.idref);
    if (!mi) continue;
    const label = mi.href.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") || mi.id;
    nodes.push({
      label,
      href: archiveHref(references, manifestResourcePath(opfPath, mi.href, references)),
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
  issues: BookIssue[],
  references?: ArchiveReferences
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
      .map((m) => manifestResourcePath(opfPath, m.href, references))
  );
  const canNavigate = (href: string): boolean => spinePaths.has(references ? references.resolve(opfPath, href).path : splitHref(href).path);

  const tryNav = async (): Promise<TocNode[] | undefined> => {
    if (!navItem) return undefined;
    const path = manifestResourcePath(opfPath, navItem.href, references);
    const xml = getText(files, path);
    if (!xml) {
      issues.push({ kind: "book_error", source: "nav", message: "nav 文档缺失" });
      return undefined;
    }
    const doc = await parseXmlText(xml, "text/html");
    const nodes = parseNav(doc.documentElement);
    return resolveTocHrefs(nodes, path, issues, "nav", canNavigate, references);
  };

  const tryNcx = async (): Promise<TocNode[] | undefined> => {
    if (!ncxItem) return undefined;
    const path = manifestResourcePath(opfPath, ncxItem.href, references);
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
    return resolveTocHrefs(nodes, path, issues, "ncx", canNavigate, references);
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
  return fallbackTocFromSpine(parsed, opfPath, issues, references);
}

/**
 * 加载 EPUB：解压 → 容器 → OPF → 资源清单 → 目录 → 字体混淆还原。
 * 抛错：文件损坏/非 EPUB → Error；DRM → DrmError。
/**
 * 按需解压加载 EPUB：仅提取包结构、目录与正文文本清单，图像/多媒体等大二进制资源按需解压。
 */
export async function loadBookSelective(
  bytes: Uint8Array,
  options: BookOptions = {}
): Promise<Book> {
  const archiveClient = await createArchiveClient(bytes);
  return loadBookSelectiveWithArchive(archiveClient, options);
}

/**
 * 按需解压加载 EPUB，归档客户端由调用方提供。返回的 Book 持有归档所有权；
 * 本函数在加载失败时关闭归档。Android 原生路径用它避免整本 EPUB 跨 IPC。
 */
export async function loadBookSelectiveWithArchive(
  archiveClient: ArchiveClient,
  options: BookOptions = {}
): Promise<Book> {
  const issues: BookIssue[] = [];
  const references = detectArchiveReferences(archiveClient.directory);

  try {
    const initFiles = await archiveClient.extract(["mimetype", "META-INF/container.xml"]);
    const containerData = initFiles.get("META-INF/container.xml");
    if (!containerData) throw new Error("缺少 META-INF/container.xml");
    const containerXml = bytesToText(containerData);
    const opfPath = archiveRootPath(references, parseContainerXmlRef(containerXml));
    if (!opfPath) throw new Error("container.xml 中未指定 OPF 路径");

    const opfFiles = await archiveClient.extract([opfPath]);
    const opfData = opfFiles.get(opfPath);
    if (!opfData) throw new Error(`OPF 文件不存在：${opfPath}`);
    const opfDoc = await parseXmlText(bytesToText(opfData), "application/xml");
    if (hasParserError(opfDoc)) {
      throw new Error(`OPF 解析失败：${opfPath}（XML 不合法）`);
    }
    const parsed = parseOpf(opfDoc.documentElement);
    issues.push(...parsed.issues);

    // ---- 加密 / 字体混淆 / DRM ----
    let obfuscated: string[] = [];
    if (archiveClient.directory.has("META-INF/encryption.xml")) {
      const encFiles = await archiveClient.extract(["META-INF/encryption.xml"]);
      const encData = encFiles.get("META-INF/encryption.xml");
      if (encData) {
        const encMap = new Map([
          ["META-INF/encryption.xml", { name: "META-INF/encryption.xml", data: encData }],
        ]);
        const encResult = await parseEncryption(encMap, issues, references);
        if (encResult.drm) {
          throw new DrmError("此书受 DRM 保护，无法打开");
        }
        obfuscated = encResult.obfuscated;
      }
    }
    const obfuscatedFonts = new Set(obfuscated);

    // 原生 Android 只解 buildToc 实际使用的首个 nav/NCX；Web/Windows 保持
    // 历史上所有 manifest 文本条目的首轮快速解压。
    const textPathsToExtract = new Set<string>();
    if (options.bootstrap === "native") {
      for (const path of archiveBootstrapPaths(
        opfPath,
        parsed.manifest,
        archiveClient.directory,
        options.parseToc !== false,
        references,
      )) {
        textPathsToExtract.add(path);
      }
    } else {
      for (const item of parsed.manifest.values()) {
        const path = manifestResourcePath(opfPath, item.href, references);
        if (!path || !archiveClient.directory.has(path)) continue;
        const mt = (item.mediaType || guessMediaType(path)).toLowerCase();
        if (
          mt.includes("html") ||
          mt.includes("xml") ||
          mt.includes("css") ||
          mt.includes("text") ||
          path.endsWith(".xhtml") ||
          path.endsWith(".html") ||
          path.endsWith(".css") ||
          path.endsWith(".xml") ||
          path.endsWith(".ncx")
        ) {
          textPathsToExtract.add(path);
        }
      }
    }

    const extractedTextMap = await archiveClient.extract(Array.from(textPathsToExtract));
    const allExtractedFiles = new Map<string, { name: string; data: Uint8Array }>();
    for (const [p, d] of initFiles) allExtractedFiles.set(p, { name: p, data: d });
    for (const [p, d] of opfFiles) allExtractedFiles.set(p, { name: p, data: d });
    for (const [p, d] of extractedTextMap) allExtractedFiles.set(p, { name: p, data: d });

    // ---- 目录 ----
    const toc =
      options.parseToc === false
        ? []
        : await buildToc(allExtractedFiles, parsed, opfPath, issues, references);

    // ---- 资源清单 ----
    const resources = new Map<string, Resource>();
    for (const item of parsed.manifest.values()) {
      const path = manifestResourcePath(opfPath, item.href, references);
      if (!path) {
        issues.push({
          kind: "book_error",
          source: "opf:manifest",
          message: `item "${item.id}" 的 href 无效`,
        });
        continue;
      }
      const isArchived = archiveClient.directory.has(path);
      if (!isArchived) {
        const remote = item.properties.includes("remote-resources") || isExternalUrl(item.href);
        if (remote) continue;
        issues.push({
          kind: "book_error",
          source: "opf:manifest",
          message: `manifest 声明的资源缺失：${path}`,
        });
        continue;
      }
      const mediaType = item.mediaType || guessMediaType(path);
      const preloadedData = extractedTextMap.get(path);
      if (preloadedData) {
        resources.set(path, { path, data: preloadedData, mediaType, loaded: true });
      } else {
        resources.set(path, { path, data: new Uint8Array(0), mediaType, loaded: false });
      }
    }

    // ---- 封面与初始章节识别 ----
    const coverHref = selectCoverHref(parsed.manifest, parsed.metaPairs, opfPath, resources, references);

    const uniqueId = parsed.metadata.identifier;

    /**
     * 同一路径的按需解压只保留一个 Promise。并发调用命中同一批资源时复用
     * 正在进行的解压，而不是重复 inflate 同一 ZIP 项。
     */
    const pendingResourceLoads = new Map<string, Promise<void>>();
    const ensureResources = async (paths: Iterable<string>): Promise<void> => {
      const awaited = new Set<Promise<void>>();
      const toFetch: string[] = [];
      for (const p of new Set(paths)) {
        const res = resources.get(p);
        if (!res || res.loaded !== false) continue;
        const pending = pendingResourceLoads.get(p);
        if (pending) {
          awaited.add(pending);
          continue;
        }
        if (archiveClient.directory.has(p)) toFetch.push(p);
      }

      if (toFetch.length > 0) {
        let resolveBatch!: () => void;
        let rejectBatch!: (error: unknown) => void;
        const batchPromise = new Promise<void>((resolve, reject) => {
          resolveBatch = resolve;
          rejectBatch = reject;
        });
        for (const p of toFetch) pendingResourceLoads.set(p, batchPromise);
        awaited.add(batchPromise);
        void (async () => {
          try {
            const batchResult = await archiveClient.extract(toFetch);
            for (const p of toFetch) {
              const data = batchResult.get(p);
              const res = resources.get(p);
              if (!res || data === undefined) continue;
              if (obfuscatedFonts.has(p) && isFontMediaType(res.mediaType)) {
                try {
                  res.data = await deobfuscateFont(data, uniqueId);
                } catch (e) {
                  res.data = data;
                  issues.push({
                    kind: "reader_error",
                    source: "fonts",
                    message: `字体混淆还原失败：${p}（${(e as Error).message}）`,
                  });
                }
              } else {
                res.data = data;
              }
              res.loaded = true;
            }
            resolveBatch();
          } catch (error) {
            rejectBatch(error);
          } finally {
            for (const p of toFetch) {
              if (pendingResourceLoads.get(p) === batchPromise) {
                pendingResourceLoads.delete(p);
              }
            }
          }
        })();
      }

      if (awaited.size > 0) await Promise.all(awaited);
    };

    const readResource = async (path: string): Promise<Uint8Array | undefined> => {
      let res = resources.get(path);
      if (res && res.loaded !== false) return res.data;
      await ensureResources([path]);
      res = resources.get(path);
      return res && res.loaded !== false ? res.data : undefined;
    };

    // 若封面存在且属于图片候选，按入口需要提前解压。原生 reader/index
    // 不预解封面，避免把书架封面预算和首屏资源峰值混在一起。
    if (
      options.preloadCover !== false &&
      coverHref &&
      resources.has(coverHref) &&
      !resources.get(coverHref)!.loaded
    ) {
      await ensureResources([coverHref]);
    }

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
      archiveReferences: references,
      coverHref,
      fixedLayout,
      viewport,
      issues,
      drmProtected: false,
      ensureResources,
      readResource,
      archive: { close: () => archiveClient.close() },
    };
  } catch (err) {
    archiveClient.close();
    throw err;
  }
}

/** 使用已建立的 ArchiveClient 加载 EPUB（供 Android 原生按需归档路径使用）。 */
export async function loadBookFromArchive(
  archiveClient: ArchiveClient,
  options: BookOptions = {}
): Promise<Book> {
  return loadBookSelectiveWithArchive(archiveClient, {
    bootstrap: "native",
    preloadCover: false,
    ...options,
  });
}

/**
 * 加载 EPUB：解压 → 容器 → OPF → 资源清单 → 目录 → 字体混淆还原。
 * 抛错：文件损坏/非 EPUB → Error；DRM → DrmError。
 */
export async function loadBook(bytes: Uint8Array, options: BookOptions = {}): Promise<Book> {
  if (options.selective === true) {
    return loadBookSelective(bytes, options);
  }
  const issues: BookIssue[] = [];
  const files = unzipEpub(bytes);
  const references = detectArchiveReferences(files);

  const containerXml = getText(files, "META-INF/container.xml");
  if (!containerXml) throw new Error("缺少 META-INF/container.xml");
  const opfPath = archiveRootPath(references, parseContainerXmlRef(containerXml));
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
    const path = manifestResourcePath(opfPath, item.href, references);
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
    resources.set(path, { path, data: f.data, mediaType, loaded: true });
  }

  // ---- 封面 ----
  const coverHref = selectCoverHref(parsed.manifest, parsed.metaPairs, opfPath, resources, references);

  // ---- 加密 / 字体混淆 / DRM ----
  const { obfuscated, drm } = await parseEncryption(files, issues, references);
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
      : await buildToc(files, parsed, opfPath, issues, references);

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
    archiveReferences: references,
    coverHref,
    fixedLayout,
    viewport,
    issues,
    drmProtected: false,
    ensureResources: async () => {},
    readResource: async (path: string) => resources.get(path)?.data,
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
  return book.archiveReferences ? book.archiveReferences.resolve(book.opfPath, mi.href).path : resolvePath(book.opfPath, mi.href);
}

/** Navigation reference for a spine item; never pass a raw ZIP key to an href consumer. */
export function spineItemHref(book: Book, index: number): string | undefined {
  const path = spineItemPath(book, index);
  return path ? archiveHref(book.archiveReferences, path) : undefined;
}

/** Resolve an already-decoded archive identity without interpreting URI punctuation. */
export function spineIndexForEntryKey(book: Book, path: string): number {
  return book.spine.findIndex((_item, i) => spineItemPath(book, i) === path);
}

/** Resolve a navigation href (as distinct from a saved archive identity). */
export function spineIndexForPath(book: Book, href: string): number {
  if (book.archiveReferences) return spineIndexForEntryKey(book, book.archiveReferences.resolve(book.opfPath, href).path);
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
  book.archive?.close();
  for (const res of book.resources.values()) {
    res.data = new Uint8Array(0);
    res.loaded = false;
  }
  book.resources.clear();
  book.archiveReferences = undefined;
  book.manifest.clear();
  book.spine = [];
  book.guide = [];
  book.toc = [];
}
