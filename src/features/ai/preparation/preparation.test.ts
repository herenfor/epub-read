import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../registry/mockProvider";
import { MOCK_PROBE, mockIndexManifest, type PreparationReply, type PreparationRequest, type PreparationStore } from "./contracts";
import { ResourceGovernor } from "./resourceGovernor";
import { withMockEmbedding } from "./embeddingSession";
import { runMockIndex } from "./mockIndexer";
import type { DocumentChunk } from "../../../core/chunking";
import { preparationCitation } from "./citation";
import { createNativePreparationStore } from "./nativeStore";
import { clearAppBuildSession, setAppBuildSession } from "../../../config/appBuildSession";

const hash = "a".repeat(64);
function chunk(i: number): DocumentChunk {
  const m = mockIndexManifest(hash);
  return { bookFingerprint: hash, chunkId: `c-${i}`, chapterPath: "Text/a.xhtml", chapterTitle: "章", spineIndex: 0,
    contentType: "paragraph", originalText: `正文😀${i}`, normalizedText: `正文😀${i}`, textAnchor: { start: i * 5, end: i * 5 + 5, snippet: `正文😀${i}` },
    parserVersion: m.parserVersion, normalizerVersion: m.normalizerVersion, chunkerVersion: m.chunkerVersion, unitStart: i, unitEnd: i + 1 };
}
async function* chunks() { yield Array.from({ length: 70 }, (_, i) => chunk(i)); }
/** Protocol spy: native atomicity/leases/replay validation are tested against real SQLite in Rust. */
function protocol() {
  const calls: PreparationRequest[] = [];
  let status: PreparationReply["status"] = { nextBatch: 0, stagedChunks: 0, publishedChunks: 0, complete: false, sqliteVersion: "test", databaseSchema: 6, supportedDatabaseSchema: 6, componentVersion: 1, busyTimeoutMs: 5000 };
  const store: PreparationStore = { request: vi.fn(async (input) => {
    calls.push(input);
    if (input.action === "append") status = { ...status, nextBatch: status.nextBatch + 1, stagedChunks: status.stagedChunks + input.rows.length };
    if (input.action === "commit") status = { ...status, publishedChunks: input.total, complete: true };
    return { status, citations: [] };
  }) };
  return { store, calls };
}
afterEach(() => { vi.useRealTimers(); clearAppBuildSession(); });

