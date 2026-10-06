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
  pageCount = 2;
  path = "";
  complete: (() => void) | undefined;
  readyWaiters: Array<(ready: boolean) => void> = [];
  callbacks: unknown[];
  settings: ReaderSettings;
  loadOptions: {
    settings?: ReaderSettings;
    restoreTicket?: { session: number; request: number; chapterPath: string } | null;
    reportRestore?: boolean;
    readingAnchor?: unknown;
  } = {};
  restoreHandler: ((result: { located: boolean; ticket: { session: number; request: number; chapterPath: string } | null; loadSeq: number }) => void) | null = null;
  userCommitHandler: (() => void) | null = null;
  constructor(...args: unknown[]) {
    this.settings = args[2] as ReaderSettings;
    this.callbacks = args;
    instances.push(this);
  }
  load = vi.fn(async (path: string, options: {
    settings?: ReaderSettings;
    restoreTicket?: { session: number; request: number; chapterPath: string } | null;
    reportRestore?: boolean;
    readingAnchor?: unknown;
  } = {}) => {
    this.path = path;
    this.loadOptions = options;
    if (options.settings) this.settings = options.settings;
    this.isDisplayReady = false;
    this.state = { status: "loading" };
    (this.callbacks[4] as Function)(this.state);
  });
  setRestoreResultHandler(handler: typeof this.restoreHandler) {
    this.restoreHandler = handler;
  }
  setUserCommitHandler(handler: typeof this.userCommitHandler) {
    this.userCommitHandler = handler;
  }
  loadAndWaitForDisplay = vi.fn(async (path: string) => {
    await this.load(path);
    return new Promise<boolean>((resolve) => { this.complete = () => resolve(true); });
  });
  reloadWithSettings = vi.fn(async (settings: ReaderSettings) => {
    this.settings = settings;
    await this.load(this.path);
  });
  finish() {
    this.isDisplayReady = true;
    this.state = { status: "ready", empty: false, pageCount: this.pageCount, currentPage: this.currentPage };
    (this.callbacks[4] as Function)(this.state);
    (this.callbacks[15] as Function)();
    this.complete?.();
    this.flushReadyWaiters(true);
  }
  finishEmpty() {
    this.isDisplayReady = true;
    this.state = { status: "ready", empty: true, pageCount: 1, currentPage: 0 };
    (this.callbacks[4] as Function)(this.state);
    (this.callbacks[15] as Function)();
    this.complete?.();
    this.flushReadyWaiters(true);
  }
  waitForDisplayReady() {
    if (this.isDisplayReady) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => { this.readyWaiters.push(resolve); });
  }
  flushReadyWaiters(ready: boolean) {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const resolve of waiters) resolve(ready);
  }
  pagedSlideFrame() { return null; }
  previewPagedScroll() {}
  planPagedTurn(direction: 1 | -1, hasAdjacentChapter: boolean) {
    const target = this.currentPage + direction;
    if (target >= 0 && target < this.pageCount) return { kind: "page", page: target, from: 0, to: 0 };
    return hasAdjacentChapter
      ? { kind: "chapter", direction, fromPage: this.currentPage }
      : { kind: "book-edge", page: this.currentPage };
  }
  getStateSnapshot() { return this.state; }
  getCurrentPath() { return this.path; }
  setNotes() {}
  setPage(page: number) { this.currentPage = page; }
  navigateToSearchTarget() { return "unresolved" as const; }
  closeForNavigation() {}
  clearSearchHighlight() {}
  resetWheelAccumulator() {}
  dispose() { this.disposed = true; this.complete?.(); this.flushReadyWaiters(false); }
}
vi.mock("../render/paginator", () => ({
  ChapterPaginator: class { constructor(...args: unknown[]) { return new MockPaginator(...args); } },
}));
import { ReaderView, type ReaderHandle } from "./ReaderView";

