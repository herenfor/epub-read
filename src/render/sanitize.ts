import { parseXmlText, hasParserError, getSerializer } from "../core/parseXml";
import { resolvePath, isExternalUrl, isFragmentOnly } from "../core/paths";
import { findElements, type XmlElementLike } from "../core/xml";
import { hasAuthoredCssProperty, rewriteCssInlineWidths, rewriteCssUrls } from "./cssRewrite";
import { imageLayoutPolicy, scrollMediaDefaultsCss } from "./imageLayoutPolicy";
import { TEXT_MEASURE, type ReaderSettings } from "./settings";

export interface SanitizeOptions {
  /** 章节文件的内部路径，用于解析相对引用 */
  basePath: string;
  /** EPUB 2 用严格 XML 解析；EPUB 3 用宽松 HTML 解析 */
  strictXml: boolean;
  /** 内部路径 → blob URL */
  urlFor: (path: string) => string | undefined;
  /** 读取内部资源文本（样式表内容改写用） */
  getText?: (path: string) => string | undefined;
  /** 由改写后的内容生成 URL（浏览器传 blob，测试传假实现） */
  makeUrl?: (text: string, mediaType: string) => string;
  settings: ReaderSettings;
}

export interface SanitizeResult {
  html: string;
  issues: string[];
  /** 是否发生了解析降级（XML 失败转 HTML） */
  downgraded: boolean;
}

const STRIP_TAGS = new Set([
  "script",
  "object",
  "embed",
  "iframe",
  "frame",
  "frameset",
  "base",
  "form",
  "button",
  "select",
  "textarea",
]);

/** Escape a font family for a CSS quoted string, including CSS-significant
 * control characters that could otherwise terminate or inject declarations. */
export function escapeCssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
}

/**
 * 表单整体仍会删除；只有这些不会提交、不会选择本地文件的 input 类型可留在
 * 无脚本章节中，以支持作者 CSS 的 :enabled/:disabled/:checked 状态。
 * 空 type 是 HTML 的 text 默认值，因此与显式 text 同等处理。
 */
const SAFE_INPUT_TYPES = new Set(["", "text", "checkbox", "radio"]);

export const VIEWER_ID = "epub-viewer";
const VIEWER_TAG = "epub-viewer";

/**
 * XMLSerializer escapes `>` in text nodes as `&gt;`.  Chapter output is later
 * consumed as HTML, where `<style>` is a raw-text element and character
 * references are not decoded.  Restore only that serializer escape inside
 * style text; keeping `<` escaped prevents CSS text from introducing a real
 * `</style>` end tag.
 */
function restoreStyleRawTextCombinators(serialized: string): string {
  return serialized.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_match, opening: string, text: string, closing: string) =>
      `${opening}${text.replace(/&gt;/g, ">")}${closing}`
  );
}

