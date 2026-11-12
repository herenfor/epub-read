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
  const window = harness.window;
  // 固定 400x300 的可用区，让 fit/原始大小/平移边界可断言。
  harness.rect(window.HTMLElement.prototype, { width: 400, height: 300 });
  let active: Element | null = null;
  harness.define(doc, "activeElement", { get: () => active });
  harness.define(window.HTMLElement.prototype, "focus", {
    writable: true,
    value: function focus(this: HTMLElement) { active = this; },
  });
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
    expect(html).toContain('class="image-viewer');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('src="blob:reader/pic"');
    expect(html).toContain('aria-label="缩小"');
    expect(html).toContain('aria-label="放大"');
    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain('aria-label="向左旋转"');
    expect(html).toContain('aria-label="向右旋转"');
    expect(html).toContain("100%");
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

    // 最后一个可用控件是“放大”（适配态下“缩小”禁用）。从最后一个控件 Tab 回绕到第一个（向左旋转）。
    const zoomIn = query<HTMLButtonElement>(harness, 'button[aria-label="放大"]');
    setActive(zoomIn);
    const keydown = fire(window, "keydown", { key: "Tab" });
    await act(async () => {
      doc.dispatchEvent(keydown);
    });
    expect(keydown.defaultPrevented).toBe(true);
    expect(getActive()).toBe(query(harness, ".image-viewer-rotate-left"));

    // 第一个控件 Shift+Tab 回绕到最后一个控件（放大）。
    const shiftTab = fire(window, "keydown", { key: "Tab", shiftKey: true });
    await act(async () => {
      doc.dispatchEvent(shiftTab);
    });
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(getActive()).toBe(zoomIn);

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

  it("百分比按钮在适配与原始大小 1:1 之间切换，缩回后居中且缩小按钮禁用", async () => {
    const { harness, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const image = query<HTMLElement>(harness, ".image-viewer-image");
    const zoomOut = query<HTMLButtonElement>(harness, 'button[aria-label="缩小"]');
    const percentBtn = query<HTMLButtonElement>(harness, ".image-viewer-percent");

    expect(zoomOut.disabled).toBe(true);
    // 400x300 视口适配 1000x500 图片，基准为 400x200（原图的 40%）。
    expect(percentBtn.textContent).toBe("40%");

    // 点按百分比切到 1:1 原始大小。fit=0.4 → 原始大小为 1/0.4 = 2.5 倍（原图的 100%）。
    await harness.click(percentBtn);
    expect(image.style.transform).toContain("scale(2.5)");
    expect(zoomOut.disabled).toBe(false);
    expect(percentBtn.textContent).toBe("100%");

    // 再次点按回到适配窗口（居中 1 倍，40%），缩小按钮恢复禁用。
    await harness.click(percentBtn);
    expect(image.style.transform).toContain("scale(1)");
    expect(image.style.transform).toContain("translate(0px, 0px)");
    expect(zoomOut.disabled).toBe(true);
    expect(percentBtn.textContent).toBe("40%");
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

describe("ImageViewer 旋转", () => {
  it("点击向左/向右旋转按钮旋转 90°，重置到居中适配", async () => {
    const { harness, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const image = query<HTMLElement>(harness, ".image-viewer-image");
    const rotateLeft = query<HTMLButtonElement>(harness, ".image-viewer-rotate-left");
    const rotateRight = query<HTMLButtonElement>(harness, ".image-viewer-rotate-right");

    // 初始 0°
    expect(image.style.transform).toContain("rotate(0deg)");

    // 向右旋转 90°
    await harness.click(rotateRight);
    expect(image.style.transform).toContain("rotate(90deg)");

    // 再向右旋转 90° -> 180°
    await harness.click(rotateRight);
    expect(image.style.transform).toContain("rotate(180deg)");

    // 向左旋转 90° -> 90°
    await harness.click(rotateLeft);
    expect(image.style.transform).toContain("rotate(90deg)");
  });

  it("键盘快捷键 r 向右旋转、Shift+r 向左旋转", async () => {
    const { harness, doc, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: baseImage, onClose }));
    const image = query<HTMLElement>(harness, ".image-viewer-image");

    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "r" }));
    });
    expect(image.style.transform).toContain("rotate(90deg)");

    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "R", shiftKey: true }));
    });
    expect(image.style.transform).toContain("rotate(0deg)");
  });
});

