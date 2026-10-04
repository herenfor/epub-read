import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { LanSavePanel } from "./LanSavePanel";
import type { UseLanSaveSessionResult } from "./useLanSaveSession";

const scan = vi.hoisted(() => vi.fn());
vi.mock("../platform/androidLanScanBridge", () => ({ scanAndroidQrCode: scan }));

it("扫码期间禁止另建连接，关闭或卸载后不消费迟到的扫码结果", async () => {
  let finishScan!: (value: string) => void;
  scan.mockReturnValue(new Promise<string>((resolve) => { finishScan = resolve; }));
  const session: UseLanSaveSessionResult = {
    state: {
      status: "idle", role: null, sessionId: null, transferId: null, pairingInfo: null,
      busy: false, closing: false, cancelTooLate: false, error: null, errorCode: null,
      notice: null, offer: null, progress: null, preview: null, sendResult: null, remoteCommit: null,
    },
    active: false, startHost: vi.fn(), join: vi.fn(), send: vi.fn(), accept: vi.fn(),
    decline: vi.fn(), commit: vi.fn(), close: vi.fn(),
  };
  const onClose = vi.fn();
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(LanSavePanel, {
      open: true, session, selectedEntries: [], isAndroid: true, onClose,
    }));
    const button = (text: string) => Array.from(dom.container.querySelectorAll("button"))
      .find((item) => item.textContent?.includes(text)) as HTMLButtonElement;
    await dom.click(button("扫码加入"));
    expect(button("显示连接码").disabled).toBe(true);
    expect(button("正在打开相机").disabled).toBe(true);
    await dom.click(dom.container.querySelector(".lan-save-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    await dom.run(async () => { finishScan("late-pairing-info"); });
    expect(session.join).not.toHaveBeenCalled();
    await dom.render(null);
    scan.mockReturnValue(new Promise<string>((resolve) => { finishScan = resolve; }));
    await dom.render(createElement(LanSavePanel, {
      open: true, session, selectedEntries: [], isAndroid: true, onClose,
    }));
    await dom.click(button("扫码加入"));
    // Unmount closes the same asynchronous scanner ownership independently of
    // whether the App used the dialog button or its Android Back handler.
    await dom.render(null);
    await dom.run(async () => { finishScan("unmounted-pairing-info"); });
    expect(session.join).not.toHaveBeenCalled();
  } finally {
    await dom.dispose();
  }
});
