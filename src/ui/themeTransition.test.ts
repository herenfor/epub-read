import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import {
  createThemeTransitionController,
  isViewTransitionSupported,
  ThemeTransitionController,
} from "./themeTransition";

type MockTransition = {
  skipTransition: ReturnType<typeof vi.fn>;
  ready: Promise<void>;
  finished: Promise<void>;
  resolveFinished: () => void;
  rejectFinished: (err: unknown) => void;
  rejectReady: (err: unknown) => void;
};

function createMockTransition(): MockTransition {
  let resolveFinished!: () => void;
  let rejectFinished!: (err: unknown) => void;
  let rejectReady!: (err: unknown) => void;

  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const ready = new Promise<void>((_resolve, reject) => {
    rejectReady = reject;
  });

  const skipTransition = vi.fn(() => {
    // 模拟原生行为：skipTransition 导致 ready 和 finished reject
    const abortErr = new Error("Transition was skipped");
    rejectReady(abortErr);
    rejectFinished(abortErr);
  });

  return {
    skipTransition,
    ready,
    finished,
    resolveFinished,
    rejectFinished,
    rejectReady,
  };
}

function createTestHarness(options?: {
  supportsApi?: boolean;
  reducedMotion?: boolean;
  backgrounded?: boolean;
}) {
  const { document } = parseHTML("<html><head></head><body></body></html>");
  let activeMockTransition: MockTransition | null = null;
  let nextUpdateCallback: (() => void) | null = null;

  if (options?.supportsApi !== false) {
    (document as any).startViewTransition = vi.fn((cb: () => void) => {
      nextUpdateCallback = cb;
      activeMockTransition = createMockTransition();
      return activeMockTransition;
    });
  }

  const isMotionReduced = vi.fn(() => Boolean(options?.reducedMotion));
  const isBackgrounded = vi.fn(() => Boolean(options?.backgrounded));
  const onStart = vi.fn();
  const onEnd = vi.fn();

  const controller = new ThemeTransitionController({
    document,
    isMotionReduced,
    isBackgrounded,
    onTransitionStart: onStart,
    onTransitionEnd: onEnd,
  });

  return {
    document,
    controller,
    isMotionReduced,
    isBackgrounded,
    onStart,
    onEnd,
    getActiveTransition: () => activeMockTransition,
    flushUpdateCallback: () => {
      const cb = nextUpdateCallback;
      nextUpdateCallback = null;
      cb?.();
    },
  };
}

