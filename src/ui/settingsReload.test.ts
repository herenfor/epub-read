import { describe, expect, it, vi } from "vitest";
import { createLatestReloadRunner, createSettingsReloadDebouncer } from "./settingsReload";

describe("settings reload debounce", () => {
  it("coalesces rapid settings changes and runs only the latest task", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const debouncer = createSettingsReloadDebouncer(150);
      debouncer.schedule(() => reload("font+1"));
      debouncer.schedule(() => reload("font+2"));
      vi.advanceTimersByTime(149);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledWith("font+2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending settings reload when the chapter changes", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const debouncer = createSettingsReloadDebouncer(150);
      debouncer.schedule(reload);
      debouncer.cancel();
      vi.advanceTimersByTime(200);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("live preview reload runner", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

  it("runs one reload at a time and then only the newest value", async () => {
    const runner = createLatestReloadRunner();
    const first = deferred();
    const calls: string[] = [];
    runner.run(() => { calls.push("a"); return first.promise; });
    runner.run(() => { calls.push("b"); });
    runner.run(() => { calls.push("c"); });
    expect(calls).toEqual(["a"]);
    expect(runner.busy).toBe(true);
    first.resolve();
    await flush();
    expect(calls).toEqual(["a", "c"]);
    await flush();
    expect(runner.busy).toBe(false);
  });

  it("starts immediately when idle and survives a failed reload", async () => {
    const runner = createLatestReloadRunner();
    const calls: string[] = [];
    runner.run(() => { calls.push("a"); return Promise.reject(new Error("x")); });
    runner.run(() => { calls.push("b"); });
    await flush();
    expect(calls).toEqual(["a", "b"]);
  });

  it("drops the queued value on cancel", async () => {
    const runner = createLatestReloadRunner();
    const first = deferred();
    const calls: string[] = [];
    runner.run(() => { calls.push("a"); return first.promise; });
    runner.run(() => { calls.push("b"); });
    runner.cancel();
    first.resolve();
    await flush();
    expect(calls).toEqual(["a"]);
    expect(runner.busy).toBe(false);
  });
});