describe("ReaderView preload settings lifecycle", () => {
  let dom: ReturnType<typeof createReactDomHarness>;
  let props: ComponentProps<typeof ReaderView>;
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
    dom = createReactDomHarness();
    const book = {
      version: 3, opfPath: "book.opf", fixedLayout: false,
      spine: [0, 1, 2, 3].map((i) => ({ idref: String(i), linear: true })),
      manifest: new Map([0, 1, 2, 3].map((i) => [String(i), { href: `${i}.xhtml` }])),
    } as Book;
    props = {
      book, server: {
        revokeAll: vi.fn(),
        textFor: vi.fn(() => "<html></html>"),
      } as unknown as ComponentProps<typeof ReaderView>["server"],
      settings: { ...DEFAULT_SETTINGS, preloadNextChapter: true }, userFonts: [], notes: [],
      spineIndex: 0, anchorNonce: 0, startAtEnd: { nonce: 0, atEnd: false },
      onPageState: vi.fn(), onDisplayReady: vi.fn(), onRequestChapter: vi.fn(), onIssues: vi.fn(),
      onInternalLink: vi.fn(), onBeforeInternalNavigate: vi.fn(), onInternalNavigationSettled: vi.fn(),
      onExternalLink: vi.fn(), onFootnote: vi.fn(), onFootnoteClose: vi.fn(),
    };
  });
  afterEach(async () => { await dom.dispose(); vi.useRealTimers(); });
  const render = () => dom.render(createElement(ReaderView, props));
  const finish = async (p: MockPaginator) => {
    await act(async () => {
      p.finish();
      vi.advanceTimersByTime(500);
    });
  };

  it("uses current theme/font in preloads scheduled by an older paginator callback", async () => {
    await render();
    const active = instances[0];
    await finish(active);
    const staleSpare = instances[1];
    props = { ...props, settings: { ...props.settings, theme: "dark", fontSizePx: 24 } };
    await render();
    expect(staleSpare.disposed).toBe(true);
    await act(async () => { vi.advanceTimersByTime(150); });
    await finish(active);
    const next = instances.at(-1)!;
    expect(next).not.toBe(staleSpare);
    expect(next.settings).toMatchObject({ theme: "dark", fontSizePx: 24 });
  });

  it("applies new settings when a chapter turn cancels the pending settings reload", async () => {
    await render();
    const active = instances[0];
    await finish(active);
    props = { ...props, settings: { ...props.settings, theme: "dark", fontSizePx: 22 } };
    await render();
    props = { ...props, spineIndex: 1 };
    await render();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(active.reloadWithSettings).not.toHaveBeenCalled();
    expect(active.path).toBe("1.xhtml");
    expect(active.settings).toMatchObject({ theme: "dark", fontSizePx: 22 });
  });

  it("rejects a ready cache when a chapter and its settings change in the same commit", async () => {
    await render();
    await finish(instances[0]);
    const spare = instances[1];
    await finish(spare);
    props = { ...props, spineIndex: 1, settings: { ...props.settings, fontSizePx: 26 } };
    await render();
    expect(spare.disposed).toBe(true);
    expect(instances[0].path).toBe("1.xhtml");
    expect(instances[0].settings.fontSizePx).toBe(26);
  });

  it("coalesces consecutive changes and applies new font resources to both active and spare slots", async () => {
    await render();
    const active = instances[0];
    await finish(active);
    props = { ...props, settings: { ...props.settings, theme: "dark" } };
    await render();
    await act(async () => { vi.advanceTimersByTime(100); });
    props = { ...props, settings: { ...props.settings, theme: "light", fontSizePx: 20 },
      userFonts: [{ family: "New Font", url: "blob:font" }] };
    await render();
    // An old display callback during the debounce may not warm stale settings.
    await finish(active);
    const count = instances.length;
    await act(async () => { vi.advanceTimersByTime(150); });
    expect(active.reloadWithSettings).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(count);
    await finish(active);
    for (const paginator of [active, instances.at(-1)!]) {
      expect(paginator.settings).toMatchObject({ theme: "light", fontSizePx: 20, customFonts: props.userFonts });
    }
  });

  it("切章后稳固停留在新章第 0 页，决不自动向后抢跑或跳页", async () => {
    await render();
    const active = instances[0];
    await finish(active);
    // 触发切章到第 1 章
    props = { ...props, spineIndex: 1 };
    await render();
    const nextActive = instances.find((p) => p.path === "1.xhtml") || instances[0];
    await finish(nextActive);
    // 确认当前页稳定停留在第 0 页（即人类视角的第 1 页），不自动回放翻页
    expect(nextActive.currentPage).toBe(0);
  });

  it("预加载不与切章就绪同步抢占主线程，而是在 500ms 空闲期后启动", async () => {
    await render();
    const active = instances[0];
    // 仅 finish，不推进时间
    await act(async () => { active.finish(); });
    // 切章完成瞬间，不应立刻同步创建下一个 spare 实例（抢占主线程）
    expect(instances).toHaveLength(1);
    // 推进 200ms，仍在空闲等待期中
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(instances).toHaveLength(1);
    // 推进满 500ms，后台预加载正式启动
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(instances).toHaveLength(2);
    expect(instances[1].path).toBe("1.xhtml");
  });

  it("在预加载空闲等待期内再次切章，会自动取消旧预加载任务", async () => {
    await render();
    const active = instances[0];
    await act(async () => { active.finish(); });
    expect(instances).toHaveLength(1);
    // 在 500ms 倒计时内，用户再次切章到第 2 章
    props = { ...props, spineIndex: 2 };
    await render();
    // 推进 500ms，不应启动第 1 章的旧预加载
    await act(async () => { vi.advanceTimersByTime(500); });
    const paths = instances.map((p) => p.path);
    expect(paths).not.toContain("1.xhtml");
  });


  it("切书释放旧活缓存，旧后台 ready 不再发布", async () => {
    await render();
    const active = instances[0];
    await finish(active);
    const oldSpare = instances[1];
    const onDisplayReady = props.onDisplayReady as ReturnType<typeof vi.fn>;
    const readyCalls = onDisplayReady.mock.calls.length;

    const nextBook = {
      ...props.book,
      opfPath: "book2.opf",
      spine: [0, 1, 2].map((i) => ({ idref: String(i), linear: true })),
      manifest: new Map([0, 1, 2].map((i) => [String(i), { href: `b2/${i}.xhtml` }])),
    } as Book;
    props = { ...props, book: nextBook };
    await render();

    expect(active.disposed).toBe(true);
    expect(oldSpare.disposed).toBe(true);
    await act(async () => { oldSpare.finish(); });
    // 旧任务的 display-ready 回调即使晚到也不能发布新书活动章 ready。
    expect(onDisplayReady.mock.calls.length).toBe(readyCalls);
  });

  it("五章活缓存补齐后才串行使用临时测量槽，临时 ready 不发布为活动章", async () => {
    const longBook = {
      ...props.book,
      spine: Array.from({ length: 7 }, (_, i) => ({ idref: String(i), linear: true })),
      manifest: new Map(Array.from({ length: 7 }, (_, i) => [String(i), { href: `${i}.xhtml` }])),
    } as Book;
    const onDisplayReady = vi.fn();
    // 统一验证无 requestIdleCallback 时的帧后小任务退避；有原生 rIC 的开发环境不走此测试路径。
    const idleWindow = window as unknown as { requestIdleCallback?: unknown };
    delete idleWindow.requestIdleCallback;
    props = { ...props, book: longBook, spineIndex: 3, onDisplayReady };
    await render();
    const active = instances[0];

    await act(async () => { active.finish(); });
    // 活动章 ready 后先等空闲 500ms，再按 next、prev、next2、prev2 补齐四个近邻。
    expect(instances).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(500); });
    const spareOrder = [instances[1].path];
    for (let i = 0; i < 3; i += 1) {
      const current = instances.at(-1)!;
      await act(async () => { current.finish(); });
      await act(async () => { vi.advanceTimersByTime(150); });
      spareOrder.push(instances.at(-1)!.path);
    }
    expect(spareOrder).toEqual(["4.xhtml", "2.xhtml", "5.xhtml", "1.xhtml"]);
    expect(instances).toHaveLength(5);
    const readyCalls = onDisplayReady.mock.calls.length;

    // 最后一个近邻 finish 后，空闲调度只进入远章轻量资源准备；
    // 不再创建第六个完整排版 iframe，也不写无人消费的页数摘要。
    await act(async () => { instances.at(-1)!.finish(); });
    await act(async () => { vi.advanceTimersByTime(150); });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(instances).toHaveLength(5);
    expect(props.server.textFor).toHaveBeenCalledWith("6.xhtml");
    expect(onDisplayReady.mock.calls.length).toBe(readyCalls);
  });

  it("普通翻页不销毁在途的近邻预载，空闲后也不重复创建同一章", async () => {
    const ref = createRef<ReaderHandle>();
    await dom.render(createElement(ReaderView, { ...props, ref }));
    const active = instances[0];
    await finish(active);
    // 第一个近邻已进入后台完整排版，但尚未 finish/发布。
    expect(instances).toHaveLength(2);
    const inFlight = instances[1];
    expect(inFlight.path).toBe("1.xhtml");

    await act(async () => { ref.current?.nextPage(); });
    // 普通输入只打断远章准备；在途的近邻目标保留，避免翻到章末时重新排版。
    expect(inFlight.disposed).toBe(false);
    expect(instances[0].disposed).toBe(false);

    await act(async () => { vi.advanceTimersByTime(500); });
    expect(instances.filter((p) => p.path === "1.xhtml" && !p.disposed)).toEqual([inFlight]);
  });

  it("末章空内容也发布 display-ready，不把 loading 留到永远", async () => {
    props = { ...props, settings: { ...props.settings, preloadNextChapter: false } };
    await render();
    const active = instances[0];
    props = { ...props, spineIndex: 3 };
    await render();
    await act(async () => { active.finishEmpty(); });
    expect(props.onDisplayReady).toHaveBeenCalled();
    expect(props.onRequestChapter).not.toHaveBeenCalled();
  });

  it("把不可变恢复 ticket 传入 load 并原样上报", async () => {
    const ticket = { session: 7, request: 11, chapterPath: "0.xhtml" };
    const onRestoreResult = vi.fn();
    props = {
      ...props,
      initialAnchor: {
        index: -1,
        ratio: 0.4,
        anchorTextOffset: 12,
        anchorTextSnippet: "正文",
        mediaAnchor: null,
      },
      restoreTicket: ticket,
      onRestoreResult,
    };
    await render();
    const active = instances[0];
    expect(active.loadOptions.restoreTicket).toEqual(ticket);
    expect(active.loadOptions.reportRestore).toBe(true);

    active.restoreHandler?.({ located: false, ticket, loadSeq: 1 });
    await act(async () => {});
    expect(onRestoreResult).toHaveBeenCalledWith({
      chapterPath: "0.xhtml",
      located: false,
      ticket,
    });
  });

  it("只把分页器真实用户提交回调及其来源 ticket 转发给宿主", async () => {
    const ticket = { session: 8, request: 12, chapterPath: "0.xhtml" };
    const onUserReadingPositionChange = vi.fn();
    props = { ...props, restoreTicket: ticket, onUserReadingPositionChange };
    await render();
    const active = instances[0];
    expect(active.loadOptions.restoreTicket).toEqual(ticket);
    expect(active.userCommitHandler).toBeTypeOf("function");

    await act(async () => { active.userCommitHandler?.(); });
    expect(onUserReadingPositionChange).toHaveBeenCalledWith(ticket);

    // 普通 ready / display-ready 页号变化不会重新推断成用户提交。
    await finish(active);
    expect(onUserReadingPositionChange).toHaveBeenCalledTimes(1);
  });

});
