/**
 * 可中断的合成层翻页驱动（WAAPI transform），只在一次运动期间接管 viewer。
 *
 * 整章设为可见溢出再整体平移，在手机上每写一次 transform 都要约 50ms 主线程。
 * 这里改用“K 屏窗口”（K=5）：viewer 仍是自身裁剪的滚动容器，宽度扩为 K 屏、左移
 * MID 屏，栏数按比例放大（栏宽/栏距不变，各栏绝对位置不变），body 只露出中间
 * 一屏；运动只写窗口内的 transform。静止时（settleTo/dispose 后）恢复原内联
 * 几何，其他读 scrollLeft/rect 的路径看不到窗口。
 *
 * 视觉阅读偏移 = 窗口 scrollLeft + MID 屏宽 − translateX。
 */
import type { InterruptResult, MotionSample, PageMotionDriver, SettlePlan } from "./pageMotion";
import { settleProgress } from "./pageMotion";

const WINDOW_SCREENS = 5;
const WINDOW_MID = 2;
const KEYFRAMES = 32;
const WINDOW_PROPERTIES = ["width", "margin-left", "column-count", "transform", "will-change"] as const;

export interface TransformMotionLayout {
  /** 各屏起点（与运动会话相同的 offsets）。 */
  readonly offsets: readonly number[];
  /** 屏宽：相邻屏起点之差（折叠几何下等于 viewer 宽）。 */
  readonly step: number;
  /** 每屏栏数（双页为 2）。 */
  readonly columnsPerScreen: number;
}

export class TransformPageMotion implements PageMotionDriver {
  private animation: Animation | null = null;
  private held: number;
  private generation = 0;
  private disposed = false;
  /** 窗口模式下的 scrollLeft；null 表示 viewer 处于正常几何。 */
  private windowStart: number | null = null;
  private restoreInline: (() => void) | null = null;

  constructor(
    private readonly viewer: HTMLElement,
    private readonly layout: TransformMotionLayout,
    initialPosition: number,
    private readonly onFault: (error: unknown) => void,
  ) {
    this.held = initialPosition;
  }

  /** 是否处于窗口模式（运动中或拖动中）。 */
  get active(): boolean {
    return this.windowStart !== null;
  }

  read(): MotionSample {
    // 正常几何下以真实 scrollLeft 为准：两次运动之间可能有跳转/恢复直接改过它。
    if (this.windowStart === null) return { position: this.viewer.scrollLeft };
    if (!this.animation) return { position: this.held };
    // 只在中断/显式快照/收尾时读取，不逐帧读。
    const value = this.viewer.ownerDocument.defaultView?.getComputedStyle(this.viewer).transform ?? "none";
    const x = value === "none" ? 0 : new DOMMatrixReadOnly(value).m41;
    return { position: this.windowStart + WINDOW_MID * this.layout.step - x };
  }

  interrupt(): InterruptResult {
    const sample = this.read();
    ++this.generation;
    const previous = this.animation;
    this.animation = null;
    // 先写入同位置的底层样式，再撤掉动画呈现；同一任务内完成，不 finish 到旧目标。
    this.held = sample.position;
    if (this.windowStart !== null) this.applyTransform();
    previous?.cancel();
    return { kind: "held", sample };
  }

  write(position: number): void {
    if (this.disposed) return;
    this.held = position;
    if (!this.ensureWindow(position, position)) return;
    this.applyTransform();
  }