/** 仅接受 #hex 或安全色名，防止书里的 bgcolor 注入任意 CSS */
function isSafeColor(v: string): boolean {
  if (/^#[0-9a-fA-F]{3,8}$/.test(v.trim())) return true;
  const SAFE_NAMES = new Set([
    "white", "black", "ivory", "beige", "linen", "seashell", "floralwhite",
    "oldlace", "snow", "mistyrose", "lavender", "lavenderblush", "honeydew",
    "mintcream", "azure", "aliceblue", "lightyellow", "lightgoldenrodyellow",
    "papayawhip", "antiquewhite", "bisque", "wheat", "cornsilk",
    "lightgray", "lightgrey", "gainsboro", "silver", "gray", "grey",
    "whitesmoke", "lightblue", "lightcyan", "lightpink", "lightgreen",
  ]);
  return SAFE_NAMES.has(v.trim().toLowerCase());
}

function buildOverrideCss(s: ReaderSettings, bodyBgColor?: string): string {
  const bg =
    s.theme === "dark" ? "#1e1e1e" : s.theme === "sepia" ? "#f4ecd8" : "#ffffff";
  const fg = s.theme === "dark" ? "#d4d4d4" : s.theme === "sepia" ? "#3b2f1e" : "#1a1a1a";
  const noteUnderline = s.theme === "dark" ? "#6cb2ff" : s.theme === "sepia" ? "#9b6a00" : "#b06a00";
  const searchBackground =
    s.theme === "dark"
      ? "rgba(255, 213, 79, 0.45)"
      : s.theme === "sepia"
        ? "rgba(211, 151, 0, 0.42)"
        : "rgba(255, 196, 0, 0.42)";
  const searchForeground = "#111111";
  const family =
    s.fontFamily ??
    `"Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif`;
  const maxEm = TEXT_MEASURE.maxEm;

  // ---- L1 安全/阅读器底线：脚注 aside 必须从正文流隐藏 ----
  const securityCss = `
/* [L1 安全] 脚注内容（aside）：从正文流隐藏，由阅读器弹层显示。
   第二段兼容 script.js（LK 参考脚本）的书：<note> 内 aside 即弹注内容。 */
#${VIEWER_ID} aside[epub\\:type="footnote"],
#${VIEWER_ID} note aside { display: none !important; }`;

  // ---- L2 用户设置：行高/字重/字距/词距，书不能覆盖 ----
  const typeCss = [
    s.lineHeight !== undefined ? `line-height: ${s.lineHeight} !important;` : "",
    s.fontWeight !== undefined ? `font-weight: ${s.fontWeight} !important;` : "",
    s.letterSpacingPx !== undefined
      ? `letter-spacing: ${s.letterSpacingPx}px !important;`
      : "",
    s.wordSpacingPx !== undefined ? `word-spacing: ${s.wordSpacingPx}px !important;` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // ---- L3 阅读器默认版心：只作用于页面直接子（reader-top） ----
  // max-width 用 rem（em 相对元素自身字号，不同字号会得到不同版心宽度）；
  // max-width 用零特异性，让书类规则（.paper{max-width:30em}）可覆盖；
  // margin auto 需要 important，压过书的通用 reset（div{margin:0}）。
  const measureCss = `
/* [L3 默认版心] viewer 直接子打 reader-top 标记；嵌套元素不在默认层。 */
:where(#${VIEWER_ID} .reader-top) {
  max-width: ${maxEm}rem;
}
:where(#${VIEWER_ID}) .reader-top {
  margin-left: auto !important;
  margin-right: auto !important;
}
/* [L3-C15] viewer 顶层链接默认是 inline，包住 p/div 时版心宽度与 auto margin
   不生效。仅把已标记的页面级链接设为 block；书籍更具体的 display 仍可覆盖。 */
:where(#${VIEWER_ID} a.reader-top) {
  display: block;
}
/* [L3-C22] HTML 允许链接包住块级内容，但 inline 锚点可在多栏断点把同一
   目录项的装饰线与文字拆到两列。把这类结构当作原子导航块；选择器保持
   零特异性，书籍明确的 display / break-inside 仍可覆盖。 */
:where(#${VIEWER_ID} a:has(> :is(
  address, article, aside, blockquote, div, dl, fieldset, figure, figcaption,
  footer, h1, h2, h3, h4, h5, h6, header, hgroup, hr, main, nav, ol, p, pre,
  section, table, ul
))) {
  display: block;
  break-inside: avoid;
}`;

  // ---- L5 引擎兼容补偿：Chromium 多栏布局 bug 的最小兜底 ----
  // fit-content 的补偿改为运行时统一处理（ChapterPaginator.applyFitContentFix），
  // 这里不再为 .summary 写特判。
  const compatCss = `/* [L5-C09] fit-content 多栏异常：由分页器运行时统一补偿。 */`;

  // ---- L1 安全/L3 版式约束：图片防溢出 + 脚注图标 ----
  // 分页保留原有媒体默认值（整页填充依赖它）；滚动改用 imageLayoutPolicy 的
  // 零特异性默认值，不再给 .cover/.illus/.kuchie 等容器写满屏 !important。
  const imageDefaultsCss = imageLayoutPolicy({
    readingMode: s.readingMode,
    paginatedFillEligible: false,
  }).usePaginatedMediaDefaults
    ? `
/* [L3/L1] 正文普通图片：只限制溢出，不覆盖书定义的高度；
   object-fit:contain 保证被列宽压缩时按比例缩放不拉伸。
   用零特异性，书的 img 规则（包括 class）可覆盖。 */
:where(#${VIEWER_ID}) img { max-width: 100%; object-fit: contain; }
:where(#${VIEWER_ID}) img, :where(#${VIEWER_ID}) video, :where(#${VIEWER_ID}) svg { max-height: 100%; }
/* [L3] 全页图片块：豁免版心限制，占满一整页（正文中的插图页）。 */
#${VIEWER_ID} .illus, #${VIEWER_ID} .kuchie, #${VIEWER_ID} .cover,
#${VIEWER_ID} .duokan-image-fullscreen {
  max-width: none !important;
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  display: flex !important;
  align-items: center;
  justify-content: center;
}
#${VIEWER_ID} .illus img, #${VIEWER_ID} .kuchie img, #${VIEWER_ID} .cover img,
#${VIEWER_ID} .duokan-image-fullscreen img {
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  border: none !important;
  object-fit: contain;
}`
    : scrollMediaDefaultsCss(VIEWER_ID);
  const imageCss = `${imageDefaultsCss}
/* [L3] 脚注标记小图标：随字号缩放，middle 对齐（书常用 top 顶到上一行）。 */
#${VIEWER_ID} sup img,
#${VIEWER_ID} .duokan-footnote img,
#${VIEWER_ID} .zhangyue-footnote img {
  height: 1.2em !important;
  width: auto !important;
  max-width: none !important;
  max-height: none !important;
  vertical-align: middle;
  border: 0;
}`;

  // ---- L2 用户设置：字号/主题/字体 fallback（书 body 字体声明优先） ----
  const escapeFamily = escapeCssString;
  const fontFaceCss = (s.fontSource === "system" ? [] : (s.customFonts ?? []))
    .map(
      (f) =>
        `/* [L2] 用户上传字体 */\n@font-face { font-family: "${escapeFamily(f.family)}"; src: url("${f.url}") format("truetype"); font-display: swap; }`
    )
    .join("\n");
  const bodyFontCss = s.customFontName
    ? `font-family: "${escapeFamily(s.customFontName)}" !important;`
    : "";
  const writingModeCss = s.forceHorizontal === true
    ? `
/* [L2/C-46] 可重排章节的强制横排：覆盖书籍 html/body、分页 viewer 及其普通后代。
   SVG 本身及其后代不匹配后代选择器；SVG 书籍显式 writing-mode 仍可保留。
   祖先属性仍会作为 SVG 未声明属性的继承值，纯 CSS 无法凭空恢复未声明的书籍继承态。 */
html, body, #${VIEWER_ID},
#${VIEWER_ID} :not(svg):not(svg *) {
  writing-mode: horizontal-tb !important;
  -webkit-writing-mode: horizontal-tb !important;
  text-orientation: mixed !important;
}`
    : "";
  const themeCss = `
/* [L2] 字体 fallback 只放 html；书在 body 上的内嵌字体声明优先。 */
html { font-size: ${s.fontSizePx}px !important; font-family: ${family}; }
${fontFaceCss}
/* [L2] 主题只覆盖背景色，不用 background 简写（会重置书的 body 背景图）。
   浅色主题下安全的书籍 bgcolor 作为默认值合入这里，用户 CSS 仍在本样式末尾。 */
body { color: ${fg}; background-color: ${bodyBgColor ?? bg}; ${bodyFontCss} }
/* [L2] 笔记标记：CSS Custom Highlight 只绘制下划线，不包裹正文节点，
   因此不会改变文字几何尺寸、分页或作者选择器匹配。颜色按 iframe 主题固定，
   不依赖宿主页面变量；不设置背景，避免遮挡原书文字。 */
::highlight(reader-notes) {
  text-decoration-line: underline;
  text-decoration-style: solid;
  text-decoration-thickness: 2px;
  text-underline-offset: 0.15em;
  text-decoration-color: ${noteUnderline};
}
/* [L2] 搜索正文命中：只使用 CSS Custom Highlight 支持的绘制属性；
   背景色保证作者白字/彩字可读，笔记下划线仍可与搜索背景共存。 */
::highlight(reader-search-hit) {
  background-color: ${searchBackground};
  color: ${searchForeground};
}
/* [L2] ruby 注音 rt 随主题换色（书常固定 ruby>rt{color:#333}）。 */
#${VIEWER_ID} rt { color: ${fg}; }
${writingModeCss}
${
  s.theme === "dark"
    ? `/* [L2] 深色主题下着重号（text-emphasis）随前景色换色；
   书常写 text-emphasis:circle #000，深色背景上看不见。 */
#${VIEWER_ID} * { -webkit-text-emphasis-color: ${fg}; text-emphasis-color: ${fg}; }
/* [L2/C-45] 深色主题可读性兜底：让未自行声明 text-shadow 的文字
   继承与阅读器背景一致的阴影；作者后代的明确声明（包括 none）可覆盖。 */
#${VIEWER_ID} { text-shadow: 1px 1px 1px #1e1e1e; }
/* [L2] 深色主题目录链接换色：书常写 .toc a{color:#000}。
   与 Sigil 深色预览一致的浅蓝。 */
#${VIEWER_ID} .toc a { color: #6cb2ff; }
/* [L2] 深色主题下清除图片投影，避免在深色背景上形成白色光晕 */
#${VIEWER_ID} img { box-shadow: none !important; }`
    : ""
}`;

  const userCss = s.customCss ? `/* [L2] 用户自定义 CSS（允许覆盖） */\n${s.customCss}` : "";

  return [
    `/* [L1/L3-C21] 正文只由 viewer 分页，不使用根页面原生滚动。
   border-box 让书籍 body padding 包含在 100% 高度内，避免短章节也撑出滚动条。 */
html, body { position: relative; height: 100%; margin: 0 !important; box-sizing: border-box; overflow: hidden !important; }`,
    // 自定义容器标签不会继承 div 的默认 block display；显式声明也避免改变
    // 作者的 div p / section p 等类型选择器祖先语义。
    `/* [L3-C14] 分页容器使用专用标签，不能以 inline 默认值参与多栏测量。 */
${VIEWER_TAG}#${VIEWER_ID} { display: block; height: 100%; overflow: hidden; margin: 0 auto; box-sizing: border-box; }`,
    securityCss,
    `/* [L2] 用户排版属性（未设置 = 跟随书）。 */
:where(#${VIEWER_ID}) :not(img) {
  ${typeCss}
}`,
    measureCss,
    compatCss,
    imageCss,
    themeCss,
    userCss,
  ].join("\n");
}

