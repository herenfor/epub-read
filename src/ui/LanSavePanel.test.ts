import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { LanSavePanel } from "./LanSavePanel";
import { lanErrorText } from "./lanSaveMessages";
import type { UseLanSaveSessionResult } from "./useLanSaveSession";
import type { LanSendResult } from "../platform/lanSaveNativeBridge";

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
      notice: null, offer: null, incoming: null, progress: null, preview: null, lastResult: null,
    },
    active: false, startHost: vi.fn(), join: vi.fn(), send: vi.fn(), accept: vi.fn(),
    cancelTransfer: vi.fn(), commit: vi.fn(), close: vi.fn(),
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
      notice: null, offer: null, incoming: null, progress: null, preview: null, lastResult: null,
      ...overrides,
    },
    active: false, startHost: vi.fn(), join: vi.fn(), send: vi.fn(), accept: vi.fn(),
    cancelTransfer: vi.fn(), commit: vi.fn(), close: vi.fn(),
  };
}

function sentResult(): LanSendResult {
  return {
    status: "completed", transferId: "t1", archiveBytes: 2048, packageId: "pkg", writtenBooks: 2,
    attachedBookCount: 0, skippedBooks: [], resultDelivered: true, code: null, message: null,
    remoteCommit: {
      importedBookCount: 2, newVisibleBookCount: 2, missingBookCount: 0,
      progressConflictBookCount: 0, appliedPreferences: false,
    },
  };
}

it("原生报错只显示白话说明，不把技术细节展示给用户", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const dom = createReactDomHarness();
  try {
    for (const [status, code, raw] of [
      ["idle", "secure-error", "TLS 握手失败：invalid peer certificate: UnknownIssuer"],
      ["closed", "invalid-data", "控制帧 JSON 失败：expected value at line 1 column 1"],
      ["settling", "storage-error", "文件读写失败：No such file or directory (os error 2)"],
      ["closed", "something-new", "panicked at src/lan_save/session.rs:42"],
    ] as const) {
      const lastResult = status === "settling"
        ? { kind: "sendFailed" as const, send: { ...sentResult(), status: "failed" as const, code, message: raw } }
        : null;
      await dom.render(createElement(LanSavePanel, {
        open: true, session: sessionWith({ status, error: raw, errorCode: code, lastResult }),
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


it("协议版本问题只按机器码显示，不读后端中文", () => {
  expect(lanErrorText("protocol-too-new", "join")).toContain("升级");
  expect(lanErrorText("protocol-unsupported", "join")).toContain("存档文件");
  for (const code of ["protocol-version-differs", "protocol-mismatch"]) {
    expect(lanErrorText(code, "join")).toBe("两台设备需要更新到支持同一互传协议的版本。");
  }
  expect(lanErrorText("network", "join")).toContain("网络连接中断");
});

it("电脑打开面板直接显示二维码，只自动开一次；手机仍二选一", async () => {
  const dom = createReactDomHarness();
  try {
    const desktop = sessionWith({});
    await dom.render(createElement(LanSavePanel, {
      open: true, session: desktop, selectedEntries: [], isAndroid: false, onClose: vi.fn(),
    }));
    expect(desktop.startHost).toHaveBeenCalledTimes(1);
    // Host failed and fell back to the start page: no automatic retry loop.
    await dom.render(createElement(LanSavePanel, {
      open: true, session: { ...desktop, state: { ...desktop.state, error: "x", errorCode: "network" } },
      selectedEntries: [], isAndroid: false, onClose: vi.fn(),
    }));
    expect(desktop.startHost).toHaveBeenCalledTimes(1);
    await dom.render(null);

    const phone = sessionWith({});
    await dom.render(createElement(LanSavePanel, {
      open: true, session: phone, selectedEntries: [], isAndroid: true, onClose: vi.fn(),
    }));
    expect(phone.startHost).not.toHaveBeenCalled();
    expect(dom.container.textContent).toContain("扫码连接");
  } finally {
    await dom.dispose();
  }
});

it("一批结束后在顶部显示结果，等下一批就绪前不能发送；预览取消只取消本批", async () => {
  const dom = createReactDomHarness();
  try {
    const settling = sessionWith({
      status: "settling", role: "join", sessionId: "s1",
      lastResult: { kind: "sent", send: sentResult() },
    });
    await dom.render(createElement(LanSavePanel, {
      open: true, session: settling, selectedEntries: [], isAndroid: true, onClose: vi.fn(),
    }));
    const text = dom.container.textContent ?? "";
    expect(dom.container.querySelector(".lan-batch.tone-success")?.textContent).toContain("发送完成");
    expect(text).toContain("正在准备下一次传送");
    expect(text).not.toContain("完成再传一次");
    const send = Array.from(dom.container.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === "发送") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    const onClose = vi.fn();
    const preview = sessionWith({
      status: "preview", sessionId: "s1", transferId: "t2",
      preview: {
        status: "prepared", jobId: "j", packageId: "p", scopeKind: "all", bookCount: 1, attachedBooks: [],
        skippedBookCount: 0, skippedBooks: [], progressConflictCount: 0, newBookCount: 1,
        hasPreferences: false, sourceBytes: 10, totalUncompressedBytes: 10,
      },
    });
    await dom.render(createElement(LanSavePanel, {
      open: true, session: preview, selectedEntries: [], isAndroid: true, onClose,
    }));
    const cancel = Array.from(dom.container.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === "取消") as HTMLButtonElement;
    await dom.click(cancel);
    expect(preview.cancelTransfer).toHaveBeenCalledTimes(1);
    expect(preview.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    await dom.dispose();
  }
});
