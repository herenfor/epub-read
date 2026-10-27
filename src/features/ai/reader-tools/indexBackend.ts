import { readBookResourceText, iterateBookChunkBatches } from "../../../core/bookCorpusIndex";
import { createIndexBuildController } from "../indexing/indexController";
import { createTauriIndexStagingStore, listIndexedBooks } from "../indexing/indexStore";
import { indexStatusIsCurrent } from "../indexing/libraryIndexer";
import { updateLibraryIndexTask, completeLibraryIndexTask, failLibraryIndexTask, cancelLibraryIndexTask, type NativeIndexTask } from "../indexing/indexTaskStore";
import { getShelfStore } from "../../../ui/shelf";
import { ReaderToolError, type ReaderToolBackend, type ReaderIndexJob } from "./contracts";
import type { ReaderBookAccess } from "./bookAccess";

type Job = { view: ReaderIndexJob; bookId: string; abort: AbortController; done: Promise<void> };
/** Reuses the durable library-index lease and staging transaction. At most one
 * preparation owns a source; ordinary queries never start a library rebuild. */
export function createReaderIndexBackend(access: ReaderBookAccess, acquire: (contentHash: string) => Promise<NativeIndexTask>) {
  let latest: Job | undefined;
  let disposed = false;
  const indexStatus: NonNullable<ReaderToolBackend["indexStatus"]> = async (books, signal) => {
    const statuses = new Map((await listIndexedBooks()).map(status => [status.contentHash, status]));
    signal.throwIfAborted();
    return books.map(book => {
      const status = statuses.get(book.contentHash ?? book.bookId);
      const current = indexStatusIsCurrent(status);
      return { bookId: book.bookId, state: current ? "current" as const : !book.available ? "unavailable" as const : status ? "outdated" as const : "missing" as const,
        chunkCount: current ? status!.chunkCount : 0,
        ...(latest?.bookId === book.bookId ? { job: { ...latest.view } } : {}) };
    });
  };
  const prepareIndex: NonNullable<ReaderToolBackend["prepareIndex"]> = async (bookId, signal) => {
    if (disposed) throw new ReaderToolError("READER_DISCONNECTED", "阅读工具提供方已断开", true);
    if (latest && ["running", "queued"].includes(latest.view.state)) {
      if (latest.bookId === bookId) return { ...latest.view, bookId, reused: true };
      throw new ReaderToolError("INDEX_BUSY", "另一本书正在准备索引，请稍后重试", true);
    }
    const entry = (await getShelfStore().list()).find(entry => entry.id === bookId);
    signal.throwIfAborted();
    if (!entry?.contentHash) throw new ReaderToolError("INDEX_UNAVAILABLE", "此书尚无可用于持久索引的内容身份");
    const current = (await listIndexedBooks()).find(status => status.contentHash === entry.contentHash);
    signal.throwIfAborted();
    if (indexStatusIsCurrent(current)) return { bookId, taskId: null, state: "completed", progress: 1, reused: true };
    let task;
    try { task = await acquire(entry.contentHash); }
    catch { throw new ReaderToolError("INDEX_BUSY", "书库索引任务已被占用或暂不可用，请稍后重试", true); }
    if (disposed || signal.aborted) {
      await cancelLibraryIndexTask(task.id).catch(() => {});
      throw new ReaderToolError("CANCELLED", "调用已取消");
    }
    const abort = new AbortController();
    const job: Job = { bookId, abort, done: Promise.resolve(), view: { taskId: task.id, state: "running", progress: 0 } };
    latest = job;
    const forward = () => abort.abort();
    signal.addEventListener("abort", forward, { once: true });
    if (signal.aborted || disposed) abort.abort();
    job.done = (async () => {
      let updates = Promise.resolve();
      let lastChapter = -1;
      try {
        await access(bookId, abort.signal, async book => {
          if (book.fixedLayout) throw new ReaderToolError("INDEX_UNAVAILABLE", "固定版式暂不提供正文索引");
          const controller = createIndexBuildController({
            metadata: { contentHash: entry.contentHash!, title: entry.title, creator: entry.creator, language: entry.language },
            store: createTauriIndexStagingStore(), signal: abort.signal,
            totalChapters: Math.max(1, book.spine.filter(spine => spine.linear).length),
            chapterProducer: async function* (buildSignal) {
              for await (const batch of iterateBookChunkBatches(book, { bookFingerprint: entry.contentHash!, signal: buildSignal,
                textFor: path => readBookResourceText(book, path, buildSignal) })) {
                const resource = book.resources.get(batch.chapterPath);
                if (resource) { resource.data = new Uint8Array(0); resource.loaded = false; }
                yield batch.chunks;
              }
            },
            yieldToReader: () => new Promise(resolve => setTimeout(resolve, 0)),
            onProgress: progress => {
              job.view.progress = progress.fraction;
              if (progress.completedChapters === lastChapter) return;
              lastChapter = progress.completedChapters;
              updates = updates.then(() => updateLibraryIndexTask(task.id, progress.fraction)).then(() => undefined);
              // Keep failures observed even while parsing continues.
              void updates.catch(() => abort.abort());
            },
          });
          const result = await controller.run();
          if (result.skipped) throw new ReaderToolError("INDEX_EMPTY", "此书未提取到可索引正文");
        });
        await updates;
        abort.signal.throwIfAborted();
        await completeLibraryIndexTask(task.id);
        job.view = { taskId: task.id, state: "completed", progress: 1 };
      } catch {
        await updates.catch(() => {});
        const cancelled = abort.signal.aborted;
        await (cancelled ? cancelLibraryIndexTask(task.id) : failLibraryIndexTask(task.id, "reader-index-failed")).catch(() => {});
        job.view = { ...job.view, state: cancelled ? "cancelled" : "failed" };
      } finally { signal.removeEventListener("abort", forward); }
    })();
    // This is an explicit background cache task. HTTP completion does not cancel
    // it; cancel_index or provider shutdown does. The durable status survives exit.
    signal.removeEventListener("abort", forward);
    return { ...job.view, bookId, reused: false };
  };
  const cancelIndex: NonNullable<ReaderToolBackend["cancelIndex"]> = async (bookId, taskId, signal) => {
    signal.throwIfAborted();
    if (!latest || latest.bookId !== bookId || latest.view.taskId !== taskId) throw new ReaderToolError("TASK_NOT_FOUND", "此书没有指定的准备任务");
    latest.abort.abort();
    await latest.done;
    return { ...latest.view, bookId };
  };
  return { indexStatus, prepareIndex, cancelIndex, async dispose() { disposed = true; latest?.abort.abort(); await latest?.done; } };
}
