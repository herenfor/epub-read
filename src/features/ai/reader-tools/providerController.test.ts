import { describe, expect, it, vi } from "vitest";
import { createProviderController, type ProviderConnection, type ProviderControlPort } from "./providerController";
import type { ReaderToolsStatus } from "./controlTypes";

const snapshot = (revision: number, patch: Partial<ReaderToolsStatus> = {}): ReaderToolsStatus => ({
  revision, supported: true, unsupportedReason: null, service: "running", error: null,
  provider: "waiting", providerError: null, serviceInstance: "instance-a", initialFromEnv: false,
  grantsSource: "default", connectionDirectory: null, clients: [], ...patch,
});
const drain = () => new Promise(resolve => setTimeout(resolve, 0));

describe("app-owned reader provider lifecycle", () => {
  it("connects once, aborts on stop, and retries a failed reply only after an explicit retry event", async () => {
    let receive!: (value: ReaderToolsStatus) => void;
    const failures: ((sessionId?: string) => void)[] = [];
    const aborts: ReturnType<typeof vi.fn>[] = [];
    const disconnect = vi.fn(async () => {});
    const connect = vi.fn(async (_instance: string, failed: (sessionId?: string) => void) => {
      failures.push(failed);
      const stop = vi.fn(async () => {}); aborts.push(stop);
      return { sessionId: `session-${aborts.length}`, stop };
    });
    const port: ProviderControlPort = {
      status: async () => snapshot(1),
      listen: async listener => { receive = listener; return vi.fn(); },
      connect, disconnect, reportError: vi.fn(async () => {}),
    };
    const control = await createProviderController(port);
    receive(snapshot(2)); receive(snapshot(3));
    await drain();
    expect(connect).toHaveBeenCalledTimes(1);
    receive(snapshot(4, { provider: "ready" }));
    failures[0]("session-1");
    await drain();
    expect(disconnect).toHaveBeenCalledWith("session-1", "provider-reply-failed");
    expect(aborts[0]).toHaveBeenCalledTimes(1);
    receive(snapshot(5, { provider: "failed", providerError: "provider-reply-failed" }));
    receive(snapshot(6, { provider: "failed", providerError: "provider-reply-failed" }));
    await drain();
    expect(connect).toHaveBeenCalledTimes(1);
    receive(snapshot(7)); // Native retry command clears the failed state.
    await drain();
    expect(connect).toHaveBeenCalledTimes(2);
    receive(snapshot(8, { provider: "ready" }));
    failures[0]("session-1"); // Retired callbacks cannot poison the new provider.
    expect(disconnect).toHaveBeenCalledTimes(1);
    receive(snapshot(9, { service: "off", serviceInstance: null }));
    expect(aborts[1]).toHaveBeenCalledTimes(1);
    receive(snapshot(8, { provider: "ready" }));
    expect(control.getStatus()?.service).toBe("off");
    await control.stop();
  });

  it("retires a late connection before joining a restarted service instance", async () => {
    let receive!: (value: ReaderToolsStatus) => void;
    let resolve!: (value: ProviderConnection) => void;
    const first = new Promise<ProviderConnection>(done => { resolve = done; });
    let finishOldStop!: () => void;
    const oldStopped = new Promise<void>(done => { finishOldStop = done; });
    const oldStop = vi.fn(() => oldStopped);
    const disconnect = vi.fn(async () => {});
    const connect = vi.fn<ProviderControlPort["connect"]>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ sessionId: "new-session", stop: vi.fn(async () => {}) });
    const control = await createProviderController({
      status: async () => snapshot(1),
      listen: async listener => { receive = listener; return vi.fn(); },
      connect, disconnect, reportError: vi.fn(async () => {}),
    });
    receive(snapshot(2, { service: "off", serviceInstance: null }));
    receive(snapshot(3, { serviceInstance: "instance-b" }));
    expect(connect).toHaveBeenCalledTimes(1);
    resolve({ sessionId: "old-session", stop: oldStop });
    await drain();
    expect(oldStop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith("old-session");
    expect(connect).toHaveBeenCalledTimes(1);
    finishOldStop();
    await drain();
    expect(connect.mock.calls.map(call => call[0])).toEqual(["instance-a", "instance-b"]);
    await control.stop();
  });
});