/**
 * 消毒并改写章节 HTML：
 * 1. 按版本选择 XML/HTML 解析（XML 失败自动降级 HTML）
 * 2. 移除脚本与危险标签/属性
 * 3. 把内部资源引用改写为 blob URL（含 CSS url() 与内联 style）
 * 4. 注入 CSP 与阅读器覆盖 CSS（字号/主题/字体回退链/图片约束）
 */
export async function sanitizeChapter(
  htmlText: string,
  opts: SanitizeOptions
): Promise<SanitizeResult> {
  // 关键修复：XHTML 风格的自闭合 <script src="..."/> 在 HTML5 解析器里
  // 会被忽略自闭合标志（script 不在自闭合清单），导致 script 元素吞掉
  // 后续全部内容直到 EOF 上不存在的 </script>——内容全部丢失。
  // 先补成正常闭合，再由消毒循环按常规 script 删除。
  htmlText = htmlText.replace(/<script\b([^>]*?)\/\s*>/gi, "<script$1></script>");
  // 同类问题：<span class="em05"/> 等非 void 标签的自闭合写法会吞掉
  // 后续文本（如目录页 C<span/>O<span/>N... 让后面字母全变小）。
  // 统一把非 void 标签补成显式开闭标签；br/img 等 void 标签保持原样。
  htmlText = htmlText.replace(
    /<([A-Za-z][\w:.-]*)\b([^>]*?)\/\s*>/g,
    (match, tag: string, attrs: string) =>
      /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag)
        ? match
        : `<${tag}${attrs}></${tag}>`
  );

  const issues: string[] = [];
  let doc: Document;
  let downgraded = false;
  if (opts.strictXml) {
    doc = await parseXmlText(htmlText, "application/xml");
    if (hasParserError(doc)) {
      downgraded = true;
      issues.push("XHTML 严格解析失败，已降级为宽松 HTML 解析");
      doc = await parseXmlText(htmlText, "text/html");
    }
  } else {
    doc = await parseXmlText(htmlText, "text/html");
  }

  const root = doc.documentElement;
  if (!root) {
    throw new Error("章节内容为空，无法渲染");
  }

  // 1) 移除危险标签
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const inputType = (el.getAttribute("type") ?? "").trim().toLowerCase();
      if (!SAFE_INPUT_TYPES.has(inputType)) {
        el.parentNode?.removeChild(el);
        continue;
      }
    } else if (STRIP_TAGS.has(tag)) {
      el.parentNode?.removeChild(el);
      continue;
    }
    // meta refresh 防自动跳转
    if (tag === "meta") {
      const he = (el.getAttribute("http-equiv") ?? "").toLowerCase();
      if (he === "refresh") {
        el.parentNode?.removeChild(el);
        continue;
      }
    }

    // 2) 清理属性
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "src" || name === "poster" || name === "data" || name === "xlink:href") {
        const value = attr.value.trim();
        if (!value) continue;
        if (/^\s*javascript:/i.test(value)) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (isFragmentOnly(value) || isExternalUrl(value) || value.startsWith("//")) {
          continue;
        }
        const url = opts.urlFor(resolvePath(opts.basePath, value));
        if (url) {
          el.setAttribute(attr.name, url);
        } else {
          el.removeAttribute(attr.name);
          issues.push(`资源缺失，已移除引用：${value}`);
        }
      } else if (name === "href" && el.tagName.toLowerCase() === "a") {
        const value = attr.value.trim();
        if (/^\s*javascript:/i.test(value)) el.removeAttribute(attr.name);
      }
    }

    // 3) 内联 style 中的 url()
    const style = el.getAttribute("style");
    if (style) {
      el.setAttribute("style", rewriteCssUrls(style, opts.basePath, opts.urlFor));
    }
  }

  // 4) 样式表：内容改写（@import/url() → blob）+ href 指向新 blob；缺失则移除
  for (const link of Array.from(doc.getElementsByTagName("link"))) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    if (rel.includes("stylesheet")) {
      const href = link.getAttribute("href");
      if (href && !isExternalUrl(href)) {
        const cssPath = resolvePath(opts.basePath, href);
        // 优先：读取 CSS 内容并改写其内部引用（@font-face/background/@import 相对路径）
        const cssText = opts.getText?.(cssPath);
        if (cssText !== undefined && opts.makeUrl) {
          const rewritten = rewriteCssUrls(cssText, cssPath, opts.urlFor, {
            getText: opts.getText,
          });
          link.setAttribute("href", opts.makeUrl(rewritten, "text/css"));
        } else {
          const url = opts.urlFor(cssPath);
          if (url) {
            link.setAttribute("href", url);
          } else {
            link.parentNode?.removeChild(link);
            issues.push(`样式表缺失，已移除：${href}`);
          }
        }
      }
    } else {
      link.parentNode?.removeChild(link);
    }
  }

  // 4.5) 页内 <style> 块：与样式表同规则改写（url() 引用 + width:% 版心换算）
  for (const stEl of Array.from(doc.getElementsByTagName("style"))) {
    const text = stEl.textContent;
    if (text) {
      const rewritten = rewriteCssUrls(text, opts.basePath, opts.urlFor);
      while (stEl.firstChild) stEl.removeChild(stEl.firstChild);
      stEl.appendChild(doc.createTextNode(rewritten));
    }
  }

  // 5) 把正文包进分页容器（paginator 依赖 #epub-viewer 做多栏分页）
  const bodyEl = doc.getElementsByTagName("body")[0] ?? root;
  const rawBgColor = bodyEl.getAttribute("bgcolor")?.trim() ?? "";
  // 书籍 bgcolor 只作为浅色主题的安全默认背景色；深色/纸色主题保持主题色。
  // 该值只进入 background-color longhand，不会重置 body 背景图。
  const bodyBgColor =
    opts.settings.theme === "light" && rawBgColor && isSafeColor(rawBgColor)
      ? rawBgColor
      : undefined;
  // The old implementation emitted a separate bgcolor rule with !important
  // after the user CSS, so it deterministically overrode user background
  // declarations. Consume the legacy attribute after reading it, leaving one
  // theme default and the user CSS in a predictable cascade. This only affects
  // background-color; background images are not touched.
  bodyEl.removeAttribute("bgcolor");
  // 不使用 div：新增祖先必须不能改变作者 `div p` 一类类型选择器的语义。
  // 自定义标签在注入 CSS 中显式 display:block，分页器继续只依赖稳定的 id。
  const viewer = doc.createElement(VIEWER_TAG);
  // 注意用 setAttribute：xmldom 不实现 el.id 属性反射，浏览器两端通用
  viewer.setAttribute("id", VIEWER_ID);
  while (bodyEl.firstChild) {
    viewer.appendChild(bodyEl.firstChild);
  }
  bodyEl.appendChild(viewer);
  // 标记 viewer 的直接子元素：页面级内容（标题/正文段/分隔符）需要强制
  // 版心居中；嵌套元素不打标记，保留书的布局（如目录条目交错 margin）。
  // 注意用 childNodes：xmldom 不实现 element.children。
  for (let c = viewer.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const child = c as Element;
    const cls = child.getAttribute("class");
    child.setAttribute("class", cls ? `${cls} reader-top` : "reader-top");
  }

  // 5.4) 宽度百分比改写：书里的 width:X% 是按“页面≈版心”的阅读器写的，
  // 我们的页面=窗口全宽、版心=maxEm，若 % 相对整页，90% 的盒子会几乎占满整页。
  // 改写为 min(X%, X%×maxEm rem)：页面级取版心比例，窄容器（td 等）取书自己的 %。
  // 仅 0 < X ≤ 100；X > 100 是刻意出血，保持原样。
  // 跳过：img/svg（自有缩放规则）、明确全页图块内部（% 相对整页有意义）、
  // 已显式定宽祖先内部（% 应相对该祖先，保持原样）。
  const FULLPAGE_CLASS_RE =
    /(^|\s)(illus|kuchie|cover|duokan-image-fullscreen)(\s|$)/;
  const hasFullpageClass = (el: Element): boolean =>
    FULLPAGE_CLASS_RE.test(el.getAttribute("class") ?? "");
  const insideFullpage = (el: Element): boolean => {
    for (let n = el.parentNode; n && n !== viewer; n = n.parentNode) {
      if (n.nodeType === 1 && hasFullpageClass(n as Element)) return true;
    }
    return false;
  };
  const ancestorHasWidth = (el: Element): boolean => {
    for (let n = el.parentNode; n && n !== viewer; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      const e = n as Element;
      if (hasAuthoredCssProperty(e.getAttribute("style") ?? "", "width")) return true;
      if (e.getAttribute("width")) return true;
    }
    return false;
  };
  const pctToMin = (x: string): string =>
    `min(${x}%, ${(parseFloat(x) * TEXT_MEASURE.maxEm) / 100}rem)`;
  // 注意：findElements 按 localName 精确匹配，无法传 "*"，这里手动递归收集子树元素
  const allEls: Element[] = [];
  const collect = (n: Node): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        allEls.push(c as Element);
        collect(c);
      }
    }
  };
  collect(viewer);
  for (const el of allEls) {
    const tag = el.tagName.toLowerCase();
    if (tag === "img" || tag === "svg") continue;
    if (insideFullpage(el) || ancestorHasWidth(el)) continue;
    const st = el.getAttribute("style");
    if (st) {
      el.setAttribute("style", rewriteCssInlineWidths(st, TEXT_MEASURE.maxEm));
    }
    const wAttr = el.getAttribute("width");
    if (wAttr && /^\s*\d+(?:\.\d+)?\s*%\s*$/.test(wAttr)) {
      const pct = parseFloat(wAttr);
      if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
        const merged = `${el.getAttribute("style") ?? ""} width: ${pctToMin(String(pct))};`.trim();
        el.setAttribute("style", merged);
      }
    }
  }

  // 5.5) 纯图片页（封面/插图）：标记并注入整屏填充样式
  // （覆盖书里 90vh 等高度限制，object-fit:contain 保证不超出屏幕地尽量填满）
  // 支持普通 img，以及多看常见的单个 `svg > image` 页面包装。后者的
  // width/height=100% 是流体视口而非固定限宽，必须把高度从 viewer 逐层传递，
  // 否则 SVG 按 viewBox 固有比例算出超页高度却仍被分页器当作单页裁切。
  // 普通 img 仍只在没有自带固定尺寸约束时整页填充（`width:100%` 属于流体
  // 声明，不算限宽）；多图页、限宽 title 图按书自身排版，否则会把一页拆成
  // 两页 / 把限宽图放大到全屏。
  const bodyText = (bodyEl.textContent ?? "").trim();
  const images = findElements(viewer, "img");
  const svgs = findElements(viewer, "svg");
  const svgImages = findElements(viewer, "image");
  const hasOwnSize = (el: XmlElementLike): boolean => {
    const st = el.getAttribute("style") ?? "";
    if (
      ["width", "height", "max-width", "max-height", "min-width", "min-height"].some(
        (property) => hasAuthoredCssProperty(st, property)
      )
    ) {
      return true;
    }
    // xmldom 对不存在的属性返回 ""（不是 null），要按空值判断
    return Boolean(el.getAttribute("width")) || Boolean(el.getAttribute("height"));
  };
  // C-54 `width:100%` 是“跟随容器”的流体声明，不是固定限宽：纯图片页的整页
  // contain 保留同一个 100% 语义（样本 学习路线：width:100% 的路线图按版心
  // 640px 缩放成 995px 高，超过一栏后被 Chromium 拆成 3 列，多出两张空
  // 页）。只有这条唯一的流体宽度声明才放行；固定 px/em 宽度、显式高度和
  // max/min 约束仍按书自身排版，限宽 title 图不会被放大到全屏。
  const hasFluidInlineFullWidthOnly = (el: XmlElementLike): boolean => {
    const st = el.getAttribute("style") ?? "";
    const fluidWidth = /(?:^|;)\s*width\s*:\s*100(?:\.0+)?%\s*(?:!\s*important)?\s*(?:;|$)/iu;
    if (!fluidWidth.test(st)) return false;
    if (
      ["height", "max-width", "max-height", "min-width", "min-height"].some((property) =>
        hasAuthoredCssProperty(st, property)
      )
    ) {
      return false;
    }
    if (el.getAttribute("width") || el.getAttribute("height")) return false;
    return !hasAuthoredCssProperty(st.replace(fluidWidth, ";"), "width");
  };
  const svgDirectChildren =
    svgs.length === 1
      ? Array.from((svgs[0] as unknown as Element).childNodes).filter(
          (node): node is Element => node.nodeType === 1
        )
      : [];
  const isPlainImagePage =
    images.length === 1 &&
    svgs.length === 0 &&
    bodyText.length === 0 &&
    (!hasOwnSize(images[0]) || hasFluidInlineFullWidthOnly(images[0]));
  const isInlineSvgImagePage =
    images.length === 0 &&
    svgs.length === 1 &&
    svgImages.length === 1 &&
    svgDirectChildren.length === 1 &&
    svgDirectChildren[0] === (svgImages[0] as unknown as Element) &&
    Boolean(svgs[0].getAttribute("viewBox")) &&
    bodyText.length === 0;
  // 整页填充只属于分页：它把图片钉在一个页高内。滚动模式要让图片按自身比例
  // 自然流动（长图可滚动），并且不得拆掉作者的高度约束；注入整屏高度会把图
  // 压扁到一屏，注入 `width:100% + height:auto` 则会把限高的整页插图放大。
  // 策略由 imageLayoutPolicy 决定：滚动只保留类名（paginator 用它跳过 margin
  // 补偿），不再附带任何强制图片尺寸。
  const imagePolicy = imageLayoutPolicy({
    readingMode: opts.settings.readingMode,
    paginatedFillEligible: isPlainImagePage || isInlineSvgImagePage,
  });
  if (imagePolicy.viewerClass) {
    viewer.setAttribute("class", imagePolicy.viewerClass);
  }
  if (imagePolicy.fillPage) {
    const imgStyle = doc.createElement("style");
    imgStyle.setAttribute("data-reader", "fullpage-image");
    // 这里有意使用后代选择器：全页图可能被书籍自己的多层容器包裹，
    // 这些非 img 祖先都需要参与整页高度传递。
    imgStyle.textContent = `
#${VIEWER_ID}.fullpage-image :not(img):not(svg):not(image) {
  width: 100% !important;
  box-sizing: border-box !important;
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  max-width: none !important;
}
#${VIEWER_ID}.fullpage-image img,
#${VIEWER_ID}.fullpage-image svg {
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  border: none !important;
  box-shadow: none !important;
  object-fit: contain;
}
#${VIEWER_ID}.fullpage-image svg { display: block; }`;
    const headForImg = doc.head ?? doc.documentElement;
    headForImg.appendChild(imgStyle);
  }

  // 6) 注入 CSP 与阅读器覆盖样式（放在所有书样式之后，保证覆盖优先级）
  const head = doc.head ?? doc.documentElement;
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute(
    "content",
    "default-src 'none'; style-src 'unsafe-inline' blob:; img-src blob: data: https: http:; font-src blob: data:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
  );
  head.appendChild(csp);

  // 滚动模式：viewer 是唯一纵向滚动容器；分页的固定页高/整页图 100% 高度
  // 只属于分页图页。放在所有书样式之后，只在本次加载生效。
  if (opts.settings.readingMode === "scroll") {
    const scrollStyle = doc.createElement("style");
    scrollStyle.setAttribute("data-reader", "scroll-mode");
    scrollStyle.textContent = `
/* [L3 滚动] viewer 保留确定高度并自行提供纵向滚动范围：html/body 已被 L1 锁死
   不滚动，正文容器自然增高后由 viewer 提供纵向滚动，隐藏原生滚动条保持界面整洁。若这里放成 height:auto /
   overflow:visible，viewer 不再是滚动容器，scrollTop 赋值会静默失效。 */
${VIEWER_TAG}#${VIEWER_ID} {
  height: 100% !important;
  max-height: 100% !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}
${VIEWER_TAG}#${VIEWER_ID}::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
/* [L3 滚动] 滚动图片尺寸只由 buildOverrideCss 里的零特异性默认值决定，
   这里不再写 img 的 max-width/height/height:auto 覆盖或整页图祖先重置：
   那会拆掉作者的高度约束（封面/彩页被放大到约 2 屏）。 */
/* [L3 滚动] 章末自然过渡卡片与进入下一章提示 */
.reader-chapter-end {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 48px 16px 80px 16px !important;
  margin-top: 40px !important;
  user-select: none !important;
  -webkit-user-select: none !important;
  box-sizing: border-box !important;
}
.reader-chapter-end .chapter-end-divider {
  display: flex !important;
  align-items: center !important;
  width: 100% !important;
  max-width: 320px !important;
  margin-bottom: 24px !important;
  color: inherit !important;
  opacity: 0.45 !important;
  font-size: 13px !important;
  letter-spacing: 2px !important;
}
.reader-chapter-end .chapter-end-divider::before,
.reader-chapter-end .chapter-end-divider::after {
  content: "" !important;
  flex: 1 !important;
  border-bottom: 1px dashed currentColor !important;
  opacity: 0.6 !important;
}
.reader-chapter-end .chapter-end-divider span {
  padding: 0 12px !important;
  white-space: nowrap !important;
}
.reader-chapter-end .chapter-end-next-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 8px 24px !important;
  font-size: 14px !important;
  font-weight: 500 !important;
  color: inherit !important;
  background: rgba(128, 128, 128, 0.12) !important;
  border: 1px solid rgba(128, 128, 128, 0.25) !important;
  border-radius: 20px !important;
  cursor: pointer !important;
  transition: all 0.2s ease !important;
  outline: none !important;
}
.reader-chapter-end .chapter-end-next-btn:hover {
  background: rgba(128, 128, 128, 0.22) !important;
  border-color: rgba(128, 128, 128, 0.45) !important;
  transform: translateY(-1px) !important;
}
.reader-chapter-end .chapter-end-next-btn:active {
  transform: translateY(0) !important;
  opacity: 0.8 !important;
}
.reader-chapter-end .chapter-end-hint {
  margin-top: 12px !important;
  font-size: 12px !important;
  color: inherit !important;
  opacity: 0.4 !important;
  letter-spacing: 0.5px !important;
}`;
    head.appendChild(scrollStyle);
  }

  const styleEl = doc.createElement("style");
  styleEl.setAttribute("data-reader", "overrides");
  styleEl.textContent = buildOverrideCss(opts.settings, bodyBgColor);
  head.appendChild(styleEl);

  const serialized = (await getSerializer()).serializeToString(doc);
  const html = restoreStyleRawTextCombinators(serialized);
  return { html, issues, downgraded };
}
