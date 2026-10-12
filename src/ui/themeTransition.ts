import { uiMotionReduced } from "./motionPreference";

/**
 * 主题过渡请求契约
 */
export type ThemeTransitionRequest = {
  /**
   * 同步提交最新目标，只执行一次；宿主负责真正更新 React/正文 DOM。
   */
  commit(): void;
  /**
   * 是否需要动画。当且仅当主题实际变化且宿主允许装饰过渡时为 true；
   * 若为 false（例如与几何尺寸一同改变、恢复默认重排等）则直接提交，不走过渡。
   */
  animate: boolean;
};

/**
 * 宿主环境配置注入
 */
export type ThemeTransitionHost = {
  /**
   * 目标文档对象，默认为全局 document。
   */
  document?: Document;
  /**
   * 是否处于减弱动效模式（系统或应用级）。
   * 默认检测 uiMotionReduced()。
   */
  isMotionReduced?: () => boolean;
  /**
   * 是否处于后台。
   * 默认检测 document.hidden。
   */
  isBackgrounded?: () => boolean;
  /**
   * 过渡开始时的回调（注入当前代次）。
   */
  onTransitionStart?: (generation: number) => void;
  /**
   * 过渡结束或中断时的清理回调（注入当前代次）。同一代次保证只收口一次。
   */
  onTransitionEnd?: (generation: number) => void;
  /**
   * 异步更新回调（如 ViewTransition updateCallback）发生异常时的错误出口。
   */
  onCommitError?: (error: unknown, generation: number) => void;
};

/**
 * 判断当前环境是否支持 Document.startViewTransition API
 */
export function isViewTransitionSupported(doc?: Document): boolean {
  const targetDoc = doc ?? (typeof document !== "undefined" ? document : undefined);
  return typeof targetDoc !== "undefined" && typeof (targetDoc as any)?.startViewTransition === "function";
}

/**
 * 可中断的整屏主题过渡控制器
 *
 * 核心设计原则：
 * 1. 宿主注入的同步 commit 始终是状态与 DOM 的唯一真值，控制器不自行读写 settings 或 paginator。
 * 2. 递增代次与 committed 标记保护：新请求取代旧请求，最新请求的 commit 绝不丢失；
 *    旧回调、迟到 promise 绝不晚提交，旧 finally 绝不误删新请求的临时样式类。
 * 3. 销毁语义（dispose）：彻底撤销未提交目标，使旧代次失效；已销毁控制器不再提交任何新请求，
 *    迟到回调与 promise 绝不再碰已卸载宿主。
 * 4. 中断语义（interrupt）：活宿主主动中断（用户手势、翻页、切后台），同步提交最新目标并跳过动画，
 *    提交异常向外保留，且通过 try/finally 确保彻底清理属于本次的过渡与临时样式。
 * 5. 一次收口保证：同一代次过渡只触发一次 onTransitionEnd，迟到结算不重复触发。
 */
export class ThemeTransitionController {
  private generation = 0;
  private committedGeneration = 0;
  private readonly closedGenerations = new Set<number>();
  private pendingRequest: ThemeTransitionRequest | null = null;
  private activeTransition: { skipTransition(): void } | null = null;
  private disposed = false;
  private boundVisibilityHandler: (() => void) | null = null;

  private readonly doc: Document | null;
  private readonly isMotionReduced: () => boolean;
  private readonly isBackgrounded: () => boolean;
  private readonly host: ThemeTransitionHost;

  constructor(options?: ThemeTransitionHost) {
    this.host = options ?? {};
    this.doc = this.host.document ?? (typeof document !== "undefined" ? document : null);
    this.isMotionReduced = this.host.isMotionReduced ?? uiMotionReduced;
    this.isBackgrounded = this.host.isBackgrounded ?? (() => (this.doc ? !!this.doc.hidden : false));

    if (this.doc && typeof this.doc.addEventListener === "function") {
      this.boundVisibilityHandler = () => {
        if (!this.disposed && this.isBackgrounded()) {
          this.interrupt();
        }
      };
      this.doc.addEventListener("visibilitychange", this.boundVisibilityHandler);
    }
  }

