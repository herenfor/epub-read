/**
 * 翻页运动的状态机与中断接口（纯逻辑：无 DOM、定时器、存储）。
 *
 * 位置是同一布局下的“阅读偏移”（CSS px，双页为 spread 起点），offsets 为当前布局
 * 各屏起点（升序、非空、布局期间不变）。一个会话只属于一个 viewport/布局与一个
 * 驱动；布局或章节改变时销毁会话。目标规则：A→B 未完成时反向回到 A；继续同向
 * 则从当前画面续到 C；每个独立输入只改变一屏。
 */
import { readSnapPosition } from "./nativeSnapPosition";

export type Direction = -1 | 1;
export interface MotionSample { readonly position: number }
export type InterruptResult =
  | { readonly kind: "held"; readonly sample: MotionSample }
  | { readonly kind: "unsupported"; readonly sample: MotionSample };

/** 收尾曲线；手势漂移先指数减速，再以同速度接入有限尾段。 */
export interface SettlePlan {
  readonly durationMs: number;
  readonly tauMs: number;
  readonly curve?: "finite-drift";
}

/**
 * held 是物理承诺：旧运动确实停止，且当前可见位置被保留；只丢弃回调、撤吸附或
 * 隐藏 overflow 都不算。animateTo 只在 held 后调用，被取消的运行绝不调用 done。
 */
export interface PageMotionDriver {
  read(): MotionSample;
  interrupt(): InterruptResult;
  write(position: number): void;
  animateTo(position: number, plan: SettlePlan, done: () => void): void;
  dispose(): void;
}

export type PageMotionState =
  | { readonly kind: "idle"; readonly page: number }
  | { readonly kind: "dragging"; readonly originPage: number; readonly ticket: number }
  | { readonly kind: "settling" | "external"; readonly originPage: number;
      readonly targetPage: number; readonly ticket: number }
  | { readonly kind: "disposed" };

export type TurnResult =
  | { readonly kind: "duplicate" | "disposed" }
  | { readonly kind: "moving"; readonly ticket: number; readonly targetPage: number }
  | { readonly kind: "unsupported"; readonly targetPage: number; readonly sample: MotionSample }
  | { readonly kind: "boundary"; readonly direction: Direction; readonly sample: MotionSample;
      readonly settled: boolean };

export type DragStartResult =
  | { readonly kind: "dragging"; readonly ticket: number; readonly originPage: number;
      readonly sample: MotionSample }
  | { readonly kind: "unsupported"; readonly sample: MotionSample }
  | { readonly kind: "disposed" };

/** 点按（无初速度）时的衰减常数。 */
export const SETTLE_TAP_TAU_MS = 90;
const SETTLE_TAU_MIN_MS = 60;
const SETTLE_TAU_MAX_MS = 160;
const SETTLE_MIN_MS = 180;
const SETTLE_MAX_MS = 700;
/** 距目标小于该值视为已落定（不再值得一段动画）。 */
const SETTLE_REST_PX = 0.5;

/**
 * 松手/点按的收尾：沿松手速度先指数减速，再平滑停到目标。
 * velocity 为位置单位的 px/ms；方向与剩余距离一致时让初速度接上手指，否则用点按常数。
 */
export function settlePlan(distance: number, velocity: number | null): SettlePlan {
  const remaining = Math.abs(distance);
  let tauMs = SETTLE_TAP_TAU_MS;
  const drifting = velocity !== null && Math.abs(velocity) > 0.05 && Math.sign(velocity) === Math.sign(distance);
  if (drifting) {
    tauMs = Math.max(SETTLE_TAU_MIN_MS, Math.min(SETTLE_TAU_MAX_MS, remaining / Math.abs(velocity)));
  }
  if (remaining <= SETTLE_REST_PX) return { durationMs: 0, tauMs };
  // 两个 tau 的指数前段保留松手速度；两个 tau 的尾段从该速度减到零。
  // 总长 240–640ms，不截短后跳到目标，也不把已近乎静止的微移拖到 700ms。
  if (drifting) return { durationMs: 4 * tauMs, tauMs, curve: "finite-drift" };
  const durationMs = Math.round(Math.min(SETTLE_MAX_MS,
    Math.max(SETTLE_MIN_MS, tauMs * Math.log(remaining / SETTLE_REST_PX))));
  return { durationMs, tauMs };
}

