import { describe, expect, it, vi } from "vitest";
import type { ExternalOpenRequest } from "../platform/externalOpenBridge";
import { ExternalOpenPump, type ExternalOpenOutcome } from "./externalOpenPump";

function request(id: string): ExternalOpenRequest {
  return { requestId: id, source: { kind: "path", path: `C:\\Books\\${id}.epub` }, fileName: `${id}.epub` };
}

/** A native queue stand-in: peek reads the head, ack removes only a matching head. */
function setup(outcomes: Record<string, ExternalOpenOutcome[]>, ids: string[]) {
  const queue = ids.map(request);
  const peek = vi.fn(async (): Promise<ExternalOpenRequest | null> => queue[0] ?? null);
  const acknowledge = vi.fn(async (id: string) => {
    if (queue[0]?.requestId !== id) return false;
    queue.shift();
    return true;
  });
  const process = vi.fn(async (item: ExternalOpenRequest) => outcomes[item.requestId]?.shift() ?? "opened");
  const onFailed = vi.fn();
  const onError = vi.fn();
  const pump = new ExternalOpenPump({ peek, acknowledge, process, onFailed, onError });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { queue, peek, acknowledge, process, onFailed, onError, pump, settle };
}

describe("external open pump", () => {
  it("opens queued books one at a time and acknowledges each", async () => {
    const t = setup({}, ["a", "b"]);
    t.pump.notify();
    await t.settle();
    expect(t.process.mock.calls.map(([item]) => item.requestId)).toEqual(["a", "b"]);
    expect(t.acknowledge.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(t.queue).toEqual([]);
    // An empty queue is not polled again until the native side notifies.
    t.pump.kick();
    await t.settle();
    expect(t.peek).toHaveBeenCalledTimes(3);
  });

  it("keeps a waiting request and tries it again on the next state change", async () => {
    const t = setup({ a: ["wait"] }, ["a"]);
    t.pump.notify();
    await t.settle();
    expect(t.acknowledge).not.toHaveBeenCalled();
    t.pump.kick();
    await t.settle();
    expect(t.process).toHaveBeenCalledTimes(2);
    expect(t.acknowledge).toHaveBeenCalledWith("a");
  });

  it("never runs two requests at once; kicks meanwhile become one more pass", async () => {
    let release!: (outcome: ExternalOpenOutcome) => void;
    const t = setup({}, ["a"]);
    t.process.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    t.pump.notify();
    await t.settle();
    t.pump.kick();
    t.pump.notify();
    expect(t.process).toHaveBeenCalledTimes(1);
    release("wait");
    await t.settle();
    expect(t.process).toHaveBeenCalledTimes(2);
    expect(t.queue).toEqual([]);
  });

  it("holds a failed request until the user retries or closes it", async () => {
    const t = setup({ a: ["failed", "failed"] }, ["a", "b"]);
    t.pump.notify();
    await t.settle();
    expect(t.onFailed).toHaveBeenLastCalledWith(request("a"));
    t.pump.notify();
    await t.settle();
    expect(t.process).toHaveBeenCalledTimes(1);

    t.pump.retry();
    await t.settle();
    expect(t.process).toHaveBeenCalledTimes(2);
    expect(t.acknowledge).not.toHaveBeenCalled();

    await t.pump.dismiss();
    await t.settle();
    expect(t.onFailed).toHaveBeenLastCalledWith(null);
    expect(t.acknowledge.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(t.process.mock.calls.at(-1)?.[0].requestId).toBe("b");
  });

  it("does not let an empty read hide a notice that arrived while it was pending", async () => {
    const t = setup({}, []);
    let answer!: (value: ExternalOpenRequest | null) => void;
    t.peek.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    t.pump.notify();
    await t.settle();
    t.queue.push(request("late"));
    t.pump.notify();
    answer(null);
    await t.settle();
    expect(t.acknowledge).toHaveBeenCalledWith("late");
    expect(t.queue).toEqual([]);
  });

  it("holds a request whose import throws for retry or close", async () => {
    const t = setup({}, ["a", "b"]);
    t.process.mockRejectedValueOnce(new Error("importRecords failed")).mockRejectedValueOnce(new Error("still failing"));
    t.pump.notify();
    await t.settle();
    expect(t.onError).toHaveBeenCalledTimes(1);
    expect(t.onFailed).toHaveBeenLastCalledWith(request("a"));
    expect(t.acknowledge).not.toHaveBeenCalled();

    t.pump.retry();
    await t.settle();
    expect(t.onFailed).toHaveBeenLastCalledWith(request("a"));
    await t.pump.dismiss();
    await t.settle();
    expect(t.acknowledge.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("does not start a request after being stopped during the read", async () => {
    const t = setup({}, ["a"]);
    let answer!: (value: ExternalOpenRequest | null) => void;
    t.peek.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    t.pump.notify();
    await t.settle();
    t.pump.stop();
    answer(request("a"));
    await t.settle();
    expect(t.process).not.toHaveBeenCalled();
    expect(t.acknowledge).not.toHaveBeenCalled();
  });

  it("reports an unreadable queue once and waits for the next notice", async () => {
    const t = setup({}, ["a"]);
    t.peek.mockRejectedValueOnce("external-open-state-unavailable");
    t.pump.notify();
    await t.settle();
    t.pump.kick();
    await t.settle();
    expect(t.onError).toHaveBeenCalledTimes(1);
    expect(t.process).not.toHaveBeenCalled();
    t.pump.notify();
    await t.settle();
    expect(t.acknowledge).toHaveBeenCalledWith("a");
  });
});
