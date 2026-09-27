import { isExternalUrl, isFragmentOnly, resolvePath, splitHref } from "../core/paths";
import type { Book } from "../core/types";

function extractUrlsFromCss(css: string): string[] {
  const urls: string[] = [];
  // 匹配 url(...)
  const urlRegex = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(css)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw && !isExternalUrl(raw) && !raw.startsWith("data:") && !raw.startsWith("blob:") && !raw.startsWith("#")) {
      urls.push(raw);
    }
  }
  return urls;
}

function extractImportsFromCss(css: string): string[] {
  const imports: string[] = [];
  const importRegex = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(css)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
    if (raw && !isExternalUrl(raw) && !raw.startsWith("data:") && !raw.startsWith("blob:") && !raw.startsWith("#")) {
      imports.push(raw);
    }
  }
  return imports;
}

/**
 * 递归收集样式表及其 @import 和 url() 依赖。
 */
function collectStylesheetDependencies(
  cssPath: string,
  getText: (path: string) => string | undefined,
  deps: Set<string>,
  seenCss: Set<string>
): void {
  if (seenCss.has(cssPath)) return;
  seenCss.add(cssPath);
  deps.add(cssPath);

  const text = getText(cssPath);
  if (!text) return;

  // 递归处理 @import
  for (const imp of extractImportsFromCss(text)) {
    const resolved = resolvePath(cssPath, splitHref(imp).path);
    if (resolved) {
      collectStylesheetDependencies(resolved, getText, deps, seenCss);
    }
  }

  // 提取 url(...) 中的字体或背景图片
  for (const url of extractUrlsFromCss(text)) {
    const resolved = resolvePath(cssPath, splitHref(url).path);
    if (resolved) {
      deps.add(resolved);
    }
  }
}

/**
 * 解析并收集一个章节文档运行渲染所需的所有直接和间接书内资源依赖：
 * - 章节 XHTML 本身
 * - 外链 CSS 及其递归 @import
 * - CSS 内引用的字体与背景图
 * - <img> / <image> / <use> / srcset 图像
 * - 内联 style 属性中的 url()
 */
export function collectChapterDependencies(
  book: Book,
  chapterPath: string,
  getText: (path: string) => string | undefined
): Set<string> {
  const deps = new Set<string>();
  deps.add(chapterPath);

  const html = getText(chapterPath);
  if (!html) return deps;

  const seenCss = new Set<string>();

  // 1. <link rel="stylesheet" href="...">
  const linkRegex = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const tag = linkMatch[0];
    if (/rel\s*=\s*["'][^"']*stylesheet[^"']*["']/i.test(tag)) {
      const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (hrefMatch) {
        const raw = hrefMatch[1].trim();
        if (!isExternalUrl(raw) && !isFragmentOnly(raw)) {
          const resolved = resolvePath(chapterPath, splitHref(raw).path);
          if (resolved) {
            collectStylesheetDependencies(resolved, getText, deps, seenCss);
          }
        }
      }
    }
  }

  // 2. <style>...</style> 块
  const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleBlockRegex.exec(html)) !== null) {
    const cssText = styleMatch[1];
    for (const imp of extractImportsFromCss(cssText)) {
      const resolved = resolvePath(chapterPath, splitHref(imp).path);
      if (resolved) {
        collectStylesheetDependencies(resolved, getText, deps, seenCss);
      }
    }
    for (const url of extractUrlsFromCss(cssText)) {
      const resolved = resolvePath(chapterPath, splitHref(url).path);
      if (resolved) {
        deps.add(resolved);
      }
    }
  }

  // 3. <img> 标签与 srcset
  const imgRegex = /<img\b[^>]*>/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const tag = imgMatch[0];
    const srcMatch = /src\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (srcMatch) {
      const raw = srcMatch[1].trim();
      if (!isExternalUrl(raw) && !raw.startsWith("data:") && !raw.startsWith("blob:") && !isFragmentOnly(raw)) {
        const resolved = resolvePath(chapterPath, splitHref(raw).path);
        if (resolved) deps.add(resolved);
      }
    }
    const srcsetMatch = /srcset\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (srcsetMatch) {
      const candidates = srcsetMatch[1].split(",");
      for (const cand of candidates) {
        const url = cand.trim().split(/\s+/)[0];
        if (url && !isExternalUrl(url) && !url.startsWith("data:") && !url.startsWith("blob:") && !isFragmentOnly(url)) {
          const resolved = resolvePath(chapterPath, splitHref(url).path);
          if (resolved) deps.add(resolved);
        }
      }
    }
  }

  // 4. SVG <image> 与 <use>
  const svgImgRegex = /<(?:image|use)\b[^>]*>/gi;
  let svgMatch: RegExpExecArray | null;
  while ((svgMatch = svgImgRegex.exec(html)) !== null) {
    const tag = svgMatch[0];
    const hrefMatch = /(?:xlink:href|href)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (hrefMatch) {
      const raw = hrefMatch[1].trim();
      if (!isExternalUrl(raw) && !raw.startsWith("data:") && !raw.startsWith("blob:") && !isFragmentOnly(raw)) {
        const resolved = resolvePath(chapterPath, splitHref(raw).path);
        if (resolved) deps.add(resolved);
      }
    }
  }

  // 5. 内联 style 属性中的 url(...)
  const inlineStyleRegex = /\bstyle\s*=\s*["']([^"']+)["']/gi;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineStyleRegex.exec(html)) !== null) {
    const css = inlineMatch[1];
    for (const url of extractUrlsFromCss(css)) {
      const resolved = resolvePath(chapterPath, splitHref(url).path);
      if (resolved) deps.add(resolved);
    }
  }

  // 只保留存在于书内资源清单中的路径
  const validDeps = new Set<string>();
  for (const dep of deps) {
    if (book.resources.has(dep)) {
      validDeps.add(dep);
    }
  }
  return validDeps;
}
