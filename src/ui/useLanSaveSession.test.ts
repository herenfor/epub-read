import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import type {
  LanHostResult,
  LanSaveEvent,
  LanSendResult,
} from "../platform/lanSaveNativeBridge";
import type { SaveFileCommitResult, SaveFilePrepareResult } from "../platform/saveFileNativeBridge";
import { useLanSaveSession, type UseLanSaveSessionResult } from "./useLanSaveSession";

const bridge = vi.hoisted(() => ({
  hostLanSave: vi.fn(),
  joinLanSave: vi.fn(),
  sendLanSave: vi.fn(),
  acceptLanSave: vi.fn(),
  commitLanSave: vi.fn(),
  closeLanSave: vi.fn(),
}));

vi.mock("../platform/lanSaveNativeBridge", () => ({
  hostLanSave: bridge.hostLanSave,
  joinLanSave: bridge.joinLanSave,
  sendLanSave: bridge.sendLanSave,
  acceptLanSave: bridge.acceptLanSave,
  commitLanSave: bridge.commitLanSave,
  closeLanSave: bridge.closeLanSave,
  lanSaveErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  lanSaveErrorCode: (error: unknown) => {
    if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
      return (error as { code: string }).code;
    }
    return null;
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function preview(hash: string): SaveFilePrepareResult {
  return {
    status: "prepared",
    jobId: hash,
    packageId: `pkg-${hash}`,
    scopeKind: "all",
    bookCount: 1,
    attachedBooks: [],
    missingBooks: [],
    progressConflictCount: 0,
    newBookCount: 1,
    hasPreferences: false,
    sourceBytes: 10,
    totalUncompressedBytes: 10,
  };
}

function commitResult(jobId: string): SaveFileCommitResult {
  return {
    status: "committed",
    jobId,
    mergedBooks: 1,
    importedBooks: ["a".repeat(64)],
    newVisibleBooks: ["a".repeat(64)],
    missingBooks: [],
    progressConflictBooks: [],
    appliedPreferences: false,
  };
}

function sendResult(status: LanSendResult["status"]): LanSendResult {
  return {
    status,
    transferId: "t1",
    archiveBytes: 2048,
    packageId: "pkg",
    writtenBooks: 1,
    attachedBookCount: 0,
    skippedBooks: [],
    remoteCommit: status === "completed" ? commitResult("remote") : null,
    resultDelivered: status === "completed",
    code: status === "failed" ? "network" : null,
    message: status === "failed" ? "网络中断" : null,
  };
}

let latest: UseLanSaveSessionResult | null = null;
const prepareSend = vi.fn(async () => ({ kind: "all" as const }));
const onImportCommitted = vi.fn(async (
  _result: SaveFileCommitResult,
  _applyPreferences: boolean,
): Promise<void> => undefined);

function Probe() {
  const session = useLanSaveSession({ prepareSend, onImportCommitted });
  latest = session;
  return createElement("span", { "data-status": session.state.status });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useLanSaveSession", () => {
  let dom: ReturnType<typeof createReactDomHarness>;

  beforeEach(() => {
    bridge.hostLanSave.mockReset();
    bridge.joinLanSave.mockReset();
    bridge.sendLanSave.mockReset();
    bridge.acceptLanSave.mockReset();
    bridge.commitLanSave.mockReset();
    bridge.closeLanSave.mockReset();
    bridge.closeLanSave.mockResolvedValue({ status: "cancelled" });
    prepareSend.mockClear();
    onImportCommitted.mockClear();
    latest = null;
    dom = createReactDomHarness();
  });

  afterEach(async () => {
    await dom.dispose();
  });

  it("登记迟到的 join pairing 事件后立即关闭，且不启动新 host", async () => {
    const host = deferred<LanHostResult>();
    bridge.hostLanSave.mockReturnValue(host.promise);
    await dom.render(createElement(Probe));

    await dom.run(() => {
      void latest!.startHost();
    });
    expect(bridge.hostLanSave).toHaveBeenCalledTimes(1);

    await dom.run(async () => {
      await latest!.close();
    });
    expect(latest!.state.closing).toBe(true);

    const onEvent = bridge.hostLanSave.mock.calls[0]![0]!.onEvent as (event: LanSaveEvent) => void;
    await dom.run(() => {
      onEvent({ event: "pairing", sessionId: "late-session", transferId: "t1" });
    });
    await vi.waitFor(() => expect(bridge.closeLanSave).toHaveBeenCalledWith("late-session"));
    await dom.run(async () => { await latest!.startHost(); });
    expect(bridge.hostLanSave).toHaveBeenCalledTimes(1);
    expect(latest!.state.status).not.toBe("idle");

    await dom.run(async () => {
      host.resolve({ sessionId: "late-session", pairingInfo: "raw" });
      await flushMicrotasks();
    });

    expect(bridge.closeLanSave).toHaveBeenCalledTimes(1);
    expect(latest!.state.status).toBe("idle");
  });

  it.each(["too-late", "already-finished"] as const)("%s 关闭后仍等待真实 commit，并只以最终结果刷新投影", async (closeStatus) => {
    let onEvent: ((event: LanSaveEvent) => void) | null = null;
    bridge.joinLanSave.mockImplementation((input: { onEvent(event: LanSaveEvent): void }) => {
      onEvent = input.onEvent;
      return Promise.resolve({ sessionId: "session-1" });
    });
    await dom.render(createElement(Probe));
    await dom.run(async () => {
      await latest!.join("pairing-info");
    });

    await dom.run(() => {
      onEvent!({ event: "paired", sessionId: "session-1", transferId: "transfer-1" });
      onEvent!({
        event: "offered",
        sessionId: "session-1",
        transferId: "transfer-1",
        summary: {
          archiveBytes: 1024,
          bookCount: 2,
          attachedBookCount: 1,
          includeBooks: true,
          hasPreferences: false,
          skippedBookCount: 1,
        },
      });
    });
    expect(latest!.state.offer?.bookCount).toBe(2);

    bridge.acceptLanSave.mockResolvedValue(preview("preview-1"));
    await dom.run(async () => {
      await latest!.accept();
    });
    expect(latest!.state.status).toBe("preview");

    const pendingCommit = deferred<SaveFileCommitResult>();
    bridge.commitLanSave.mockReturnValue(pendingCommit.promise);
    let commitPromise!: Promise<void>;
    await dom.run(() => {
      commitPromise = latest!.commit(false);
    });
    expect(latest!.state.status).toBe("committing");

    bridge.closeLanSave.mockResolvedValue({ status: closeStatus });
    await dom.run(async () => {
      await latest!.close();
    });
    expect(latest!.state.status).toBe("committing");
    expect(latest!.state.cancelTooLate).toBe(closeStatus === "too-late");

    await dom.run(async () => {
      pendingCommit.resolve(commitResult("preview-1"));
      await commitPromise;
    });

    expect(onImportCommitted).toHaveBeenCalledTimes(1);
    expect(onImportCommitted.mock.calls[0]![0]).toMatchObject({ status: "committed" });
    expect(onImportCommitted.mock.calls[0]![1]).toBe(false);
    expect(latest!.state.status).toBe("commitComplete");
    expect(latest!.active).toBe(false);
    await dom.run(() => {
      onEvent!({ event: "error", sessionId: "session-1", transferId: "transfer-1", message: "late EOF" });
    });
    expect(latest!.state.status).toBe("commitComplete");
  });

  it("busy 后保留当前会话，第二次发送可重试成功", async () => {
    bridge.joinLanSave.mockImplementation((input: { onEvent(event: LanSaveEvent): void }) => {
      const onEvent = input.onEvent;
      queueMicrotask(() => {
        onEvent({ event: "paired", sessionId: "session-2", transferId: "transfer-2" });
      });
      return Promise.resolve({ sessionId: "session-2" });
    });
    await dom.render(createElement(Probe));
    await dom.run(async () => {
      await latest!.join("pairing-info");
    });
    expect(latest!.state.status).toBe("connected");

    const busy = Object.assign(new Error("已有传输正在进行"), { code: "busy" });
    bridge.sendLanSave
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce(sendResult("completed"));

    await dom.run(async () => {
      await latest!.send("all", false);
    });
    expect(latest!.state.status).toBe("connected");
    expect(latest!.state.errorCode).toBe("busy");

    await dom.run(async () => {
      await latest!.send("all", false);
    });
    expect(bridge.sendLanSave).toHaveBeenCalledTimes(2);
    expect(latest!.state.status).toBe("sendComplete");
  });

  it("join返回前的Offer不被启动结果覆盖", async () => {
    const joining = deferred<{ sessionId: string }>();
    bridge.joinLanSave.mockReturnValue(joining.promise);
    await dom.render(createElement(Probe));
    await dom.run(() => { void latest!.join("raw"); });
    const emit = bridge.joinLanSave.mock.calls[0]![0]!.onEvent;
    await dom.run(() => {
      emit({ event: "paired", sessionId: "early", transferId: "t1" });
      emit({ event: "offered", sessionId: "early", transferId: "t1", summary: {
        archiveBytes: 10, bookCount: 1, attachedBookCount: 0,
        includeBooks: false, hasPreferences: false, skippedBookCount: 0,
      } });
    });
    await dom.run(async () => { joining.resolve({ sessionId: "early" }); await flushMicrotasks(); });
    expect(latest!.state.status).toBe("receiving");
    expect(latest!.state.offer?.bookCount).toBe(1);
  });

  it("保存进度期间关闭不会继续发送", async () => {
    bridge.joinLanSave.mockImplementation((input) => {
      input.onEvent({ event: "paired", sessionId: "preflight", transferId: "t1" });
      return Promise.resolve({ sessionId: "preflight" });
    });
    await dom.render(createElement(Probe));
    await dom.run(async () => { await latest!.join("raw"); });
    const saved = deferred<{ kind: "all" }>();
    prepareSend.mockReturnValueOnce(saved.promise);
    let sending!: Promise<void>;
    await dom.run(() => { sending = latest!.send("all", false); });
    await dom.run(async () => { await latest!.close(); });
    expect(latest!.state.status).not.toBe("idle");
    await dom.run(async () => { saved.resolve({ kind: "all" }); await sending; });
    expect(bridge.sendLanSave).not.toHaveBeenCalled();
    expect(latest!.state.status).toBe("idle");
  });

  it("预览断线与接收失败均清除失效操作", async () => {
    let emit!: (event: LanSaveEvent) => void;
    bridge.joinLanSave.mockImplementation((input) => {
      emit = input.onEvent;
      emit({ event: "paired", sessionId: "receive", transferId: "t1" });
      return Promise.resolve({ sessionId: "receive" });
    });
    const offer = () => emit({ event: "offered", sessionId: "receive", transferId: "t1", summary: {
      archiveBytes: 10, bookCount: 1, attachedBookCount: 0,
      includeBooks: false, hasPreferences: false, skippedBookCount: 0,
    } });
    await dom.render(createElement(Probe));
    await dom.run(async () => { await latest!.join("raw"); offer(); });
    bridge.acceptLanSave.mockResolvedValueOnce(preview("receive"));
    await dom.run(async () => { await latest!.accept(); });
    expect(latest!.state.preview).not.toBeNull();
    await dom.run(() => { emit({ event: "closed", sessionId: "receive", code: "cancelled" }); });
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.preview).toBeNull();
    expect(latest!.active).toBe(false);
    await dom.run(async () => { await latest!.close(); await latest!.join("raw"); offer(); });
    bridge.acceptLanSave.mockRejectedValueOnce(Object.assign(new Error("存档损坏"), { code: "invalid-data" }));
    await dom.run(async () => { await latest!.accept(); });
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.offer).toBeNull();
    expect(latest!.active).toBe(false);
    await dom.run(async () => { await latest!.close(); await latest!.join("raw"); offer(); });
    const receiving = deferred<SaveFilePrepareResult>();
    bridge.acceptLanSave.mockReturnValueOnce(receiving.promise);
    let accepted!: Promise<void>;
    await dom.run(() => { accepted = latest!.accept(); });
    await dom.run(() => { emit({ event: "closed", sessionId: "receive", code: "cancelled" }); });
    await dom.run(async () => { receiving.resolve(preview("already-discarded")); await accepted; });
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.preview).toBeNull();
  });

});
