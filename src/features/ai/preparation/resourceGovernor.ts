import { ProviderError, throwIfAborted } from "../contracts/provider";
import type { HardwareProbeResult } from "./contracts";
import { assessMemoryBudget } from "../hardware/budget";

interface Waiter { bytes: number; signal?: AbortSignal; grant(): void; cancel(): void }
/** One admitted mock session. Reading priority also pauses active work at batch boundaries. */
export class ResourceGovernor {
  private reserved = 0;
  private active = false;
  private reading = false;
  private readonly queue: Waiter[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(private readonly probe: HardwareProbeResult) {}
  get snapshot() { return { reservedBytes: this.reserved, active: this.active, waiting: this.queue.length, reading: this.reading }; }
  setReadingBusy(busy: boolean): void {
    this.reading = busy;
    if (!busy) { for (const listener of this.listeners) listener(); this.drain(); }
  }
  async waitUntilRunnable(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.reading) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.listeners.delete(ready); signal?.removeEventListener("abort", abort); };
      const ready = () => { if (!this.reading) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(new ProviderError("aborted", "已取消等待阅读器空闲")); };
      this.listeners.add(ready); signal?.addEventListener("abort", abort, { once: true });
    });
  }
  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    const budget = this.probe.memoryBudgetBytes;
    if (this.probe.source !== "mock" || !this.probe.backends.some((b) => b.id === "mock" && b.available)) {
      throw new ProviderError("unavailable", "本阶段仅允许明确可用的 mock 后端");
    }
    if (assessMemoryBudget(budget, 0, bytes).status !== "fits") {
      throw new ProviderError("unavailable", "资源预算未知或请求超出预算");
    }
    return new Promise((resolve, reject) => {
      const remove = () => { const i = this.queue.indexOf(waiter); if (i >= 0) this.queue.splice(i, 1); signal?.removeEventListener("abort", waiter.cancel); };
      const waiter: Waiter = {
        bytes, signal,
        grant: () => {
          remove(); this.active = true; this.reserved = bytes;
          let released = false;
          resolve(() => { if (released) return; released = true; this.active = false; this.reserved = 0; this.drain(); });
        },
        cancel: () => { remove(); reject(new ProviderError("aborted", "已取消资源准入")); this.drain(); },
      };
      this.queue.push(waiter); signal?.addEventListener("abort", waiter.cancel, { once: true }); this.drain();
    });
  }
  private drain(): void {
    if (this.active || this.reading) return;
    this.queue[0]?.grant();
  }
}
