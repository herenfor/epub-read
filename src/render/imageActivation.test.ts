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

describe("displayed image hit area", () => {
  function fitted(position = "50% 50%", fit = "contain") {
    const d = doc(`<a href="other.xhtml"><img src="image.png"/></a>`);
    const img = loaded(pick(d, "img"), 600, 1200) as HTMLElement;
    img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 360, height: 600 }) as DOMRect;
    Object.defineProperty(img, "offsetWidth", { value: 360 });
    Object.defineProperty(img, "offsetHeight", { value: 600 });
    d.defaultView!.getComputedStyle = () => ({ objectFit: fit, objectPosition: position,
      paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0",
      borderLeftWidth: "0", borderRightWidth: "0", borderTopWidth: "0", borderBottomWidth: "0" }) as CSSStyleDeclaration;
    return { img, d };
  }
  it("portrait full-page image ignores both side margins while retaining image and link activation", () => {
    const { img } = fitted();
    expect(imageRequestFromTarget(img, "ch.xhtml", { clientX: 20, clientY: 300 })).toBeNull();
    expect(imageRequestFromTarget(img, "ch.xhtml", { clientX: 360, clientY: 300 })).toBeNull();
    expect(imageRequestFromTarget(img, "ch.xhtml", { clientX: 180, clientY: 300 })?.linkHref).toBe("other.xhtml");
  });
  it("object-position changes the painted area, cover keeps the full clipped content clickable", () => {
    const { img } = fitted("left top");
    expect(imageRequestFromTarget(img, "ch.xhtml", { clientX: 20, clientY: 300 })).not.toBeNull();
    expect(imageRequestFromTarget(img, "ch.xhtml", { clientX: 330, clientY: 300 })).toBeNull();
    const { img: cover } = fitted("50% 50%", "cover");
    expect(imageRequestFromTarget(cover, "ch.xhtml", { clientX: 20, clientY: 300 })).not.toBeNull();
  });
  it("a simple SVG wrapper ignores space outside its transformed image bounds", async () => {
    const { isImageBlankAtPoint } = await import("./imageActivation");
    const d = doc('<svg viewBox="0 0 600 1200"><image href="page.png" width="600" height="1200"/></svg>');
    const svg = pick(d, "svg"), image = pick(d, "image");
    image.getBoundingClientRect = () => ({ left: 40, top: 20, width: 300, height: 600 }) as DOMRect;
    expect(isImageBlankAtPoint(svg, { clientX: 20, clientY: 300 })).toBe(true);
    expect(isImageBlankAtPoint(svg, { clientX: 180, clientY: 300 })).toBe(false);
  });
  it("SVG's own meet letterboxing uses actual intrinsic size; closing cancels pending metadata reads", async () => {
    const { prepareImageHitAreas, isImageBlankAtPoint } = await import("./imageActivation");
    const d = doc('<svg viewBox="0 0 360 600"><image href="page.png" width="360" height="600"/></svg>');
    const image = pick(d, "image"), svg = pick(d, "svg");
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 600 }) as DOMRect;
    const probes: any[] = [];
    class Probe {
      naturalWidth = 600; naturalHeight = 1200; complete = false;
      onload: (() => void) | null = null; onerror: (() => void) | null = null; src = "";
      constructor() { probes.push(this); }
      removeAttribute() { this.src = ""; }
    }
    Object.defineProperty(d, "defaultView", { value: { Image: Probe } });
    const cleanup = prepareImageHitAreas(d);
    probes[0].onload();
    expect(imageRequestFromTarget(image, "ch.xhtml")?.naturalHeight).toBe(1200);
    expect(isImageBlankAtPoint(svg, { clientX: 10, clientY: 300 })).toBe(true);
    expect(isImageBlankAtPoint(svg, { clientX: 180, clientY: 300 })).toBe(false);
    expect(probes[0].src).toBe("");
    cleanup();
    const cancel = prepareImageHitAreas(d);
    cancel();
    expect(probes[1].onload).toBeNull();
    expect(probes[1].src).toBe("");
  });
  it("linked image blank touch toggles chrome once, painted image and drag keep their existing priorities", async () => {
    const { isImageBlankAtPoint } = await import("./imageActivation");
    const { installPlainTap } = await import("./plainTap");
    const { img, d } = fitted();
    let taps = 0;
    const cleanup = installPlainTap(d, { onTap: () => taps++, isBlankImageTap: isImageBlankAtPoint });
    const touch = (type: string, clientX: number) => {
      const event = new d.defaultView!.Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX, clientY: 300 }] });
      Object.defineProperty(event, "changedTouches", { value: [{ clientX, clientY: 300 }] });
      img.dispatchEvent(event);
    };
    touch("touchstart", 20); touch("touchend", 20);
    touch("touchstart", 180); touch("touchend", 180);
    touch("touchstart", 38); touch("touchend", 42); // Cross into the image within tap tolerance.
    touch("touchstart", 20); touch("touchmove", 80); touch("touchend", 80);
    expect(taps).toBe(1);
    cleanup();
  });
});
