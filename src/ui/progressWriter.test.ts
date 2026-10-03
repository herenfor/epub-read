import { describe, expect, it, vi } from "vitest";
import { ShelfProgressWriter } from "./progressWriter";
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
