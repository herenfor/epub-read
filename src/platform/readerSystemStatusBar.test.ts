import { describe, expect, it, vi } from "vitest";
import { createReaderStatusBarCoordinator, shouldHideReaderSystemStatusBar } from "./readerSystemStatusBar";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("reader status bar intent", () => {
  it("hides only on a supported reader route with the preference enabled", () => {
    expect(shouldHideReaderSystemStatusBar({ readerActive: true, hideWhileReading: true, supported: true })).toBe(true);
    expect(shouldHideReaderSystemStatusBar({ readerActive: false, hideWhileReading: true, supported: true })).toBe(false);
    expect(shouldHideReaderSystemStatusBar({ readerActive: true, hideWhileReading: false, supported: true })).toBe(false);
    expect(shouldHideReaderSystemStatusBar({ readerActive: true, hideWhileReading: true, supported: false })).toBe(false);
  });

  it("serializes a rapid enter/exit so delayed hide cannot leave the shelf hidden", async () => {
    const first = deferred();
    const driver = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const coordinator = createReaderStatusBarCoordinator(driver);
    const pending = coordinator.requestHidden(true);
    await Promise.resolve();
    coordinator.requestHidden(false);
    expect(driver.mock.calls).toEqual([[true]]);
    first.resolve();
    await pending;
    expect(driver.mock.calls).toEqual([[true], [false]]);
    await coordinator.requestHidden(false);
    expect(driver).toHaveBeenCalledTimes(2);
  });

  it("coalesces queued route changes and retries a failed current request without an automatic loop", async () => {
    const first = deferred();
    const driver = vi.fn().mockImplementationOnce(() => first.promise).mockRejectedValueOnce(new Error("IPC unavailable")).mockResolvedValue(undefined);
    const coordinator = createReaderStatusBarCoordinator(driver);
    const pending = coordinator.requestHidden(true);
    await Promise.resolve();
    coordinator.requestHidden(false);
    coordinator.requestHidden(true);
    coordinator.requestHidden(false);
    first.reject(new Error("obsolete hide failed"));
    await expect(pending).rejects.toThrow("IPC unavailable");
    expect(driver.mock.calls).toEqual([[true], [false]]);
    await coordinator.requestHidden(false);
    expect(driver.mock.calls).toEqual([[true], [false], [false]]);
  });

  it("reapplies after native rebinding, including a request arriving while the same value is in flight", async () => {
    const first = deferred();
    const driver = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const coordinator = createReaderStatusBarCoordinator(driver);
    const pending = coordinator.requestHidden(true);
    await Promise.resolve();
    coordinator.requestHidden(true, true);
    first.resolve();
    await pending;
    expect(driver.mock.calls).toEqual([[true], [true]]);
  });
});
