import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, channels } = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<(value: unknown) => void>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    constructor(handler: (value: unknown) => void) { channels.push(handler); }
  },
}));
vi.mock("../../platform/runtimeCapabilities", () => ({
  getRuntimeCapabilities: () => ({ platform: "windows", supportsCloudSync: true }),
}));

import { createReactDomHarness } from "../../test/reactDomHarness";
import type { CloudBookUploadProgress, CloudBookUploadResult } from "../../platform/cloudBookUploadNative";
import type { CloudSyncStatus } from "../../platform/cloudSyncNative";
import { translate, translatePlural } from "../localization/core";
import { CloudBookUploadLayer, UPLOAD_LIST_LIMIT } from "./CloudBookUploadPanel";
import {
  cancelCloudBookUpload,
  cloudBookUploadBusy,
  cloudBookUploadView,
  confirmCloudBookUpload,
  recoverCloudBookUpload,
  requestCloudBookUpload,
  resetCloudBookUploadStoreForTest,
  rereadCloudBookUpload,
  retryFailedCloudBookUpload,
} from "./cloudBookUploadStore";
import { stopCode, uploadReasonText, uploadResultTitle } from "./cloudBookUploadText";
import { adoptCloudSyncStatus, resetCloudSyncStoreForTest } from "./cloudSyncStore";

const connected: CloudSyncStatus = {
  nativeReady: true,
  connection: { connectionId: "c1", baseUrl: "https://dav.example/dav/", remoteRoot: "EPUBReader", username: "u", spaceId: "s", deviceLabel: "pc" },
  phase: "idle", lastSuccessAtMs: null, retryAtMs: null, lastError: null, pending: false, localChanged: false,
  issues: [], deviceCount: 1, cloudOnlyBookCount: 0, localRecoverySaved: false,
};

function connectedTo(connectionId: string): CloudSyncStatus {
  return { ...connected, connection: { ...connected.connection!, connectionId, baseUrl: `https://${connectionId}.example/dav/`, spaceId: connectionId } };
}

const looseT = translate as unknown as (locale: string, ...args: unknown[]) => string;
const looseTn = translatePlural as unknown as (locale: string, ...args: unknown[]) => string;
const ui = {
  t: ((...args: unknown[]) => looseT("zh-CN", ...args)) as never,
  tn: ((...args: unknown[]) => looseTn("zh-CN", ...args)) as never,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function result(jobId: string, patch: Partial<CloudBookUploadResult> = {}): CloudBookUploadResult {
  return {
    jobId, connectionId: "c1", status: "completed", books: [], uploaded: 0, alreadyPresent: 0,
    failed: 0, cancelled: 0, notAttempted: 0, cleanupPending: false, ...patch,
  };
}

function progress(jobId: string, patch: Partial<CloudBookUploadProgress> = {}): CloudBookUploadProgress {
  return {
    jobId, connectionId: "c1", phase: "uploading", index: 0, count: 2, contentHash: "a",
    bookSent: 10, bookTotal: 100, batchSent: 10, batchTotal: 200, ...patch,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let status: CloudSyncStatus;
let uploads: Array<{ jobId: string; hashes: string[]; done: ReturnType<typeof deferred<CloudBookUploadResult>> }>;

beforeEach(() => {
  resetCloudBookUploadStoreForTest();
  resetCloudSyncStoreForTest();
  invoke.mockReset();
  channels.length = 0;
  uploads = [];
  status = connected;
  adoptCloudSyncStatus(connected);
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "cloud_book_upload_preview":
        return {
          books: [
            { contentHash: "a", title: "百年孤独", fileName: "a.epub", bytes: 100, ready: true, code: null },
            { contentHash: "b", title: "三体", fileName: "b.epub", bytes: 0, ready: false, code: "source-unbound" },
            { contentHash: "c", title: "沙丘", fileName: "c.epub", bytes: 100, ready: true, code: null },
          ],
          totalBytes: 200,
        };
      case "cloud_book_upload": {
        const done = deferred<CloudBookUploadResult>();
        uploads.push({ jobId: args.jobId as string, hashes: args.bookHashes as string[], done });
        return done.promise;
      }
      case "cloud_book_upload_cancel": return true;
      case "cloud_book_upload_current": return null;
      case "cloud_sync_get_status": return status;
      default: throw new Error(`unexpected ${command}`);
    }
  });
});

