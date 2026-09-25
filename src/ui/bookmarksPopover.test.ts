import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, useCallback, useRef, useState, type MutableRefObject } from "react";
import { createReactDomHarness } from "../test/reactDomHarness";
import { BookmarksPopover, type BookmarksPopoverEntry } from "./BookmarksPopover";
import { bookmarkPopoverLayout } from "./bookmarkPopoverLayout";

type Harness = ReturnType<typeof createReactDomHarness>;

const activeHarnesses: Harness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const harness = activeHarnesses.pop();
    await harness?.dispose();
  }
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 隐藏祖先（display:none / is-suppressed）下所有 rect 归零，用它代表入口已被 CSS 隐藏。 */
function hiddenRect(): DOMRect {
  return rect(0, 0, 0, 0);
}

/**
 * 渲染浮层与它的触发按钮。按钮默认不可见，从而强制走 App 记录的 fallbackRect ——
 * 这正是 Windows 上顶部状态岛被隐藏后的路径。
 */
async function setup(options: {
  bookmarks: BookmarksPopoverEntry[];
  fallbackRect?: DOMRect | null;
  /** 触发按钮可见时的实时 rect；缺省表示按钮被 CSS 隐藏（rect 归零）。 */
  anchorRect?: DOMRect;
  /** 在组件首次读取 rect 之前设置锚点坐标，模拟“按钮本来就可见”。 */
  setAnchorRectBeforeMount?: boolean;
}) {
  const harness = createReactDomHarness();
  activeHarnesses.push(harness);
  const doc = harness.container.ownerDocument;
  const window = doc.defaultView as unknown as Window & typeof globalThis;
  const rects = new WeakMap<Element, DOMRect>();
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: HTMLElement,
  ): DOMRect {
    return rects.get(this) ?? hiddenRect();
  };
  let active: Element | null = null;
  Object.defineProperty(doc, "activeElement", { get: () => active, configurable: true });
  window.HTMLElement.prototype.focus = function focus(this: HTMLElement) {
    active = this;
  };
  window.HTMLElement.prototype.blur = function blur(this: HTMLElement) {
    if (active === this) active = null;
  };
  window.innerWidth = 1024;
  window.innerHeight = 768;

  const onSelect = vi.fn();
  const onClose = vi.fn();
  const anchorRef: MutableRefObject<HTMLButtonElement | null> = { current: null };
  function Surfaces() {
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    const localRef = useRef<HTMLButtonElement | null>(null);
    const bookmarks = options.bookmarks;
    const attach = useCallback((node: HTMLButtonElement | null) => {
      localRef.current = node;
      anchorRef.current = node;
      if (node && options.anchorRect && options.setAnchorRectBeforeMount) {
        rects.set(node, options.anchorRect);
      }
      setAnchor(node);
    }, []);
    return createElement(
      "div",
      null,
      createElement("button", {
        ref: attach,
        type: "button",
        "data-testid": "bookmark-trigger",
      }),
      createElement(BookmarksPopover, {
        anchor,
        fallbackRect: options.fallbackRect ?? null,
        bookmarks,
        onSelect,
        onClose,
      }),
    );
  }
  await harness.render(createElement(Surfaces));

  const anchor = anchorRef.current as unknown as HTMLButtonElement;
  const panel = harness.container.querySelector(".reader-bookmarks-popover") as HTMLElement;
  const backdrop = harness.container.querySelector(".reader-bookmarks-backdrop") as HTMLElement;
  const fire = (type: string, target: EventTarget, props: Record<string, unknown> = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, props);
    target.dispatchEvent(event);
  };
  return { harness, window, doc, anchor, panel, backdrop, onSelect, onClose, fire, getActive: () => active };
}

const twoBookmarks: BookmarksPopoverEntry[] = [
  {
    id: "b1",
    spineIndex: 0,
    page: 1,
    anchorIndex: null,
    anchorRatio: null,
    text: "重要段落摘录",
    createdAtMs: 1,
    chapterLabel: "第一章",
  },
  {
    id: "b2",
    spineIndex: 2,
    page: 5,
    anchorIndex: null,
    anchorRatio: null,
    text: "（无文字）",
    createdAtMs: 2,
    chapterLabel: "第三章",
  },
];

