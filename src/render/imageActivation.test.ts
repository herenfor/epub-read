import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { imageRequestFromTarget } from "./imageActivation";

function doc(bodyHtml: string): Document {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`);
  return document;
}

/** linkedom 不实现图片解码尺寸，测试里显式模拟“已加载成功”的自然尺寸。 */
function loaded(img: Element, naturalWidth = 640, naturalHeight = 480, complete = true): Element {
  Object.defineProperty(img, "naturalWidth", { value: naturalWidth, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: naturalHeight, configurable: true });
  Object.defineProperty(img, "complete", { value: complete, configurable: true });
  return img;
}

function pick(d: Document, selector: string): Element {
  const el = d.querySelector(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el;
}

describe("imageRequestFromTarget：普通正文图片", () => {
  it("用已解析资源地址与自然尺寸构造请求", () => {
    const d = doc(`<p><img alt="插图" src="Images/pic.png"/></p>`);
    const request = imageRequestFromTarget(loaded(pick(d, "img")), "OEBPS/ch1.xhtml");
    expect(request).toEqual({
      src: "Images/pic.png",
      alt: "插图",
      naturalWidth: 640,
      naturalHeight: 480,
      chapterPath: "OEBPS/ch1.xhtml",
      linkHref: undefined,
    });
  });

  it("优先 currentSrc（srcset/已选候选），缺失时回退 src", () => {
    const d = doc(`<img src="Images/fallback.png"/>`);
    const img = pick(d, "img") as HTMLImageElement;
    loaded(img);
    Object.defineProperty(img, "currentSrc", { value: "blob:reader/selected", configurable: true });
    expect(imageRequestFromTarget(img, "ch.xhtml")?.src).toBe("blob:reader/selected");

    const d2 = doc(`<img src="blob:reader/only"/>`);
    const img2 = loaded(pick(d2, "img"));
    expect(imageRequestFromTarget(img2, "ch.xhtml")?.src).toBe("blob:reader/only");
  });

  it("未加载成功或尺寸无效时返回 null，交由原链接行为继续", () => {
    const d = doc(`<img src="Images/loading.png"/>`);
    const notComplete = pick(d, "img");
    Object.defineProperty(notComplete, "naturalWidth", { value: 0, configurable: true });
    Object.defineProperty(notComplete, "naturalHeight", { value: 0, configurable: true });
    Object.defineProperty(notComplete, "complete", { value: false, configurable: true });
    expect(imageRequestFromTarget(notComplete, "ch.xhtml")).toBeNull();

    const d2 = doc(`<img src="Images/zero.png"/>`);
    expect(imageRequestFromTarget(loaded(pick(d2, "img"), 0, 0), "ch.xhtml")).toBeNull();
  });

  it("空 src 返回 null；非图片目标返回 null", () => {
    const d = doc(`<p>正文</p><img alt="无源"/>`);
    expect(imageRequestFromTarget(loaded(pick(d, "img")), "ch.xhtml")).toBeNull();
    expect(imageRequestFromTarget(pick(d, "p"), "ch.xhtml")).toBeNull();
  });

  it("单纯尺寸小不当作脚注：普通小图仍可放大", () => {
    const d = doc(`<p><img alt="小图" src="Images/small.png" width="12" height="12"/></p>`);
    const request = imageRequestFromTarget(loaded(pick(d, "img"), 12, 12), "ch.xhtml");
    expect(request?.naturalWidth).toBe(12);
  });

  it("普通链接包裹的图片仍可放大并保留原链接 href", () => {
    const d = doc(`<a href="chapter2.xhtml#sec"><img alt="链接图" src="Images/link.png"/></a>`);
    const request = imageRequestFromTarget(loaded(pick(d, "img")), "OEBPS/ch1.xhtml");
    expect(request?.linkHref).toBe("chapter2.xhtml#sec");
  });
});

describe("imageRequestFromTarget：脚注优先", () => {
  it("多看/掌阅脚注标记内的图片不进入浮层", () => {
    const d = doc(`
<p>正文<sup><a class="duokan-footnote" epub:type="noteref" href="#n1"><img alt="note" src="Images/note.png"/></a></sup></p>`);
    expect(imageRequestFromTarget(loaded(pick(d, "img")), "ch.xhtml")).toBeNull();
  });

  it("script.js 的 <note><sup><a href=#aside> 结构内的图片不进入浮层", () => {
    const d = doc(`
<note><p>正文<sup><a href="#n1"><img alt="note" src="Images/note.png"/></a></sup></p>
<aside id="n1">注释文本</aside></note>`);
    expect(imageRequestFromTarget(loaded(pick(d, "img")), "ch.xhtml")).toBeNull();
  });

  it("sup/note 语义内的脚注图（无链接）也不进入浮层", () => {
    const sup = doc(`<p>正文<sup><img alt="note" src="Images/note.png"/></sup></p>`);
    expect(imageRequestFromTarget(loaded(pick(sup, "img")), "ch.xhtml")).toBeNull();

    const note = doc(`<note><p><img alt="note" src="Images/note.png"/></p></note>`);
    expect(imageRequestFromTarget(loaded(pick(note, "img")), "ch.xhtml")).toBeNull();
  });

  it("Z 掌阅脚注样式类内的图片不进入浮层", () => {
    const d = doc(`<p><span class="zhangyue-footnote"><img alt="note" src="Images/note.png"/></span></p>`);
    expect(imageRequestFromTarget(loaded(pick(d, "img")), "ch.xhtml")).toBeNull();
  });
});

describe("imageRequestFromTarget：SVG 单 image 包装", () => {
  it("取 xlink:href 与 viewBox 固有尺寸", () => {
    const d = doc(`<svg viewBox="0 0 1200 1600" xmlns:xlink="http://www.w3.org/1999/xlink">
<image xlink:href="blob:reader/page" width="100%" height="100%"/></svg>`);
    const request = imageRequestFromTarget(pick(d, "image"), "OEBPS/cover.xhtml");
    expect(request).toEqual({
      src: "blob:reader/page",
      alt: "",
      naturalWidth: 1200,
      naturalHeight: 1600,
      chapterPath: "OEBPS/cover.xhtml",
      linkHref: undefined,
    });
  });

  it("image 显式数字 width/height 优先于 viewBox", () => {
    const d = doc(`<svg viewBox="0 0 10 10"><image xlink:href="blob:reader/a" width="300" height="200"/></svg>`);
    const request = imageRequestFromTarget(pick(d, "image"), "ch.xhtml");
    expect(request?.naturalWidth).toBe(300);
    expect(request?.naturalHeight).toBe(200);
  });

  it("复杂内联 SVG（多个元素子节点）不导出", () => {
    const d = doc(`<svg viewBox="0 0 10 10"><image xlink:href="blob:reader/a"/><rect width="1" height="1"/></svg>`);
    expect(imageRequestFromTarget(pick(d, "image"), "ch.xhtml")).toBeNull();
  });

  it("缺 href 或缺固有尺寸时返回 null", () => {
    const missingHref = doc(`<svg viewBox="0 0 10 10"><image width="10" height="10"/></svg>`);
    expect(imageRequestFromTarget(pick(missingHref, "image"), "ch.xhtml")).toBeNull();

    const missingSize = doc(`<svg><image xlink:href="blob:reader/a"/></svg>`);
    expect(imageRequestFromTarget(pick(missingSize, "image"), "ch.xhtml")).toBeNull();
  });
});

describe("imageRequestFromTarget：跨 iframe 文档节点", () => {
  it("来自另一 realm 的 img/svg image 不依赖宿主 instanceof", () => {
    const { document: iframeDoc } = parseHTML(
      `<!doctype html><html><body><p><img alt="iframe 图" src="blob:reader/iframe"/></p>
<svg viewBox="0 0 20 30"><image xlink:href="blob:reader/iframe-svg"/></svg></body></html>`,
    );
    const img = iframeDoc.querySelector("img") as Element;
    loaded(img, 200, 100);
    expect(imageRequestFromTarget(img, "OEBPS/iframe.xhtml")?.src).toBe("blob:reader/iframe");

    const svgImage = iframeDoc.querySelector("image") as Element;
    const request = imageRequestFromTarget(svgImage, "OEBPS/iframe.xhtml");
    expect(request?.src).toBe("blob:reader/iframe-svg");
    expect(request?.naturalWidth).toBe(20);
    expect(request?.naturalHeight).toBe(30);
  });
});
