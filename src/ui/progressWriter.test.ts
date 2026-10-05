import { describe, expect, it, vi } from "vitest";
import { ScopedProgressWriter, ShelfProgressWriter } from "./progressWriter";
import type { ProgressLease } from "./portableState/ownedProgressSessions";
import { LocalProgressCheckpoints, type LocalProgressCheckpoint } from "./localProgressCheckpoint";
import {
  planCheckpointOpen,
  stageCheckpointSample,
  persistCheckpointSample,
  ProgressWriteUnconfirmed,
} from "./checkpointProgressRepair";
import { createRepositoryReadinessRecovery } from "./portableState/repositoryReadinessRepair";
import type { ShelfProgressPatch } from "./shelf";

function patch(page: number): ShelfProgressPatch {
  return {
    lastReadAtMs: page,
    spineIndex: 0,
    page,
    progressPct: page,
    anchorIndex: page,
    anchorRatio: 0.5,
    anchorTextOffset: page * 10,
    anchorTextSnippet: "正文",
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ShelfProgressWriter", () => {
  it("写入中连续翻页只保留最新待写值", async () => {
    const first = deferred();
    const writes: number[] = [];
    const writer = new ShelfProgressWriter(async (_id, value) => {
      writes.push(value.page);
      if (writes.length === 1) await first.promise;
    });

    writer.enqueue("book", patch(1));
    await Promise.resolve();
    writer.enqueue("book", patch(2));
    writer.enqueue("book", patch(3));
    first.resolve();
    await writer.flush();
    expect(writes).toEqual([1, 3]);
  });

  it("不同书的最终进度不会互相覆盖", async () => {
    const writes: string[] = [];
    const writer = new ShelfProgressWriter(async (id, value) => {
      writes.push(`${id}:${value.page}`);
    });
    writer.enqueue("a", patch(2));
    writer.enqueue("b", patch(4));
    await writer.flush();
    expect(writes).toEqual(["a:2", "b:4"]);
  });

  it("每本书的首次稳定进度都立即写入", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const writer = new ShelfProgressWriter(async (id, value) => {
        writes.push(`${id}:${value.page}`);
      }, { debounceMs: 100 });

      writer.enqueue("a", patch(1));
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toEqual(["a:1"]);

      writer.enqueue("b", patch(2));
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toEqual(["a:1", "b:2"]);
      writer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("按阅读会话重新允许首次位置立即写入", async () => {
    vi.useFakeTimers();
    try {
      const writes: number[] = [];
      const writer = new ShelfProgressWriter(async (_id, value) => {
        writes.push(value.page);
      }, { debounceMs: 100 });
      writer.enqueue("book", patch(1));
      await Promise.resolve();
      await writer.flush();
      writer.beginSession("book");
      writer.enqueue("book", patch(2));
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toEqual([1, 2]);
      writer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush 报告写入错误，但后续写入仍可继续", async () => {
    let fail = true;
    const writes: number[] = [];
    const writer = new ShelfProgressWriter(async (_id, value) => {
      if (fail) throw new Error("disk failed");
      writes.push(value.page);
    });
    writer.enqueue("book", patch(1));
    await expect(writer.flush()).rejects.toThrow("disk failed");
    fail = false;
    writer.enqueue("book", patch(2));
    await writer.flush();
    expect(writes).toEqual([2]);
  });

  it("beginSession 丢弃上一会话的失败和待写样本", async () => {
    let fail = true;
    const writes: number[] = [];
    const writer = new ShelfProgressWriter(async (_id, value) => {
      if (fail) throw new Error("disk failed");
      writes.push(value.page);
    });
    writer.enqueue("book", patch(1));
    await expect(writer.flush()).rejects.toThrow("disk failed");
    writer.beginSession("book");
    fail = false;
    await writer.flush();
    expect(writes).toEqual([]);
    writer.enqueue("book", patch(2));
    await writer.flush();
    expect(writes).toEqual([2]);
    writer.dispose();
  });

  it("stale-basis/stale-choice 样本直接丢弃，不进入 flush 重试", async () => {
    const writes: number[] = [];
    const writer = new ShelfProgressWriter(async (_id, value) => {
      writes.push(value.page);
      if (writes.length === 1) {
        throw Object.assign(new Error("stale-basis"), { code: "stale-basis" });
      }
    });
    writer.enqueue("book", patch(1));
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(writes).toEqual([1]);

    writer.enqueue("book", patch(2));
    await writer.flush();
    expect(writes).toEqual([1, 2]);
  });

  it("活跃写入期间的新位置等待 debounce，且只写最新值", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred();
      const writes: number[] = [];
      const writer = new ShelfProgressWriter(async (_id, value) => {
        writes.push(value.page);
        if (writes.length === 1) await first.promise;
      }, { debounceMs: 100 });

      writer.enqueue("book", patch(1));
      await Promise.resolve();
      writer.enqueue("book", patch(2));
      writer.enqueue("book", patch(3));
      first.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toEqual([1]);

      await vi.advanceTimersByTimeAsync(99);
      expect(writes).toEqual([1]);
      await vi.advanceTimersByTimeAsync(1);
      await writer.flush();
      expect(writes).toEqual([1, 3]);
      writer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("ScopedProgressWriter", () => {
  const lease = (bookId: string, generation = 1): ProgressLease => Object.freeze({ bookId, generation });

  it("keeps one failed book lane without blocking another book", async () => {
    const writer = new ScopedProgressWriter<number>(0);
    const a = lease("a");
    const b = lease("b");
    writer.register(a, async () => { throw new Error("synthetic storage failure"); });
    writer.register(b, async () => undefined);
    writer.enqueue(a, 9);
    await expect(writer.flush(a)).resolves.toMatchObject({ status: "failed" });
    writer.enqueue(b, 3);
    await expect(writer.flush(b)).resolves.toMatchObject({ status: "saved" });
    expect(writer.hasUnsaved(a)).toBe(true);
    expect(writer.hasUnsaved(b)).toBe(false);
    writer.disposeTimers();
  });

  it("refuses a replacement lease until the old failed lane is retired", async () => {
    const writer = new ScopedProgressWriter<number>(0);
    const oldLease = lease("book", 1);
    writer.register(oldLease, async () => { throw new Error("synthetic storage failure"); });
    writer.enqueue(oldLease, 1);
    await writer.flush(oldLease);
    expect(() => writer.register(lease("book", 2), async () => undefined)).toThrow(/不能覆盖/);
    writer.disposeTimers();
  });

  it("a late old rejection cannot replace a newer queued sample", async () => {
    let first = true;
    let rejectOld!: (error: unknown) => void;
    const old = new Promise<void>((_, reject) => { rejectOld = reject; });
    const written: number[] = [];
    const writer = new ScopedProgressWriter<number>(0);
    const book = lease("book");
    writer.register(book, async (page) => {
      if (first) { first = false; await old; }
      written.push(page);
    });
    writer.enqueue(book, 4);
    await Promise.resolve();
    writer.enqueue(book, 5);
    rejectOld(new Error("synthetic late failure"));
    await expect(writer.flush(book)).resolves.toMatchObject({ status: "saved" });
    expect(written).toEqual([5]);
    writer.disposeTimers();
  });
});


type RepairPatch = {
  page: number;
  lastReadAtMs: number;
  chapterPath?: string | null;
};

function memoryCheckpoints() {
  const disk = new Map<string, string>();
  let sequence = 0;
  const checkpoints = new LocalProgressCheckpoints<RepairPatch>({
    getItem: (key) => disk.get(key) ?? null,
    setItem: (key, value) => { disk.set(key, value); },
    removeItem: (key) => { disk.delete(key); },
  }, (value) => value as LocalProgressCheckpoint<RepairPatch>, () => `cp-${++sequence}`);
  return { checkpoints, disk };
}

describe("progress lifecycle repair", () => {
  const stamp = { deviceId: "00000000-0000-4000-8000-000000000001", counter: 1 };
  const version = { stamp, page: 9 };

  it("plans checkpoint open without bypassing multi-version choice", () => {
    const { checkpoints } = memoryCheckpoints();
    const checkpoint = checkpoints.put("book", stamp, { page: 9, lastReadAtMs: 1, chapterPath: "a.xhtml" });
    const sameLocation = (patch: RepairPatch, current: typeof version) => patch.page === current.page;

    expect(planCheckpointOpen(checkpoint, [version], sameLocation).kind).toBe("use-saved");
    expect(planCheckpointOpen(checkpoint, [{ stamp, page: 8 }], sameLocation).kind).toBe("restore-local");
    expect(planCheckpointOpen(
      checkpoint,
      [version, { stamp: { deviceId: "other", counter: 2 }, page: 9 }],
      sameLocation,
    ).kind).toBe("choose");
    expect(planCheckpointOpen(
      checkpoint,
      [{ stamp: { deviceId: "other", counter: 2 }, page: 8 }],
      sameLocation,
    ).kind).toBe("choose");
  });

  it("stages one record for the same stable location and keeps the late ack from deleting a newer ID", async () => {
    const { checkpoints } = memoryCheckpoints();
    const first = stageCheckpointSample(checkpoints, "book", stamp, { page: 9, lastReadAtMs: 1, chapterPath: "a.xhtml" });
    const sameLocation = stageCheckpointSample(checkpoints, "book", stamp, { page: 9, lastReadAtMs: 99, chapterPath: "a.xhtml" });
    expect(sameLocation.checkpointId).toBe(first.checkpointId);

    await expect(persistCheckpointSample(
      checkpoints,
      "book",
      sameLocation,
      async () => ({ status: "unconfirmed", code: "progress-write-interrupted" }),
    )).rejects.toBeInstanceOf(ProgressWriteUnconfirmed);
    expect(checkpoints.peek("book")?.patch.page).toBe(9);

    const newer = stageCheckpointSample(checkpoints, "book", stamp, { page: 10, lastReadAtMs: 100, chapterPath: "a.xhtml" });
    await persistCheckpointSample(
      checkpoints,
      "book",
      first,
      async () => ({ status: "saved", entry: { ok: true }, shownStamp: stamp }),
    );
    expect(checkpoints.peek("book")?.checkpointId).toBe(newer.checkpointId);
  });

  it("retains the latest failed lane sample only for explicit handoff", async () => {
    const writer = new ScopedProgressWriter<number>(0);
    const oldLease = Object.freeze({ bookId: "book", generation: 1 });
    writer.register(oldLease, async () => { throw new Error("synthetic storage failure"); });
    writer.enqueue(oldLease, 9);
    await expect(writer.flush(oldLease)).resolves.toMatchObject({ status: "failed" });

    const retained: number[] = [];
    writer.handoffToCheckpoint(oldLease, (sample) => { retained.push(sample); });
    expect(retained).toEqual([9]);
    writer.register(Object.freeze({ bookId: "book", generation: 2 }), async () => undefined);
    writer.disposeTimers();
  });

  it("recovers readiness with a real single activation, not an old promise", async () => {
    let ready = false;
    let activations = 0;
    const ensureReady = createRepositoryReadinessRecovery({
      runtimeStatus: async () => ({
        repositoryGeneration: "runtime-repaired",
        repositoryReady: ready,
      }),
      activate: async () => {
        activations++;
        ready = true;
      },
    });
    const [first, second] = await Promise.all([ensureReady(), ensureReady()]);
    expect(first.repositoryReady).toBe(true);
    expect(second.repositoryReady).toBe(true);
    expect(activations).toBe(1);
    await ensureReady();
    expect(activations).toBe(1);
  });
});