/** 收尾进度 0..1（t 为 0..1 的时间比例），在 t=1 恰好为 1。 */
export function settleProgress(plan: SettlePlan, t: number): number {
  if (plan.durationMs <= 0) return 1;
  const clamped = Math.max(0, Math.min(1, t));
  if (plan.curve === "finite-drift") {
    if (clamped <= 0.5) return 1 - Math.exp(-4 * clamped);
    // p 与 dp/dt 在中点连续；终点速度为零。平方剩余量始终非负，绝不越界。
    return 1 - Math.exp(-2) * (2 * (1 - clamped)) ** 2;
  }
  const norm = 1 - Math.exp(-plan.durationMs / plan.tauMs);
  return (1 - Math.exp(-clamped * plan.durationMs / plan.tauMs)) / norm;
}

/** 纯策略：A→B 反向回 A；A→B→C 反向请求 B。 */
export function nextDesiredPage(state: PageMotionState, direction: Direction, visualPage: number): number {
  const base = state.kind === "settling" || state.kind === "external"
    ? state.targetPage : state.kind === "dragging" ? state.originPage : visualPage;
  return base + direction;
}

const nearestPage = (offsets: readonly number[], position: number): number =>
  readSnapPosition(offsets, position)?.page ?? 0;

/**
 * 单个 viewport/布局的运动会话。UI 每个真实操作分配一个单调 inputId，派生的
 * touchend/click 共用该 ID，只消费一次；旧动画/旧拖动的回调凭 ticket 失效。
 */
export class PageMotionSession {
  private epoch = 0;
  private lastInputId = -1;
  private current: PageMotionState;
  private pendingTarget: number | null = null;

  constructor(
    private readonly driver: PageMotionDriver,
    private readonly offsets: readonly number[],
    initialPage: number,
    private readonly onCommit: (page: number, sample: MotionSample) => void,
    private readonly onMismatch: (sample: MotionSample) => void,
  ) {
    this.current = { kind: "idle", page: initialPage };
  }

  get state(): PageMotionState { return this.current; }
  get deferredTarget(): number | null { return this.pendingTarget; }
  get pageCount(): number { return this.offsets.length; }
  read(): MotionSample { return this.driver.read(); }
  offsetOf(page: number): number { return this.offsets[page]; }
  nearest(position: number): number { return nearestPage(this.offsets, position); }

  /** 观测一次已由其他执行者接手的运动；不是请求再启动一个驱动。 */
  observeExternal(originPage: number, targetPage: number): number {
    if (this.current.kind === "disposed") return this.epoch;
    this.pendingTarget = null; // 新的真实横滑取代被延后的点按。
    const ticket = ++this.epoch;
    this.current = { kind: "external", originPage, targetPage, ticket };
    return ticket;
  }

  turn(inputId: number, direction: Direction): TurnResult {
    if (this.current.kind === "disposed") return { kind: "disposed" };
    if (inputId <= this.lastInputId) return { kind: "duplicate" };
    this.lastInputId = inputId;
    const sample = this.driver.read();
    const page = nearestPage(this.offsets, sample.position);
    const target = this.pendingTarget === null
      ? nextDesiredPage(this.current, direction, page) : this.pendingTarget + direction;
    if (target < 0 || target >= this.offsets.length) {
      // 宿主最多预约一次跨章，待物理落定后执行；这里从不加载章节。
      return {
        kind: "boundary",
        direction,
        sample,
        settled: this.current.kind === "idle" && Math.abs(sample.position - this.offsets[page]) <= 1,
      };
    }
    const stopped = this.driver.interrupt();
    if (stopped.kind === "unsupported") {
      // 旧运动仍在：保留旧票据/状态，不开第二条动画，也不静默丢弃意图。
      this.pendingTarget = target;
      return { kind: "unsupported", targetPage: target, sample: stopped.sample };
    }
    this.pendingTarget = null;
    const origin = this.current.kind === "idle" ? page : this.current.originPage;
    return this.startSettlement(origin, target, stopped.sample, null);
  }

