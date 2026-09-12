import { describe, expect, it, vi } from "vitest";
import { deleteShelfBooks } from "./shelf";

describe("shelf deletion", () => {
  it("deletes the unique selection in one native batch", async () => {
    const store = { deleteBook: vi.fn(), deleteBooks: vi.fn().mockResolvedValue(undefined) };
    expect(await deleteShelfBooks(store, ["a", "b", "a"])).toEqual({ deleted: ["a", "b"], failed: [] });
    expect(store.deleteBooks).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
    expect(store.deleteBook).not.toHaveBeenCalled();
  });
  it("keeps failed browser rows visible while removing successful rows", async () => {
    const store = { deleteBook: vi.fn(async (id: string) => { if (id === "b") throw new Error("disk full"); }) };
    expect(await deleteShelfBooks(store, ["a", "b", "c"])).toEqual({
      deleted: ["a", "c"], failed: [{ id: "b", error: "Error: disk full" }],
    });
  });
  it("reports a failed native batch without retrying individual deletions", async () => {
    const store = { deleteBook: vi.fn(), deleteBooks: vi.fn().mockRejectedValue("index locked") };
    expect(await deleteShelfBooks(store, ["a", "b"])).toEqual({
      deleted: [], failed: [{ id: "a", error: "index locked" }, { id: "b", error: "index locked" }],
    });
    expect(store.deleteBook).not.toHaveBeenCalled();
    expect(store.deleteBooks).toHaveBeenCalledTimes(1);
  });
  it("does not start cleanup for an empty selection", async () => {
    const store = { deleteBook: vi.fn(), deleteBooks: vi.fn() };
    expect(await deleteShelfBooks(store, [])).toEqual({ deleted: [], failed: [] });
    expect(store.deleteBooks).not.toHaveBeenCalled();
  });
});
