import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { escapeCssString, sanitizeChapter, VIEWER_ID } from "./sanitize";
import { DEFAULT_SETTINGS } from "./settings";

function opts(basePath = "OEBPS/Text/ch1.xhtml") {
  return {
    basePath,
    strictXml: true,
    // 模拟资源缺失：含 missing 的路径解析不到
    urlFor: (p: string) => (p.includes("missing") ? undefined : `blob:test/${p}`),
    settings: DEFAULT_SETTINGS,
  };
}

/** 读取注入样式节点的 CSS 文本，避免整份 HTML 断言误伤其他合法规则。 */
function readStyleText(out: string, marker: string): string {
  const { document } = parseHTML(out);
  return document.querySelector(`style[data-reader="${marker}"]`)?.textContent ?? "";
}

describe("font family CSS escaping", () => {
  it("escapes quote, slash and CSS control characters", () => {
    const escaped = escapeCssString('A\\B"C\r\n\f');
    expect(escaped).toBe('A\\\\B\\"C\\d \\a \\c ');
    expect(escaped).not.toMatch(/[\r\n\f]/);
  });
});

function expectCombinatorsAndEscaping(out: string): void {
  expect(out).toContain(".parent>.direct { color: red; }");
  expect(out).toContain(".previous + .next { color: green; }");
  expect(out).toContain(".start ~ .sibling { color: blue; }");
  expect(out).toContain(".ancestor .descendant { color: purple; }");
  expect(out).not.toContain(".parent&gt;.direct");
  // Only style raw text may restore `>`; text outside style must not be globally decoded.
  expect(out).toContain("literal &amp;gt; token");
  // Keep `<` escaped inside style text so a CSS value cannot close the style element.
  expect(out).toContain('.safe::before{content:"&lt;"}');
  expect(out).toContain('.escape::before{content:"&lt;/style>"}');
  expect(out).not.toContain('.escape::before{content:"</style>"}');
}

