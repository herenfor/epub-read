import { expect, it, vi } from "vitest";
import { watchAndroidForeground } from "./androidAppTask";

const mocks = vi.hoisted(() => ({ addPluginListener: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => mocks);

it("keeps a newer pause event when the initial foreground snapshot returns late", async () => {
  let event!: (status: { foreground: boolean }) => void;
  let finish!: (status: { foreground: boolean }) => void;
  const unregister = vi.fn().mockResolvedValue(undefined);
  mocks.addPluginListener.mockImplementation(async (_plugin, _name, callback) => {
    event = callback;
    return { unregister };
  });
  mocks.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const update = vi.fn();
  const stop = watchAndroidForeground(update);
  await Promise.resolve();
  event({ foreground: false });
  finish({ foreground: true });
  await Promise.resolve();
  expect(update.mock.calls).toEqual([[false]]);
  stop();
  event({ foreground: true });
  expect(update).toHaveBeenCalledTimes(1);
  expect(unregister).toHaveBeenCalledOnce();
});