describe("mock resource admission", () => {
  it("rejects unknown budgets and native backends without silently selecting CPU", () => {
    expect(() => new ResourceGovernor({ ...MOCK_PROBE, memoryBudgetBytes: null }).acquire(1)).toThrow("预算");
    expect(() => new ResourceGovernor({ ...MOCK_PROBE, source: "native" }).acquire(1)).toThrow("mock");
    expect(() => new ResourceGovernor(MOCK_PROBE).acquire(Infinity)).toThrow("预算");
  });
  it("allows one session, cancels queued work, and releases idempotently", async () => {
    const governor = new ResourceGovernor(MOCK_PROBE);
    const release = await governor.acquire(100);
    const cancel = new AbortController();
    const waiting = governor.acquire(100, cancel.signal);
    const failure = expect(waiting).rejects.toMatchObject({ code: "aborted" });
    cancel.abort(); await failure;
    expect(governor.snapshot).toMatchObject({ active: true, waiting: 0, reservedBytes: 100 });
    release(); release();
    expect(governor.snapshot).toMatchObject({ active: false, reservedBytes: 0 });
  });
  it("lets reading block admission and batch work without polling or sleeps", async () => {
    const governor = new ResourceGovernor(MOCK_PROBE); governor.setReadingBusy(true);
    const granted = vi.fn(); const run = governor.acquire(100).then((release) => { granted(); release(); });
    expect(granted).not.toHaveBeenCalled(); governor.setReadingBusy(false); await run;
    governor.setReadingBusy(true);
    const abort = new AbortController(); const ready = governor.waitUntilRunnable(abort.signal);
    const rejected = expect(ready).rejects.toMatchObject({ code: "aborted" }); abort.abort(); await rejected;
    governor.setReadingBusy(false);
  });
});
describe("mock session ownership", () => {
  it("disposes after failure and returns all reservations", async () => {
    const provider = createMockProvider(); const governor = new ResourceGovernor(MOCK_PROBE);
    await expect(withMockEmbedding(governor, new AbortController().signal, async () => { throw new Error("OOM"); }, () => provider)).rejects.toThrow("OOM");
    expect(provider.stats.dispose).toBe(1); expect(governor.snapshot.reservedBytes).toBe(0);
  });
  it("rejects malformed vectors and never forwards them to persistence", async () => {
    const provider = createMockProvider(); provider.embed = async () => ({ modelId: "mock-model", dimensions: 8, vectors: [[NaN]] });
    const governor = new ResourceGovernor(MOCK_PROBE);
    await expect(withMockEmbedding(governor, new AbortController().signal, (embed) => embed(["x"]), () => provider)).rejects.toThrow("不兼容");
    expect(governor.snapshot.reservedBytes).toBe(0);
  });
  it("bounds an unresponsive request and ignores its late result", async () => {
    vi.useFakeTimers(); const provider = createMockProvider(); const governor = new ResourceGovernor(MOCK_PROBE);
    let finish!: (value: Awaited<ReturnType<typeof provider.embed>>) => void;
    provider.embed = () => new Promise((resolve) => { finish = resolve; });
    const done = vi.fn();
    const work = withMockEmbedding(governor, new AbortController().signal, async (embed) => { await embed(["x"]); done(); }, () => provider, 100);
    const failed = expect(work).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(101); await failed;
    finish({ modelId: "mock-model", dimensions: 8, vectors: [Array(8).fill(0)] });
    await Promise.resolve(); expect(done).not.toHaveBeenCalled(); expect(governor.snapshot.reservedBytes).toBe(0);
  });
  it("bounds disposal and does not strand the next admitted session", async () => {
    vi.useFakeTimers(); const provider = createMockProvider(); provider.dispose = () => new Promise(() => {});
    const governor = new ResourceGovernor(MOCK_PROBE);
    const task = withMockEmbedding(governor, new AbortController().signal, async () => {}, () => provider, 100);
    const failed = expect(task).rejects.toThrow("释放超时"); await vi.advanceTimersByTimeAsync(101); await failed;
    const release = await governor.acquire(100); release(); expect(governor.snapshot.active).toBe(false);
  });
});
describe("resumable mock index orchestration", () => {
  it("cancels after one persisted batch then replays the prefix without embedding it again", async () => {
    const { store, calls } = protocol(); const governor = new ResourceGovernor(MOCK_PROBE); const abort = new AbortController();
    await expect(runMockIndex({ store, governor, manifest: mockIndexManifest(hash), chunks, signal: abort.signal,
      onProgress: () => abort.abort() })).rejects.toMatchObject({ code: "aborted" });
    expect(calls.map((c) => c.action)).toEqual(["begin", "append", "pause"]);
    const provider = createMockProvider();
    const result = await runMockIndex({ store, governor, manifest: mockIndexManifest(hash), chunks, createProvider: () => provider });
    expect(result.publishedChunks).toBe(70); expect(provider.stats.embed).toBe(2); expect(provider.stats.dispose).toBe(1);
    expect(calls.filter((c) => c.action === "replay")).toHaveLength(1);
    expect(calls.filter((c) => c.action === "append").map((c) => c.rows.length)).toEqual([32, 32, 6]);
    expect(governor.snapshot.reservedBytes).toBe(0);
  });
  it("preserves the checkpoint on OOM and never publishes a partial book", async () => {
    const { store, calls } = protocol(); const provider = createMockProvider(); const embed = provider.embed.bind(provider); let n = 0;
    provider.embed = async (...args) => { if (++n === 2) throw new Error("OOM"); return embed(...args); };
    const governor = new ResourceGovernor(MOCK_PROBE);
    await expect(runMockIndex({ store, governor, manifest: mockIndexManifest(hash), chunks, createProvider: () => provider })).rejects.toThrow("OOM");
    expect(calls.map((c) => c.action)).toEqual(["begin", "append", "pause"]); expect(governor.snapshot.reservedBytes).toBe(0);
  });
  it("does not read EPUB or construct a provider when a complete matching index exists", async () => {
    const { store } = protocol(); const governor = new ResourceGovernor(MOCK_PROBE);
    await runMockIndex({ store, governor, manifest: mockIndexManifest(hash), chunks });
    const produce = vi.fn(chunks); const factory = vi.fn(createMockProvider);
    await runMockIndex({ store, governor, manifest: mockIndexManifest(hash), chunks: produce, createProvider: factory });
    expect(produce).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });
  it("rejects a source with changed parser versions before storing it", async () => {
    const { store, calls } = protocol();
    await expect(runMockIndex({ store, governor: new ResourceGovernor(MOCK_PROBE), manifest: mockIndexManifest(hash),
      chunks: async function* () { yield [{ ...chunk(0), parserVersion: "changed" }]; } })).rejects.toThrow("不一致");
    expect(calls.map((c) => c.action)).toEqual(["begin", "pause"]);
  });
  it("uses the original code-point anchor for reader navigation", () => {
    const original = chunk(9); const result = preparationCitation(original);
    expect(result.textOffset).toBe(45); expect(result.textSnippet).toBe(original.textAnchor.snippet);
    expect(result.spineIndex).toBe(original.spineIndex); expect(result.chapterPath).toBe(original.chapterPath);
  });
  it("rejects Core, browser and release use before invoking native storage", async () => {
    const store = createNativePreparationStore();
    for (const edition of ["core", "ai"] as const) {
      setAppBuildSession({ source: "browser", edition, debug: true });
      await expect(store.request({ action: "status", book: hash })).rejects.toThrow("桌面调试");
    }
    for (const edition of ["core", "ai"] as const) {
      setAppBuildSession({ source: "desktop", buildInfo: { edition, debug: false, version: "test", protocolVersion: 1, target: "test", profile: "release" } });
      await expect(store.request({ action: "status", book: hash })).rejects.toThrow("桌面调试");
    }
  });
});