describe("upload job ownership", () => {
  it("sends only ready books and ignores a finished job's late progress", async () => {
    requestCloudBookUpload(["a", "b", "c", "a"]);
    await flush();
    confirmCloudBookUpload();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].hashes).toEqual(["a", "c"]);
    const first = uploads[0];
    const firstChannel = channels[0];

    firstChannel(progress(first.jobId));
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "running", progress: { bookSent: 10 } });

    first.done.resolve(result(first.jobId, {
      status: "partial", uploaded: 1, failed: 1,
      books: [
        { contentHash: "a", title: "百年孤独", outcome: "uploaded", code: null, bytes: 100 },
        { contentHash: "c", title: "沙丘", outcome: "failed", code: "network", bytes: 100 },
      ],
    }));
    await flush();
    expect(cloudBookUploadView().panel.kind).toBe("result");
    expect(cloudBookUploadView().last?.jobId).toBe(first.jobId);

    retryFailedCloudBookUpload();
    expect(uploads).toHaveLength(2);
    expect(uploads[1].hashes).toEqual(["c"]);
    expect(uploads[1].jobId).not.toBe(first.jobId);

    // The old job's channel and result cannot reach the new job.
    firstChannel(progress(first.jobId, { bookSent: 99 }));
    first.done.resolve(result(first.jobId));
    await flush();
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "running", jobId: uploads[1].jobId, progress: null });
  });

  it("cancel waits for the real result instead of reporting it", async () => {
    requestCloudBookUpload(["a"]);
    await flush();
    confirmCloudBookUpload();
    cancelCloudBookUpload();
    await flush();
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "running", canceling: true });
    expect(cloudBookUploadBusy()).toBe(true);
    uploads[0].done.resolve(result(uploads[0].jobId, { status: "cancelled", cancelled: 1 }));
    await flush();
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "result", result: { status: "cancelled" } });
    expect(cloudBookUploadBusy()).toBe(false);
  });

  it("an unreadable current job is unknown, and a job from before a reload blocks a new batch", async () => {
    invoke.mockImplementationOnce(async () => { throw new Error("ipc"); });
    await recoverCloudBookUpload();
    expect(cloudBookUploadView()).toMatchObject({ current: "unknown", panel: { kind: "closed" } });

    resetCloudBookUploadStoreForTest();
    invoke.mockImplementationOnce(async () => ({ jobId: "j-old", connectionId: "c1", progress: null }));
    await recoverCloudBookUpload();
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "detached", jobId: "j-old" });
    requestCloudBookUpload(["a"]);
    await flush();
    expect(invoke.mock.calls.some(([command]) => command === "cloud_book_upload_preview")).toBe(false);
  });
});

describe("running job state and connection ownership", () => {
  const uploadCalls = () => invoke.mock.calls.filter(([command]) => command === "cloud_book_upload").length;

  it("waits for a pending recovery, then shows the job it found instead of starting a batch", async () => {
    const lookup = deferred<unknown>();
    invoke.mockImplementationOnce(() => lookup.promise);
    const recovery = recoverCloudBookUpload();
    requestCloudBookUpload(["a"]);
    await flush();
    confirmCloudBookUpload();
    expect(uploadCalls()).toBe(0);
    lookup.resolve({ jobId: "native-old", connectionId: "c1", progress: null });
    await recovery;
    expect(uploadCalls()).toBe(0);
    expect(cloudBookUploadView()).toMatchObject({ current: "known", collapsed: false, panel: { kind: "detached", jobId: "native-old" } });
  });

  it("an unreadable running job blocks a new batch until the user reads it again", async () => {
    invoke.mockImplementationOnce(async () => { throw new Error("ipc"); });
    await recoverCloudBookUpload();
    invoke.mockImplementationOnce(async () => { throw new Error("ipc"); });
    requestCloudBookUpload(["a"]);
    await flush();
    confirmCloudBookUpload();
    expect(uploadCalls()).toBe(0);
    expect(cloudBookUploadView().current).toBe("unknown");
    // Reading again (the panel's or the settings row's button) lets it start.
    await rereadCloudBookUpload();
    expect(cloudBookUploadView().current).toBe("known");
    confirmCloudBookUpload();
    expect(uploads.map((item) => item.hashes)).toEqual([["a", "c"]]);
  });

  it("reading again while a read is pending sends no second lookup", async () => {
    const lookup = deferred<unknown>();
    invoke.mockImplementationOnce(() => lookup.promise);
    const recovery = recoverCloudBookUpload();
    void rereadCloudBookUpload();
    lookup.resolve(null);
    await recovery;
    expect(invoke.mock.calls.filter(([command]) => command === "cloud_book_upload_current")).toHaveLength(1);
    expect(cloudBookUploadView().current).toBe("known");
  });

  it("the user switching drives turns a retry into a fresh confirmation for the new drive", async () => {
    requestCloudBookUpload(["a", "c"]);
    await flush();
    confirmCloudBookUpload();
    const first = uploads[0];
    first.done.resolve(result(first.jobId, { status: "partial", uploaded: 1, failed: 1, books: [
      { contentHash: "a", title: "百年孤独", outcome: "uploaded", code: null, bytes: 100 },
      { contentHash: "c", title: "沙丘", outcome: "failed", code: "network", bytes: 100 },
    ] }));
    await flush();
    // Settings → Sync: disconnect c1, connect c2.
    status = connectedTo("c2");
    adoptCloudSyncStatus(status);
    retryFailedCloudBookUpload();
    await flush();
    expect(uploads).toHaveLength(1);
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "confirm", hashes: ["c"], connectionId: "c2", targetChanged: true });
    confirmCloudBookUpload();
    expect(uploads).toHaveLength(2);
    // The mock preview always answers with its fixed books; the ready ones go.
    expect(uploads[1].hashes).toEqual(["a", "c"]);
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "running", connectionId: "c2" });
  });

  it("a drive switched while the confirm panel is open asks once more before uploading", async () => {
    requestCloudBookUpload(["a"]);
    await flush();
    status = connectedTo("c2");
    adoptCloudSyncStatus(status);
    confirmCloudBookUpload();
    expect(uploads).toHaveLength(0);
    expect(cloudBookUploadView().panel).toMatchObject({ kind: "confirm", connectionId: "c2", targetChanged: true });
    confirmCloudBookUpload();
    expect(uploads).toHaveLength(1);
  });
});

