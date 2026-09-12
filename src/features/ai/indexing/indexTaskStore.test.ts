import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  LIBRARY_TEXT_INDEX_TASK_KIND,
  completeLibraryIndexTask,
  createLibraryIndexTask,
  latestInterruptedLibraryIndexTask,
  listLibraryIndexTasks,
  type NativeIndexTask,
  updateLibraryIndexTask,
} from "./indexTaskStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

function task(overrides: Partial<NativeIndexTask> = {}): NativeIndexTask {
  return {
    id: "job-1",
    kind: LIBRARY_TEXT_INDEX_TASK_KIND,
    state: "running",
    progress: 0,
    cancelRequested: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("library index persistent task bridge", () => {
  beforeEach(() => invokeMock.mockReset());

  it("atomically acquires and starts one durable library task", async () => {
    invokeMock.mockResolvedValueOnce(task());
    await createLibraryIndexTask();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("ai_task_acquire_library_index");
  });

  it("clamps progress and completes through native transitions", async () => {
    invokeMock.mockResolvedValue(task());
    await updateLibraryIndexTask("job-1", 2);
    await completeLibraryIndexTask("job-1");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_task_update_progress", { id: "job-1", progress: 1 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "ai_task_complete", { id: "job-1" });
  });

  it("filters task kinds and detects the latest startup-reclaimed run", async () => {
    const older = task({ id: "old", state: "cancelled", cancelRequested: true, error: "应用退出，未完成任务已回收", updatedAtMs: 2 });
    const latest = task({ id: "new", state: "cancelled", cancelRequested: true, error: "应用退出，未完成任务已回收", updatedAtMs: 4 });
    invokeMock.mockResolvedValue([older, task({ id: "other", kind: "embedding" }), latest]);
    const tasks = await listLibraryIndexTasks();
    expect(tasks).toHaveLength(2);
    expect(latestInterruptedLibraryIndexTask(tasks)?.id).toBe("new");
    expect(latestInterruptedLibraryIndexTask([...tasks, task({ id: "done", state: "completed", updatedAtMs: 5 })])).toBeUndefined();
  });
});