describe("BookmarksPopover 所有权与定位", () => {
  it("入口被隐藏时仍用点击坐标渲染唯一一份书签列表", async () => {
    const clickRect = rect(566, 74, 22, 22);
    const dom = await setup({ bookmarks: twoBookmarks, fallbackRect: clickRect });

    // 触发按钮仍然连接在文档里，只是被隐藏祖先压成 0×0。
    expect(dom.anchor.isConnected).toBe(true);
    expect(dom.anchor.getBoundingClientRect().width).toBe(0);

    // 唯一浮层挂在工具栏之外，因此能看到全部条目与章节。
    expect(dom.panel.textContent).toContain("重要段落摘录");
    expect(dom.panel.textContent).toContain("第一章");
    expect(dom.panel.textContent).toContain("第三章");
    expect(dom.panel.querySelectorAll(".bookmark-item")).toHaveLength(2);
    expect(dom.harness.container.querySelectorAll(".reader-bookmarks-popover")).toHaveLength(1);
    expect(dom.harness.container.querySelector(".toolbar-top-island")).toBeNull();

    // fixed + border-box，坐标直接来自 bookmarkPopoverLayout。
    const expected = bookmarkPopoverLayout(clickRect, { width: 1024, height: 768 });
    expect(dom.panel.style.position).toBe("fixed");
    expect(dom.panel.style.boxSizing).toBe("border-box");
    expect(dom.panel.style.left).toBe(`${expected.left}px`);
    expect(dom.panel.style.top).toBe(`${expected.top}px`);
    expect(dom.panel.style.width).toBe(`${expected.width}px`);
    expect(dom.panel.style.maxHeight).toBe(`${expected.maxHeight}px`);
  });

  it("锚点可见时以实时 rect 对齐到按钮右端", async () => {
    const anchorRect = rect(500, 100, 22, 22);
    const dom = await setup({
      bookmarks: twoBookmarks,
      anchorRect,
      setAnchorRectBeforeMount: true,
      fallbackRect: rect(1, 1, 1, 1),
    });

    expect(dom.anchor.getBoundingClientRect().width).toBe(22);
    const expected = bookmarkPopoverLayout(anchorRect, { width: 1024, height: 768 });
    expect(dom.panel.style.left).toBe(`${expected.left}px`);
    expect(dom.panel.style.top).toBe(`${expected.top}px`);
  });

  it("无书签时渲染空列表文案", async () => {
    const dom = await setup({ bookmarks: [], fallbackRect: rect(600, 100, 22, 22) });
    expect(dom.panel.textContent).toContain("暂无书签");
  });

  it("选择条目只回调 id，不自行关闭或抢焦点", async () => {
    const dom = await setup({ bookmarks: twoBookmarks, fallbackRect: rect(600, 100, 22, 22) });

    const item = dom.panel.querySelectorAll(".bookmark-item")[0] as HTMLElement;
    dom.fire("click", item);
    expect(dom.onSelect).toHaveBeenCalledWith("b1");
    expect(dom.onClose).not.toHaveBeenCalled();
    expect(dom.getActive()).toBe(dom.panel);
  });

  it("Esc 与遮罩点击关闭浮层", async () => {
    const dom = await setup({ bookmarks: twoBookmarks, fallbackRect: rect(600, 100, 22, 22) });

    dom.fire("keydown", dom.window, { key: "Escape" });
    expect(dom.onClose).toHaveBeenCalledTimes(1);
    dom.fire("click", dom.backdrop);
    expect(dom.onClose).toHaveBeenCalledTimes(2);
  });

  it("浮层内的点击不回调关闭，正文遮罩负责外部关闭", async () => {
    const dom = await setup({ bookmarks: twoBookmarks, fallbackRect: rect(600, 100, 22, 22) });

    dom.fire("click", dom.panel.querySelectorAll(".bookmark-item")[0]);
    expect(dom.onClose).not.toHaveBeenCalled();
    dom.fire("click", dom.backdrop);
    expect(dom.onClose).toHaveBeenCalledTimes(1);
  });
});
