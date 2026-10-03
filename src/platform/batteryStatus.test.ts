import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  addPluginListener: mocks.addPluginListener,
}));

type BatteryStatus = { levelPct: number | null; charging: boolean | null };
function senderFor(args: Record<string, unknown>) {
  const handler = mocks.addPluginListener.mock.calls[0]![2] as (payload: unknown) => void;
  return {
    onmessage(payload: Record<string, unknown>) {
      handler({ ...payload, subscriptionId: args.subscriptionId });
    },
  };
}

describe("batteryStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.addPluginListener.mockReset();
    mocks.addPluginListener.mockResolvedValue({ unregister: vi.fn() });
  });

  it("registers the event callback before starting the native subscription", async () => {
    const received: BatteryStatus[] = [];
    mocks.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "android_battery_subscribe") {
          const handler = mocks.addPluginListener.mock.calls[0]?.[2];
          // The service must have registered its callback before `invoke` runs,
          // otherwise the first sticky native value can be lost.
          expect(typeof handler).toBe("function");
          senderFor(args!).onmessage({ levelPct: 72.6, charging: true });
        }
      },
    );

    const { subscribeBattery } = await import("./batteryStatus");
    const unsubscribe = subscribeBattery((status) => received.push(status));

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "android_battery_subscribe",
      { subscriptionId: 1 },
    ));
    expect(received).toEqual([{ levelPct: 73, charging: true }]);

    const channel = senderFor(mocks.invoke.mock.calls[0]![1]!);
    channel.onmessage({ levelPct: -1, charging: "not-a-boolean" });
    channel.onmessage({ levelPct: 0, charging: false });
    expect(received).toEqual([
      { levelPct: 73, charging: true },
      { levelPct: null, charging: null },
      { levelPct: 0, charging: false },
    ]);

    unsubscribe();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("android_battery_unsubscribe"),
    );
  });

  it("uses one native receiver for multiple listeners", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { subscribeBattery } = await import("./batteryStatus");
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeBattery(first);
    const unsubscribeSecond = subscribeBattery(second);

    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "android_battery_subscribe",
        expect.anything(),
      ),
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    const channel = senderFor(mocks.invoke.mock.calls[0]![1]!);
    channel.onmessage({ levelPct: 40, charging: false });
    expect(first).toHaveBeenCalledWith({ levelPct: 40, charging: false });
    expect(second).toHaveBeenCalledWith({ levelPct: 40, charging: false });

    const late = vi.fn();
    const unsubscribeLate = subscribeBattery(late);
    expect(late).toHaveBeenCalledWith({ levelPct: 40, charging: false });

    unsubscribeFirst();
    unsubscribeLate();
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    unsubscribeSecond();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("android_battery_unsubscribe"),
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("releases only once when an unsubscribe handle is called repeatedly", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { subscribeBattery } = await import("./batteryStatus");
    const unsubscribe = subscribeBattery(vi.fn());

    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "android_battery_subscribe",
        expect.anything(),
      ),
    );
    unsubscribe();
    unsubscribe();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("android_battery_unsubscribe"),
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("review_reuses one event registration and ignores old sessions after subscribing again", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { subscribeBattery } = await import("./batteryStatus");
    const stopFirst = subscribeBattery(vi.fn());
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    const oldChannel = senderFor(mocks.invoke.mock.calls[0]![1]!);
    oldChannel.onmessage({ levelPct: 20, charging: false });
    stopFirst();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    oldChannel.onmessage({ levelPct: 19, charging: false });

    const received = vi.fn();
    const stopSecond = subscribeBattery(received);
    expect(received).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
    const newChannel = senderFor(mocks.invoke.mock.calls[2]![1]!);
    newChannel.onmessage({ levelPct: 80, charging: true });
    oldChannel.onmessage({ levelPct: 18, charging: false });
    expect(received.mock.calls).toEqual([[{ levelPct: 80, charging: true }]]);
    expect(mocks.addPluginListener).toHaveBeenCalledTimes(1);
    stopSecond();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(4));
  });
});