describe("result wording", () => {
  it("names the stop cause, counts what was missed and shows unknown codes as themselves", () => {
    expect(uploadResultTitle(ui, result("j", {
      status: "stopped", uploaded: 1, failed: 1, notAttempted: 2,
      books: [
        { contentHash: "a", title: "A", outcome: "uploaded", code: null, bytes: 1 },
        { contentHash: "b", title: "B", outcome: "failed", code: "quota-exceeded", bytes: 1 },
      ],
    }))).toBe("网盘空间不足，上传已停止");
    expect(uploadResultTitle(ui, result("j", { status: "partial", uploaded: 1, failed: 2 , books: [
      { contentHash: "a", title: "A", outcome: "uploaded", code: null, bytes: 1 },
      { contentHash: "b", title: "B", outcome: "failed", code: "network", bytes: 1 },
      { contentHash: "c", title: "C", outcome: "failed", code: "x", bytes: 1 },
    ] }))).toBe("上传结束，有 2 本没成功");
    // A stop before the first book: every book not attempted, each with the cause.
    const preflight = result("j", { status: "stopped", notAttempted: 1, books: [
      { contentHash: "a", title: "A", outcome: "not-attempted", code: "space-mismatch", bytes: 1 },
    ] });
    expect(stopCode(preflight)).toBe("space-mismatch");
    expect(uploadResultTitle(ui, preflight)).not.toBe(looseT("zh-CN", "cloudSync.upload.stopped.other"));
    expect(uploadReasonText(ui.t, "brand-new-code")).toBe("未上传（brand-new-code）");
    expect(uploadReasonText(ui.t, "toString")).toBe("未上传（toString）");
  });

  it("renders a long batch shortened, with the retry button only for failed books", async () => {
    const books = Array.from({ length: UPLOAD_LIST_LIMIT + 5 }, (_, index) => ({
      contentHash: `h${index}`, title: `书${index}`, outcome: "failed" as const, code: "network", bytes: 1,
    }));
    requestCloudBookUpload(["a"]);
    await flush();
    confirmCloudBookUpload();
    uploads[0].done.resolve(result(uploads[0].jobId, { status: "partial", failed: books.length, books }));
    await flush();
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(CloudBookUploadLayer, { onOpenSync: () => undefined }));
      expect(dom.container.querySelectorAll(".cloud-upload-list > li:not(.cloud-upload-more)")).toHaveLength(UPLOAD_LIST_LIMIT);
      expect(dom.container.textContent).toContain("还有 5 本");
      expect(dom.container.textContent).toContain(`重试失败的 ${books.length} 本`);
    } finally {
      await dom.dispose();
    }
  });
});
