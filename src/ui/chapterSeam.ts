/**
 * A16 无缝换章：章边一屏与相邻章首/末屏并排，一起跟手、一起落定。
 *
 * 只在高性能预读开启时使用：相邻章已在缓存槽里排好、显示就绪，这里只负责两个
 * iframe 的合成层平移，不加载章节、不提交进度。落定在相邻章后由宿主走既有的
 * 换章提交与缓存升格；弹回则撤掉平移，当前章不变。
 *
 * 位置沿用运动会话的“阅读偏移”：两屏 offsets = [0, W]，按阅读顺序第 0 屏是前一章的
 * 边屏（lead），第 1 屏是后一章的边屏（trail）。前进时当前章是 lead，后退时当前章是
 * trail。lead 平移 −s·p，trail 平移 s·(W−p)，s 为阅读方向（RTL 为 −1）。
 */
import {
  desktopSettlePlan,
  PageMotionSession,
  settlePlan,
  settleProgress,
  type InterruptResult,
  type MotionSample,
  type PageMotionDriver,
  type SettlePlan,
} from "../render/pageMotion";
import { pageAxisSign, type PageProgression } from "../render/pagedDirection";

const KEYFRAMES = 32;

type SeamElement = HTMLElement;

/** 两个 iframe 的同步平移；与章内 TransformPageMotion 同一套中断/收尾约定。 */
export class ChapterSeamDriver implements PageMotionDriver {
  private animations: Animation[] = [];
  private held: number;
  private generation = 0;
  private disposed = false;
  private readonly sign: 1 | -1;

  constructor(
    private readonly lead: SeamElement,
    private readonly trail: SeamElement,
    private readonly width: number,
    progression: PageProgression,
    initialPosition: number,
    private readonly onFault: (error: unknown) => void,
  ) {
    this.sign = pageAxisSign(progression);
    this.held = initialPosition;
    this.apply(initialPosition);
  }

  read(): MotionSample {
    if (this.animations.length === 0) return { position: this.held };
    const value = this.lead.ownerDocument.defaultView?.getComputedStyle(this.lead).transform ?? "none";
    const x = value === "none" ? 0 : new DOMMatrixReadOnly(value).m41;
    return { position: -x * this.sign };
  }

  interrupt(): InterruptResult {
    const sample = this.read();
    ++this.generation;
    const previous = this.animations;
    this.animations = [];
    // 先写同位置的底层样式再撤动画呈现，同一任务内完成，不跳到旧目标。
    this.held = sample.position;
    this.apply(sample.position);
    for (const animation of previous) animation.cancel();
    return { kind: "held", sample };
  }

  write(position: number): void {
    if (this.disposed) return;
    this.held = position;
    this.apply(position);
  }

  animateTo(position: number, plan: SettlePlan, done: () => void): void {
    if (this.disposed) return;
    const from = this.held;
    const ticket = ++this.generation;
    if (plan.durationMs <= 0) {
      this.held = position;
      this.apply(position);
      done();
      return;
    }
    const desktop = plan.curve === "ease-out-cubic";
    const leadFrames: Keyframe[] = [];
    const trailFrames: Keyframe[] = [];
    const steps = desktop ? 1 : KEYFRAMES;
    for (let k = 0; k <= steps; k++) {
      const progress = desktop ? k : settleProgress(plan, k / KEYFRAMES);
      const at = from + (position - from) * progress;
      const offset = desktop ? undefined : k / KEYFRAMES;
      leadFrames.push({ transform: this.leadTransform(at), ...(offset === undefined ? {} : { offset }) });
      trailFrames.push({ transform: this.trailTransform(at), ...(offset === undefined ? {} : { offset }) });
    }
    const timing: KeyframeAnimationOptions = {
      duration: plan.durationMs,
      easing: desktop ? "cubic-bezier(0.3333333333, 1, 0.6666666667, 1)" : "linear",
      fill: "both",
    };
    let animations: Animation[];
    try {
      // 同一任务内创建：两段动画同帧开始，同一时长与曲线，始终严丝合缝。
      animations = [this.lead.animate(leadFrames, timing), this.trail.animate(trailFrames, timing)];
    } catch (error) {
      this.onFault(error);
      this.held = position;
      this.apply(position);
      done();
      return;
    }
    this.animations = animations;
    void Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (this.disposed || ticket !== this.generation) return;
      this.held = position;
      this.apply(position);
      this.animations = [];
      for (const animation of animations) animation.cancel();
      done();
    }, (error) => {
      // cancel 会使 finished 拒绝：只有当前这一轮的拒绝才是真故障。
      if (this.disposed || ticket !== this.generation) return;
      this.animations = [];
      this.onFault(error);
    });
  }

  /** 撤掉两侧的平移（交还给正常的单 iframe 显示）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.lead.style.removeProperty("transform");
    this.trail.style.removeProperty("transform");
  }

  private leadTransform(position: number): string {
    return `translate3d(${-this.sign * position}px, 0, 0)`;
  }

  private trailTransform(position: number): string {
    return `translate3d(${this.sign * (this.width - position)}px, 0, 0)`;
  }

  private apply(position: number): void {
    this.lead.style.setProperty("transform", this.leadTransform(position));
    this.trail.style.setProperty("transform", this.trailTransform(position));
  }
}

export interface ChapterSeamOptions {
  /** 1 = 去下一章（当前章是 lead），-1 = 去上一章（当前章是 trail）。 */
  direction: 1 | -1;
  current: SeamElement;
  neighbor: SeamElement;
  /** 一屏宽（单页或双页都是整个视口宽）。 */
  width: number;
  progression: PageProgression;
  /** 触屏用松手曲线，桌面用与章内相同的缓出。 */
  touch: boolean;
  /** 落定：landed=true 停在相邻章，false 回到当前章。 */
  onSettled(landed: boolean): void;
  onFault(error: unknown): void;
}

