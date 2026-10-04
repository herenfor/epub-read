import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { LanSavePanel } from "./LanSavePanel";
import type { UseLanSaveSessionResult } from "./useLanSaveSession";

const scan = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../platform/androidLanScanBridge", () => ({ scanAndroidQrCode: scan, openAndroidAppSettings: openSettings }));

it("扫码期间禁止另建连接，关闭或卸载后不消费迟到的扫码结果", async () => {
  let finishScan!: (value: string) => void;
  const pendingScan = () => new Promise<{ status: "scanned"; contents: string }>((resolve) => {
    finishScan = (contents) => resolve({ status: "scanned", contents });
  });
  scan.mockReturnValue(pendingScan());
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
    // Option rows carry a title and a description; match the title first.
    const button = (text: string) => (Array.from(dom.container.querySelectorAll("button"))
      .find((item) => item.querySelector("strong")?.textContent?.includes(text))
      ?? Array.from(dom.container.querySelectorAll("button"))
        .find((item) => item.textContent?.includes(text))) as HTMLButtonElement;
    await dom.click(button("扫码连接"));
    expect(button("显示二维码").disabled).toBe(true);
    expect(button("正在打开相机").disabled).toBe(true);
    await dom.click(dom.container.querySelector(".lan-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    await dom.run(async () => { finishScan("late-pairing-info"); });
    expect(session.join).not.toHaveBeenCalled();
    await dom.render(null);
    scan.mockReturnValue(pendingScan());
    await dom.render(createElement(LanSavePanel, {
      open: true, session, selectedEntries: [], isAndroid: true, onClose,
    }));
    await dom.click(button("扫码连接"));
    // Unmount closes the same asynchronous scanner ownership independently of
    // whether the App used the dialog button or its Android Back handler.
    await dom.render(null);
    await dom.run(async () => { finishScan("unmounted-pairing-info"); });
    expect(session.join).not.toHaveBeenCalled();
  } finally {
    await dom.dispose();
  }
});

function sessionWith(overrides: Partial<UseLanSaveSessionResult["state"]>): UseLanSaveSessionResult {
  return {
    state: {
      status: "idle", role: null, sessionId: null, transferId: null, pairingInfo: null,
      busy: false, closing: false, cancelTooLate: false, error: null, errorCode: null,
      notice: null, offer: null, progress: null, preview: null, sendResult: null, remoteCommit: null,
      ...overrides,
    },
    active: false, startHost: vi.fn(), join: vi.fn(), send: vi.fn(), accept: vi.fn(),
    decline: vi.fn(), commit: vi.fn(), close: vi.fn(),
  };
}

it("原生报错只显示白话说明，不把技术细节展示给用户", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const dom = createReactDomHarness();
  try {
    for (const [status, code, raw] of [
      ["idle", "secure-error", "TLS 握手失败：invalid peer certificate: UnknownIssuer"],
      ["closed", "invalid-data", "控制帧 JSON 失败：expected value at line 1 column 1"],
      ["sendFailed", "storage-error", "文件读写失败：No such file or directory (os error 2)"],
      ["closed", "something-new", "panicked at src/lan_save/session.rs:42"],
    ] as const) {
      await dom.render(createElement(LanSavePanel, {
        open: true, session: sessionWith({ status, error: raw, errorCode: code }),
        selectedEntries: [], isAndroid: true, onClose: vi.fn(),
      }));
      const text = dom.container.textContent ?? "";
      expect(text).not.toContain(raw);
      expect(text).not.toMatch(/TLS|JSON|os error|\.rs:/);
    }
    expect(dom.container.textContent).toContain("这次传输没有完成");
  } finally {
    warn.mockRestore();
    await dom.dispose();
  }
});

it("拒绝相机权限时给出白话说明和打开系统设置的入口", async () => {
  scan.mockResolvedValue({ status: "permission-denied", contents: null });
  openSettings.mockClear();
  const session = sessionWith({});
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(LanSavePanel, {
      open: true, session, selectedEntries: [], isAndroid: true, onClose: vi.fn(),
    }));
    // Option rows carry a title and a description; match the title first.
    const button = (text: string) => (Array.from(dom.container.querySelectorAll("button"))
      .find((item) => item.querySelector("strong")?.textContent?.includes(text))
      ?? Array.from(dom.container.querySelectorAll("button"))
        .find((item) => item.textContent?.includes(text))) as HTMLButtonElement;
    await dom.click(button("扫码连接"));
    expect(dom.container.textContent).toContain("需要相机权限才能扫码");
    expect(session.join).not.toHaveBeenCalled();
    await dom.click(button("打开系统设置"));
    expect(openSettings).toHaveBeenCalledTimes(1);
  } finally {
    await dom.dispose();
  }
});

it("已连接且未选书时默认发送全部书籍、不附带书籍文件", async () => {
  const session = sessionWith({ status: "connected", role: "host", sessionId: "s1" });
  const dom = createReactDomHarness();
  try {
    await dom.render(createElement(LanSavePanel, {
      open: true, session, selectedEntries: [], isAndroid: false, onClose: vi.fn(),
    }));
    const button = (text: string) => Array.from(dom.container.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === text) as HTMLButtonElement;
    expect(button("已选的书").disabled).toBe(true);
    expect((dom.container.querySelector("input.lan-switch") as HTMLInputElement).checked).toBe(false);
    await dom.click(button("发送"));
    expect(session.send).toHaveBeenCalledWith("all", false);
  } finally {
    await dom.dispose();
  }
});
