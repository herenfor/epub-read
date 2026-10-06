import { describe, expect, it, vi } from "vitest";
import { ScopedProgressWriter, ShelfProgressWriter } from "./progressWriter";
import type { ProgressLease } from "./portableState/ownedProgressSessions";
import { LocalProgressCheckpoints, type LocalProgressCheckpoint } from "./localProgressCheckpoint";
import {
  openingBaselinePct,
  planCheckpointOpen,
  sameCheckpointValue,
  stageCheckpointSample,
  persistCheckpointSample,
  ProgressWriteUnconfirmed,
} from "./checkpointProgressRepair";
import { createRepositoryReadinessRecovery } from "./portableState/repositoryReadinessRepair";
import { ProgressRuntimeGate } from "./portableState/progressRuntimeGate";
import { checkThenRecoverProgressRuntime, planFreshProgressOpen } from "./progressOpenOrder";
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
  progressPct?: number;
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

  it("open_order bounds the first status query without activating on timeout", async () => {
    const gate = new ProgressRuntimeGate(() => new Promise(() => undefined), 20);
    const activate = vi.fn(async () => undefined);
    await expect(checkThenRecoverProgressRuntime(gate, activate)).rejects.toMatchObject({ code: "runtime-check-timeout" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("open_order activates only an explicitly unready runtime and checks the real response", async () => {
    let ready = false;
    const gate = new ProgressRuntimeGate(async () => ({ repositoryReady: ready, repositoryGeneration: "synthetic" }));
    const activate = vi.fn(async () => { ready = true; });
    await expect(checkThenRecoverProgressRuntime(gate, activate)).resolves.toMatchObject({ repositoryReady: true });
    await checkThenRecoverProgressRuntime(gate, activate);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("open_order cancellation and failed save do not retire the old lane", async () => {
    const lease = Object.freeze({ bookId: "book", generation: 1 });
    const writer = new ScopedProgressWriter<number>(0);
    writer.register(lease, async () => { throw new Error("synthetic failure"); });
    writer.enqueue(lease, 9);
    const port = {
      flushTarget: () => writer.flush(lease),
      readCurrent: async () => ({ page: 9 }),
      choose: async () => ({ explicitPositionChoice: false }),
    };
    await expect(planFreshProgressOpen(port)).rejects.toThrow("synthetic failure");
    await expect(planFreshProgressOpen({ ...port, choose: async () => null })).resolves.toBeNull();
    expect(writer.hasUnsaved(lease)).toBe(true);
    const explicit = await planFreshProgressOpen({ ...port, choose: async () => ({ explicitPositionChoice: true }) });
    expect(explicit?.targetSave?.status).toBe("failed");
    expect(writer.current("book")).toBe(lease);
    writer.disposeTimers();
  });

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

  it("gives a same-position percent fix its own checkpoint so the old ack cannot delete it", async () => {
    const { checkpoints } = memoryCheckpoints();
    const zero = stageCheckpointSample(checkpoints, "book", stamp, { page: 9, lastReadAtMs: 1, chapterPath: "a.xhtml", progressPct: 0 });
    const fixed = stageCheckpointSample(checkpoints, "book", stamp, { page: 9, lastReadAtMs: 2, chapterPath: "a.xhtml", progressPct: 42 });
    expect(fixed.checkpointId).not.toBe(zero.checkpointId);
    expect(checkpoints.peek("book")?.patch.progressPct).toBe(42);
    // Only lastReadAtMs changed: still the same record.
    const touched = stageCheckpointSample(checkpoints, "book", stamp, { page: 9, lastReadAtMs: 3, chapterPath: "a.xhtml", progressPct: 42 });
    expect(touched.checkpointId).toBe(fixed.checkpointId);

    const saved = async () => ({ status: "saved" as const, entry: { ok: true }, shownStamp: stamp });
    await persistCheckpointSample(checkpoints, "book", zero, saved);
    expect(checkpoints.peek("book")?.checkpointId).toBe(fixed.checkpointId);
    await persistCheckpointSample(checkpoints, "book", fixed, saved);
    expect(checkpoints.peek("book")).toBeNull();
  });

  it("does not treat a stored same-locator value with another percent as saved", () => {
    const locator = {
      locatorVersion: 1 as const,
      chapterPath: "a.xhtml",
      target: { kind: "text" as const, textProfile: "visible-codepoints-no-whitespace-v1" as const, offset: 120, snippet: "abc" },
    };
    const value = (progressPctHint: number) => ({ locator, progressPctHint }) as Parameters<typeof sameCheckpointValue>[0];
    expect(sameCheckpointValue(value(42), value(42))).toBe(true);
    expect(sameCheckpointValue(value(42), value(0))).toBe(false);

    const { checkpoints } = memoryCheckpoints();
    const checkpoint = checkpoints.put("book", stamp, { page: 9, lastReadAtMs: 1, chapterPath: "a.xhtml", progressPct: 42 });
    type V = { stamp: typeof stamp; value: ReturnType<typeof value> };
    const same = (p: RepairPatch, v: V) => sameCheckpointValue(value(p.progressPct ?? 0), v.value);
    // Same locator, stale 0%: not use-saved; the valid basis restores the local 42%.
    expect(planCheckpointOpen(checkpoint, [{ stamp, value: value(0) }], same).kind).toBe("restore-local");
    expect(planCheckpointOpen(checkpoint, [{ stamp, value: value(42) }], same).kind).toBe("use-saved");
    expect(planCheckpointOpen(
      checkpoint,
      [{ stamp, value: value(0) }, { stamp: { deviceId: "other", counter: 2 }, value: value(42) }],
      same,
    ).kind).toBe("choose");
  });

  it("opens a restored local checkpoint with its own percent, not the stored 0%", () => {
    expect(openingBaselinePct({ progressPct: 42 }, 0, true, 0)).toBe(42);
    expect(openingBaselinePct(null, 37, true, 0)).toBe(37);
    expect(openingBaselinePct(null, undefined, true, 12)).toBe(12);
    expect(openingBaselinePct(null, 37, false, 12)).toBe(12);
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
