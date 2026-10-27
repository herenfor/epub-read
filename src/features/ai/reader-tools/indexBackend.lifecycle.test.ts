import { expect, it, vi } from "vitest";
import { createReaderIndexBackend } from "./indexBackend";
import type { NativeIndexTask } from "../indexing/indexTaskStore";

const cancel = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../ui/shelf", () => ({ getShelfStore: () => ({ list: async () => [{ id: "book", contentHash: "hash" }] }) }));
vi.mock("../indexing/indexStore", () => ({ listIndexedBooks: async () => [], createTauriIndexStagingStore: vi.fn() }));
vi.mock("../indexing/libraryIndexer", () => ({ indexStatusIsCurrent: () => false }));
vi.mock("../indexing/indexTaskStore", () => ({
  cancelLibraryIndexTask: cancel, updateLibraryIndexTask: vi.fn(), completeLibraryIndexTask: vi.fn(), failLibraryIndexTask: vi.fn(),
}));

it("cancels a lease arriving after dispose without starting background extraction", async () => {
  let finish!: (task: NativeIndexTask) => void;
  const lease = new Promise<NativeIndexTask>(resolve => { finish = resolve; });
  let acquired!: () => void;
  const entered = new Promise<void>(resolve => { acquired = resolve; });
  const access = vi.fn(async () => { throw new Error("must not open a source after dispose"); });
  const backend = createReaderIndexBackend(access, () => { acquired(); return lease; });
  const prepare = backend.prepareIndex("book", new AbortController().signal);
  await entered;
  await backend.dispose();
  finish({ id: "late-lease" } as NativeIndexTask);
  await expect(prepare).rejects.toMatchObject({ code: "CANCELLED" });
  expect(cancel).toHaveBeenCalledWith("late-lease");
  expect(access).not.toHaveBeenCalled();
});
