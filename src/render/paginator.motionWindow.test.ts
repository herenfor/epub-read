import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterPaginator } from "./paginator";
import { MotionWindowIdleLease } from "./motionWindowIdleLease";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function leaseFixture() {
  let idle = true;
  const exit = vi.fn();
  const callbacks: Array<() => void> = [];
  const lease = new MotionWindowIdleLease({
    after: (ms, callback) => { callbacks.push(callback); return setTimeout(callback, ms); },
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }, { canExitIdleWindow: () => idle, exitIdleWindow: exit });
  return { lease, exit, callbacks, moving: () => { idle = false; }, idle: () => { idle = true; } };
}

describe("motion window idle lease", () => {
  it("连续落定延后退出；旧定时回调不能拆掉新窗口", () => {
    const f = leaseFixture();
    f.lease.settled();
    vi.advanceTimersByTime(600);
    f.lease.moving(); f.moving();
    f.callbacks[0]();
    expect(f.exit).not.toHaveBeenCalled();
    f.idle(); f.lease.settled();
    vi.advanceTimersByTime(899);
    expect(f.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.exit).toHaveBeenCalledTimes(1);
  });
  it("手指停留超过租期也不退出；取消/抬手后正常回收", () => {
    const f = leaseFixture();
    f.lease.settled(); f.lease.beginContact();
    vi.advanceTimersByTime(2000);
    expect(f.exit).not.toHaveBeenCalled();
    f.lease.endContact();
    vi.advanceTimersByTime(900);
    expect(f.exit).toHaveBeenCalledTimes(1);
  });
  it("运动中或销毁后不退出；没有周期轮询", () => {
    const f = leaseFixture();
    f.moving(); f.lease.settled();
    expect(vi.getTimerCount()).toBe(0);
    f.idle(); f.lease.settled(); f.lease.dispose();
    f.callbacks[0](); vi.advanceTimersByTime(3000);
    expect(f.exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Invoke the real paginator wiring without building an unrelated resource server.
type Pager = Record<string, any>;
function pagerFixture() {
  const p = Object.create(ChapterPaginator.prototype) as Pager;
  const el = { textContent: "current page text", getBoundingClientRect: () => ({ left: 0, width: 100 }) };
  const text = { nodeType: 3, parentElement: el };
  const caret = vi.fn(() => ({ offsetNode: text, offset: 0 }));
  const viewer = {
    clientWidth: 500, clientHeight: 100, clientLeft: 0, scrollLeft: 200,
    getBoundingClientRect: () => ({ left: -200, top: 0 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ paddingLeft: "0" }) } },
  };
  const driver = { active: true, read: () => ({ position: 400 }), holdSettledAt: vi.fn(), settleTo: vi.fn() };
  const lease = leaseFixture().lease;
  Object.assign(p, {
    viewer, contentDoc: { documentElement: { clientWidth: 100 }, caretPositionFromPoint: caret },
    textIndex: { offsetForNode: () => 400, elementIndex: () => 4, snippetAt: () => "current page text", totalChars: 900, mediaUnits: 0 },
    pageMotion: { driver, session: { state: { kind: "idle" }, offsetOf: (page: number) => page * 100 }, lease },
    settings: { readingMode: "paginated" }, disposed: false, metrics: { currentPage: 4 },
    lastState: { status: "ready", currentPage: 4, pageCount: 10, empty: false },
    effectiveColumns: 1, leadingColumns: 0, pageWidth: 100, step: 100, geometry: { columns: 1, columnWidth: 100 },
    _currentPath: "Text/ch.xhtml", pageMotionPendingChapter: null,
    readVisualPosition: () => ({ page: 4, left: 400, snapLeft: 400, aligned: true }),
    readyState: (empty: boolean, page = p.metrics.currentPage) => ({ status: "ready", currentPage: page, pageCount: 10, empty }),
    emit: vi.fn(), scheduleAnchorSample: vi.fn(), cancelPendingAnchorSample: vi.fn(),
  });
  return { p, driver, caret };
}

describe("paginator retained motion window", () => {
  it("进度采样使用视觉正文坐标，不撤窗口；正式快照不被误标 transient", () => {
    const { p, driver, caret } = pagerFixture();
    p.captureAnchor();
    expect(caret).toHaveBeenCalledWith(50, 50);
    expect(p.anchor.textOffset).toBe(400);
    expect(p.anchorPath).toBe("Text/ch.xhtml");
    const snapshot = p.readPositionSnapshot();
    p.readPositionSnapshot();
    expect(caret).toHaveBeenCalledTimes(1);
    expect(snapshot?.state).toMatchObject({ currentPage: 4 });
    expect(snapshot?.state).not.toHaveProperty("transient");
    expect(snapshot?.readingAnchor?.textOffset).toBe(400);
    expect(driver.settleTo).not.toHaveBeenCalled();
  });
  it("显式运动快照仍采样当前视觉位置并标 transient，不能返回缓存的旧锚点", () => {
    const { p, caret } = pagerFixture();
    p.anchor = { textOffset: 100 };
    p.pageMotion.session.state = { kind: "settling" };
    const snapshot = p.readPositionSnapshot();
    expect(snapshot?.state.transient).toBe(true);
    expect(snapshot?.readingAnchor.textOffset).toBe(400);
    expect(caret).toHaveBeenCalledOnce();
  });

  it("真实落定立即认账，窗口延迟退出与进度提交分离", () => {
    const { p, driver } = pagerFixture();
    p.commitPageMotion(5);
    expect(driver.holdSettledAt).toHaveBeenCalledWith(500);
    expect(driver.settleTo).not.toHaveBeenCalled();
    expect(p.metrics.currentPage).toBe(5);
    expect(p.emit).toHaveBeenCalledWith({ status: "ready", currentPage: 5, pageCount: 10, empty: false });
    expect(p.scheduleAnchorSample).toHaveBeenCalledOnce();
  });
  it("同步落定后处理命令返回值，不取消刚安排的空闲回收", () => {
    const { p } = pagerFixture();
    p.closeFootnoteForNavigation = vi.fn();
    p.clearSearchHighlightForDocument = vi.fn();
    p.reportPageMotionLivePage = vi.fn();
    p.commitPageMotion(4);
    p.pageMotionStarted(4);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(900);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("显式导航仍立即恢复正常几何；旧租约不再触发退出", () => {
    const { p, driver } = pagerFixture();
    p.pageMotion.lease.settled();
    p.haltPageMotion();
    expect(driver.settleTo).toHaveBeenCalledWith(400);
    expect(vi.getTimerCount()).toBe(0);
  });
});
