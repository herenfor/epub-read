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

    await dom.run(async () => {
      host.resolve({ sessionId: "late-session", pairingInfo: "raw" });
      await flushMicrotasks();
    });

    expect(bridge.closeLanSave).toHaveBeenCalledTimes(1);
    expect(latest!.state.status).toBe("idle");
  });

  it("too-late 关闭后仍等待真实 commit，并只以最终结果刷新投影", async () => {
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

    bridge.closeLanSave.mockResolvedValue({ status: "too-late" });
    await dom.run(async () => {
      await latest!.close();
    });
    expect(latest!.state.status).toBe("committing");
    expect(latest!.state.cancelTooLate).toBe(true);

    await dom.run(async () => {
      pendingCommit.resolve(commitResult("preview-1"));
      await commitPromise;
    });

    expect(onImportCommitted).toHaveBeenCalledTimes(1);
    expect(onImportCommitted.mock.calls[0]![0]).toMatchObject({ status: "committed" });
    expect(onImportCommitted.mock.calls[0]![1]).toBe(false);
    expect(latest!.state.status).toBe("commitComplete");
    expect(latest!.state.status).not.toBe("idle");
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
});
