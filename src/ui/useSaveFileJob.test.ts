import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import type {
  SaveFileCommitResult,
  SaveFilePrepareResult,
  SaveFileProgress,
} from "../platform/saveFileNativeBridge";
import { useSaveFileJob, type UseSaveFileJobResult } from "./useSaveFileJob";

const bridge = vi.hoisted(() => ({
  exportSaveFile: vi.fn(),
  prepareSaveFileImport: vi.fn(),
  commitSaveFileImport: vi.fn(),
  cancelSaveFile: vi.fn(),
}));

vi.mock("../platform/saveFileNativeBridge", () => ({
  saveFileErrorMessage: (error: unknown) => String(error),
  exportSaveFile: bridge.exportSaveFile,
  prepareSaveFileImport: bridge.prepareSaveFileImport,
  commitSaveFileImport: bridge.commitSaveFileImport,
  cancelSaveFile: bridge.cancelSaveFile,
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

let latest: UseSaveFileJobResult | null = null;
function Probe() {
  const job = useSaveFileJob();
  latest = job;
  return createElement("span", { "data-kind": job.state.kind });
}

describe("useSaveFileJob", () => {
  let dom: ReturnType<typeof createReactDomHarness>;

  beforeEach(() => {
    bridge.exportSaveFile.mockReset();
    bridge.prepareSaveFileImport.mockReset();
    bridge.commitSaveFileImport.mockReset();
    bridge.cancelSaveFile.mockReset();
    latest = null;
    dom = createReactDomHarness();
  });

  afterEach(async () => {
    await dom.dispose();
  });

  it("prepare 过程中关闭后，迟到的成功回包不会重新打开确认", async () => {
    const pendingPrepare = deferred<SaveFilePrepareResult>();
    bridge.prepareSaveFileImport.mockReturnValue(pendingPrepare.promise);
    bridge.cancelSaveFile.mockResolvedValue("cancelled");
    await dom.render(createElement(Probe));
    const job = latest!;

    let preparePromise!: Promise<SaveFilePrepareResult>;
    await dom.run(() => {
      preparePromise = job.beginPrepare({
        source: { kind: "path", path: "/tmp/late.epubsave" },
        sourceLabel: "late.epubsave",
      });
    });
    expect(latest?.state.kind).toBe("preparing");

    await dom.run(async () => {
      await job.cancelCurrent();
    });
    expect(latest?.state.kind).toBe("preparing");
    expect(latest?.state.kind === "preparing" && latest.state.canceling).toBe(true);

    let prepareError: unknown;
    await dom.run(async () => {
      pendingPrepare.resolve(preview("late-preview"));
      try {
        await preparePromise;
      } catch (error) {
        prepareError = error;
      }
    });

    expect((prepareError as Error | undefined)?.message).toContain("已取消存档导入");
    expect(latest?.state.kind).toBe("idle");
  });

  it("双击确认只 commit 一次", async () => {
    const pendingCommit = deferred<SaveFileCommitResult>();
    bridge.prepareSaveFileImport.mockResolvedValue(preview("preview"));
    bridge.commitSaveFileImport.mockReturnValue(pendingCommit.promise);
    await dom.render(createElement(Probe));
    const job = latest!;

    await dom.run(async () => {
      await job.beginPrepare({
        source: { kind: "path", path: "/tmp/good.epubsave" },
        sourceLabel: "good.epubsave",
      });
    });
    expect(latest?.state.kind).toBe("prepared");

    let firstCommit!: Promise<SaveFileCommitResult>;
    let secondError: unknown;
    await dom.run(async () => {
      firstCommit = job.commit(false);
      const secondCommit = job.commit(false);
      await secondCommit.catch((error) => {
        secondError = error;
      });
    });
    expect(bridge.commitSaveFileImport).toHaveBeenCalledTimes(1);
    expect((secondError as Error | undefined)?.message).toContain("当前没有待确认的存档导入");

    await dom.run(async () => {
      pendingCommit.resolve(commitResult("preview"));
      await firstCommit;
    });
    expect(latest?.state.kind).toBe("idle");
  });

  it("新 job 的进度不被旧 Channel 回包污染", async () => {
    const firstProgress = { callback: null as ((progress: SaveFileProgress) => void) | null };
    const secondPending = deferred<SaveFilePrepareResult>();
    const secondProgress = { callback: null as ((progress: SaveFileProgress) => void) | null };
    bridge.prepareSaveFileImport
      .mockImplementationOnce((input: { onProgress(progress: SaveFileProgress): void }) => {
        firstProgress.callback = input.onProgress;
        return Promise.resolve(preview("first"));
      })
      .mockImplementationOnce((input: { onProgress(progress: SaveFileProgress): void }) => {
        secondProgress.callback = input.onProgress;
        return secondPending.promise;
      });
    bridge.cancelSaveFile.mockResolvedValue("cancelled");
    await dom.render(createElement(Probe));
    const job = latest!;

    await dom.run(async () => {
      await job.beginPrepare({
        source: { kind: "path", path: "/tmp/first.epubsave" },
        sourceLabel: "first.epubsave",
      });
    });
    await dom.run(async () => {
      await job.cancelCurrent();
    });

    let secondPrepare!: Promise<SaveFilePrepareResult>;
    await dom.run(() => {
      secondPrepare = job.beginPrepare({
        source: { kind: "path", path: "/tmp/second.epubsave" },
        sourceLabel: "second.epubsave",
      });
    });
    expect(latest?.state.kind).toBe("preparing");

    await dom.run(() => {
      firstProgress.callback?.({
        phase: "extracting",
        processedBytes: 77,
        totalBytes: 100,
      });
    });
    expect(latest?.state.kind).toBe("preparing");
    expect(latest?.state.kind === "preparing" && latest.state.progress.processedBytes).toBe(0);

    let secondError: unknown;
    await dom.run(async () => {
      await job.cancelCurrent();
      secondPending.resolve(preview("second"));
      try {
        await secondPrepare;
      } catch (error) {
        secondError = error;
      }
    });
    expect((secondError as Error | undefined)?.message).toContain("已取消存档导入");
    expect(latest?.state.kind).toBe("idle");
  });
});
