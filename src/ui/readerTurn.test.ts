import { act, createElement, createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ReaderSettings } from "../render/settings";
import type { Book } from "../core/types";
import { createReactDomHarness } from "../test/reactDomHarness";

const instances = vi.hoisted(() => [] as MockPaginator[]);
class MockPaginator {
  disposed = false;
  isDisplayReady = false;
  state: { status: string; empty?: boolean; pageCount?: number; currentPage?: number } = { status: "loading" };
  currentPage = 0;
  pageCount = 5;
  path = "";
  callbacks: unknown[];
  settings: ReaderSettings;
  constructor(...args: unknown[]) {
    this.settings = args[2] as ReaderSettings;
    this.callbacks = args;
    instances.push(this);
  }
  load = vi.fn(async (path: string, options: { settings?: ReaderSettings } = {}) => {
    this.path = path;
    if (options.settings) this.settings = options.settings;
    this.isDisplayReady = false;
    this.state = { status: "loading" };
    (this.callbacks[4] as Function)(this.state);
  });
  loadAndWaitForDisplay = vi.fn(async (path: string) => {
    await this.load(path);
    return true;
  });
  finish() {
    this.isDisplayReady = true;
    this.state = { status: "ready", empty: false, pageCount: this.pageCount, currentPage: this.currentPage };
    (this.callbacks[4] as Function)(this.state);
    (this.callbacks[15] as Function)();
  }
  getStateSnapshot() { return this.state; }
  getCurrentPath() { return this.path; }
  setNotes() {}
  setPage = vi.fn((page: number) => {
    this.currentPage = page;
    this.state = { ...this.state, currentPage: page };
    (this.callbacks[4] as Function)(this.state);
  });
  navigateToSearchTarget() { return "unresolved" as const; }
  closeForNavigation() {}
  clearSearchHighlight() {}
  resetWheelAccumulator() {}
  dispose() { this.disposed = true; }
}

vi.mock("../render/paginator", () => ({
  ChapterPaginator: class { constructor(...args: unknown[]) { return new MockPaginator(...args); } },
}));

import { ReaderView, type ReaderHandle } from "./ReaderView";

