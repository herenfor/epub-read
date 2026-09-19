import { throwIfAborted } from "../contracts/provider";
import type { SemanticSession } from "./contracts";

/** One owner for this coordinator. Native process admission must additionally be enforced in Rust.
 * Cancellation never releases admission while a driver call or close is still running. */
export class SemanticSessionCoordinator {
  private state: "idle" | "active" | "faulted" = "idle";
  get status() { return this.state; }
  async run<T>(open: (signal: AbortSignal) => Promise<SemanticSession>, signal: AbortSignal,
    operation: (session: SemanticSession) => Promise<T>): Promise<T> {
    throwIfAborted(signal);
    if (this.state !== "idle") throw new Error("模型会话占用中或释放失败，不能开始新会话");
    this.state = "active";
    let session: SemanticSession | undefined;
    try {
      // An unsuccessful open must clean up resources before rejecting.
      session = await open(signal);
      throwIfAborted(signal);
      const result = await operation(session);
      throwIfAborted(signal);
      return result;
    } finally {
      try { await session?.close(); this.state = "idle"; }
      catch (error) { this.state = "faulted"; throw error; }
    }
  }
}
