/** Internal performance core: reuse one already-validated window for a short burst. */
export interface WindowLeasePort {
  /** True only for the same live paginator/layout, active window and idle motion. */
  canExitIdleWindow(): boolean;
  /** Restore normal geometry at the ACTUAL position, no commit/save/next. */
  exitIdleWindow(): void;
}

export interface LeaseClock {
  after(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

/**
 * One timeout, not a watchdog/poll. No input is disabled or delayed.
 * beginContact/endContact are a gesture pair, not every move event.
 * settled is called after a REAL settlement, including tap animations.
 * Immediate navigation/reflow/close first retires this lease, then the host halts
 * and restores its own driver. This class never performs a forced moving exit.
 */
export class MotionWindowIdleLease {
  private handle: unknown | null = null;
  private epoch = 0;
  private contact = false;
  private disposed = false;

  constructor(
    private readonly clock: LeaseClock,
    private readonly port: WindowLeasePort,
    private readonly idleMs = 900,
  ) {}

  beginContact(): void {
    if (this.disposed) return;
    this.contact = true;
    this.retireTimer();
  }

  /** New discrete command: retire old cleanup without pretending contact ended. */
  moving(): void {
    if (!this.disposed) this.retireTimer();
  }

  endContact(): void {
    if (this.disposed) return;
    this.contact = false;
    this.armIfIdle();
  }

  settled(): void {
    if (!this.disposed) this.armIfIdle();
  }

  dispose(): void {
    this.disposed = true;
    this.contact = false;
    this.retireTimer();
  }

  private armIfIdle(): void {
    this.retireTimer();
    if (this.contact || !this.port.canExitIdleWindow()) return;
    const ticket = this.epoch;
    this.handle = this.clock.after(this.idleMs, () => {
      if (this.disposed || ticket !== this.epoch) return;
      this.handle = null;
      // A new gesture/animation may start before a delivered timer executes.
      if (!this.contact && this.port.canExitIdleWindow()) this.port.exitIdleWindow();
    });
  }

  private retireTimer(): void {
    ++this.epoch;
    if (this.handle !== null) this.clock.cancel(this.handle);
    this.handle = null;
  }
}