describe("ThemeTransitionController", () => {
  it("detects API support accurately via isViewTransitionSupported", () => {
    const { document } = parseHTML("<html></html>");
    expect(isViewTransitionSupported(document)).toBe(false);

    (document as any).startViewTransition = () => {};
    expect(isViewTransitionSupported(document)).toBe(true);
  });

  it("commits synchronously without animation when startViewTransition is unsupported", () => {
    const { controller, document } = createTestHarness({ supportsApi: false });
    const commit = vi.fn();

    controller.request({ commit, animate: true });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
    expect(document.documentElement.classList.contains("theme-transitioning")).toBe(false);
  });

  it("commits synchronously without animation when animate is false", () => {
    const { controller, document } = createTestHarness();
    const commit = vi.fn();

    controller.request({ commit, animate: false });

    expect(commit).toHaveBeenCalledTimes(1);
    expect((document as any).startViewTransition).not.toHaveBeenCalled();
    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
  });

  it("commits synchronously without animation when motion is reduced", () => {
    const { controller, document } = createTestHarness({ reducedMotion: true });
    const commit = vi.fn();

    controller.request({ commit, animate: true });

    expect(commit).toHaveBeenCalledTimes(1);
    expect((document as any).startViewTransition).not.toHaveBeenCalled();
    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
  });

  it("commits synchronously without animation when app is backgrounded", () => {
    const { controller, document } = createTestHarness({ backgrounded: true });
    const commit = vi.fn();

    controller.request({ commit, animate: true });

    expect(commit).toHaveBeenCalledTimes(1);
    expect((document as any).startViewTransition).not.toHaveBeenCalled();
    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
  });

  it("runs standard view transition lifecycle and cleans up upon finish", async () => {
    const harness = createTestHarness();
    const { controller, document, onStart, onEnd, getActiveTransition, flushUpdateCallback } = harness;
    const commit = vi.fn();

    controller.request({ commit, animate: true });

    expect(controller.isTransitioning).toBe(true);
    expect(document.documentElement.getAttribute("data-theme-transitioning")).toBe("true");
    expect(document.documentElement.classList.contains("theme-transitioning")).toBe(true);
    expect(onStart).toHaveBeenCalledWith(1);

    // 浏览器调用 updateCallback 执行真正的 DOM 提交
    flushUpdateCallback();
    expect(commit).toHaveBeenCalledTimes(1);

    // 动画完成
    const transition = getActiveTransition();
    expect(transition).not.toBeNull();
    transition!.resolveFinished();
    await transition!.finished;

    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
    expect(document.documentElement.classList.contains("theme-transitioning")).toBe(false);
    expect(onEnd).toHaveBeenCalledWith(1);
  });

  it("replaces old requests: stale updateCallback does not commit late, only latest commits", () => {
    const harness = createTestHarness();
    const { controller, document } = harness;

    const commit1 = vi.fn();
    const commit2 = vi.fn();

    // 抓取第 1 次 startViewTransition 的 updateCallback，先不执行
    let cb1: (() => void) | null = null;
    let cb2: (() => void) | null = null;
    (document as any).startViewTransition = vi.fn((cb: () => void) => {
      if (!cb1) cb1 = cb;
      else cb2 = cb;
      return createMockTransition();
    });

    controller.request({ commit: commit1, animate: true });
    expect(controller.currentGeneration).toBe(1);

    // 快速发起第 2 个请求，此时第 1 个尚未 commit
    controller.request({ commit: commit2, animate: true });
    expect(controller.currentGeneration).toBe(2);

    // 模拟浏览器迟到执行第 1 个回调
    cb1!();
    expect(commit1).toHaveBeenCalledTimes(0); // 旧目标被取代，绝不晚提交

    // 第 2 个回调执行
    cb2!();
    expect(commit2).toHaveBeenCalledTimes(1); // 最新目标成功提交
  });

  it("skips in-flight animation on fast switch and preserves new generation temporary scope", async () => {
    const harness = createTestHarness();
    const { controller, document, onStart, onEnd } = harness;

    const commit1 = vi.fn();
    const commit2 = vi.fn();

    let t1!: MockTransition;
    let t2!: MockTransition;
    (document as any).startViewTransition = vi.fn((cb: () => void) => {
      if (!t1) {
        t1 = createMockTransition();
        cb(); // 同步提交
        return t1;
      }
      t2 = createMockTransition();
      cb();
      return t2;
    });

    controller.request({ commit: commit1, animate: true });
    expect(commit1).toHaveBeenCalledTimes(1);
    expect(controller.currentGeneration).toBe(1);

    // 在 t1 播放中快速发起第 2 次切换
    controller.request({ commit: commit2, animate: true });
    expect(commit2).toHaveBeenCalledTimes(1);
    expect(controller.currentGeneration).toBe(2);
    expect(t1.skipTransition).toHaveBeenCalledTimes(1);

    // t1 的 finally/catch 结算
    await t1.finished.catch(() => {});

    // 关键断言：旧 finally 绝不移除新请求的临时类
    expect(document.documentElement.getAttribute("data-theme-transitioning")).toBe("true");
    expect(document.documentElement.classList.contains("theme-transitioning")).toBe(true);

    // t2 完成动画
    t2.resolveFinished();
    await t2.finished;

    // t2 结束后正常移除
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
    expect(document.documentElement.classList.contains("theme-transitioning")).toBe(false);
    expect(onStart).toHaveBeenCalledWith(2);
    expect(onEnd).toHaveBeenCalledWith(2);
  });

  it("interrupt() commits uncommitted latest target synchronously and stops animation immediately", () => {
    const harness = createTestHarness();
    const { controller, document, getActiveTransition } = harness;

    const commit = vi.fn();
    controller.request({ commit, animate: true });

    // 此时浏览器尚未调用 updateCallback，用户产生输入（如翻页/手势）
    controller.interrupt();

    // interrupt 必须立即同步提交最新目标，跳过装饰动画
    expect(commit).toHaveBeenCalledTimes(1);
    const transition = getActiveTransition();
    expect(transition?.skipTransition).toHaveBeenCalledTimes(1);
    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);

    // 迟到的 updateCallback 不会重复提交
    harness.flushUpdateCallback();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("interrupts decoration immediately when entering background via visibilitychange", () => {
    const harness = createTestHarness();
    const { controller, document, isBackgrounded, getActiveTransition, flushUpdateCallback } = harness;

    const commit = vi.fn();
    controller.request({ commit, animate: true });
    flushUpdateCallback();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(controller.isTransitioning).toBe(true);

    // 模拟切入后台
    isBackgrounded.mockReturnValue(true);
    document.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event("visibilitychange"));

    // 必须已中断动画并清理临时样式
    const transition = getActiveTransition();
    expect(transition?.skipTransition).toHaveBeenCalledTimes(1);
    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
  });

  it("still commits target and releases style scope if startViewTransition throws synchronously", () => {
    const { document, isMotionReduced, isBackgrounded } = createTestHarness();
    (document as any).startViewTransition = vi.fn(() => {
      throw new Error("InvalidStateError");
    });

    const controller = new ThemeTransitionController({
      document,
      isMotionReduced,
      isBackgrounded,
    });

    const commit = vi.fn();
    controller.request({ commit, animate: true });

    // 启动失败仍走同一个有效目标提交，释放属于本次的样式，不丢目标
    expect(commit).toHaveBeenCalledTimes(1);
    expect(controller.isTransitioning).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
  });

  it("dispose() skips in-flight transition, removes event listeners and prevents leaking", () => {
    const harness = createTestHarness();
    const { controller, document, getActiveTransition, flushUpdateCallback } = harness;

    const commit = vi.fn();
    controller.request({ commit, animate: true });
    flushUpdateCallback();

    controller.dispose();
    expect(controller.isDisposed).toBe(true);
    expect(getActiveTransition()?.skipTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);

    // dispose 后新请求直接同步 commit，不碰 transition 逻辑
    const commit2 = vi.fn();
    controller.request({ commit: commit2, animate: true });
    expect(commit2).toHaveBeenCalledTimes(1);
  });

  it("factory function createThemeTransitionController creates functional controller instance", () => {
    const { document } = parseHTML("<html></html>");
    const instance = createThemeTransitionController({ document });
    expect(instance).toBeInstanceOf(ThemeTransitionController);
    expect(instance.currentGeneration).toBe(0);
    expect(instance.isDisposed).toBe(false);
  });
});
