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
  cancelLanSaveTransfer: vi.fn(),
}));

vi.mock("../platform/lanSaveNativeBridge", () => ({
  hostLanSave: bridge.hostLanSave,
  joinLanSave: bridge.joinLanSave,
  sendLanSave: bridge.sendLanSave,
  acceptLanSave: bridge.acceptLanSave,
  commitLanSave: bridge.commitLanSave,
  closeLanSave: bridge.closeLanSave,
  cancelLanSaveTransfer: bridge.cancelLanSaveTransfer,
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
    skippedBookCount: 0,
    skippedBooks: [],
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
    skippedBookCount: 0,
    skippedBooks: [],
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
    remoteCommit: status === "completed"
      ? {
          importedBookCount: 1,
          newVisibleBookCount: 1,
          missingBookCount: 0,
          progressConflictBookCount: 0,
          appliedPreferences: false,
        }
      : null,
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
    bridge.cancelLanSaveTransfer.mockReset();
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

    bridge.acceptLanSave.mockResolvedValue(preview("preview-1"));
    await dom.run(async () => {
      onEvent!({ event: "paired", sessionId: "session-1", transferId: "transfer-1" });
      onEvent!({
        event: "offered",
        sessionId: "session-1",
        transferId: "transfer-1",
        summary: {
          archiveBytes: 1024,
          bookBytes: 100,
          reusedBookCount: 0,
          bookCount: 2,
          attachedBookCount: 1,
          includeBooks: true,
          hasPreferences: false,
          skippedBookCount: 1,
        },
      });
      await flushMicrotasks();
    });
    // The offer is accepted automatically (L1), straight into the preview.
    expect(bridge.acceptLanSave).toHaveBeenCalledWith("session-1", "transfer-1");
    expect(latest!.state.incoming?.bookCount).toBe(2);
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
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.lastResult?.kind).toBe("imported");
    expect(latest!.active).toBe(false);
    await dom.run(() => {
      onEvent!({ event: "error", sessionId: "session-1", transferId: "transfer-1", message: "late EOF" });
    });
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.lastResult?.kind).toBe("imported");
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
    expect(latest!.state.status).toBe("settling");
    expect(latest!.state.lastResult?.kind).toBe("sent");
  });

  it("join返回前的Offer不被启动结果覆盖", async () => {
    const joining = deferred<{ sessionId: string }>();
    bridge.joinLanSave.mockReturnValue(joining.promise);
    bridge.acceptLanSave.mockReturnValue(deferred<SaveFilePrepareResult>().promise);
    await dom.render(createElement(Probe));
    await dom.run(() => { void latest!.join("raw"); });
    const emit = bridge.joinLanSave.mock.calls[0]![0]!.onEvent;
    await dom.run(() => {
      emit({ event: "paired", sessionId: "early", transferId: "t1" });
      emit({ event: "offered", sessionId: "early", transferId: "t1", summary: {
        archiveBytes: 10, bookBytes: 0, reusedBookCount: 0, bookCount: 1, attachedBookCount: 0,
        includeBooks: false, hasPreferences: false, skippedBookCount: 0,
      } });
    });
    // Still starting: the offer waits instead of being accepted under a launch.
    expect(bridge.acceptLanSave).not.toHaveBeenCalled();
    await dom.run(async () => { joining.resolve({ sessionId: "early" }); await flushMicrotasks(); await flushMicrotasks(); });
    expect(latest!.state.status).toBe("receiving");
    expect(latest!.state.incoming?.bookCount).toBe(1);
    expect(bridge.acceptLanSave).toHaveBeenCalledTimes(1);
    expect(bridge.acceptLanSave).toHaveBeenCalledWith("early", "t1");
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
      archiveBytes: 10, bookBytes: 0, reusedBookCount: 0, bookCount: 1, attachedBookCount: 0,
      includeBooks: false, hasPreferences: false, skippedBookCount: 0,
    } });
    const joinAndOffer = async () => {
      await dom.run(async () => { await latest!.join("raw"); offer(); await flushMicrotasks(); await flushMicrotasks(); });
    };
    await dom.render(createElement(Probe));
    bridge.acceptLanSave.mockResolvedValueOnce(preview("receive"));
    await joinAndOffer();
    expect(latest!.state.preview).not.toBeNull();
    await dom.run(() => { emit({ event: "closed", sessionId: "receive", code: "cancelled" }); });
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.preview).toBeNull();
    expect(latest!.active).toBe(false);
    await dom.run(async () => { await latest!.close(); });
    bridge.acceptLanSave.mockRejectedValueOnce(Object.assign(new Error("存档损坏"), { code: "invalid-data" }));
    await joinAndOffer();
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.offer).toBeNull();
    expect(latest!.active).toBe(false);
    await dom.run(async () => { await latest!.close(); });
    const receiving = deferred<SaveFilePrepareResult>();
    bridge.acceptLanSave.mockReturnValueOnce(receiving.promise);
    await joinAndOffer();
    expect(latest!.state.status).toBe("receiving");
    await dom.run(() => { emit({ event: "closed", sessionId: "receive", code: "cancelled" }); });
    await dom.run(async () => { receiving.resolve(preview("already-discarded")); await flushMicrotasks(); await flushMicrotasks(); });
    expect(latest!.state.status).toBe("closed");
    expect(latest!.state.preview).toBeNull();
  });

  const offerSummary = {
    archiveBytes: 4096, bookBytes: 0, reusedBookCount: 0, bookCount: 3, attachedBookCount: 0,
    includeBooks: false, hasPreferences: false, skippedBookCount: 0,
  };

  async function joinPaired(sessionId: string): Promise<(event: LanSaveEvent) => void> {
    let emit!: (event: LanSaveEvent) => void;
    bridge.joinLanSave.mockImplementation((input) => {
      emit = input.onEvent;
      emit({ event: "paired", sessionId, transferId: "t1" });
      return Promise.resolve({ sessionId });
    });
    await dom.render(createElement(Probe));
    await dom.run(async () => { await latest!.join("raw"); });
    expect(latest!.state.status).toBe("connected");
    return emit;
  }

  async function settle(): Promise<void> {
    await flushMicrotasks();
    await flushMicrotasks();
  }

  it("同一连接连续多批：ready 换编号回到已连接，旧编号的迟到帧被忽略，反向再收一批", async () => {
    const emit = await joinPaired("reuse");
    bridge.sendLanSave.mockResolvedValueOnce(sendResult("completed"));
    await dom.run(async () => { await latest!.send("all", false); });
    expect(latest!.state.status).toBe("settling");
    expect(latest!.state.lastResult?.kind).toBe("sent");
    expect(latest!.active).toBe(true);

    // A ready that does not name the batch we know is not ours.
    await dom.run(() => {
      emit({ event: "ready", sessionId: "reuse", transferId: "tx", summary: { previousTransferId: "other" } });
    });
    expect(latest!.state.status).toBe("settling");
    await dom.run(() => {
      emit({ event: "ready", sessionId: "reuse", transferId: "t2", summary: { previousTransferId: "t1" } });
    });
    expect(latest!.state.status).toBe("connected");
    expect(latest!.state.transferId).toBe("t2");
    expect(latest!.state.lastResult?.kind).toBe("sent");

    bridge.acceptLanSave.mockResolvedValueOnce(preview("second"));
    await dom.run(async () => {
      emit({ event: "offered", sessionId: "reuse", transferId: "t1", summary: offerSummary });
      emit({ event: "closed", sessionId: "reuse", transferId: "t1" });
      await settle();
    });
    expect(latest!.state.status).toBe("connected");
    expect(bridge.acceptLanSave).not.toHaveBeenCalled();

    await dom.run(async () => {
      emit({ event: "offered", sessionId: "reuse", transferId: "t2", summary: offerSummary });
      await settle();
    });
    expect(bridge.acceptLanSave).toHaveBeenCalledTimes(1);
    expect(bridge.acceptLanSave).toHaveBeenCalledWith("reuse", "t2");
    expect(latest!.state.status).toBe("preview");
    expect(latest!.state.lastResult).toBeNull();

    bridge.commitLanSave.mockResolvedValueOnce(commitResult("second"));
    await dom.run(async () => { await latest!.commit(false); });
    expect(bridge.commitLanSave).toHaveBeenCalledWith("reuse", "t2", false);
    expect(latest!.state.status).toBe("settling");
    expect(latest!.state.lastResult?.kind).toBe("imported");
    await dom.run(() => {
      emit({ event: "ready", sessionId: "reuse", transferId: "t3", summary: { previousTransferId: "t2" } });
    });
    expect(latest!.state.status).toBe("connected");
    expect(bridge.closeLanSave).not.toHaveBeenCalled();
  });

  it("ready 先于发送结果到达：迟到结果只记上一批，不覆盖新的 Offer，空闲后再自动接收", async () => {
    const emit = await joinPaired("race");
    const sending = deferred<LanSendResult>();
    bridge.sendLanSave.mockReturnValueOnce(sending.promise);
    bridge.acceptLanSave.mockReturnValueOnce(deferred<SaveFilePrepareResult>().promise);
    let sent!: Promise<void>;
    await dom.run(() => { sent = latest!.send("all", false); });
    await dom.run(async () => {
      emit({ event: "ready", sessionId: "race", transferId: "t2", summary: { previousTransferId: "t1" } });
      emit({ event: "offered", sessionId: "race", transferId: "t2", summary: offerSummary });
      await settle();
    });
    expect(latest!.state.transferId).toBe("t2");
    expect(latest!.state.status).toBe("receiving");
    // Our send invoke still owns the busy slot.
    expect(bridge.acceptLanSave).not.toHaveBeenCalled();

    await dom.run(async () => { sending.resolve(sendResult("completed")); await sent; await settle(); });
    expect(latest!.state.status).toBe("receiving");
    expect(latest!.state.lastResult?.kind).toBe("sent");
    expect(bridge.acceptLanSave).toHaveBeenCalledTimes(1);
    expect(bridge.acceptLanSave).toHaveBeenCalledWith("race", "t2");
  });

  it("ready 先于提交结果到达时回到已连接，而不是停在本批收尾", async () => {
    const emit = await joinPaired("commit-race");
    bridge.acceptLanSave.mockResolvedValueOnce(preview("c"));
    await dom.run(async () => {
      emit({ event: "offered", sessionId: "commit-race", transferId: "t1", summary: offerSummary });
      await settle();
    });
    const committing = deferred<SaveFileCommitResult>();
    bridge.commitLanSave.mockReturnValueOnce(committing.promise);
    let committed!: Promise<void>;
    await dom.run(() => { committed = latest!.commit(false); });
    await dom.run(() => {
      emit({ event: "ready", sessionId: "commit-race", transferId: "t2", summary: { previousTransferId: "t1" } });
    });
    expect(latest!.state.status).toBe("committing");
    await dom.run(async () => { committing.resolve(commitResult("c")); await committed; });
    expect(latest!.state.status).toBe("connected");
    expect(latest!.state.lastResult?.kind).toBe("imported");
    expect(onImportCommitted).toHaveBeenCalledTimes(1);
  });

  it("预览里取消只取消本批，连接保持；提交已开始时取消显示为等待结果", async () => {
    const emit = await joinPaired("cancel");
    bridge.acceptLanSave.mockResolvedValue(preview("p"));
    await dom.run(async () => {
      emit({ event: "offered", sessionId: "cancel", transferId: "t1", summary: offerSummary });
      await settle();
    });
    expect(latest!.state.status).toBe("preview");

    bridge.cancelLanSaveTransfer.mockResolvedValueOnce({ status: "cancelled" });
    await dom.run(async () => {
      await latest!.cancelTransfer();
      emit({ event: "cancelled", sessionId: "cancel", transferId: "t1", code: "cancelled" });
    });
    expect(bridge.cancelLanSaveTransfer).toHaveBeenCalledWith("cancel", "t1");
    expect(bridge.closeLanSave).not.toHaveBeenCalled();
    expect(latest!.state.status).toBe("settling");
    expect(latest!.state.preview).toBeNull();
    expect(latest!.state.lastResult?.kind).toBe("importCancelled");

    await dom.run(async () => {
      emit({ event: "ready", sessionId: "cancel", transferId: "t2", summary: { previousTransferId: "t1" } });
      emit({ event: "offered", sessionId: "cancel", transferId: "t2", summary: offerSummary });
      await settle();
    });
    expect(latest!.state.status).toBe("preview");
    bridge.cancelLanSaveTransfer.mockResolvedValueOnce({ status: "too-late" });
    await dom.run(async () => { await latest!.cancelTransfer(); });
    expect(bridge.cancelLanSaveTransfer).toHaveBeenLastCalledWith("cancel", "t2");
    expect(latest!.state.status).toBe("committing");
    expect(latest!.state.cancelTooLate).toBe(true);
    expect(latest!.state.lastResult?.kind).not.toBe("importCancelled");
  });

  it("自动接收每批只试一次：忙时留下 Offer 给手动接收或不接收", async () => {
    const emit = await joinPaired("busy-accept");
    bridge.acceptLanSave
      .mockRejectedValueOnce(Object.assign(new Error("已有任务"), { code: "busy" }))
      .mockResolvedValueOnce(preview("manual"));
    await dom.run(async () => {
      emit({ event: "offered", sessionId: "busy-accept", transferId: "t1", summary: offerSummary });
      await settle();
    });
    expect(bridge.acceptLanSave).toHaveBeenCalledTimes(1);
    expect(latest!.state.status).toBe("receiving");
    expect(latest!.state.offer?.bookCount).toBe(3);
    expect(latest!.state.errorCode).toBe("busy");
    await dom.run(async () => { await settle(); });
    expect(bridge.acceptLanSave).toHaveBeenCalledTimes(1);

    await dom.run(async () => { await latest!.accept(); });
    expect(bridge.acceptLanSave).toHaveBeenCalledTimes(2);
    expect(latest!.state.status).toBe("preview");
  });

});
