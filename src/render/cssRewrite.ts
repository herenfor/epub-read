import { resolveArchiveHref, type ArchiveReferences } from "../core/archiveReferences";
import { isExternalUrl } from "../core/paths";
import { TEXT_MEASURE } from "./settings";

function resolveOrKeep(
  raw: string,
  basePath: string,
  resolveUrl: (path: string) => string | undefined,
  match: string,
  references?: ArchiveReferences
): string {
  const trimmed = raw.trim();
  if (!trimmed) return match;
  if (isExternalUrl(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("#")) {
    return match;
  }
  const { path: resolved, anchor } = resolveArchiveHref(references, basePath, trimmed);
  const url = resolveUrl(resolved);
  if (!url) return match; // 资源缺失：保留原样，由浏览器静默失败
  return `url("${url}${anchor ? `#${references ? encodeURIComponent(anchor) : anchor}` : ""}")`;
}

export interface CssRewriteOptions {
  archiveReferences?: ArchiveReferences;
  /** 读取书内 CSS 文本（递归处理 @import 链用） */
  getText?: (path: string) => string | undefined;
  /** 已内联的样式表路径（防循环 @import） */
  seen?: Set<string>;
}

interface CssCommentContext {
  comments: Map<string, string>;
  nextId: number;
  nonce: string;
}

let commentContextSequence = 0;

function createCommentContext(): CssCommentContext {
  const sequence = commentContextSequence++;
  return {
    comments: new Map(),
    nextId: 0,
    // Private-use sentinels plus a context nonce make accidental author-text
    // collisions vanishingly unlikely while keeping the internal pass cheap.
    nonce: `${Date.now().toString(36)}-${sequence.toString(36)}`,
  };
}

/**
 * CSS 注释扫描器：只在 normal 状态识别 `/* ... *\/`；引号内的相同字符
 * 属于字符串内容，反斜杠会跳过下一个字符。未闭合注释保护到文本末尾。
 */
function protectCssComments(css: string, context: CssCommentContext): string {
  let out = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < css.length) {
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const start = i;
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      let token = `\uE000reader-css-comment-${context.nonce}-${context.nextId++}\uE001`;
      while (css.includes(token) || context.comments.has(token)) {
        token = `\uE000reader-css-comment-${context.nonce}-${context.nextId++}\uE001`;
      }
      context.comments.set(token, css.slice(start, i));
      out += token;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function restoreCssComments(css: string, context: CssCommentContext): string {
  let out = css;
  for (const [token, comment] of context.comments) out = out.split(token).join(comment);
  return out;
}

/** 去掉注释但保留字符串，用于只读 CSS 声明来源的启发式判断。 */
export function stripCssComments(css: string): string {
  const context = createCommentContext();
  let out = protectCssComments(css, context);
  for (const token of context.comments.keys()) out = out.split(token).join(" ");
  return out;
}

function stripProtectedCssComments(css: string, context: CssCommentContext): string {
  let out = stripCssComments(css);
  for (const token of context.comments.keys()) out = out.split(token).join(" ");
  return out;
}

/** 判断 inline style 中是否存在注释外的 authored CSS 属性声明。 */
export function hasAuthoredCssProperty(css: string, property: string): boolean {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[;{])\\s*${escaped}\\s*:`, "i").test(stripCssComments(css));
}

function mapCssImports(css: string, replace: (match: string, href: string, suffix: string) => string): string {
  return css.replace(
    /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/gi,
    (match, dq, sq, bare, sdq, ssq, suffix) =>
      replace(match, (dq ?? sq ?? bare ?? sdq ?? ssq ?? "").trim(), suffix ?? ""),
  );
}

function mapCssUrls(css: string, replace: (match: string, href: string) => string): string {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi,
    (match, dq, sq, bare) => replace(match, (dq ?? sq ?? bare ?? "").trim()));
}

/** The dependency graph uses exactly the same reference syntax as rewriting. */
export function cssResourceReferences(css: string): Array<{ href: string; stylesheet: boolean }> {
  const refs: Array<{ href: string; stylesheet: boolean }> = [];
  const rest = mapCssImports(stripCssComments(css), (_match, href) => {
    refs.push({ href, stylesheet: true });
    return "";
  });
  mapCssUrls(rest, (match, href) => {
    refs.push({ href, stylesheet: false });
    return match;
  });
  return refs;
}

function hasCombinator(selector: string, context: CssCommentContext): boolean {
  const s = stripProtectedCssComments(selector, context).trim();
  if (!s || s.startsWith("@")) return false;
  return s.split(",").some((part) => /[\s>+~]/.test(part.trim()));
}

function isBareTypeSelector(selector: string, context: CssCommentContext): boolean {
  const s = stripProtectedCssComments(selector, context).trim();
  if (!s || s.startsWith("@")) return false;
  return !/[.#]/.test(s);
}

/** Rewrites a protected stylesheet. The caller owns comment protection. */
function rewriteWidthDeclarations(css: string, maxEm: number, context: CssCommentContext): string {
  return css.replace(/([^{}]*\{)([^{}]*\})/g, (block, head: string, body: string) => {
    const selector = head.replace(/\s*\{$/, "");
    if (
      /(illus|kuchie|cover|duokan-image-fullscreen|\bimg\b|\bsvg\b|\bhtml\b|\bbody\b)/i.test(
        stripProtectedCssComments(selector, context)
      ) ||
      hasCombinator(selector, context) ||
      isBareTypeSelector(selector, context) ||
      /(?:^|;)\s*float\s*:/i.test(stripProtectedCssComments(body, context))
    ) {
      return block;
    }
    return (
      head +
      body.replace(
        /(^|[;{]|\uE000reader-css-comment-[^\uE001]*\uE001)(\s*)width\s*:\s*(\d+(?:\.\d+)?)\s*%/gi,
        (_w, pre: string, sp: string, x: string) => {
          const pct = parseFloat(x);
          if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return _w;
          return `${pre}${sp}width: min(${x}%, ${(pct * maxEm) / 100}rem)`;
        }
      )
    );
  });
}

function rewriteInlineWidthDeclarations(css: string, maxEm: number): string {
  return css.replace(
    /(^|[;{]|\uE000reader-css-comment-[^\uE001]*\uE001)(\s*)width\s*:\s*(\d+(?:\.\d+)?)\s*%/gi,
    (_w, pre: string, sp: string, x: string) => {
      const pct = parseFloat(x);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return _w;
      return `${pre}${sp}width: min(${x}%, ${(pct * maxEm) / 100}rem)`;
    }
  );
}

/**
 * 重写 CSS 中的引用：
 * 1. @import "x.css" / @import url(x.css)：优先读取并递归内联（宽度换算与
 *    url() 相对路径都以被导入文件的位置为基准）；读不到时退回 blob @import
 * 2. 其余 url(...)（@font-face src、background 等）
 * 相对书内路径 → blob URL；外部/data:/blob:/# 保持原样。
 */
function rewriteCssUrlsInternal(
  css: string,
  basePath: string,
  resolveUrl: (path: string) => string | undefined,
  options: CssRewriteOptions,
  context: CssCommentContext
): string {
  // Protect once per recursion level. Tokens are shared with the root so a
  // child stylesheet's restored comments can never be seen by a parent pass.
  let out = protectCssComments(css, context);
  // 先处理 @import（裸字符串与 url() 两种写法，保留媒体后缀）
  out = mapCssImports(out, (match, raw, suffix) => {
    if (!raw || /^(data:|blob:|https?:|mailto:|#|\/\/)/i.test(raw)) return match;
    const resolved = resolveArchiveHref(options.archiveReferences, basePath, raw).path;
    // 能读到内容就递归内联：width:%→em、url()→blob 都以被导入文件为基准，
    // 也避免 blob 样式表里的相对路径失效
    const importedText = options.getText?.(resolved);
    if (importedText !== undefined) {
      const seen = new Set(options.seen ?? []);
      if (seen.has(resolved)) {
        return protectCssComments(`/* 循环 @import 已跳过：${raw} */`, context);
      }
      seen.add(resolved);
      const rewritten = rewriteCssUrlsInternal(importedText, resolved, resolveUrl, { ...options, seen }, context);
      const note = `/* @import ${raw} → 内联 */`;
      const media = suffix?.trim();
      const protectedNote = protectCssComments(note, context);
      return media
        ? `${protectedNote}\n@media ${media} {\n${rewritten}\n}`
        : `${protectedNote}\n${rewritten}`;
    }
    const url = resolveUrl(resolved);
    if (!url) return match;
    return `@import url("${url}")${suffix ?? ""};`;
  });
  // 再处理其余 url(...)
  out = mapCssUrls(out, (match, href) => resolveOrKeep(href, basePath, resolveUrl, match, options.archiveReferences));
  // width:X% → 改写为 min(X%, X%×40rem)（与 sanitize 的 DOM 级重写配套）。
  // 书的 % 是按“页面≈版心”的阅读器写的，我们的页面=窗口全宽；
  // min() 保留两个候选让浏览器按真实包含块取值：
  //   - 页面级元素：% 相对窗口（1311px 等），min 取版心比例值，维持 90%→576px 的语义；
  //   - 窄容器元素（td / authorbox / 浮动父容器）：% 相对窄包含块，
  //     min 取书自己的 %，不再被固定 em 拉宽溢出。
  // 仅改写 0 < X ≤ 100；X > 100 表示刻意超出包含块（出血），原样保留。
  // 跳过规则：全页图块（% 相对整页有意义）、img/svg/html/body 选择器，
  // 以及带组合器（后代/子代等）的嵌套选择器——它们的 % 相对某个限宽
  // 父容器（如 .authorbox table{width:100%}），改写会破坏书布局。
  out = rewriteWidthDeclarations(out, TEXT_MEASURE.maxEm, context);
  return out;
}

export function rewriteCssUrls(
  css: string,
  basePath: string,
  resolveUrl: (path: string) => string | undefined,
  options: CssRewriteOptions = {}
): string {
  const context = createCommentContext();
  return restoreCssComments(
    rewriteCssUrlsInternal(css, basePath, resolveUrl, options, context),
    context
  );
}

/** Rewrite percentage widths in an inline style without touching comments. */
export function rewriteCssInlineWidths(css: string, maxEm = TEXT_MEASURE.maxEm): string {
  const context = createCommentContext();
  const protectedCss = protectCssComments(css, context);
  return restoreCssComments(rewriteInlineWidthDeclarations(protectedCss, maxEm), context);
}