export type SeamTurnResult = "moving" | "beyond" | "duplicate";

/**
 * 一次章边联动。会话只有两屏；拖动、点按、反向与打断全部沿用 PageMotionSession 的
 * 票据语义，一次最多跨一个章节边界。
 */
export class ChapterSeam {
  readonly direction: 1 | -1;
  private readonly session: PageMotionSession;
  private readonly driver: ChapterSeamDriver;
  private readonly currentPage: 0 | 1;
  private dragBase = 0;
  private finished = false;

  constructor(private readonly options: ChapterSeamOptions) {
    this.direction = options.direction;
    this.currentPage = options.direction === 1 ? 0 : 1;
    const lead = options.direction === 1 ? options.current : options.neighbor;
    const trail = options.direction === 1 ? options.neighbor : options.current;
    const width = options.width;
    const start = this.currentPage * width;
    this.driver = new ChapterSeamDriver(lead, trail, width, options.progression, start, (error) => this.fault(error));
    this.session = new PageMotionSession(
      this.driver,
      [0, width],
      this.currentPage,
      (page) => this.settled(page),
      (sample) => this.settled(sample.position >= width / 2 ? 1 : 0),
      (distance, velocity) => options.touch ? settlePlan(distance, velocity) : desktopSettlePlan(distance, width),
    );
  }

  get neighborPage(): 0 | 1 {
    return this.currentPage === 0 ? 1 : 0;
  }

  /** 拖动或动画进行中（idle 只在构造后、被接手前短暂出现）。 */
  get moving(): boolean {
    const kind = this.session.state.kind;
    return kind === "dragging" || kind === "settling";
  }

  get done(): boolean {
    return this.finished;
  }

  /** 横向意图成立（含打断进行中的联动）；返回拖动票据。 */
  beginDrag(direction: 1 | -1): number | null {
    if (this.finished) return null;
    const result = this.session.beginDrag(direction);
    if (result.kind !== "dragging") return null;
    this.dragBase = result.sample.position;
    return result.ticket;
  }

  /** dx 为逻辑横向位移（负 = 前进），与章内拖动同一约定。 */
  drag(ticket: number, dx: number): void {
    this.session.drag(ticket, this.dragBase - dx);
  }

  /** 松手：direction 0 回起点屏，±1 去相邻屏；返回是否接住了该拖动。 */
  release(ticket: number, direction: -1 | 0 | 1, velocity: number | null): boolean {
    const state = this.session.state;
    if (state.kind !== "dragging" || state.ticket !== ticket) return false;
    return this.session.releaseDrag(ticket, state.originPage + direction, velocity) !== null;
  }

  /** 独立翻页命令；"beyond" 表示越过了两屏范围（宿主可预约到新章里再翻一次）。 */
  turn(inputId: number, direction: 1 | -1): SeamTurnResult {
    if (this.finished) return "beyond";
    const result = this.session.turn(inputId, direction);
    if (result.kind === "moving") return "moving";
    if (result.kind === "duplicate") return "duplicate";
    return "beyond";
  }

  /** 撤掉平移并结束（落定后升格完成、或被导航/重排/故障打断）。 */
  dispose(): void {
    this.finished = true;
    this.session.dispose();
  }

  private settled(page: number): void {
    if (this.finished) return;
    this.options.onSettled(page === this.neighborPage);
  }

  private fault(error: unknown): void {
    this.options.onFault(error);
  }
}