describe("sanitizeChapter", () => {
  it("注入 iframe 内的笔记 Custom Highlight 下划线规则，不包裹正文或设置背景", async () => {
    const { html: out } = await sanitizeChapter(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`,
      opts()
    );
    expect(out).toContain("::highlight(reader-notes)");
    expect(out).toContain("text-decoration-thickness: 2px");
    expect(out).toContain("text-underline-offset: 0.15em");
    const highlightRule = /::highlight\(reader-notes\)\s*\{([^}]*)\}/s.exec(out)?.[1] ?? "";
    expect(highlightRule).not.toContain("background");
    expect(out).not.toContain("reader-note-span");
  });

  it("注入 iframe 内的搜索 Custom Highlight 背景/前景，不写入布局属性", async () => {
    const { html: out } = await sanitizeChapter(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`,
      opts()
    );
    expect(out).toContain("::highlight(reader-search-hit)");
    const searchRule = /::highlight\(reader-search-hit\)\s*\{([^}]*)\}/s.exec(out)?.[1] ?? "";
    expect(searchRule).toContain("background-color");
    expect(searchRule).toContain("color:");
    expect(searchRule).not.toMatch(/margin|font-size|padding|width|height/);
  });

  it("移除脚本与事件属性", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<script>alert(1)</script>
</head><body onclick="evil()">
<p onmouseover="x()">正文</p>
<a href="javascript:alert(1)">链接</a>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
    expect(out).not.toContain("javascript:");
  });

  it("严格 XML 中仅保留无提交能力的 text/checkbox/radio input 及其状态属性", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<label for="reader-name">姓名</label><input id="reader-name" type="text" disabled="disabled" oninput="evil()"/>
<label for="reader-check">选择</label><input id="reader-check" type="checkbox" checked="checked" onclick="evil()"/>
<input id="reader-radio" type="radio" disabled="disabled"/>
<input id="reader-default" disabled="disabled"/>
<input id="upload" type="file"/><input id="submit" type="submit"/><input id="image" type="image"/>
<input id="button" type="button"/><input id="reset" type="reset"/><input id="hidden" type="hidden"/>
<form><input id="inside-form" type="text"/></form><button id="native-button">发送</button>
<select id="native-select"><option>一</option></select><textarea id="native-textarea">二</textarea>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    const { document } = parseHTML(out);

    expect(document.querySelectorAll("input")).toHaveLength(4);
    expect(document.querySelector("label[for=\"reader-name\"]")).not.toBeNull();
    expect(document.getElementById("reader-name")?.getAttribute("type")).toBe("text");
    expect(document.getElementById("reader-name")?.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById("reader-check")?.hasAttribute("checked")).toBe(true);
    expect(document.getElementById("reader-radio")?.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById("reader-default")?.hasAttribute("disabled")).toBe(true);
    expect(out).not.toContain("oninput");
    expect(out).not.toContain("onclick");
    for (const id of [
      "upload",
      "submit",
      "image",
      "button",
      "reset",
      "hidden",
      "inside-form",
      "native-button",
      "native-select",
      "native-textarea",
    ]) {
      expect(document.getElementById(id)).toBeNull();
    }
  });

  it("HTML 路径同样保留安全 input 的 checked/disabled/for，删除危险类型", async () => {
    const html = `<html><body>
<label for="fallback-check">选择</label><input id="fallback-check" type="checkbox" checked="checked" disabled="disabled"/>
<input id="fallback-text" type="text"/><input id="fallback-radio" type="radio" checked="checked"/>
<input id="fallback-file" type="file"/><input id="fallback-submit" type="submit"/>
</body></html>`;
    const { html: out, downgraded } = await sanitizeChapter(html, {
      ...opts(),
      strictXml: false,
    });
    const { document } = parseHTML(out);

    expect(downgraded).toBe(false);
    expect(document.querySelectorAll("input")).toHaveLength(3);
    expect(document.querySelector("label[for=\"fallback-check\"]")).not.toBeNull();
    expect(document.getElementById("fallback-check")?.hasAttribute("checked")).toBe(true);
    expect(document.getElementById("fallback-check")?.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById("fallback-file")).toBeNull();
    expect(document.getElementById("fallback-submit")).toBeNull();
  });

  it("图片 src 改写为 blob URL；缺失资源移除并记 issue", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<img src="images/a.png" alt="a"/>
<img src="images/missing.png" alt="b"/>
</body></html>`;
    const res = await sanitizeChapter(html, opts());
    expect(res.html).toContain('src="blob:test/OEBPS/Text/images/a.png"');
    expect(res.html).not.toContain("missing.png");
    expect(res.issues.some((i) => i.includes("missing.png"))).toBe(true);
  });

  it("样式表 link 改写为 blob URL", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<link rel="stylesheet" href="../css/main.css"/>
</head><body>正文</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain('href="blob:test/OEBPS/css/main.css"');
  });

  it("内联 style 的 url() 被改写", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p style="background: url(../img/x.png)">t</p>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("blob:test/OEBPS/img/x.png");
  });

  it("严格 XML 序列化保留 style 中的全部 CSS 组合器且不全局解码", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>.parent>.direct { color: red; }
.previous + .next { color: green; }
.start ~ .sibling { color: blue; }
.ancestor .descendant { color: purple; }
.safe::before{content:"&lt;"}
.escape::before{content:"&lt;/style&gt;"}</style>
</head><body><p>literal &amp;gt; token</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expectCombinatorsAndEscaping(out);
  });

  it("HTML 降级路径同样保留 style 组合器", async () => {
    const broken = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>.parent>.direct { color: red; }
.previous + .next { color: green; }
.start ~ .sibling { color: blue; }
.ancestor .descendant { color: purple; }
.safe::before{content:"&lt;"}
.escape::before{content:"&lt;/style&gt;"}</style>
</head><body><p id="a" id="b">literal &amp;gt; token</p></body></html>`;
    const res = await sanitizeChapter(broken, opts());
    expect(res.downgraded).toBe(true);
    expectCombinatorsAndEscaping(res.html);
  });

  it("注入 CSP 与覆盖样式（含字号/主题）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>t</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, fontSizePx: 20, theme: "dark" },
    });
    expect(out).toContain("Content-Security-Policy");
    expect(out).toContain("script-src 'none'");
    expect(out).toContain(`#${VIEWER_ID}`);
    expect(out).toContain("font-size: 20px");
    expect(out).toContain("#1e1e1e");
  });

  it("书在 body 上声明的字体保留，阅读器 fallback 只在 html 层", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>body,iframe{font-family:main,emoji,sym;} @font-face{font-family:"main";src:url(../Fonts/main.ttf)}</style>
</head><body><p>正文</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    // 书的 body 字体声明完整保留（含 url 改写）
    expect(out).toContain("body,iframe{font-family:main,emoji,sym;}");
    expect(out).toContain('url("blob:test/OEBPS/Fonts/main.ttf")');
    // 阅读器 fallback 移到 html，body 规则不再覆盖 font-family
    expect(out).toContain('font-family: "Segoe UI"');
    expect(out).toContain("html { font-size: 16px !important; font-family:");
    expect(out).toMatch(/body\s*\{\s*color:[^}]*\}/);
    expect(out).not.toMatch(/body\s*\{\s*color:[^}]*font-family:/);
  });

  it("严格 XML 失败时降级 HTML 并标记", async () => {
    // 重复属性在 XML 模式属于致命错误（浏览器 DOMParser 与 xmldom 均报告）
    const broken = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="a" id="b">重复属性</p></body></html>`;
    const res = await sanitizeChapter(broken, opts());
    expect(res.downgraded).toBe(true);
    expect(res.html).toContain("重复属性");
  });

  it("外部链接与页内锚点保持不变", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<a href="https://example.com">外链</a>
<a href="#sec1">锚点</a>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="#sec1"');
  });

  it("script 后的正文仍保留（删脚本不删内容）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><script src="x.js"/></head><body><p>正文文字</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("正文文字");
  });

  it("自闭合 <script/>（XHTML 风格）不吞正文：先补闭合再删除", async () => {
    // 真实书场景：HTML 解析器忽略 script 自闭合标志，会吞掉全部后续内容
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<script type="text/javascript" src="../Misc/script.js"/>
</head><body><h4>第一章</h4><p>正文第一段</p><p>正文第二段</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).not.toContain("<script");
    expect(out).toContain("第一章");
    expect(out).toContain("正文第一段");
    expect(out).toContain("正文第二段");
  });

  it("非 void 标签的自闭合写法不吞后续文本（如目录页 C<span/>O<span/>N...）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>.em05{font-size:0.5em}</style>
</head><body><p class="fbox">C<span class="em05"/>O<span class="em05"/>N<span class="em05"/>T<span class="em05"/>S</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    // 空 span 被显式闭合，后面的字母不再落入 0.5em 的 span
    expect(out).toContain('<span class="em05"></span>');
    expect(out).toContain("</span>O<span");
    expect(out).toContain("</span>S</p>");
  });

  it("void 标签（br/img）的自闭合写法保持原样", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一行<br/><img src="a.png" alt="x"/></p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("<br/>");
    expect(out).toContain('src="blob:test/OEBPS/Text/a.png"');
  });

  it("样式表内容被改写（@import 链 + url 相对路径）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<link rel="stylesheet" href="../css/main.css"/>
</head><body>正文</body></html>`;
    const getText = (p: string): string | undefined =>
      p === "OEBPS/css/main.css"
        ? `@import "default.css"; @font-face{font-family:x;src:url(../fonts/a.ttf)}`
        : undefined;
    const makeUrl = (text: string, type: string): string =>
      `blob:css/${type}/${encodeURIComponent(text)}`;
    const res = await sanitizeChapter(html, { ...opts(), getText, makeUrl });
    expect(res.html).toContain('href="blob:css/text/css/');
    const rewritten = decodeURIComponent(
      /href="blob:css\/text\/css\/([^"]+)"/.exec(res.html)![1]
    );
    expect(rewritten).toContain('@import url("blob:test/OEBPS/css/default.css")');
    expect(rewritten).toContain('url("blob:test/OEBPS/fonts/a.ttf")');
  });

  it("@import 被导入的样式表也递归内联并换算 width:%", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<link rel="stylesheet" href="../css/main.css"/>
</head><body><div class="paper">信件</div></body></html>`;
    const getText = (p: string): string | undefined => {
      if (p === "OEBPS/css/main.css") return `@import "default.css"; .paper { max-width: 30em; }`;
      if (p === "OEBPS/css/default.css") return `.paper { width: 90%; }`;
      return undefined;
    };
    const makeUrl = (text: string, type: string): string =>
      `blob:css/${type}/${encodeURIComponent(text)}`;
    const res = await sanitizeChapter(html, { ...opts(), getText, makeUrl });
    const rewritten = decodeURIComponent(
      /href="blob:css\/text\/css\/([^"]+)"/.exec(res.html)![1]
    );
    expect(rewritten).toContain(".paper { width: min(90%, 36rem); }");
    expect(rewritten).toContain(".paper { max-width: 30em; }");
    expect(rewritten).not.toContain("@import url(");
  });

  it("主题覆盖样式尊重书声明的更窄 max-width（类规则优先）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="paper">信件</div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain(`:where(#${VIEWER_ID} .reader-top)`);
    expect(out).toContain("max-width: 40rem;");
    expect(out).not.toContain("max-width: 40rem !important");
  });

  it("居中 margin 只作为默认值，不覆盖书声明的左右 margin", async () => {
    // 目录条目类（如 .bg1box{margin-right:2em}）必须能覆盖阅读器默认的 auto
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>.toc{margin:0 0 0.5em}.bg1box{margin-right:2em}.bg2box{margin-left:2em}</style>
</head><body><div class="toc bg1box">一</div><div class="toc bg2box">二</div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("margin-left: auto !important;");
    // 书规则完整保留
    expect(out).toContain("margin-right:2em");
    expect(out).toContain("margin-left:2em");
  });

  it("viewer 直接子元素（正文段/分隔符）强制版心居中，嵌套元素不受影响", async () => {
    // .cut 是页面直接内容，即使书写了 margin:0 也必须居中；
    // 嵌套的目录条目不能被强制居中（否则破坏书的交错 margin）
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p class="cut">◇◇◇</p><div class="tocbox"><div class="toc">目录条目</div></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    // 直接子被标记 reader-top，嵌套元素没有标记
    expect(out).toContain(`class="cut reader-top"`);
    expect(out).toContain(`class="toc"`);
    // 居中规则针对 reader-top；B-007 已保证子组合器也能安全序列化。
    expect(out).toContain(`:where(#${VIEWER_ID}) .reader-top`);
    expect(out).toContain("margin-left: auto !important;");
    expect(out).toContain("margin-right: auto !important;");
  });

  it("viewer 顶层链接包裹块级正文时使用 block 版心，不再贴页面左缘", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<a href="x.xhtml"><p>第一章</p></a>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    const { document } = parseHTML(out);
    const link = document.querySelector(`epub-viewer#${VIEWER_ID} > a`);
    const paragraph = link?.querySelector("p");

    expect(link?.classList.contains("reader-top")).toBe(true);
    expect(paragraph?.classList.contains("reader-top")).toBe(false);
    expect(out).toMatch(
      new RegExp(`:where\\(#${VIEWER_ID} a\\.reader-top\\)\\s*\\{\\s*display:\\s*block`, "s")
    );
  });

  it("根页面使用 border-box 并禁止原生滚动，body padding 不再撑出空滚动条", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>body{height:100%;padding:1em 0 2em}</style>
</head><body><p>短目录</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());

    expect(out).toMatch(
      /html, body\s*\{[^}]*height:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*overflow:\s*hidden\s*!important;/s
    );
  });

  it("直接包住块级条目的链接默认作为不可拆分页块", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div><a href="chapter.xhtml"><div class="rule"> </div><p class="label">章节</p></a></div>
<p><a href="note.xhtml"><span>普通行内链接</span></a></p>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());

    expect(out).toMatch(
      new RegExp(
        `:where\\(#${VIEWER_ID} a:has\\(> :is\\([^}]+\\)\\)\\)\\s*\\{[^}]*display:\\s*block;[^}]*break-inside:\\s*avoid;`,
        "s"
      )
    );
  });

  it("纯图片页注入 fullpage-image 类与整屏填充样式", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面</title></head>
<body><div class="cover"><img alt="cover" src="cover.jpg"/></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts("OEBPS/Text/cover.xhtml"));
    expect(out).toContain('class="fullpage-image"');
    expect(out).toContain("object-fit: contain");
    expect(out).toContain("width: 100% !important");
    expect(out).toContain("box-sizing: border-box !important");
    expect(out).toContain("height: 100% !important");
  });

  it("纯图片页使用 inline SVG image 时同样整屏 contain，且不改写书的 viewBox", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>标题</title></head>
<body><div style="text-align:center;padding:0;margin:0">
<svg xmlns="http://www.w3.org/2000/svg" height="100%" preserveAspectRatio="xMidYMid meet"
  viewBox="0 0 1370 1945" width="100%" xmlns:xlink="http://www.w3.org/1999/xlink">
  <image width="1370" height="1945" xlink:href="../Images/title.jpg"/>
</svg></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts("OEBPS/Text/title.xhtml"));

    expect(out).toContain('class="fullpage-image"');
    expect(out).toContain('viewBox="0 0 1370 1945"');
    expect(out).toContain('xlink:href="blob:test/OEBPS/Images/title.jpg"');
    expect(out).toMatch(/#epub-viewer\.fullpage-image\s+svg\s*\{/);
    expect(out).toContain("width: 100% !important");
    expect(out).toContain("height: 100% !important");
  });

  it("带图注的 duokan-image-single 是普通正文图，不能仅凭类名被强制为全页 flex 图", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>.duokan-image-single { width:100%; margin:1em 0; padding:5px; }
.duokan-image-maintitle { text-align:center; }</style>
</head><body><div class="duokan-image-single"><img alt="图 3-3" src="default_style.png"/>
<p class="duokan-image-maintitle">图 3-3　默认样式</p></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts("OEBPS/Text/chapter3-1.xhtml"));

    expect(out).not.toContain('class="fullpage-image"');
    expect(out).toContain(".duokan-image-single { width: min(100%, 40rem);");
    expect(out).not.toMatch(/#epub-viewer\s+\.duokan-image-single\s*\{/);
    expect(out).not.toMatch(/#epub-viewer\s+\.duokan-image-single\s+img\s*\{/);
    expect(out).toContain(".duokan-image-maintitle { text-align:center; }");
  });

  it("显式 duokan-image-fullscreen 仍保留全页图规则", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div class="duokan-image-fullscreen"><img alt="插图" src="illus.jpg"/></div>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts("OEBPS/Text/illus.xhtml"));

    expect(out).toMatch(/#epub-viewer\s+\.duokan-image-fullscreen\s*\{[^}]*height:\s*100%\s*!important;[^}]*display:\s*flex\s*!important;/s);
    expect(out).toMatch(/#epub-viewer\s+\.duokan-image-fullscreen\s+img\s*\{[^}]*width:\s*100%\s*!important;[^}]*height:\s*100%\s*!important;/s);
  });

  it("文字页不注入 fullpage-image", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>有文字</p><img alt="x" src="a.png"/></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).not.toContain("fullpage-image");
  });

  it("多图纯图片页不注入 fullpage-image（title 页上下两张图不能被拆成两页）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div style="margin:0 auto 1em"><p><img alt="t1" src="t1.png" style="width:21em"/></p></div>
<div style="margin:1em auto 0"><p><img alt="t2" src="t2.png" style="width:7em"/></p></div>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).not.toContain("fullpage-image");
    // 保留书自身排版声明
    expect(out).toContain("width:21em");
    expect(out).toContain("width:7em");
  });

  it("自带限宽声明的单图页不注入 fullpage-image（title 限宽图不被放大到全屏）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div style="margin:0 auto"><p><img alt="t1" src="t1.png" style="width:13em"/></p></div>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).not.toContain("fullpage-image");
    expect(out).toContain("width:13em");
  });

  it("唯一流体 width:100% 的单图页仍按整页 contain（学习路线不产生空列）", async () => {
    // 样本 OEBPS/Text/Learning-Path.xhtml：单张 width:100% 的路线图，若按
    // 普通正文图排，640px 版心宽会把 1688×2624 的图算成 995px 高，超过一栏
    // 后被 Chromium 拆成 3 列，读者看到 2 张空页。
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>学习路线</title></head><body>
<div class="duokan-image-single"><img style="width: 100%;" alt="学习路线" src="../Images/Learning.png"/></div>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts("OEBPS/Text/Learning-Path.xhtml"));

    expect(out).toContain('class="fullpage-image"');
    expect(out).toContain("object-fit: contain");
    expect(out).toContain("height: 100% !important");
  });

  it("percentage width 不是 100%、或另有尺寸约束的单图页仍按书排版", async () => {
    const cases = [
      `<img alt="a" src="a.png" style="width: 90%"/>`,
      `<img alt="b" src="b.png" style="width: 100%; height: 100%"/>`,
      `<img alt="c" src="c.png" style="width: 100%; max-height: 80vh"/>`,
      `<img alt="d" src="d.png" style="width: 100%; max-width: 30em"/>`,
      `<img alt="e" src="e.png" style="width: 100%; width: 90%"/>`,
      `<img alt="f" src="f.png" width="100%"/>`,
    ];
    for (const image of cases) {
      const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${image}</p></body></html>`;
      const { html: out } = await sanitizeChapter(html, opts());
      expect(out, image).not.toContain('class="fullpage-image"');
    }
  });

  it("正文被包进 #epub-viewer 分页容器", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><h1>标题</h1><p>正文</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    const viewerStart = out.indexOf(`<epub-viewer id="${VIEWER_ID}"`);
    expect(viewerStart).toBeGreaterThan(-1);
    // 容器内包含正文内容，容器闭合后直接是 </body>
    const after = out.slice(viewerStart);
    const closeIdx = after.indexOf("</epub-viewer>");
    expect(after.slice(0, closeIdx)).toContain("正文");
    expect(after.slice(closeIdx)).toContain("</body>");
  });

  it("分页容器不把 body 顶层 p 变成 div 后代，作者 div 内 p 仍匹配", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>div p { background-color: yellow; }</style>
</head><body><p id="top-one">测试</p><p id="top-two">测试2</p><div id="author"><p id="inside">作者 div 内</p></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    const { document } = parseHTML(out);
    const topOne = document.getElementById("top-one");
    const topTwo = document.getElementById("top-two");
    const inside = document.getElementById("inside");

    expect(document.querySelector(`epub-viewer#${VIEWER_ID}`)).not.toBeNull();
    expect(topOne?.closest("div")).toBeNull();
    expect(topTwo?.closest("div")).toBeNull();
    expect(inside?.closest("div")?.id).toBe("author");
    expect(document.querySelectorAll("div p")).toHaveLength(1);
    expect(out).toMatch(new RegExp(`epub-viewer#${VIEWER_ID}\\s*\\{[^}]*display:\\s*block`, "s"));
  });

  it("普通图片不覆盖书定义的高度（height:auto 不得强制；用 object-fit 防拉伸）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p class="cut"><img alt="kugiri" src="kugiri.png"/></p>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    // 通用图片规则：零特异性默认值，书的 img 规则可覆盖
    expect(out).toContain("max-width: 100%; object-fit: contain");
    expect(out).not.toContain("height: auto !important");
  });

  it("book 的 bgcolor 在浅色主题下应用到版面，深色/纸色忽略", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body bgcolor="#f5f0e6"><p>正文</p></body></html>`;
    const light = await sanitizeChapter(html, opts());
    expect(light.html).toContain("body { color: #1a1a1a; background-color: #f5f0e6;");
    expect(light.html).not.toContain('data-reader="bgcolor"');
    const dark = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "dark" as const },
    });
    expect(dark.html).toContain("body { color: #d4d4d4; background-color: #1e1e1e;");
    expect(dark.html).not.toContain("background-color: #f5f0e6");
    const sepia = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "sepia" as const },
    });
    expect(sepia.html).toContain("body { color: #3b2f1e; background-color: #f4ecd8;");
    expect(sepia.html).not.toContain("background-color: #f5f0e6");
  });

  it("bgcolor 非法值不注入（防 CSS 注入）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body bgcolor="red;} #epub-viewer{display:none"><p>正文</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    // 非法值不得进入 CSS（body 属性本身保留无害，浏览器会忽略无效颜色）
    expect(out).not.toMatch(/background:\s*red/);
    expect(out).not.toContain('data-reader="bgcolor"');
  });

  it("width:% 内联样式与 width 属性改写为 min（90% → min(90%, 36rem)）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div style="width:90%; padding:1em" id="b">x</div>
<table width="50%"><tr><td>y</td></tr></table>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("width: min(90%, 36rem)");
    expect(out).toContain("width: min(50%, 20rem)");
  });

  it("内联 style 的 max-width/min-width 百分比不改写", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div style="max-width:50%; min-width:50%">x</div>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("max-width:50%");
    expect(out).toContain("min-width:50%");
    expect(out).not.toContain("max-min(");
    expect(out).not.toContain("min-min(");
  });

  it("祖先注释中的 width 不阻断子元素的活动 width 改写", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div style="/* width:20em; */"><span style="width:50%">x</span></div>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain('style="/* width:20em; */"');
    expect(out).toContain("width: min(50%, 20rem)");
  });

  it("图片 style 中的注释尺寸不阻断纯图片页识别", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<img src="cover.png" style="/* width:12em; height:8em; */"/>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts("OEBPS/Text/cover.xhtml"));
    expect(out).toContain('class="fullpage-image"');
  });

  it("全页图块内部 / 已定宽祖先内部 / img 的 width:% 不换算", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div class="illus"><div style="width:90%" id="a">x</div></div>
<div style="width:20em"><div style="width:90%" id="b">y</div></div>
<img style="width:90%" alt="i" src="a.png"/>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain('style="width:90%"');
    expect(out).not.toContain("width: min(90%, 36rem)");
  });

  it("table 不再豁免版心限宽（width:90% 的表格同样收进版心）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><table width="90%"><tr><td>t</td></tr></table></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    // 覆盖样式里不再有 table 专属 max-width 规则
    expect(out).not.toMatch(/#epub-viewer table/);
  });

  it("页内 <style> 块的 url() 与 width:% 都被改写", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>.paper{width:90%;background:url(../img/bg.png)}</style>
</head><body><div class="paper">x</div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("width: min(90%, 36rem)");
    expect(out).toContain('url("blob:test/OEBPS/img/bg.png")');
  });

  it("深色主题下 ruby 注音 rt 随主题前景色换色", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>ruby>rt{color:#333}</style>
</head><body><p><ruby>漢<rt>kan</rt></ruby></p></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
    });
    expect(out).toContain(`#${VIEWER_ID} rt { color: #d4d4d4; }`);
  });

  it("fit-content 补偿不写死在 sanitize（由分页器运行时统一处理）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="summary"><h3>简介</h3><p>正文</p></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).not.toContain(`#${VIEWER_ID} .summary { max-width: 40rem; }`);
    expect(out).toContain("fit-content 多栏异常");
  });

  it("深色主题下目录链接换为深色模式浅蓝（Sigil 风格）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="toc"><a href="x.xhtml"><p>条目</p></a></div></body></html>`;
    const dark = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
    });
    expect(dark.html).toContain(`#${VIEWER_ID} .toc a { color: #6cb2ff; }`);
    const light = await sanitizeChapter(html, opts());
    expect(light.html).not.toContain("#6cb2ff");
  });

  it("深色主题注入继承式文字阴影兜底，浅色/纸色不注入", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>.none{text-shadow:none}.effect{text-shadow:0 0 2px red}</style></head><body><p>正文</p><p class="none">无阴影</p><p class="effect">作者特效</p></body></html>`;
    const dark = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
    });
    expect(dark.html).toContain(
      `#${VIEWER_ID} { text-shadow: 1px 1px 1px #1e1e1e; }`
    );
    expect(dark.html).not.toContain(
      `#${VIEWER_ID} { text-shadow: 1px 1px 1px #1e1e1e !important; }`
    );
    expect(dark.html).not.toContain(
      `#${VIEWER_ID} * { text-shadow: 1px 1px 1px #1e1e1e; }`
    );
    expect(dark.html).toMatch(/\.none\s*\{\s*text-shadow\s*:\s*none\s*\}/);
    expect(dark.html).toMatch(/\.effect\s*\{\s*text-shadow\s*:\s*0 0 2px red\s*\}/);

    const light = await sanitizeChapter(html, opts());
    const sepia = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "sepia" },
    });
    expect(light.html).not.toContain("text-shadow: 1px 1px 1px #1e1e1e");
    expect(sepia.html).not.toContain("text-shadow: 1px 1px 1px #1e1e1e");
  });

  it("深色主题下着重号 text-emphasis 随前景色换色", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>.dot{text-emphasis:circle #000}</style>
</head><body><p><span class="dot">着重</span></p></body></html>`;
    const dark = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
    });
    expect(dark.html).toContain("text-emphasis-color: #d4d4d4");
    const light = await sanitizeChapter(html, opts());
    expect(light.html).not.toContain("text-emphasis-color");
  });

  it("强制横排覆盖根级与嵌套竖排，但不把规则直接应用到 SVG 及其后代", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml" style="writing-mode:vertical-rl"><head><style>
      body{writing-mode:vertical-lr} .nested{writing-mode:vertical-rl} svg text{writing-mode:vertical-rl}
    </style></head><body><div class="nested"><p>竖排正文</p></div><svg><text style="writing-mode:vertical-rl">图中文字</text></svg></body></html>`;
    const forced = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, forceHorizontal: true },
    });
    expect(forced.html).toContain("html, body, #epub-viewer,");
    expect(forced.html).toContain("#epub-viewer :not(svg):not(svg *)");
    expect(forced.html).toContain("writing-mode: horizontal-tb !important;");
    expect(forced.html).toContain("-webkit-writing-mode: horizontal-tb !important;");
    expect(forced.html).toContain("text-orientation: mixed !important;");
    expect(forced.html).toContain('style="writing-mode:vertical-rl"');
    expect(forced.html).not.toContain("direction:");

    for (const theme of ["light", "dark", "sepia"] as const) {
      const themed = await sanitizeChapter(html, {
        ...opts(),
        settings: { ...DEFAULT_SETTINGS, theme, forceHorizontal: true },
      });
      expect(themed.html).toContain("writing-mode: horizontal-tb !important;");
    }

    const normal = await sanitizeChapter(html, opts());
    expect(normal.html).not.toContain("writing-mode: horizontal-tb !important;");
    expect(normal.html).not.toContain("-webkit-writing-mode: horizontal-tb !important;");
  });

  it("脚注标记图标用 middle 垂直对齐（书里的 top 会顶到上一行）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>正文<sup><a class="duokan-footnote" href="#n1"><img class="zhangyue-footnote" alt="note" src="note.png"/></a></sup></p>
<aside id="n1">注：内容</aside></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain("vertical-align: middle;");
    expect(out).not.toContain("vertical-align: top;");
  });

  it("script.js 模式的 <note> 内 aside 也被隐藏（正文中不显示注释块）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>note{display:block}</style>
</head><body><note><p>正文<sup><a href="#n1">*</a></sup></p>
<aside id="n1"><p>注释内容</p></aside></note></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain(`${VIEWER_ID} note aside { display: none !important; }`);
    // 结构保留，供阅读器弹层提取
    expect(out).toContain('href="#n1"');
    expect(out).toContain("注释内容");
  });

  it("主题覆盖样式不重置书在 body 上声明的背景图", async () => {
    // 真实书场景：目录页在 <style> 里给 body 设置 background-image。
    // 注入的主题样式若用 background 简写，会把 background-image 重置为 none。
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>body{background-image:url(../Images/bdimg.webp);background-repeat:no-repeat;
background-position:center center;background-size:cover;background-color:#f9ebdf;}</style>
</head><body><div class="tocbox">CONTENTS</div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain('url("blob:test/OEBPS/Images/bdimg.webp")');
    // 主题样式只覆盖背景色（在书样式之后注入），不再用 background 简写
    expect(out).toContain("body { color: #1a1a1a; background-color: #ffffff;");
    expect(out).not.toMatch(/body\s*\{\s*color:[^}]*background:\s*#/);
  });

  it("bgcolor 默认值不遮挡 body 背景图，且用户 CSS 可覆盖", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head>
<style>body{background-image:url(../Images/bdimg.webp)}</style>
</head><body bgcolor="#f5f0e6"><p>正文</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts());
    expect(out).toContain('url("blob:test/OEBPS/Images/bdimg.webp")');
    expect(out).toContain("body { color: #1a1a1a; background-color: #f5f0e6;");
    expect(out).not.toContain('data-reader="bgcolor"');
    const defaultIndex = out.indexOf("background-color: #f5f0e6;");
    const userCss = await sanitizeChapter(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body bgcolor="#f5f0e6"><p>正文</p></body></html>`,
      {
        ...opts(),
        settings: { ...DEFAULT_SETTINGS, customCss: "body { background-color: #123456; }" },
      }
    );
    const userIndex = userCss.html.indexOf("body { background-color: #123456; }");
    expect(defaultIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThan(userCss.html.indexOf("background-color: #f5f0e6;"));
    // 不再给 viewer 铺不透明背景，否则会遮住 body 的背景图
    expect(out).not.toMatch(/epub-viewer\s*\{\s*background:/);
  });

  it("用户自定义 CSS 注入在覆盖样式之后", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts(),
      settings: {
        ...DEFAULT_SETTINGS,
        customCss: `#epub-viewer p { color: red !important; }`,
      },
    });
    expect(out).toContain("用户自定义 CSS");
    expect(out).toContain("#epub-viewer p { color: red !important; }");
  });

  it("用户上传字体注入 @font-face 并可在选择后强制 body 字体", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts(),
      settings: {
        ...DEFAULT_SETTINGS,
        customFonts: [{ family: "MyFont", url: "blob:myfont" }],
        customFontName: "MyFont",
      },
    });
    expect(out).toContain('@font-face { font-family: "MyFont";');
    expect(out).toContain('src: url("blob:myfont")');
    expect(out).toContain('font-family: "MyFont" !important;');
  });

  it("滚动模式注入的样式让 viewer 保持唯一纵向滚动容器", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, readingMode: "scroll" },
    });
    // 回归：曾经用 height:auto + overflow:visible 让 viewer 不再是滚动容器，
    // scrollTop 赋值静默失效，滚动模式整章都滚不动。
    expect(out).toMatch(
      new RegExp(`#${VIEWER_ID}\\s*\\{[^}]*overflow-y:\\s*auto\\s*!important;`, "s")
    );
    expect(out).toMatch(/scrollbar-width:\s*none\s*!important;/);
    expect(out).toMatch(/::-webkit-scrollbar\s*\{[^}]*display:\s*none\s*!important;/s);
    expect(out).toMatch(new RegExp(`#${VIEWER_ID}\\s*\\{[^}]*height:\\s*100%\\s*!important;`, "s"));
    expect(out).not.toMatch(new RegExp(`#${VIEWER_ID}\\s*\\{[^}]*overflow:\\s*visible`, "s"));
  });

  it("滚动模式纯图片页只保留类名，不再注入任何强制图片尺寸", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面</title></head>
<body><div class="cover"><img alt="cover" src="cover.jpg"/></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts("OEBPS/Text/cover.xhtml"),
      settings: { ...DEFAULT_SETTINGS, readingMode: "scroll" },
    });
    expect(out).not.toContain('class="fullpage-image"');
    expect(out).toContain('data-reader="scroll-mode"');
    // 类名保留：paginator 依赖它跳过 margin 补偿
    expect(out).toContain('class="pure-image-page"');
    expect(out).not.toContain('data-reader="pure-image-page"');
    // 三处强制尺寸都不得出现（纯图分支 + scroll-mode 全局 + 基础 imageCss）。
    // 按具体样式节点断言，避免误伤章末卡片的合法 width:100% / 脚注 max-height。
    const overrides = readStyleText(out, "overrides");
    const scrollMode = readStyleText(out, "scroll-mode");
    expect(overrides).not.toContain("#epub-viewer .cover");
    expect(overrides).not.toContain("#epub-viewer .illus");
    expect(overrides).not.toContain("#epub-viewer .kuchie");
    expect(overrides).not.toContain("max-height: 100%");
    expect(overrides).not.toContain("height: auto");
    expect(scrollMode).not.toMatch(/#epub-viewer\s+img/);
    expect(scrollMode).not.toContain("height: auto");
    expect(scrollMode).not.toContain("max-height: none");
    // 作者容器/图片约束的注入式移除已取消，脚注专用规则和滚动默认值保留
    expect(overrides).toContain(":where(#epub-viewer img, #epub-viewer svg, #epub-viewer video)");
    expect(overrides).toContain("#epub-viewer sup img,");
    expect(overrides).toContain("height: 1.2em !important;");
    // 作者自己的结构保留在文档里
    expect(out).toContain('class="cover reader-top"');
  });

  it("滚动模式不给普通图片注入 height:auto 或 max-height 覆盖", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>正文文字</p><img alt="fig" src="fig.png" style="max-height:60vh"/>
</body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts("OEBPS/Text/ch1.xhtml"),
      settings: { ...DEFAULT_SETTINGS, readingMode: "scroll" },
    });
    expect(out).toContain('style="max-height:60vh"');
    const overrides = readStyleText(out, "overrides");
    expect(overrides).not.toMatch(/:where\(#epub-viewer\)\s+img\s*\{[^}]*max-height/s);
    expect(overrides).not.toContain("height: auto");
    expect(readStyleText(out, "scroll-mode")).not.toMatch(/#epub-viewer\s+(img|\.cover|\.illus)/);
  });

  it("滚动模式限宽标题图不被放大，也不命中纯图片页类名", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>标题</title></head>
<body><div class="title-block"><img alt="title" src="title.jpg" style="width:75%;max-width:20em"/></div>
<p>作者：某某</p></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts("OEBPS/Text/title.xhtml"),
      settings: { ...DEFAULT_SETTINGS, readingMode: "scroll" },
    });
    expect(out).not.toContain('class="pure-image-page"');
    expect(out).not.toContain('class="fullpage-image"');
    expect(out).toContain('style="width:75%;max-width:20em"');
    const overrides = readStyleText(out, "overrides");
    expect(overrides).not.toMatch(/:where\(#epub-viewer\)\s+img\s*\{[^}]*width:\s*100%/s);
    expect(overrides).not.toContain("#epub-viewer .cover");
  });

  it("分页模式保留原有整页填充与媒体默认值（滚动改动不影响分页）", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面</title></head>
<body><div class="cover"><img alt="cover" src="cover.jpg"/></div></body></html>`;
    const { html: out } = await sanitizeChapter(html, opts("OEBPS/Text/cover.xhtml"));
    expect(out).toContain('class="fullpage-image"');
    expect(out).toContain('data-reader="fullpage-image"');
    expect(out).not.toContain("data-reader=\"scroll-mode\"");
    const overrides = readStyleText(out, "overrides");
    expect(overrides).toMatch(
      /#epub-viewer\s+\.illus,\s*#epub-viewer\s+\.kuchie,\s*#epub-viewer\s+\.cover,/s
    );
    expect(overrides).toMatch(
      /#epub-viewer\s+\.illus\s+img,\s*#epub-viewer\s+\.kuchie\s+img,\s*#epub-viewer\s+\.cover\s+img,/s
    );
    expect(overrides).toContain(":where(#epub-viewer) img { max-width: 100%; object-fit: contain; }");
    expect(overrides).toContain(":where(#epub-viewer) img, :where(#epub-viewer) video, :where(#epub-viewer) svg { max-height: 100%; }");
    expect(out).toContain('data-reader="fullpage-image"');
  });

  it("深色模式下清除图片投影避免浅色光晕", async () => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p><img alt="fig" src="fig.png"/></body></html>`;
    const { html: out } = await sanitizeChapter(html, {
      ...opts(),
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
    });
    expect(out).toContain('img { box-shadow: none !important; }');
  });
});