  /**
   * 横向意图成立后才调用（不是每次按下）；在当前视觉位置接手。正在去目标页时
   * 又朝同一方向拖，以那个目标页为起点（与按钮“未完成时同向续接”一致），
   * 否则以最近屏为起点。
   */
  beginDrag(direction?: Direction): DragStartResult {
    if (this.current.kind === "disposed") return { kind: "disposed" };
    const previous = this.current;
    const stopped = this.driver.interrupt();
    if (stopped.kind === "unsupported") return stopped;
    this.pendingTarget = null;
    const ticket = ++this.epoch;
    const nearest = nearestPage(this.offsets, stopped.sample.position);
    const originPage = direction !== undefined &&
      (previous.kind === "settling" || previous.kind === "external") &&
      Math.sign(previous.targetPage - nearest) === direction
      ? previous.targetPage : nearest;
    this.current = { kind: "dragging", originPage, ticket };
    return { kind: "dragging", ticket, originPage, sample: stopped.sample };
  }

  /** 拖动只在起点屏与相邻屏之间跟手：一次手势最多一屏。 */
  drag(ticket: number, position: number): void {
    if (this.current.kind !== "dragging" || this.current.ticket !== ticket) return;
    const origin = this.current.originPage;
    const low = this.offsets[Math.max(0, origin - 1)];
    const high = this.offsets[Math.min(this.offsets.length - 1, origin + 1)];
    this.driver.write(Math.max(low, Math.min(high, position)));
  }

  /** 松手：目标只能是起点屏或相邻屏（由调用方按距离/反悔规则选择）。 */
  releaseDrag(ticket: number, targetPage: number, velocity: number | null): TurnResult | null {
    if (this.current.kind !== "dragging" || this.current.ticket !== ticket) return null;
    const origin = this.current.originPage;
    const target = Math.max(0, Math.min(this.offsets.length - 1,
      Math.max(origin - 1, Math.min(origin + 1, targetPage))));
    return this.startSettlement(origin, target, this.driver.read(), velocity);
  }

  /** 调用方确认外部运动已真实静止（期限到不算证明）。 */
  externalSettled(ticket: number, noActivePointer: boolean, physicallySettled: boolean): void {
    if (this.current.kind !== "external" || this.current.ticket !== ticket ||
        !noActivePointer || !physicallySettled) return;
    const sample = this.driver.read();
    // 原生松手可能回到原页：提交实际合法落点。
    this.commit(ticket, sample, nearestPage(this.offsets, sample.position));
  }

  /** 外部运动落定后复用被延后的目标；不新造输入 ID。 */
  resumeDeferred(): TurnResult | null {
    if (this.current.kind !== "idle" || this.pendingTarget === null) return null;
    const stopped = this.driver.interrupt();
    if (stopped.kind === "unsupported") {
      return { kind: "unsupported", targetPage: this.pendingTarget, sample: stopped.sample };
    }
    const target = this.pendingTarget;
    this.pendingTarget = null;
    return this.startSettlement(this.current.page, target, stopped.sample, null);
  }

  /** 中止当前运动并停在原地（导航/重排前调用）；返回停下的位置。 */
  halt(): MotionSample | null {
    if (this.current.kind === "disposed") return null;
    const stopped = this.driver.interrupt();
    if (stopped.kind === "unsupported") return null;
    ++this.epoch;
    this.pendingTarget = null;
    this.current = { kind: "idle", page: nearestPage(this.offsets, stopped.sample.position) };
    return stopped.sample;
  }

  /** 布局改变/关闭：调用方须先保存只读快照再销毁。 */
  dispose(): void {
    if (this.current.kind === "disposed") return;
    ++this.epoch;
    this.pendingTarget = null;
    this.current = { kind: "disposed" };
    this.driver.dispose();
  }

  private startSettlement(originPage: number, targetPage: number, from: MotionSample,
    velocity: number | null): TurnResult {
    const ticket = ++this.epoch;
    this.current = { kind: "settling", originPage, targetPage, ticket };
    const to = this.offsets[targetPage];
    this.driver.animateTo(to, settlePlan(to - from.position, velocity), () => {
      if (ticket !== this.epoch || this.current.kind === "disposed") return;
      this.commit(ticket, this.driver.read(), targetPage);
    });
    return { kind: "moving", ticket, targetPage };
  }

  private commit(ticket: number, sample: MotionSample, page: number): void {
    if (ticket !== this.epoch || this.current.kind === "disposed") return;
    ++this.epoch;
    if (Math.abs(sample.position - this.offsets[page]) > 1) {
      // 不伪造落页、不循环校正：交给宿主按实际位置处理。
      this.current = { kind: "idle", page: nearestPage(this.offsets, sample.position) };
      this.onMismatch(sample);
      return;
    }
    this.current = { kind: "idle", page };
    this.onCommit(page, sample);
  }
}
