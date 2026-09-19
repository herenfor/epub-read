import { describe, it, expect, vi } from "vitest";
import type { DocumentChunk } from "../../../core/chunking";
import { manifestKey, profileKey, type SemanticManifest, type SemanticSession, type PublishedSnapshot } from "./contracts";
import { normalizeVector, poolTokens, ExactTopK } from "./vectors";
import { SemanticSessionCoordinator } from "./session";
import { embedBatch, searchSnapshot } from "./pipeline";
const manifest: SemanticManifest = {
  componentVersion: 1, bookFingerprint: "a".repeat(64), parserVersion: "p1", normalizerVersion: "n1", chunkerVersion: "c1",
  profile: { modelId: "test-only", modelDigest: "b".repeat(64), tokenizerDigest: "c".repeat(64), runtimeVersion: "test1",
    dimensions: 2, maxTokens: 512, pooling: "cls", normalization: "l2", queryPrefix: "query:", passagePrefix: "" },
};
function chunk(id: string): DocumentChunk {
  return { bookFingerprint: manifest.bookFingerprint, chunkId: id, chapterPath: "ch.xhtml", chapterTitle: "章",
    spineIndex: 0, contentType: "mixed", originalText: "测试正文", normalizedText: "测试正文", textAnchor: { start: 7, end: 11, snippet: "测试正文" },
    parserVersion: "p1", normalizerVersion: "n1", chunkerVersion: "c1", unitStart: 0, unitEnd: 1 };
}
function session(): SemanticSession {
  return { profile: { ...manifest.profile }, embed: vi.fn(async texts => texts.map(() => [1, 0])), close: vi.fn(async () => {}) };
}
function snapshot(): PublishedSnapshot {
  return { manifest, generation: 1, total: 3, close: vi.fn(async () => {}),
    async *batches() { yield [
      { ordinal: 0, chunk: chunk("first"), vector: [0, 1] },
      { ordinal: 1, chunk: chunk("second"), vector: [1, 0] },
      { ordinal: 2, chunk: chunk("third"), vector: [1, 0] },
    ]; },
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
const signal = () => new AbortController().signal;
describe("semantic identity and vectors", () => {
  it("invalidates tokenizer, query prefix and corpus changes", () => {
    expect(profileKey(manifest.profile)).not.toBe(profileKey({ ...manifest.profile, queryPrefix: "new:" }));
    expect(profileKey(manifest.profile)).not.toBe(profileKey({ ...manifest.profile, tokenizerDigest: "d".repeat(64) }));
    expect(manifestKey(manifest)).not.toBe(manifestKey({ ...manifest, chunkerVersion: "c2" }));
    expect(() => profileKey({ ...manifest.profile, modelDigest: "mock-v1" })).toThrow();
  });
  it("normalizes extreme finite values and rejects zero/nonfinite/wrong dimensions", () => {
    expect(normalizeVector([1e300, 1e300], 2)[0]).toBeCloseTo(Math.SQRT1_2);
    expect(normalizeVector([1e-300, 0], 2)).toEqual([1, 0]);
    for (const vector of [[0, 0], [NaN, 0], [1], [Infinity, 0]]) expect(() => normalizeVector(vector, 2)).toThrow();
  });
  it("excludes padding from mean and applies CLS deliberately", () => {
    expect(poolTokens([3, 0, 0, 3, 999, 999], [1, 1, 0], 2, "mean")[0]).toBeCloseTo(Math.SQRT1_2);
    expect(poolTokens([3, 0, 0, 3], [1, 1], 2, "cls")).toEqual([1, 0]);
    expect(() => poolTokens([3, 0], [0], 2, "mean")).toThrow();
    expect(() => poolTokens([3, 0], [0], 2, "cls")).toThrow();
  });
  it("bounds Top-K and uses ordinal to break ties", () => {
    const top = new ExactTopK<string>(2);
    for (const ordinal of [3, 2, 1, 0]) top.add({ ordinal, score: 0.5, value: String(ordinal) });
    expect(top.results().map(x => x.ordinal)).toEqual([0, 1]);
    expect(() => new ExactTopK(0)).toThrow();
  });
});
describe("semantic session ownership", () => {
  it("retains admission after cancellation until native work and close settle", async () => {
    const coordinator = new SemanticSessionCoordinator(); const controller = new AbortController();
    const work = deferred<number>(); const closed = deferred<void>(); const entered = deferred<void>(); const s = session();
    s.close = vi.fn(() => closed.promise);
    const running = coordinator.run(async () => s, controller.signal, () => { entered.resolve(); return work.promise; });
    const rejected = expect(running).rejects.toMatchObject({ code: "aborted" });
    await entered.promise; controller.abort();
    await expect(coordinator.run(async () => session(), signal(), async () => 2)).rejects.toThrow("占用");
    work.resolve(1); await Promise.resolve(); await Promise.resolve();
    expect(coordinator.status).toBe("active"); closed.resolve(); await rejected;
    expect(coordinator.status).toBe("idle"); expect(s.close).toHaveBeenCalledTimes(1);
  });
  it("cleans up a late open after abort without executing work", async () => {
    const coordinator = new SemanticSessionCoordinator(); const controller = new AbortController();
    const opened = deferred<SemanticSession>(); const operation = vi.fn(); const s = session();
    const running = coordinator.run(() => opened.promise, controller.signal, operation);
    const rejected = expect(running).rejects.toMatchObject({ code: "aborted" });
    controller.abort(); opened.resolve(s); await rejected;
    expect(operation).not.toHaveBeenCalled(); expect(s.close).toHaveBeenCalledOnce();
  });
  it("fails closed when native disposal is unconfirmed", async () => {
    const coordinator = new SemanticSessionCoordinator(); const s = session(); s.close = async () => { throw new Error("release failed"); };
    await expect(coordinator.run(async () => s, signal(), async () => 1)).rejects.toThrow("release failed");
    expect(coordinator.status).toBe("faulted");
    await expect(coordinator.run(async () => session(), signal(), async () => 2)).rejects.toThrow();
  });
});
describe("semantic batch and published query", () => {
  it("validates the whole batch and uses passage purpose", async () => {
    const s = session(); const rows = await embedBatch(manifest, s, [chunk("a")], 0, signal());
    expect(rows[0].vector).toEqual([1, 0]); expect(s.embed).toHaveBeenCalledWith(["测试正文"], "passage", expect.any(AbortSignal));
    await expect(embedBatch(manifest, s, [chunk("a"), chunk("a")], 0, signal())).rejects.toThrow("重复");
    await expect(embedBatch(manifest, s, [{ ...chunk("a"), bookFingerprint: "d".repeat(64) }], 0, signal())).rejects.toThrow("不一致");
  });
  it("rejects malformed model output and late cancelled batches", async () => {
    const s = session(); s.embed = async () => [[0, 0]];
    await expect(embedBatch(manifest, s, [chunk("a")], 0, signal())).rejects.toThrow("零向量");
    const controller = new AbortController(); s.embed = async () => { controller.abort(); return [[1, 0]]; };
    await expect(embedBatch(manifest, s, [chunk("a")], 0, controller.signal)).rejects.toMatchObject({ code: "aborted" });
  });
  it("returns stable exact scores with existing original-text anchors", async () => {
    const snap = snapshot(); const s = session(); const hits = await searchSnapshot(snap, s, "问题", 2, signal());
    expect(hits.map(x => x.chunkId)).toEqual(["second", "third"]);
    expect(hits[0]).toMatchObject({ score: 1, generation: 1, citation: { textOffset: 7, chapterPath: "ch.xhtml" } });
    expect(s.embed).toHaveBeenCalledWith(["问题"], "query", expect.any(AbortSignal));
    expect(snap.close).toHaveBeenCalledOnce(); expect(s.close).not.toHaveBeenCalled();
  });
  it("rejects incompatible model before querying and still releases snapshot", async () => {
    const snap = snapshot(); const s = session(); s.profile.queryPrefix = "changed";
    await expect(searchSnapshot(snap, s, "问题", 2, signal())).rejects.toThrow("不兼容");
    expect(s.embed).not.toHaveBeenCalled(); expect(snap.close).toHaveBeenCalledOnce();
  });
  it("rejects missing/duplicate rows rather than returning partial hits", async () => {
    const snap = snapshot(); snap.batches = async function* () { yield [{ ordinal: 1, chunk: chunk("a"), vector: [1, 0] }]; };
    await expect(searchSnapshot(snap, session(), "问题", 2, signal())).rejects.toThrow("序号");
    expect(snap.close).toHaveBeenCalledOnce();
  });
  it("rejects changed generation and cancellation after stream completion", async () => {
    const snap = snapshot(); const batches = snap.batches;
    snap.batches = async function* (s) { yield* batches(s); Object.assign(snap, { generation: 2 }); };
    await expect(searchSnapshot(snap, session(), "问题", 2, signal())).rejects.toThrow("快照");
    const snap2 = snapshot(); const batches2 = snap2.batches; const controller = new AbortController();
    snap2.batches = async function* (s) { yield* batches2(s); controller.abort(); };
    await expect(searchSnapshot(snap2, session(), "问题", 2, controller.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(snap2.close).toHaveBeenCalledOnce();
  });
});
