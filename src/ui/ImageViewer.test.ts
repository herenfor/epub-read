import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createReactDomHarness } from "../test/reactDomHarness";
import { ImageViewer } from "./ImageViewer";
import type { ImageViewRequest } from "../render/imageActivation";

const baseImage: ImageViewRequest = {
  src: "blob:reader/pic",
  alt: "插图",
  naturalWidth: 1000,
  naturalHeight: 500,
  chapterPath: "OEBPS/ch1.xhtml",
};

type Harness = ReturnType<typeof createReactDomHarness>;

const activeHarnesses: Harness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const harness = activeHarnesses.pop();
    await harness?.dispose();
  }
});

function fire(
  window: Window & typeof globalThis,
  type: string,
  props: Record<string, unknown> = {},
): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, props);
  return event;
}

function setup() {
  const harness = createReactDomHarness();
  activeHarnesses.push(harness);
  const doc = harness.container.ownerDocument;
  const window = doc.defaultView as unknown as Window & typeof globalThis;
  // 固定 400x300 的可用区，让 fit/原始大小/平移边界可断言。
  window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 }) as DOMRect;
  let active: Element | null = null;
  Object.defineProperty(doc, "activeElement", { get: () => active, configurable: true });
  window.HTMLElement.prototype.focus = function focus(this: HTMLElement) {
    active = this;
  };
  const onClose = vi.fn();
  const onFollowLink = vi.fn();
  return {
    harness,
    doc,
    window,
    onClose,
    onFollowLink,
    getActive: () => active,
    setActive: (element: Element | null) => {
      active = element;
    },
  };
}

