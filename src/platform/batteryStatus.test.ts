import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void;

    constructor(onmessage?: (message: T) => void) {
      this.onmessage = onmessage ?? (() => {});
    }
  }

  return { Channel, invoke: mocks.invoke };
});

type BatteryStatus = { levelPct: number | null; charging: boolean | null };
type StatusChannel = { onmessage: (payload: unknown) => void };

describe("batteryStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
  });

  it("creates the callback before starting the native subscription", async () => {
    const received: BatteryStatus[] = [];
    mocks.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "android_battery_subscribe") {
          const channel = args?.onStatus as StatusChannel | undefined;
          // The service must have installed its callback before `invoke` runs,
          // otherwise the first sticky native value can be lost.
          expect(typeof channel?.onmessage).toBe("function");
          channel?.onmessage({ levelPct: 72.6, charging: true });
        }
      },
    );

    const { subscribeBattery } = await import("./batteryStatus");
    const unsubscribe = subscribeBattery((status) => received.push(status));

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "android_battery_subscribe",
      expect.objectContaining({ onStatus: expect.anything() }),
    ));
    expect(received).toEqual([{ levelPct: 73, charging: true }]);

    const channel = mocks.invoke.mock.calls[0]![1]!.onStatus as StatusChannel;
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

    const channel = mocks.invoke.mock.calls[0]![1]!.onStatus as StatusChannel;
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
});
