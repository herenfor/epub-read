/**
 * B-153 高性能预备队列核心。纯调度状态，不含 DOM、计时器或主线程抢占逻辑；
 * 宿主在每次空闲回调中调用 `take`，一次只允许一个后台任务在跑。
 *
 * `chapters` 是按阅读顺序排列的 spine 下标；`resident` 必须是当前布局代次下
 * 真正 display-ready 的章节集合。已测过但 DOM 已被淘汰的近邻仍会重新入队。
 */
export interface WarmupTicket {
  readonly epoch: number;
  readonly serial: number;
  readonly chapter: number;
}

export class ReadingWarmupPlan {
  private epoch = 0;
  private serial = 0;
  private chapters: readonly number[] = [];
  private done = new Set<number>();
  private failed = new Set<number>();
  private running: WarmupTicket | null = null;

  /** 开书、影响排版的配置变化或关闭高性能模式：旧 epoch 的任何异步结果不可发布。 */
  reset(chapters: readonly number[]): void {
    this.epoch += 1;
    this.chapters = [...chapters];
    this.done.clear();
    this.failed.clear();
    this.running = null;
  }

  /**
   * 取下一个后台任务。`active` 必须是已 display-ready 的活动章；候选顺序为
   * next、prev、next2、prev2，然后才按 spine 顺序逐章预备。
   */
  take(
    active: number,
    resident: ReadonlySet<number>,
    userBusy: boolean,
    foregroundPending: boolean,
  ): WarmupTicket | null {
    if (userBusy || foregroundPending || this.running) return null;
    this.done.add(active);
    const at = this.chapters.indexOf(active);
    if (at < 0) return null;

    const preferred = [at + 1, at - 1, at + 2, at - 2]
      .filter((i) => i >= 0 && i < this.chapters.length)
      .map((i) => this.chapters[i]);
    const chapter =
      preferred.find((i) => !resident.has(i) && !this.failed.has(i)) ??
      [...this.chapters.slice(at + 1), ...this.chapters.slice(0, at)].find(
        (i) => !resident.has(i) && !this.done.has(i) && !this.failed.has(i),
      );
    if (chapter === undefined) return null;

    const ticket: WarmupTicket = {
      epoch: this.epoch,
      serial: ++this.serial,
      chapter,
    };
    this.running = ticket;
    return ticket;
  }

  isCurrent(ticket: WarmupTicket): boolean {
    return this.running === ticket && ticket.epoch === this.epoch;
  }

  /** 是否还有本 epoch 内未处理且未失败的章节。 */
  hasRemaining(): boolean {
    return this.chapters.some((chapter) => !this.done.has(chapter) && !this.failed.has(chapter));
  }

  finish(ticket: WarmupTicket, success: boolean): boolean {
    if (!this.isCurrent(ticket)) return false;
    (success ? this.done : this.failed).add(ticket.chapter);
    this.running = null;
    return true;
  }

  /** 输入优先：宿主必须先 abort/dispose 正在进行的旧工作，再继续调度。 */
  interrupt(): WarmupTicket | null {
    const ticket = this.running;
    this.running = null;
    return ticket;
  }
}