  /**
   * 发起主题过渡请求。
   * 新请求取代旧请求；最新请求的 commit 保证被执行。已销毁控制器不执行任何操作。
   */
  request(req: ThemeTransitionRequest): void {
    if (this.disposed) {
      return;
    }

    const doc = this.doc;
    const canAnimate =
      req.animate &&
      Boolean(doc) &&
      isViewTransitionSupported(doc!) &&
      !this.isMotionReduced() &&
      !this.isBackgrounded();

    if (!canAnimate) {
      // 不满足动效条件：瞬时直接同步提交
      this.interruptCurrentAnimation();
      const gen = ++this.generation;
      this.committedGeneration = gen;
      this.pendingRequest = null;
      try {
        req.commit();
      } finally {
        this.cleanup(gen);
      }
      return;
    }

    // 满足过渡条件：开启 ViewTransition
    const gen = ++this.generation;
    this.pendingRequest = req;

    // 先中断先前的动画（若有）
    this.interruptCurrentAnimation();

    this.applyTransitionScope(true);
    if (!this.disposed) {
      this.host.onTransitionStart?.(gen);
    }

    let transition: any;
    try {
      transition = (doc as any).startViewTransition(() => {
        // 检查身份：已被取代、已销毁或已提交则跳过
        if (this.disposed || this.generation !== gen || this.committedGeneration === gen) {
          return;
        }
        this.committedGeneration = gen;
        this.pendingRequest = null;
        try {
          req.commit();
        } catch (err) {
          this.host.onCommitError?.(err, gen);
          throw err;
        }
      });
    } catch {
      // 启动动画失败（例如环境限制或文档状态不可用）：
      // 仍走同一个有效目标提交，并通过 try/finally 确保释放本次样式
      const pending = (!this.disposed && this.generation === gen && this.committedGeneration !== gen)
        ? this.pendingRequest
        : null;
      if (pending) {
        this.committedGeneration = gen;
        this.pendingRequest = null;
      }
      try {
        if (pending) {
          pending.commit();
        }
      } finally {
        this.cleanup(gen);
      }
      return;
    }

    this.activeTransition = transition;

    // 正常跳过导致 ready 拒绝不算用户错误；必须挂载 catch 处理
    if (transition && typeof transition.ready?.catch === "function") {
      transition.ready.catch(() => {});
    }

    // 监听 finished 结束生命周期
    if (transition && typeof transition.finished?.then === "function") {
      transition.finished
        .then(() => {
          this.cleanup(gen);
        })
        .catch(() => {
          // 被 skipTransition() 中断或取消时进入 catch，正常完成清理
          this.cleanup(gen);
        });
    } else {
      this.cleanup(gen);
    }
  }

  /**
   * 中断当前装饰过渡：
   * 活宿主主动中断，提交当前未提交的最新目标，跳过装饰动画，释放属于本次的临时样式；
   * 提交异常向外保留，try/finally 保证过渡状态与样式完全清理。
   */
  interrupt(): void {
    if (this.disposed) return;
    const targetGen = this.generation;
    const transitionToCancel = this.activeTransition;
    const pendingReq = (this.pendingRequest && this.committedGeneration !== targetGen)
      ? this.pendingRequest
      : null;

    if (pendingReq) {
      this.committedGeneration = targetGen;
      this.pendingRequest = null;
    }

    try {
      if (pendingReq) {
        pendingReq.commit();
      }
    } finally {
      if (transitionToCancel && this.activeTransition === transitionToCancel) {
        this.activeTransition = null;
        try {
          transitionToCancel.skipTransition();
        } catch {
          // 忽略 skipTransition 可能抛出的异常
        }
      }
      this.cleanup(targetGen);
    }
  }

  /**
   * 释放过渡、事件监听与临时样式。
   * 撤销未提交目标，使旧代次失效；后续回调不再触碰已卸载宿主。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const currentGen = this.generation;

    // 撤销未提交的挂起请求，不触碰已卸载宿主
    this.pendingRequest = null;

    if (this.activeTransition) {
      const transition = this.activeTransition;
      this.activeTransition = null;
      try {
        transition.skipTransition();
      } catch {
        // 忽略 skipTransition 异常
      }
    }

    if (this.boundVisibilityHandler && this.doc && typeof this.doc.removeEventListener === "function") {
      this.doc.removeEventListener("visibilitychange", this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }

    this.cleanup(currentGen);
  }

  /** 当前是否有正在播放的视图过渡动画 */
  get isTransitioning(): boolean {
    return !this.disposed && this.activeTransition !== null;
  }

  /** 当前最新的请求代次 */
  get currentGeneration(): number {
    return this.generation;
  }

  /** 是否已被释放 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private interruptCurrentAnimation(): void {
    if (this.activeTransition) {
      const transition = this.activeTransition;
      this.activeTransition = null;
      try {
        transition.skipTransition();
      } catch {
        // 忽略 skipTransition 可能抛出的异常
      }
    }
  }

  private cleanup(gen: number): void {
    // 代次检查与一次收口：
    // 旧代次且未销毁时不清理新代次；已收口过的代次不重复处理
    if ((this.generation !== gen && !this.disposed) || this.closedGenerations.has(gen)) {
      return;
    }
    this.closedGenerations.add(gen);

    if (this.generation === gen) {
      this.activeTransition = null;
    }
    this.applyTransitionScope(false);

    // 销毁后不再次通知宿主
    if (!this.disposed) {
      this.host.onTransitionEnd?.(gen);
    }
  }

  private applyTransitionScope(active: boolean): void {
    if (!this.doc || !this.doc.documentElement) return;
    const el = this.doc.documentElement;
    if (active) {
      el.setAttribute("data-theme-transitioning", "true");
      el.classList?.add("theme-transitioning");
    } else {
      el.removeAttribute("data-theme-transitioning");
      el.classList?.remove("theme-transitioning");
    }
  }
}

/**
 * 工厂函数：创建 ThemeTransitionController 实例
 */
export function createThemeTransitionController(
  options?: ThemeTransitionHost,
): ThemeTransitionController {
  return new ThemeTransitionController(options);
}
