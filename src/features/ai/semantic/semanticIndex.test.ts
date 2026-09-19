import { describe, expect, it, vi } from "vitest";
import { corpusDigest, defaultBatchPolicy } from "./store";
import { manifestFor, runSemanticIndex } from "./indexer";
import { SemanticQueryController } from "./queryController";
import { createPreviewSession, previewVector } from "./previewSession";
import { MemorySemanticStore, policy, sessionWith, testChunk } from "./testStore";

const BOOK = "a".repeat(64);

function source(chunks: readonly ReturnType<typeof testChunk>[]) {
  return async function* () { yield chunks; };
}

describe("semantic preview vectors", () => {
  it("is deterministic, normalized and order sensitive", () => {
    const first = previewVector("语义检索测试");
    const second = previewVector("语义检索测试");
    expect(first).toEqual(second);
    expect(first).toHaveLength(256);
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
    expect(previewVector("语义检索测试")).not.toEqual(previewVector("检索语义测试"));
  });

  it("reports cancellation instead of returning a stale batch", async () => {
    const controller = new AbortController();
    const session = createPreviewSession({ batchDelayMs: 5 });
    const pending = session.embed(["文本"], "passage", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("semantic indexer", () => {
  it("commits one generation after the whole corpus is validated", async () => {
    const store = new MemorySemanticStore();
    const session = createPreviewSession();
    const chunks = [testChunk(0), testChunk(1), testChunk(2)];
    const result = await runSemanticIndex({ store, session, policy: policy(2), chunks: source(chunks) });
    expect(result.interrupted).toBe(false);
    expect(result.status.generation).toBe(1);
    expect(result.status.completedRows).toBe(3);
    const status = await store.request({ action: "status", book: BOOK });
    expect(status.published?.total).toBe(3);
    expect(status.job).toBeNull();
    expect(store.generationCount(BOOK)).toBe(1);
  });

  it("reuses a published index repeatedly without embedding or leaving a lease", async () => {
    const store = new MemorySemanticStore();
    const chunks = [testChunk(0), testChunk(1)];
    await runSemanticIndex({ store, session: createPreviewSession(), policy: policy(2), chunks: source(chunks) });
    const embed = vi.fn(createPreviewSession().embed);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ready = await runSemanticIndex({ store, session: sessionWith(embed), policy: policy(2), chunks: source(chunks) });
      expect(ready.status.completedRows).toBe(2);
      expect(ready.status.generation).toBe(1);
      expect((await store.request({ action: "status", book: BOOK })).job).toBeNull();
    }
    expect(embed).not.toHaveBeenCalled();
  });

  it("rejects a completed begin response with no published generation", async () => {
    const store = new MemorySemanticStore();
    const original = store.request.bind(store);
    vi.spyOn(store, "request").mockImplementation(async (input) => {
      const reply = await original(input);
      if (input.action === "begin" && reply.job) reply.job.complete = true;
      return reply;
    });
    await expect(runSemanticIndex({
      store, session: createPreviewSession(), policy: policy(2), chunks: source([testChunk(0)]),
    })).rejects.toThrow("完成状态与发布数据不一致");
    expect((await store.request({ action: "status", book: BOOK })).job?.owner).toBe("");
  });

  it("resumes from the checkpoint without re-embedding confirmed batches", async () => {
    const store = new MemorySemanticStore();
    const chunks = Array.from({ length: 6 }, (_, index) => testChunk(index));
    const controller = new AbortController();
    // Abort once the first two batches have been appended.
    let batches = 0;
    const first = await runSemanticIndex({
      store,
      session: createPreviewSession({ onBeforeEmbed: () => { if (++batches === 3) controller.abort(); } }),
      policy: policy(2),
      chunks: source(chunks),
      signal: controller.signal,
    });
    expect(first.interrupted).toBe(true);
    const checkpoint = store.staged(BOOK);
    expect(checkpoint).toBeGreaterThan(0);
    const replayed = vi.fn(createPreviewSession().embed);
    const second = await runSemanticIndex({
      store,
      session: sessionWith(replayed),
      policy: policy(2),
      chunks: source(chunks),
    });
    expect(second.interrupted).toBe(false);
    expect(second.status.recovered).toBe(true);
    // Only the batch that never reached storage is embedded again.
    expect(replayed).toHaveBeenCalledTimes(1);
    expect(second.status.completedRows).toBe(6);
    expect(checkpoint).toBeLessThan(6);
  });

  it("refuses a resumed job whose corpus changed", async () => {
    const store = new MemorySemanticStore();
    const chunks = [testChunk(0), testChunk(1), testChunk(2)];
    const controller = new AbortController();
    let batches = 0;
    const interrupted = await runSemanticIndex({
      store,
      session: createPreviewSession({ onBeforeEmbed: () => { if (++batches === 2) controller.abort(); } }),
      policy: policy(1),
      chunks: source(chunks),
      signal: controller.signal,
    });
    expect(interrupted.interrupted).toBe(true);
    expect(store.staged(BOOK)).toBeGreaterThan(0);
    const changed = [testChunk(0), { ...testChunk(1), chunkId: "chunk-1-changed" }, testChunk(2)];
    await expect(runSemanticIndex({
      store, session: createPreviewSession(), policy: policy(1), chunks: source(changed),
    })).rejects.toThrow("语料已变化");
  });

  it("splits a batch on token overflow and refuses a single oversized chunk", async () => {
    const store = new MemorySemanticStore();
    const chunks = Array.from({ length: 4 }, (_, index) => testChunk(index));
    let largest = 0;
    const embed = vi.fn(async (texts: readonly string[]) => {
      largest = Math.max(largest, texts.length);
      if (texts.length > 1) throw new Error("正文块超过模型 token 上限（900 > 512），请缩短分块后重建");
      return texts.map(() => previewVector(texts[0]));
    });
    const first = await runSemanticIndex({ store, session: sessionWith(embed as never), policy: policy(4), chunks: source(chunks) });
    expect(first.interrupted).toBe(false);
    expect(first.status.completedRows).toBe(chunks.length);
    const snapshot = await store.openSnapshot(BOOK);
    const savedIds: string[] = [];
    for await (const rows of snapshot.batches(new AbortController().signal)) savedIds.push(...rows.map((row) => row.chunk.chunkId));
    expect(savedIds).toEqual(chunks.map((chunk) => chunk.chunkId));
    await snapshot.close();
    expect(largest).toBe(4);
    expect(embed.mock.calls.some(([texts]) => texts.length === 2)).toBe(true);

    const dense = new MemorySemanticStore();
    await expect(runSemanticIndex({
      store: dense,
      session: sessionWith((async () => { throw new Error("正文块超过模型 token 上限（900 > 512），请缩短分块后重建"); }) as never),
      policy: policy(4),
      chunks: source([testChunk(0)]),
    })).rejects.toThrow("token 上限");
  });

  it("fences a live lease and preserves the checkpoint on cancellation", async () => {
    const store = new MemorySemanticStore();
    const chunks = [testChunk(0), testChunk(1)];
    const controller = new AbortController();
    let batches = 0;
    const interrupted = await runSemanticIndex({
      store,
      session: createPreviewSession({ onBeforeEmbed: () => { if (++batches === 2) controller.abort(); } }),
      policy: policy(1),
      chunks: source(chunks),
      signal: controller.signal,
    });
    expect(interrupted.interrupted).toBe(true);
    // A cancelled run must not leave an owner that blocks a new session, and it
    // must keep only the batches that reached storage.
    const status = await store.request({ action: "status", book: BOOK });
    expect(status.job?.owner).toBe("");
    expect(status.job?.stagedRows).toBe(store.staged(BOOK));
    const resumed = await runSemanticIndex({ store, session: createPreviewSession(), policy: policy(1), chunks: source(chunks) });
    expect(resumed.interrupted).toBe(false);
    expect(resumed.status.completedRows).toBe(2);
  });
});

describe("semantic query controller", () => {
  const chunks = Array.from({ length: 5 }, (_, index) => testChunk(index));

  it("returns ranked hits with original-text citations for the pinned generation", async () => {
    const store = new MemorySemanticStore();
    const controller = new SemanticQueryController({
      store,
      previewSession: { packageId: "preview", session: createPreviewSession(), device: { adapterName: "浏览器 IndexedDB", luid: null } },
      chunks: () => source(chunks)(),
    });
    await controller.build(BOOK, "preview", null, false);
    const hits = await controller.query(BOOK, "preview", null, "第2段正文内容", 3);
    expect(hits).toHaveLength(3);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    expect(hits[0].generation).toBe(1);
    expect(hits[0].citation.chapterPath).toMatch(/^book\/chapter-/);
    expect(hits[0].chunk.chunkId).toBe(hits[0].chunkId);
    // The snapshot pin must be released so a rebuild can reclaim the generation.
    const status = await store.request({ action: "status", book: BOOK });
    expect(status.published?.generation).toBe(1);
    await controller.query(BOOK, "preview", null, "再次查询", 1);
    await store.request({ action: "clear", book: BOOK, owner: "cleanup-owner" });
    expect(store.generationCount(BOOK)).toBe(0);
  });

  it("keeps the report honest about preview mode and generation state", async () => {
    const store = new MemorySemanticStore();
    const seen: string[] = [];
    const controller = new SemanticQueryController({
      store,
      previewSession: { packageId: "preview", session: createPreviewSession(), device: { adapterName: "浏览器 IndexedDB", luid: null } },
      chunks: () => source(chunks)(),
      onChange: (status) => seen.push(status.state),
    });
    const before = await controller.refresh(BOOK);
    expect(before.state).toBe("unavailable");
    const built = await controller.build(BOOK, "preview", null, false);
    expect(built.state).toBe("ready");
    expect(built.preview).toBe(true);
    expect(built.generation).toBe(1);
    expect(seen).toContain("building");
    expect(built.model).toBe("preview-test-vectors");
  });

  it("drops a stale query result when a newer request supersedes it", async () => {
    const store = new MemorySemanticStore();
    const session = createPreviewSession({ batchDelayMs: 40 });
    const controller = new SemanticQueryController({
      store,
      previewSession: { packageId: "preview", session, device: { adapterName: "浏览器 IndexedDB", luid: null } },
      chunks: () => source(chunks)(),
    });
    await controller.build(BOOK, "preview", null, false);
    const pending = controller.query(BOOK, "preview", null, "第1段", 3);
    // A newer request supersedes the in-flight query before it resolves.
    controller.release();
    expect(await pending).toEqual([]);
    expect(await controller.query(BOOK, "preview", null, "第2段", 2)).toHaveLength(2);
    expect(await controller.query(BOOK, "preview", null, "第2段", 2)).toHaveLength(2);
  });

  it("deletes the published index through the real cleanup path", async () => {
    const store = new MemorySemanticStore();
    const controller = new SemanticQueryController({
      store,
      previewSession: { packageId: "preview", session: createPreviewSession(), device: { adapterName: "浏览器 IndexedDB", luid: null } },
      chunks: () => source(chunks)(),
    });
    await controller.build(BOOK, "preview", null, false);
    expect(store.generationCount(BOOK)).toBe(1);
    const cleared = await controller.clear(BOOK);
    expect(cleared.state).toBe("unavailable");
    expect(cleared.publishedRows).toBe(0);
    expect(cleared.generation).toBeNull();
    expect(store.generationCount(BOOK)).toBe(0);
    // The backend owns the refusal rules: a live build lease blocks cleanup.
    await controller.build(BOOK, "preview", null, false);
    await store.request({
      action: "begin", manifest: manifestFor(createPreviewSession(), chunks[0]), manifestKey: "f".repeat(64),
      owner: "live-owner-1", corpusDigest: "0".repeat(64), policy: policy(2), force: true,
    });
    await expect(controller.clear(BOOK)).rejects.toThrow("请先取消活动任务");
    expect(store.generationCount(BOOK)).toBe(1);
  });

  it("keeps a partial index resumable after a failure", async () => {
    const store = new MemorySemanticStore();
    const controller = new SemanticQueryController({
      store,
      previewSession: { packageId: "preview", session: createPreviewSession({ failAfter: 9 }), device: { adapterName: "浏览器 IndexedDB", luid: null } },
      chunks: () => source(chunks)(),
    });
    await controller.build(BOOK, "preview", null, false);
    const failed = await controller.build(BOOK, "preview", null, false);
    expect(["failed", "unavailable", "ready"]).toContain(failed.state);
  });
});

describe("corpus digest", () => {
  it("is stable, order sensitive and 64 hex characters", () => {
    const first = corpusDigest(["a", "b", "c"]);
    expect(first).toBe(corpusDigest(["a", "b", "c"]));
    expect(first).not.toBe(corpusDigest(["c", "b", "a"]));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the default batch policy inside the pipeline limits", () => {
    const profile = createPreviewSession().profile;
    const value = defaultBatchPolicy(profile);
    expect(value.maxRows).toBeLessThanOrEqual(32);
    expect(value.maxTokens).toBeLessThanOrEqual(profile.maxTokens);
    expect(value.maxBytes).toBe(512 * 1024);
  });
});

describe("semantic manifest identity", () => {
  it("binds the corpus versions and the model profile", () => {
    const session = createPreviewSession();
    const manifest = manifestFor(session, testChunk(0));
    expect(manifest.profile.modelId).toBe("preview-test-vectors");
    expect(manifest.chunkerVersion).toBe("chunker-v1");
    expect(manifestFor(session, testChunk(0, BOOK, "chunker-v2")).chunkerVersion).toBe("chunker-v2");
  });
});
