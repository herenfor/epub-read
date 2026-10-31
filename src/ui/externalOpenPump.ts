import type { ExternalOpenRequest } from "../platform/externalOpenBridge";

/**
 * - opened: the book is in the reader; the request is acknowledged.
 * - wait: not handled yet (busy, leaving the reader, import still rendering);
 *   the next state change kicks again.
 * - failed: shown to the user, who retries or dismisses it.
 */
export type ExternalOpenOutcome = "opened" | "wait" | "failed";

export interface ExternalOpenPumpDeps {
  peek(): Promise<ExternalOpenRequest | null>;
  acknowledge(requestId: string): Promise<boolean>;
  process(request: ExternalOpenRequest): Promise<ExternalOpenOutcome>;
  onFailed(request: ExternalOpenRequest | null): void;
  onError(error: unknown): void;
}

/**
 * The one serial worker over the native external-open queue. Kicks while it
 * runs are folded into one more pass; nothing is consumed without an ack, and
 * a failed head blocks the queue until the user retries or dismisses it.
 */
export class ExternalOpenPump {
  private running = false;
  private again = false;
  /** The queue may hold something: set by notices and waits, cleared by an empty peek. */
  private stale = true;
  private failed: ExternalOpenRequest | null = null;
  private stopped = false;

  constructor(private readonly deps: ExternalOpenPumpDeps) {}

  /** A native "pending" notice: the queue changed. */
  notify(): void {
    this.stale = true;
    this.kick();
  }

  /** A state change that might let a waiting request through. */
  kick(): void {
    if (this.stopped || this.failed || !this.stale) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.run();
  }

  retry(): void {
    if (!this.failed) return;
    this.failed = null;
    this.deps.onFailed(null);
    this.stale = true;
    this.kick();
  }

  async dismiss(): Promise<void> {
    const request = this.failed;
    if (!request) return;
    try {
      await this.deps.acknowledge(request.requestId);
    } catch (error) {
      this.deps.onError(error);
    }
    this.failed = null;
    this.deps.onFailed(null);
    this.stale = true;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        while (!this.stopped && !this.failed) {
          const request = await this.deps.peek();
          if (!request) {
            this.stale = false;
            break;
          }
          const outcome = await this.deps.process(request);
          if (this.stopped) return;
          if (outcome === "wait") break;
          if (outcome === "failed") {
            this.failed = request;
            this.deps.onFailed(request);
            break;
          }
          // Removing the head does not notify the next item: keep draining.
          await this.deps.acknowledge(request.requestId);
        }
      } while (this.again && this.stale && !this.failed && !this.stopped);
    } catch (error) {
      // Native state unreadable: report once and wait for the next notice.
      this.stale = false;
      this.deps.onError(error);
    } finally {
      this.running = false;
    }
  }
}