describe("Zen UI Packet C: 硬件加速平滑翻页与边缘翻页交互契约", () => {
  let dom: ReturnType<typeof createReactDomHarness>;
  let props: ComponentProps<typeof ReaderView>;
  let ref: React.RefObject<ReaderHandle>;

  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
    dom = createReactDomHarness();
    ref = createRef<ReaderHandle>();
    const book = {
      version: 3,
      opfPath: "book.opf",
      fixedLayout: false,
      spine: [0, 1, 2].map((i) => ({ idref: String(i), linear: true })),
      manifest: new Map([0, 1, 2].map((i) => [String(i), { href: `${i}.xhtml` }])),
    } as Book;

    props = {
      book,
      server: {
        revokeAll: vi.fn(),
        textFor: vi.fn(() => "<html></html>"),
      } as unknown as ComponentProps<typeof ReaderView>["server"],
      settings: { ...DEFAULT_SETTINGS, instantTurn: false },
      userFonts: [],
      notes: [],
      spineIndex: 0,
      anchorNonce: 0,
      startAtEnd: { nonce: 0, atEnd: false },
      onPageState: vi.fn(),
      onDisplayReady: vi.fn(),
      onRequestChapter: vi.fn(),
      onIssues: vi.fn(),
      onInternalLink: vi.fn(),
      onBeforeInternalNavigate: vi.fn(),
      onInternalNavigationSettled: vi.fn(),
      onExternalLink: vi.fn(),
      onFootnote: vi.fn(),
      onFootnoteClose: vi.fn(),
    };
  });

  afterEach(async () => {
    await dom.dispose();
    vi.useRealTimers();
  });

  const render = () => dom.render(createElement(ReaderView, { ...props, ref }));
  const finishActive = async () => {
    const active = instances[0];
    await act(async () => {
      active.finish();
      vi.advanceTimersByTime(300);
    });
    return active;
  };

  it("渲染左右 5% 悬停感应区与边缘翻页指示箭头", async () => {
    await render();
    const prevZone = dom.container.querySelector(".edge-turn-zone.edge-turn-prev");
    const nextZone = dom.container.querySelector(".edge-turn-zone.edge-turn-next");

    expect(prevZone).not.toBeNull();
    expect(nextZone).not.toBeNull();
    expect(prevZone?.getAttribute("title")).toBe("上一页");
    expect(nextZone?.getAttribute("title")).toBe("下一页");

    expect(prevZone?.querySelector(".edge-turn-arrow")).not.toBeNull();
    expect(nextZone?.querySelector(".edge-turn-arrow")).not.toBeNull();
  });

  it("点击下一页感应区触发翻页与 180ms 动画，并在结束后恢复", async () => {
    await render();
    const active = await finishActive();

    const nextZone = dom.container.querySelector(".edge-turn-zone.edge-turn-next") as HTMLElement;
    expect(nextZone).not.toBeNull();

    await dom.click(nextZone);

    expect(active.setPage).toHaveBeenCalledWith(1);
    const readerEl = dom.container.querySelector(".reader");
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(true);
    expect(readerEl?.classList.contains("turn-next")).toBe(true);

    // 180ms 动画结束后应清理 class
    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(false);
  });

  it("点击上一页感应区触发翻页与 180ms 动画", async () => {
    await render();
    const active = await finishActive();
    active.currentPage = 2;

    const prevZone = dom.container.querySelector(".edge-turn-zone.edge-turn-prev") as HTMLElement;
    expect(prevZone).not.toBeNull();

    await dom.click(prevZone);

    expect(active.setPage).toHaveBeenCalledWith(1);
    const readerEl = dom.container.querySelector(".reader");
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(true);
    expect(readerEl?.classList.contains("turn-prev")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(false);
  });

  it("当开启 instantTurn (0ms 立即翻页) 时，翻页不添加动画类", async () => {
    props = {
      ...props,
      settings: { ...props.settings, instantTurn: true },
    };
    await render();
    const active = await finishActive();

    const nextZone = dom.container.querySelector(".edge-turn-zone.edge-turn-next") as HTMLElement;
    await dom.click(nextZone);

    expect(active.setPage).toHaveBeenCalledWith(1);
    const readerEl = dom.container.querySelector(".reader");
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(false);
  });

  it("通过 ReaderHandle 接口 setPage(i) 调用正确派发动向动画", async () => {
    await render();
    const active = await finishActive();
    active.currentPage = 1;

    // 前进到第 3 页
    await act(async () => {
      ref.current?.setPage(3);
    });
    expect(active.setPage).toHaveBeenCalledWith(3);
    const readerEl = dom.container.querySelector(".reader");
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(true);
    expect(readerEl?.classList.contains("turn-next")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(false);

    // 后退到第 0 页
    await act(async () => {
      ref.current?.setPage(0);
    });
    expect(active.setPage).toHaveBeenCalledWith(0);
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(true);
    expect(readerEl?.classList.contains("turn-prev")).toBe(true);
  });

  it("在最后一章最后一页继续向下翻页时不触发翻页动画", async () => {
    props = {
      ...props,
      spineIndex: 2,
    };
    await render();
    const active = await finishActive();
    active.currentPage = 4;
    active.pageCount = 5;

    const nextZone = dom.container.querySelector(".edge-turn-zone.edge-turn-next") as HTMLElement;
    expect(nextZone).not.toBeNull();

    await dom.click(nextZone);

    const readerEl = dom.container.querySelector(".reader");
    expect(readerEl?.classList.contains("has-turn-anim")).toBe(false);
    expect(props.onRequestChapter).not.toHaveBeenCalled();
  });
});
