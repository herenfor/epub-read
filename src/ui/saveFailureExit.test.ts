import { describe, expect, it } from "vitest";
import type { ProgressLease } from "./portableState/ownedProgressSessions";
import { ScopedProgressWriter } from "./progressWriter";
import { releaseUnsavedLane } from "./saveFailureExit";

const lease = (bookId: string): ProgressLease => Object.freeze({ bookId, generation: 1 });

async function failedLane(): Promise<{ writer: ScopedProgressWriter<string>; book: ProgressLease; attempts: () => number }> {
  const writer = new ScopedProgressWriter<string>(0);
  const book = lease("book");
  let attempts = 0;
  writer.register(book, async () => {
    attempts++;
    throw Object.assign(new Error("chapterPath invalid"), { code: "invalid-data" });
  });
  writer.enqueue(book, "page-9");
  const result = await writer.flush(book);
  expect(result.status).toBe("failed");
  return { writer, book, attempts: () => attempts };
}

describe("leaving after a failed progress save", () => {
  it("retry flushes the same sample again and still reports failure", async () => {
    const { writer, book, attempts } = await failedLane();
    const before = attempts();
    const retry = await writer.flush(book);
    expect(retry.status).toBe("failed");
    expect(attempts()).toBe(before + 1);
    expect(writer.hasUnsaved(book)).toBe(true);
  });

  it("leave hands the latest sample to the local checkpoint and frees the lane", async () => {
    const { writer, book } = await failedLane();
    const retained: string[] = [];
    expect(releaseUnsavedLane(writer, book, (sample) => retained.push(sample))).toBe("checkpoint");
    expect(retained).toEqual(["page-9"]);
    expect(writer.current("book")).toBeUndefined();
    // The book can be opened again with a fresh lane.
    expect(() => writer.register(lease("book"), async () => undefined)).not.toThrow();
  });

  it("leave still succeeds when the checkpoint cannot be written; the lane stays for a later retry", async () => {
    const { writer, book } = await failedLane();
    const result = releaseUnsavedLane(writer, book, () => {
      throw new Error("localStorage full");
    });
    expect(result).toBe("kept");
    expect(writer.current("book")).toBe(book);
    expect(writer.hasUnsaved(book)).toBe(true);
    expect((await writer.flushBooks()).map((item) => item.status)).toEqual(["failed"]);
  });

  it("an unknown lease is reported as kept instead of throwing", () => {
    const writer = new ScopedProgressWriter<string>(0);
    expect(releaseUnsavedLane(writer, lease("missing"), () => undefined)).toBe("kept");
  });
});