describe("ImageViewer 图集与前后翻看", () => {
  const galleryImage: ImageViewRequest = {
    ...baseImage,
    gallery: {
      items: [
        { src: "blob:reader/pic1", alt: "图1", naturalWidth: 1000, naturalHeight: 500, chapterPath: "ch1.xhtml" },
        { src: "blob:reader/pic2", alt: "图2", naturalWidth: 800, naturalHeight: 600, chapterPath: "ch1.xhtml" },
        { src: "blob:reader/pic3", alt: "图3", naturalWidth: 600, naturalHeight: 400, chapterPath: "ch1.xhtml" },
      ],
      index: 0,
    },
  };

  it("多图时显示计数器与翻图箭头，点击上一张/下一张切换图片并重置旋转与缩放", async () => {
    const { harness, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: galleryImage, onClose }));

    const counter = query(harness, ".image-viewer-counter");
    expect(counter.textContent).toBe("1 / 3");
    expect(harness.container.querySelector(".image-viewer-edge.is-prev")).toBeNull();
    const nextBtn = query<HTMLButtonElement>(harness, ".image-viewer-edge.is-next");

    // 点击下一张
    await harness.click(nextBtn);
    expect(counter.textContent).toBe("2 / 3");
    expect(query<HTMLImageElement>(harness, ".image-viewer-image").src).toBe("blob:reader/pic2");
    expect(harness.container.querySelector(".image-viewer-edge.is-prev")).not.toBeNull();
    expect(harness.container.querySelector(".image-viewer-edge.is-next")).not.toBeNull();

    // 点击下一张到达最后一张
    await harness.click(query<HTMLButtonElement>(harness, ".image-viewer-edge.is-next"));
    expect(counter.textContent).toBe("3 / 3");
    expect(query<HTMLImageElement>(harness, ".image-viewer-image").src).toBe("blob:reader/pic3");
    expect(harness.container.querySelector(".image-viewer-edge.is-next")).toBeNull();

    // 点击上一张回到第二张
    await harness.click(query<HTMLButtonElement>(harness, ".image-viewer-edge.is-prev"));
    expect(counter.textContent).toBe("2 / 3");
    expect(query<HTMLImageElement>(harness, ".image-viewer-image").src).toBe("blob:reader/pic2");
  });

  it("键盘方向键 Left / Right 翻看上一张 / 下一张，首末张不越界", async () => {
    const { harness, doc, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: galleryImage, onClose }));

    const counter = query(harness, ".image-viewer-counter");
    expect(counter.textContent).toBe("1 / 3");

    // 第一张按 Left 不越界
    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "ArrowLeft" }));
    });
    expect(counter.textContent).toBe("1 / 3");

    // 按 Right 翻到第二张、第三张
    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "ArrowRight" }));
    });
    expect(counter.textContent).toBe("2 / 3");

    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "ArrowRight" }));
    });
    expect(counter.textContent).toBe("3 / 3");

    // 末张按 Right 不越界
    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "ArrowRight" }));
    });
    expect(counter.textContent).toBe("3 / 3");

    // 按 Left 回到第二张
    await act(async () => {
      doc.dispatchEvent(fire(window, "keydown", { key: "ArrowLeft" }));
    });
    expect(counter.textContent).toBe("2 / 3");
  });

  it("适配态单指横滑翻图：向左滑翻下一张，向右滑翻上一张", async () => {
    const { harness, window, onClose } = setup();
    await harness.render(createElement(ImageViewer, { image: galleryImage, onClose }));
    const stage = query(harness, ".image-viewer-stage");
    const counter = query(harness, ".image-viewer-counter");
    expect(counter.textContent).toBe("1 / 3");

    const touch = (type: string, props: Record<string, unknown>) =>
      fire(window, type, { pointerType: "touch", button: 0, buttons: 1, pointerId: 1, ...props });

    // 从 200, 150 向左滑动 80px (到 120, 150) -> 下一张
    await act(async () => {
      stage.dispatchEvent(touch("pointerdown", { clientX: 200, clientY: 150 }));
    });
    await act(async () => {
      stage.dispatchEvent(touch("pointermove", { clientX: 120, clientY: 150 }));
    });
    await act(async () => {
      stage.dispatchEvent(touch("pointerup", { clientX: 120, clientY: 150, buttons: 0 }));
    });
    expect(counter.textContent).toBe("2 / 3");

    // 从 200, 150 向右滑动 80px (到 280, 150) -> 上一张
    await act(async () => {
      stage.dispatchEvent(touch("pointerdown", { clientX: 200, clientY: 150 }));
    });
    await act(async () => {
      stage.dispatchEvent(touch("pointermove", { clientX: 280, clientY: 150 }));
    });
    await act(async () => {
      stage.dispatchEvent(touch("pointerup", { clientX: 280, clientY: 150, buttons: 0 }));
    });
    expect(counter.textContent).toBe("1 / 3");
  });
});
