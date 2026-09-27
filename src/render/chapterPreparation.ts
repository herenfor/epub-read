export type PreparationPriority = 0 | 1 | 2; // 0: 显式目标, 1: 可见/紧邻, 2: 远处

export interface PreparationContext {
  signal: AbortSignal;
  priority(): PreparationPriority;
}

function cancelled(): DOMException {
  return new DOMException("章节准备已失效", "AbortError");
}

interface Entry<T> {
  controller: AbortController;
  priority: PreparationPriority;
  promise: Promise<T>;
  ready: boolean;
  value?: T;
}

/**
 * 一个实例只服务同一 book session + layout revision。
 * 所有阶段缓存均不能冒充这里的最终 T：T 必须已通过 display-ready。
 * 普通翻页/滚轮不调用 forget/reset。尺寸/字体等布局身份变化才 reset。
 * 这是准备结果的所有权，不代替 App/Continuous 的导航票据。
 */
export class ChapterPreparationRegistry<T> {
  private entries = new Map<string, Entry<T>>();
  private release: (value: T) => void;

  constructor(release: (value: T) => void) {
    this.release = release;
  }

  request(
    path: string,
    priority: PreparationPriority,
    prepare: (context: PreparationContext) => Promise<T>,
  ): Promise<T> {
    const existing = this.entries.get(path);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority) as PreparationPriority;
      return existing.promise; // 正在预排的目标升级优先级，复用同一 promise/iframe。
    }
    const controller = new AbortController();
    const entry: Entry<T> = { controller, priority, ready: false, promise: null! };
    this.entries.set(path, entry);
    entry.promise = new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(cancelled());
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const context: PreparationContext = {
        signal: controller.signal,
        priority: () => entry.priority,
      };
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancelled();
        return prepare(context);
      }).then((value) => {
        controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted || this.entries.get(path) !== entry) {
          this.release(value); // 取消不保证底层立即停止；晚到结果仍需销毁。
          reject(cancelled());
          return;
        }
        entry.value = value;
        entry.ready = true;
        resolve(value);
      }, (error) => {
        controller.signal.removeEventListener("abort", onAbort);
        if (this.entries.get(path) === entry) this.entries.delete(path);
        reject(error);
      });
    });
    return entry.promise;
  }

  /** 阅读方向改变后可降低旧任务的优先级；不销毁它已完成的工作。 */
  reprioritize(path: string, priority: PreparationPriority): void {
    const entry = this.entries.get(path);
    if (entry) entry.priority = priority;
  }

  peek(path: string): T | undefined {
    const entry = this.entries.get(path);
    return entry?.ready ? entry.value : undefined;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  isReady(path: string): boolean {
    return Boolean(this.entries.get(path)?.ready);
  }

  /**
   * 导航票据仍有效时，交出 ready 槽的所有权给活动宿主。
   * expected 防止旧 await 的结果误取同路径的新实例。宿主此后负责销毁它。
   */
  takeReady(path: string, expected?: T): T | undefined {
    const entry = this.entries.get(path);
    if (!entry?.ready) return undefined;
    if (expected !== undefined && entry.value !== expected) return undefined;
    this.entries.delete(path);
    return entry.value;
  }

  /** 活动槽降为缓存。返回 false 时未接收所有权，调用方仍负责该值。 */
  retainReady(path: string, value: T): boolean {
    if (this.entries.has(path)) return false;
    this.entries.set(path, {
      controller: new AbortController(),
      priority: 2,
      ready: true,
      value,
      promise: Promise.resolve(value),
    });
    return true;
  }

  /** 只用于容量淘汰（不得淘汰活动/显式目标/可见章节）。 */
  forget(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    entry.controller.abort();
    if (entry.ready && entry.value !== undefined) this.release(entry.value);
  }

  reset(): void {
    const paths = Array.from(this.entries.keys());
    for (const path of paths) this.forget(path);
  }

  get size(): number {
    return this.entries.size;
  }
}

interface DomStep {
  context: PreparationContext;
  run(): void;
  resolve(): void;
  reject(error: unknown): void;
  cancel(): void;
}

/**
 * DOM 同步工作只有一条通道。字节解压、图片/字体等待不能放入 run。
 * yieldTurn 由宿主提供：可见窗口用 RAF 后的任务，隐藏窗口暂停后台派发。
 * 每步建议 <= 6ms；这个类不能抢占一个已经开始的 100ms 同步函数。
 * 要在安全阶段切片，不是在原 measure 外套一层 Promise 冒充异步化。
 */
export class DomPreparationLane {
  private steps: DomStep[] = [];
  private running = false;
  private yieldTurn: () => Promise<void>;

  constructor(yieldTurn?: () => Promise<void>) {
    this.yieldTurn = yieldTurn ?? defaultYieldTurn;
  }

  run(context: PreparationContext, run: () => void): Promise<void> {
    if (context.signal.aborted) return Promise.reject(cancelled());
    const promise = new Promise<void>((resolve, reject) => {
      const step: DomStep = {
        context,
        run,
        resolve,
        reject,
        cancel: () => {
          this.steps = this.steps.filter((item) => item !== step);
          reject(cancelled());
        },
      };
      context.signal.addEventListener("abort", step.cancel, { once: true });
      this.steps.push(step);
    });
    if (!this.running) void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.steps.length) {
        await this.yieldTurn();
        // 等待绘制期间显式目标可能改变；在执行前取最新优先级。
        this.steps.sort((a, b) => a.context.priority() - b.context.priority());
        const step = this.steps.shift();
        if (!step) continue;
        step.context.signal.removeEventListener("abort", step.cancel);
        if (step.context.signal.aborted) {
          step.reject(cancelled());
          continue;
        }
        try {
          step.run();
          step.resolve();
        } catch (error) {
          step.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function defaultYieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * 仅适用于互不依赖的纯读/判断，例如 C-53 第二轮的 batch.add 阶段。
 * 不用于浮动试排→读取→回滚；不要让下一切片依赖本切片刚写入的布局。
 * 所有读取完成后，C-53 batch.flush 保留为单次写阶段。
 */
export async function readCandidatesInSlices<T>(
  candidates: readonly T[],
  context: PreparationContext,
  lane: DomPreparationLane,
  read: (candidate: T) => void,
  now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
): Promise<void> {
  let cursor = 0;
  while (cursor < candidates.length) {
    await lane.run(context, () => {
      const until = now() + 6;
      do {
        read(candidates[cursor++]);
      } while (cursor < candidates.length && now() < until);
    });
  }
}
