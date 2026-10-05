import type { ShelfProgressPatch } from "./shelf";
import type { ProgressLease } from "./portableState/ownedProgressSessions";

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
    // A new reading/adoption session supersedes queued or failed samples for
    // this book. The caller flushes the old session before calling this.
    this.pending.delete(id);
    this.failed.delete(id);
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


export type ScopedProgressSaveResult =
  | { readonly status: "saved"; readonly lease: ProgressLease }
  | { readonly status: "failed"; readonly lease: ProgressLease; readonly error: unknown };

interface ScopedSample<P> {
  readonly sequence: number;
  readonly patch: P;
}

interface ScopedLane<P> {
  readonly lease: ProgressLease;
  readonly write: (patch: P) => Promise<void>;
  sequence: number;
  started: boolean;
  pending: ScopedSample<P> | null;
  failed: { sample: ScopedSample<P>; error: unknown } | null;
  flight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-book latest-value channel. A lane is owned by one exact lease and is
 * never flushed or replaced by book ID alone.
 */
export class ScopedProgressWriter<P> {
  private readonly lanes = new Map<string, ScopedLane<P>>();
  private disposed = false;

  constructor(private readonly debounceMs = 750) {}

  register(lease: ProgressLease, write: (patch: P) => Promise<void>): void {
    if (this.disposed) throw new Error("阅读进度写入器已销毁");
    if (this.lanes.has(lease.bookId)) {
      throw new Error("不能覆盖仍持有的阅读会话；先保存并 retire");
    }
    this.lanes.set(lease.bookId, {
      lease, write, sequence: 0, started: false,
      pending: null, failed: null, flight: null, timer: null,
    });
  }

  current(bookId: string): ProgressLease | undefined {
    return this.lanes.get(bookId)?.lease;
  }

  private lane(lease: ProgressLease): ScopedLane<P> {
    const lane = this.lanes.get(lease.bookId);
    if (!lane || lane.lease !== lease) throw new Error("进度样本不属于当前阅读会话");
    return lane;
  }

  enqueue(lease: ProgressLease, patch: P): void {
    if (this.disposed) throw new Error("阅读进度写入器已销毁");
    const lane = this.lane(lease);
    lane.pending = { sequence: ++lane.sequence, patch };
    lane.failed = null; // Only a newer position from this exact lease supersedes it.
    this.schedule(lane);
  }

  hasUnsaved(lease: ProgressLease): boolean {
    const lane = this.lane(lease);
    return !!(lane.pending || lane.failed || lane.flight);
  }

  /** Retry this book once; callers decide whether its failure blocks this action. */
  async flush(lease: ProgressLease): Promise<ScopedProgressSaveResult> {
    const lane = this.lane(lease);
    this.cancelTimer(lane);
    while (lane.flight) await lane.flight;
    // Snapshot the failed value once; never spin on persistent storage errors.
    if (!lane.pending && lane.failed) {
      lane.pending = lane.failed.sample;
      lane.failed = null;
    }
    while (lane.pending || lane.flight) {
      this.cancelTimer(lane);
      this.start(lane);
      if (lane.flight) await lane.flight;
    }
    this.cancelTimer(lane);
    return lane.failed
      ? { status: "failed", lease, error: lane.failed.error }
      : { status: "saved", lease };
  }

  /** Export/window close may deliberately cover all books; normal open may not. */
  async flushBooks(bookIds?: readonly string[]): Promise<ScopedProgressSaveResult[]> {
    const selected = bookIds ? new Set(bookIds) : null;
    const lanes = [...this.lanes.values()].filter((lane) => !selected || selected.has(lane.lease.bookId));
    return Promise.all(lanes.map((lane) => this.flush(lane.lease)));
  }

  /**
   * Explicit user choice only: retain the lane's latest stable sample locally,
   * then remove the old lane without pretending the original write succeeded.
   */
  handoffToCheckpoint(lease: ProgressLease, retain: (sample: P) => void): void {
    const lane = this.lane(lease);
    if (lane.flight) throw new Error("旧进度请求仍在执行，请稍后重试");
    const sample = lane.pending ?? lane.failed?.sample;
    if (sample) retain(sample.patch); // retain must durably stage before lane removal
    this.cancelTimer(lane);
    this.lanes.delete(lease.bookId);
  }

  /** Must precede closing the lease. A failed sample is never silently erased. */
  retire(lease: ProgressLease): void {
    const lane = this.lane(lease);
    if (this.hasUnsaved(lease)) throw new Error("阅读进度尚未保存，不能释放会话");
    this.cancelTimer(lane);
    this.lanes.delete(lease.bookId);
  }

  /** Actual App teardown only; background/shelf navigation must not call this. */
  disposeTimers(): void {
    this.disposed = true;
    for (const lane of this.lanes.values()) this.cancelTimer(lane);
    // Keep pending/failed samples readable; this is not durable persistence.
  }

  private cancelTimer(lane: ScopedLane<P>): void {
    if (lane.timer !== null) clearTimeout(lane.timer);
    lane.timer = null;
  }

  private schedule(lane: ScopedLane<P>): void {
    if (this.disposed || lane.flight || !lane.pending || lane.timer !== null) return;
    if (!lane.started || this.debounceMs <= 0) this.start(lane);
    else lane.timer = setTimeout(() => {
      lane.timer = null;
      this.start(lane);
    }, this.debounceMs);
  }

  private start(lane: ScopedLane<P>): void {
    if (lane.flight || !lane.pending) return;
    const sample = lane.pending;
    lane.pending = null;
    lane.started = true;
    // Start in a microtask so flight is assigned even if write throws synchronously.
    lane.flight = Promise.resolve().then(async () => {
      try {
        await lane.write(sample.patch);
      } catch (error) {
        // A newer queued sample is authoritative; an old rejection cannot restore it.
        if (lane.sequence === sample.sequence) lane.failed = { sample, error };
      }
    }).finally(() => {
      lane.flight = null;
      this.schedule(lane);
    });
  }
}
