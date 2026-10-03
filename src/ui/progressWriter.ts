import type { ShelfProgressPatch } from "./shelf";

type WriteProgress = (id: string, patch: ShelfProgressPatch) => Promise<void>;

/** Stale samples are already superseded; never retry them from failed/flush. */
function isStaleProgressSample(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === "stale-basis" || code === "stale-choice";
}

/**
 * 单通道、同书最新值优先的进度写入器。
 * 写入进行中时的连续翻页只保留最后一个待写位置，避免旧请求晚到覆盖新位置。
 */
export class ShelfProgressWriter {
  private readonly pending = new Map<string, ShelfProgressPatch>();
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly startedIds = new Set<string>();
  private readonly failed = new Map<
    string,
    { patch: ShelfProgressPatch; error: unknown }
  >();

  constructor(
    private readonly write: WriteProgress,
    private readonly options: { debounceMs?: number } = {},
  ) {}

  /** Start a new reading session for a book without disturbing other books. */
  beginSession(id: string): void {
    if (this.disposed) throw new Error("阅读进度写入器已销毁");
    this.startedIds.delete(id);
  }

  enqueue(id: string, patch: ShelfProgressPatch): void {
    if (this.disposed) throw new Error("阅读进度写入器已销毁");
    const firstForBook = !this.startedIds.has(id);
    this.pending.set(id, patch);
    // A failed value is superseded by a newer in-memory position for the same
    // book. Keeping the old failed value here could make flush write it back
    // after the newer patch.
    this.failed.delete(id);
    if (!this.draining) {
      const delay = Math.max(0, this.options.debounceMs ?? 750);
      if (firstForBook && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      // Persist the first position promptly. Once the channel has been used,
      // idle updates are debounced; updates arriving while a write is active
      // are already coalesced by `pending`.
      if (firstForBook || delay === 0) this.startDrain();
      else if (!this.timer) this.timer = setTimeout(() => {
        this.timer = null;
        this.startDrain();
      }, delay);
    }
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.draining) await this.draining;
    if (this.pending.size === 0 && this.failed.size === 0) return;
    // 返回书架/关闭窗口时对失败的最终位置再尝试一次；仍失败才交给 UI。
    const retries = Array.from(this.failed.entries());
    this.failed.clear();
    for (const [id, value] of retries) {
      // A newer patch may have arrived while the failed request was settling;
      // never replace it with the stale failed value.
      if (!this.pending.has(id)) this.pending.set(id, value.patch);
    }
    this.startDrain();
    while (this.draining) await this.draining;
    if (this.failed.size === 0) return;
    const error = Array.from(this.failed.values()).at(-1)?.error;
    throw error ?? new Error("阅读进度写入失败");
  }

  /** Stop timers and reject no work; callers should flush before disposing. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private startDrain(): void {
    if (this.disposed || this.draining || this.pending.size === 0) return;
    for (const id of this.pending.keys()) this.startedIds.add(id);
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.pending.size > 0 && !this.disposed) {
        const delay = Math.max(0, this.options.debounceMs ?? 750);
        if (delay === 0 || this.hasUnstartedPending()) this.startDrain();
        else this.timer = setTimeout(() => {
          this.timer = null;
          this.startDrain();
        }, delay);
      }
    });
  }

  private async drain(): Promise<void> {
    // Freeze this drain's work. Enqueues that happen while a backend write is
    // in flight belong to the next debounce window rather than being emitted
    // immediately by this loop.
    const batch = new Map(this.pending);
    this.pending.clear();
    for (const [id, patch] of batch) {
      try {
        await this.write(id, patch);
        this.failed.delete(id);
      } catch (error) {
        if (isStaleProgressSample(error)) {
          this.failed.delete(id);
          continue;
        }
        this.failed.set(id, { patch, error });
      }
    }
  }

  private hasUnstartedPending(): boolean {
    for (const id of this.pending.keys()) {
      if (!this.startedIds.has(id)) return true;
    }
    return false;
  }
}
