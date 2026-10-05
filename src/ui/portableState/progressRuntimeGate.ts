/** Lightweight, read-only native status. No shelf snapshot, migration or prune. */
export interface ProgressRuntimeStatus {
  readonly repositoryGeneration: string;
  readonly repositoryReady: boolean;
}

export class ProgressRuntimeUnavailable extends Error {
  constructor(
    readonly code: "runtime-check-timeout" | "runtime-check-interrupted" | "runtime-not-ready",
  ) {
    super("阅读资料服务尚未就绪，请重试；书籍没有因此被删除");
    this.name = "ProgressRuntimeUnavailable";
  }
}

/** Events invalidate checks; an actual response, rather than an event, proves readiness. */
export class ProgressRuntimeGate {
  private epoch = 0;
  private flight: { epoch: number; promise: Promise<ProgressRuntimeStatus> } | null = null;

  constructor(
    private readonly inspect: () => Promise<ProgressRuntimeStatus>,
    private readonly timeoutMs = 5000,
  ) {}

  invalidate(): void {
    this.epoch++;
    this.flight = null;
  }

  /** Call on foreground/open, also after a real operation reports a stale runtime. */
  check(): Promise<ProgressRuntimeStatus> {
    if (this.flight?.epoch === this.epoch) return this.flight.promise;
    const epoch = this.epoch;
    const deadline = Date.now() + this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProgressRuntimeUnavailable("runtime-check-timeout")), this.timeoutMs);
    });
    const promise = Promise.race([Promise.resolve().then(this.inspect), timeout])
      .then((status) => {
        if (epoch !== this.epoch) throw new ProgressRuntimeUnavailable("runtime-check-interrupted");
        // JS timers may have been frozen. Check wall time before accepting a late response.
        if (Date.now() >= deadline) throw new ProgressRuntimeUnavailable("runtime-check-timeout");
        if (!status.repositoryReady) throw new ProgressRuntimeUnavailable("runtime-not-ready");
        return status;
      }).finally(() => {
        clearTimeout(timer);
        if (this.flight?.promise === promise) this.flight = null;
      });
    this.flight = { epoch, promise };
    return promise;
  }
}