  animateTo(position: number, plan: SettlePlan, done: () => void): void {
    if (this.disposed) return;
    const from = this.windowStart === null ? this.viewer.scrollLeft : this.held;
    this.held = from;
    const ticket = ++this.generation;
    if (plan.durationMs <= 0 || !this.ensureWindow(Math.min(from, position), Math.max(from, position))) {
      // 无需动画或窗口前提不成立：直接落到目标（正常几何下写 scrollLeft）。
      this.held = position;
      if (this.windowStart !== null) this.applyTransform();
      else this.viewer.scrollLeft = position;
      done();
      return;
    }
    const frames: Keyframe[] = [];
    for (let k = 0; k <= KEYFRAMES; k++) {
      const progress = settleProgress(plan, k / KEYFRAMES);
      frames.push({ transform: this.transformFor(from + (position - from) * progress), offset: k / KEYFRAMES });
    }
    let animation: Animation;
    try {
      animation = this.viewer.animate(frames, { duration: plan.durationMs, easing: "linear", fill: "both" });
    } catch (error) {
      this.onFault(error);
      this.settleTo(position);
      done();
      return;
    }
    this.animation = animation;
    void animation.finished.then(() => {
      if (this.disposed || ticket !== this.generation || this.animation !== animation) return;
      this.held = position;
      this.applyTransform();
      this.animation = null;
      animation.cancel();
      done();
    }, (error) => {
      // cancel 会使 finished 拒绝：只有当前这一轮的拒绝才是真故障。
      if (this.disposed || ticket !== this.generation) return;
      this.animation = null;
      this.onFault(error);
    });
  }

  /**
   * 收尾：撤窗口、恢复原内联几何，并把正常滚动位置停在 position。同一任务内
   * 完成，屏幕只会看到同一位置（不闪回、不残留旧惯性）。
   */
  settleTo(position: number): void {
    ++this.generation;
    const previous = this.animation;
    this.animation = null;
    this.held = position;
    if (this.windowStart !== null) {
      this.windowStart = null;
      this.restoreInline?.();
      this.restoreInline = null;
      this.viewer.scrollLeft = position;
    }
    previous?.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    const position = this.read().position;
    this.settleTo(position);
    this.disposed = true;
  }

  private transformFor(position: number): string {
    const start = this.windowStart ?? 0;
    return `translateX(${start + WINDOW_MID * this.layout.step - position}px)`;
  }

  private applyTransform(): void {
    this.viewer.style.setProperty("transform", this.transformFor(this.held));
  }

  /**
   * 让 [low, high] 落在窗口可视范围内。已在范围内则不动窗口（每次挪窗口都会
   * 换一批内容栅格化）；挪窗口时同一任务内同时改 scrollLeft 与 transform。
   * 进入窗口后整章内容宽度必须不变，否则说明栏位被改动，恢复并报故障。
   */
  private ensureWindow(low: number, high: number): boolean {
    const viewer = this.viewer;
    const { step, columnsPerScreen } = this.layout;
    if (!(step > 0)) return false;
    if (this.windowStart === null) {
      const before = viewer.scrollWidth;
      const snapshot = WINDOW_PROPERTIES.map((property) => ({
        property,
        value: viewer.style.getPropertyValue(property),
        priority: viewer.style.getPropertyPriority(property),
      }));
      this.restoreInline = () => {
        for (const item of snapshot) {
          if (item.value) viewer.style.setProperty(item.property, item.value, item.priority);
          else viewer.style.removeProperty(item.property);
        }
      };
      viewer.style.setProperty("width", `${WINDOW_SCREENS * step}px`);
      viewer.style.setProperty("margin-left", `${-WINDOW_MID * step}px`);
      viewer.style.setProperty("column-count", String(WINDOW_SCREENS * columnsPerScreen));
      viewer.style.setProperty("will-change", "transform");
      if (Math.abs(viewer.scrollWidth - before) > 1) {
        this.restoreInline();
        this.restoreInline = null;
        this.onFault(new Error(`page motion window changed layout (${before} → ${viewer.scrollWidth})`));
        return false;
      }
      this.windowStart = -Infinity;
    }
    const span = (WINDOW_SCREENS - 1) * step;
    const start = this.windowStart as number;
    if (low >= start && high <= start + span) return true;
    const maxStart = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
    const wanted = Math.round((low + high) / 2 - WINDOW_MID * step);
    viewer.scrollLeft = Math.max(0, Math.min(maxStart, wanted));
    this.windowStart = viewer.scrollLeft;
    this.applyTransform();
    return true;
  }
}
