import { act, createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ReaderSettings } from "../render/settings";
import type { Book } from "../core/types";
import { createReactDomHarness } from "../test/reactDomHarness";

const instances = vi.hoisted(() => [] as MockPaginator[]);
class MockPaginator {
  disposed = false;
  isDisplayReady = false;
  state: { status: string; empty?: boolean } = { status: "loading" };
  currentPage = 0;
  pageCount = 2;
  path = "";
  complete: (() => void) | undefined;
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
    return new Promise<boolean>((resolve) => { this.complete = () => resolve(true); });
  });
  reloadWithSettings = vi.fn(async (settings: ReaderSettings) => {
    this.settings = settings;
    await this.load(this.path);
  });
  finish() {
    this.isDisplayReady = true;
    this.state = { status: "ready", empty: false };
    (this.callbacks[4] as Function)(this.state);
    (this.callbacks[15] as Function)();
    this.complete?.();
  }
  getStateSnapshot() { return this.state; }
  setNotes() {}
  setPage(page: number) { this.currentPage = page; }
  navigateToSearchTarget() { return "unresolved" as const; }
  closeForNavigation() {}
  clearSearchHighlight() {}
  resetWheelAccumulator() {}
  dispose() { this.disposed = true; this.complete?.(); }
}
vi.mock("../render/paginator", () => ({
  ChapterPaginator: class { constructor(...args: unknown[]) { return new MockPaginator(...args); } },
}));
import { ReaderView } from "./ReaderView";

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
      book, server: { revokeAll: vi.fn() } as unknown as ComponentProps<typeof ReaderView>["server"],
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
});
