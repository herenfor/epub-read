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
   * 过渡结束或中断时的清理回调（注入当前代次）。
   */
  onTransitionEnd?: (generation: number) => void;
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
 * 3. skipTransition 仅跳过装饰动画，不会取消浏览器的 updateCallback；必须通过代次检查阻止旧目标晚提交。
 * 4. 读者输入、换页导航或切后台时立即 interrupt()：同步提交最新目标并跳过动画，不留半段动画，不回滚，不锁输入。
 * 5. 妥善捕获 ready/finished 等 Promise 拒绝，避免非预期的 unhandled rejection。
 */
export class ThemeTransitionController {
  private generation = 0;
  private committedGeneration = 0;
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
        if (this.isBackgrounded()) {
          this.interrupt();
        }
      };
      this.doc.addEventListener("visibilitychange", this.boundVisibilityHandler);
    }
  }

  /**
   * 发起主题过渡请求。
   * 新请求取代旧请求；最新请求的 commit 保证被执行。
   */
  request(req: ThemeTransitionRequest): void {
    if (this.disposed) {
      req.commit();
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
      // 不满足动效条件（无需动画、无 API、减弱动效、后台中）：直接瞬时同步提交
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
    this.host.onTransitionStart?.(gen);

    let transition: any;
    try {
      transition = (doc as any).startViewTransition(() => {
        // 检查身份：已被取代、已销毁或已提交则跳过
        if (this.disposed || this.generation !== gen || this.committedGeneration === gen) {
          return;
        }
        this.committedGeneration = gen;
        this.pendingRequest = null;
        req.commit();
      });
    } catch {
      // 启动动画失败（例如环境限制或文档状态不可用）：
      // 仍走同一个有效目标提交，释放本次样式，不把错误吞成静默丢失
      if (!this.disposed && this.generation === gen && this.committedGeneration !== gen) {
        this.committedGeneration = gen;
        this.pendingRequest = null;
        req.commit();
      }
      this.cleanup(gen);
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
   * 提交当前未提交的最新目标，跳过装饰动画，释放属于本次的临时样式；
   * 立即允许读者继续阅读与交互，不锁死界面。
   */
  interrupt(): void {
    if (this.disposed) return;
    const currentGen = this.generation;

    // 若最新目标尚未提交，立即同步提交
    if (this.pendingRequest && this.committedGeneration !== currentGen) {
      this.committedGeneration = currentGen;
      const req = this.pendingRequest;
      this.pendingRequest = null;
      req.commit();
    }

    this.interruptCurrentAnimation();
    this.cleanup(currentGen);
  }

  /**
   * 释放过渡、事件监听与临时样式。
   * 后续回调不再操作已卸载宿主。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const currentGen = this.generation;

    if (this.pendingRequest && this.committedGeneration !== currentGen) {
      this.committedGeneration = currentGen;
      const req = this.pendingRequest;
      this.pendingRequest = null;
      try {
        req.commit();
      } catch {
        // 宿主卸载期间容错
      }
    }

    this.interruptCurrentAnimation();

    if (this.boundVisibilityHandler && this.doc && typeof this.doc.removeEventListener === "function") {
      this.doc.removeEventListener("visibilitychange", this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }

    this.cleanup(currentGen);
  }

  /** 当前是否有正在播放的视图过渡动画 */
  get isTransitioning(): boolean {
    return this.activeTransition !== null;
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
    // 代次检查：旧 finally 不能移除新请求的临时类
    if (this.generation !== gen && !this.disposed) {
      return;
    }
    if (this.generation === gen) {
      this.activeTransition = null;
    }
    this.applyTransitionScope(false);
    this.host.onTransitionEnd?.(gen);
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