function query<T extends Element>(harness: Harness, selector: string): T {
  const element = harness.container.querySelector(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element as unknown as T;
}

describe("ImageViewer 结构", () => {
  it("image 为 null 时不渲染任何节点", () => {
    const html = renderToStaticMarkup(createElement(ImageViewer, { image: null, onClose() {} }));
    expect(html).toBe("");
  });

  it("渲染遮罩、图片与 适配/原始大小/关闭 控件", () => {
    const html = renderToStaticMarkup(createElement(ImageViewer, { image: baseImage, onClose() {} }));
    expect(html).toContain('class="image-viewer"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('src="blob:reader/pic"');
    expect(html).toContain('aria-label="适配窗口"');
    expect(html).toContain('aria-label="原始大小"');
    expect(html).toContain('aria-label="缩小"');
    expect(html).toContain('aria-label="放大"');
    expect(html).toContain('aria-label="关闭"');
    // 无 linkHref 时不显示链接入口
    expect(html).not.toContain("打开链接");
  });

  it("普通链接图片在提供 onFollowLink 时显示“打开链接”", () => {
    const html = renderToStaticMarkup(
      createElement(ImageViewer, {
        image: { ...baseImage, linkHref: "chapter2.xhtml#sec" },
        onClose() {},
        onFollowLink() {},
      }),
    );
    expect(html).toContain("打开链接");
  });
});

describe("ImageViewer 关闭与焦点", () => {
  it("关闭按钮与空白背景关闭，点击图片本身不关闭", async () => {
    const { harness, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));

    await harness.click(query(harness, ".image-viewer-image"));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      query(harness, ".image-viewer-stage").dispatchEvent(fire(window, "click"));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await harness.click(query(harness, ".image-viewer-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Esc 关闭浮层", async () => {
    const { harness, doc, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("打开时焦点进入浮层并困在弹层内，关闭后还原原焦点", async () => {
    const { harness, doc, window, onClose, getActive, setActive } = setup();
    const previous = doc.createElement("button");
    previous.textContent = "原焦点";
    doc.body.appendChild(previous);
    setActive(previous);

    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const closeButton = query(harness, ".image-viewer-close");
    expect(getActive()).toBe(closeButton);
    expect(closeButton.getAttribute("aria-label")).toBe("关闭");

    // Tab 从最后一个可聚焦元素回绕到第一个，不跑到背景。
    const keydown = fire(window, "keydown", { key: "Tab" });
    await act(async () => {
      doc.dispatchEvent(keydown);
    });
    expect(keydown.defaultPrevented).toBe(true);
    // 适配态下“缩小/适配”禁用，回绕到第一个可用控件（放大）。
    expect(getActive()).toBe(query(harness, ".image-viewer-controls button:not([disabled])"));
    expect((getActive() as Element).getAttribute("aria-label")).toBe("放大");

    await harness.render(createElement(ImageViewer, { image: null, onClose }));
    expect(getActive()).toBe(previous);
  });
});

describe("ImageViewer 缩放/拖动核心", () => {
  it("滚轮以指针为中心缩放并阻止默认滚动", async () => {
    const { harness, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const overlay = query(harness, ".image-viewer");
    const wheel = fire(window, "wheel", { deltaY: -100, clientX: 200, clientY: 150 });
    await act(async () => {
      overlay.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(true);
    const scale = Number(/scale\(([\d.]+)\)/.exec(query<HTMLElement>(harness, ".image-viewer-image").style.transform)?.[1]);
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThan(2);
  });

  it("双击在适配与 2 倍之间切换", async () => {
    const { harness, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const stage = query(harness, ".image-viewer-stage");
    const image = query<HTMLElement>(harness, ".image-viewer-image");

    await act(async () => {
      stage.dispatchEvent(fire(window, "dblclick", { clientX: 200, clientY: 150 }));
    });
    expect(image.style.transform).toContain("scale(2)");

    await act(async () => {
      stage.dispatchEvent(fire(window, "dblclick", { clientX: 200, clientY: 150 }));
    });
    expect(image.style.transform).toContain("scale(1)");
  });

  it("单指拖动已放大图片到边界后停住，pointercancel 后手势不残留", async () => {
    const { harness, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const stage = query(harness, ".image-viewer-stage");
    const image = query<HTMLElement>(harness, ".image-viewer-image");

    const pointer = (type: string, props: Record<string, unknown>) => fire(window, type, { pointerType: "touch", ...props });
    await act(async () => {
      stage.dispatchEvent(fire(window, "dblclick", { clientX: 200, clientY: 150 }));
    });
    // fit=0.4 → 基准 400x200；2 倍时宽 800>400、高 400>300，可平移 x∈[-200,200]、y∈[-50,50]。
    await act(async () => {
      stage.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 200, clientY: 150, button: 0, buttons: 1 }));
    });
    await act(async () => {
      stage.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 400, clientY: 150, buttons: 1 }));
    });
    expect(image.style.transform).toContain("translate(200px, 0px)");
    await act(async () => {
      stage.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 5000, clientY: 150, buttons: 1 }));
    });
    expect(image.style.transform).toContain("translate(200px, 0px)");

    await act(async () => {
      stage.dispatchEvent(pointer("pointercancel", { pointerId: 1, clientX: 5000, clientY: 150 }));
    });
    const afterCancel = image.style.transform;
    await act(async () => {
      stage.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 0, clientY: 0, buttons: 0 }));
    });
    expect(image.style.transform).toBe(afterCancel);
  });

  it("拖动结束的 click 不误触背景关闭，之后正常空白点击仍关闭", async () => {
    const { harness, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const stage = query(harness, ".image-viewer-stage");
    await act(async () => {
      stage.dispatchEvent(fire(window, "pointerdown", { pointerId: 1, clientX: 200, clientY: 150, pointerType: "touch", button: 0, buttons: 1 }));
    });
    await act(async () => {
      stage.dispatchEvent(fire(window, "pointermove", { pointerId: 1, clientX: 260, clientY: 150, pointerType: "touch", buttons: 1 }));
    });
    await act(async () => {
      stage.dispatchEvent(fire(window, "pointerup", { pointerId: 1, clientX: 260, clientY: 150, pointerType: "touch" }));
    });
    await act(async () => {
      stage.dispatchEvent(fire(window, "click"));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      stage.dispatchEvent(fire(window, "click"));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("原始大小达到 1:1，缩回适配后居中且缩小按钮禁用", async () => {
    const { harness, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const image = query<HTMLElement>(harness, ".image-viewer-image");
    const zoomOut = query<HTMLButtonElement>(harness, 'button[aria-label="缩小"]');
    const fit = query<HTMLButtonElement>(harness, 'button[aria-label="适配窗口"]');

    expect(zoomOut.disabled).toBe(true);
    expect(fit.disabled).toBe(true);

    await harness.click(query(harness, 'button[aria-label="原始大小"]'));
    // fit=0.4 → 原始大小 = 1/0.4 = 2.5 倍。
    expect(image.style.transform).toContain("scale(2.5)");
    expect(zoomOut.disabled).toBe(false);

    await harness.click(fit);
    expect(image.style.transform).toContain("scale(1)");
    expect(image.style.transform).toContain("translate(0px, 0px)");
    expect(fit.disabled).toBe(true);
  });

  it("提供 onFollowLink 时“打开链接”交回原请求", async () => {
    const { harness, onClose, onFollowLink } = setup();
    const linked = { ...baseImage, linkHref: "chapter2.xhtml#sec" };
    await harness.render(createElement(ImageViewer, { image: linked, onClose, onFollowLink }));
    await harness.click(query(harness, ".image-viewer-link"));
    expect(onFollowLink).toHaveBeenCalledWith(linked);
    expect(onClose).not.toHaveBeenCalled();
  });
});
