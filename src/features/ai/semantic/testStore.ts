import type { DocumentChunk } from "../../../core/chunking";
import { vi } from "vitest";
import type { SemanticSession } from "./contracts";
import { defaultBatchPolicy, type SemanticBatchPolicy, type SemanticReply, type SemanticRequest, type SemanticSnapshot, type SemanticStore } from "./store";
import { createPreviewSession, previewVector } from "./previewSession";
import { createSnapshot } from "./store";

interface Job {
  manifest: Record<string, unknown>;
  manifestKey: string;
  owner: string;
  leaseUntil: number;
  corpusDigest: string;
  policy: SemanticBatchPolicy;
  nextBatch: number;
  total: number;
  bytes: number;
  rows: { batch: number; ordinal: number; chunk: DocumentChunk; vector: readonly number[] }[];
}

/** Deterministic in-memory stand-in for the Rust store.  It mirrors the
 * fencing rules (lease, batch sequence, checkpoint, pinned generations) so the
 * indexer and query controller can be tested without IPC or IndexedDB. */
export class MemorySemanticStore implements SemanticStore {
  private jobs = new Map<string, Job>();
  private generations = new Map<string, { generation: number; manifest: Record<string, unknown>; manifestKey: string; total: number; rows: { ordinal: number; chunk: DocumentChunk; vector: readonly number[] }[] }[]>();
  private pins = new Map<string, Set<number>>();
  now = 1_000;
  failNext?: string;

  private leaseMs = 30_000;

  async request(input: SemanticRequest): Promise<SemanticReply> {
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = undefined;
      throw new Error(message);
    }
    const book = "book" in input ? input.book : input.manifest.bookFingerprint;
    const job = this.jobs.get(book);
    const all = this.generations.get(book) ?? [];
    const latest = all[all.length - 1];
    switch (input.action) {
      case "begin": {
        if (job && job.owner && job.leaseUntil > this.now) throw new Error("另一个会话正在为此书建立语义索引，请稍后继续");
        // Only a published generation can make a build a no-op; an unfinished
        // job must fall through so its checkpoint is resumed or reset.
        if (!job && latest && latest.manifestKey === input.manifestKey && !input.force) {
          return {
            ...this.reply(book, false),
            job: {
              owner: "", manifestKey: input.manifestKey, corpusDigest: input.corpusDigest,
              policy: input.policy, manifest: input.manifest, nextBatch: 0,
              stagedRows: 0, stagedBytes: 0, complete: true,
            },
          };
        }
        // Same identity, different corpus, unfinished checkpoint: refuse.
        // A paused job (empty owner) still owns a valid checkpoint.
        if (!input.force && job && job.manifestKey === input.manifestKey
          && JSON.stringify(job.policy) === JSON.stringify(input.policy)
          && job.corpusDigest !== input.corpusDigest && job.total > 0) {
          throw new Error("正文语料已变化，需要清理后重建语义索引");
        }
        const same = job && job.manifestKey === input.manifestKey && job.corpusDigest === input.corpusDigest
          && JSON.stringify(job.policy) === JSON.stringify(input.policy);
        // Any identity change or forced rebuild restarts the checkpoint; only
        // the exact same identity and corpus resumes it.
        if (!same || input.force) job?.rows.splice(0, job.rows.length);
        const next: Job = same && !input.force
          ? { ...job!, owner: input.owner, leaseUntil: this.now + this.leaseMs }
          : {
            manifest: input.manifest as unknown as Record<string, unknown>, manifestKey: input.manifestKey,
            owner: input.owner, leaseUntil: this.now + this.leaseMs, corpusDigest: input.corpusDigest,
            policy: input.policy, nextBatch: 0, total: 0, bytes: 0, rows: [],
          };
        void job;
        this.jobs.set(book, next);
        return this.reply(book, false);
      }
      case "append": {
        const current = this.owned(book, input.owner);
        if (input.sequence !== current.nextBatch) throw new Error("语义批次顺序或数量无效");
        for (const [index, row] of input.rows.entries()) {
          if (row.ordinal !== current.total + index) throw new Error("语义批次序号不连续");
          const dimensions = (current.manifest.profile as { dimensions: number }).dimensions;
          if (row.vector.length !== dimensions || row.vector.some((value) => !Number.isFinite(value))) {
            throw new Error("向量维度或数值无效");
          }
          current.rows.push({ batch: input.sequence, ordinal: row.ordinal, chunk: row.chunk, vector: row.vector });
        }
        current.nextBatch += 1;
        current.total += input.rows.length;
        return this.reply(book, false);
      }
      case "replay": {
        const current = this.owned(book, input.owner);
        if (input.sequence < 0 || input.sequence >= current.nextBatch) throw new Error("无效恢复批次");
        const saved = current.rows.filter((row) => row.batch === input.sequence).map((row) => JSON.stringify(row.chunk));
        const actual = input.chunks.map((chunk) => JSON.stringify(chunk));
        if (JSON.stringify(saved) !== JSON.stringify(actual)) throw new Error("恢复语料与 checkpoint 不一致，请清理后重建");
        return this.reply(book, false);
      }
      case "heartbeat": {
        const current = this.owned(book, input.owner);
        current.leaseUntil = this.now + this.leaseMs;
        return this.reply(book, false);
      }
      case "pause": {
        if (job && job.owner === input.owner) { job.owner = ""; job.leaseUntil = 0; }
        return this.reply(book, false);
      }
      case "commit": {
        const current = this.owned(book, input.owner);
        if (input.total <= 0 || input.total !== current.total || input.batches !== current.nextBatch) {
          throw new Error("语义索引未完整提交");
        }
        const generation = (latest?.generation ?? 0) + 1;
        all.push({
          generation, manifest: current.manifest, manifestKey: current.manifestKey, total: input.total,
          rows: current.rows.map((row) => ({ ordinal: row.ordinal, chunk: row.chunk, vector: row.vector })),
        });
        this.generations.set(book, all);
        this.jobs.delete(book);
        this.reclaim(book, generation);
        return this.reply(book, true);
      }
      case "status":
        return this.reply(book, false);
      case "openSnapshot": {
        if (!latest) throw new Error("此书尚未发布语义索引");
        const pins = this.pins.get(book) ?? new Set<number>();
        pins.add(latest.generation);
        this.pins.set(book, pins);
        return {
          ...this.reply(book, false),
          snapshot: { generation: latest.generation, manifest: latest.manifest as never, manifestKey: latest.manifestKey, total: latest.total, rows: [], done: false },
        };
      }
      case "readSnapshot": {
        if (!this.pins.get(book)?.has(input.generation)) throw new Error("快照未打开或已释放");
        const target = all.find((item) => item.generation === input.generation);
        if (!target) throw new Error("已发布代次不存在");
        const rows = target.rows.filter((row) => row.ordinal >= input.after).slice(0, input.limit)
          .map((row) => ({ ordinal: row.ordinal, chunk: row.chunk, vector: row.vector }));
        const last = rows[rows.length - 1];
        return {
          ...this.reply(book, false),
          snapshot: {
            generation: target.generation, manifest: target.manifest as never, manifestKey: target.manifestKey,
            total: target.total, rows, done: last ? last.ordinal + 1 >= target.total : input.after >= target.total,
          },
        };
      }
      case "closeSnapshot": {
        this.pins.get(book)?.delete(input.generation);
        const latestGeneration = all[all.length - 1]?.generation ?? 0;
        this.reclaim(book, latestGeneration);
        return this.reply(book, false);
      }
      case "clear": {
        if (job && job.owner && job.leaseUntil > this.now) throw new Error("请先取消活动任务并关闭查询后再清理");
        if (this.pins.get(book)?.size) throw new Error("请先取消活动任务并关闭查询后再清理");
        this.jobs.delete(book);
        this.generations.delete(book);
        return this.reply(book, false);
      }
    }
  }

  async openSnapshot(book: string): Promise<SemanticSnapshot> {
    const reply = await this.request({ action: "openSnapshot", book });
    if (!reply.snapshot) throw new Error("此书尚未发布语义索引");
    return createSnapshot(this, book, reply.snapshot);
  }

  /** Test helper: number of stored generations for one book. */
  generationCount(book: string): number {
    return this.generations.get(book)?.length ?? 0;
  }

  /** Test helper: staged rows at the current checkpoint. */
  staged(book: string): number {
    return this.jobs.get(book)?.total ?? 0;
  }

  private owned(book: string, owner: string): Job {
    const current = this.jobs.get(book);
    if (!current || current.owner !== owner || current.leaseUntil <= this.now) throw new Error("任务租约已失效或属于其他会话");
    return current;
  }

  private reclaim(book: string, keep: number): void {
    const all = this.generations.get(book) ?? [];
    const pins = this.pins.get(book) ?? new Set<number>();
    this.generations.set(book, all.filter((item) => item.generation >= keep || pins.has(item.generation)));
  }

  private reply(book: string, complete: boolean): SemanticReply {
    const job = this.jobs.get(book);
    const all = this.generations.get(book) ?? [];
    const latest = all[all.length - 1];
    return {
      schema: 6, supportedSchema: 6, componentVersion: 1, busyTimeoutMs: 5000,
      job: job ? {
        owner: job.owner, manifestKey: job.manifestKey, corpusDigest: job.corpusDigest,
        nextBatch: job.nextBatch, stagedRows: job.total, stagedBytes: job.bytes, complete,
        manifest: job.manifest as never, policy: job.policy,
      } : null,
      published: latest ? {
        generation: latest.generation, total: latest.total, manifestKey: latest.manifestKey,
        manifest: latest.manifest as never, publishedAtMs: this.now,
      } : null,
      generations: all.slice().reverse().map((item) => ({
        generation: item.generation, total: item.total, manifestKey: item.manifestKey,
        manifest: item.manifest as never, publishedAtMs: this.now,
      })),
      snapshot: null,
    };
  }
}

export function testChunk(index: number, bookFingerprint = "a".repeat(64), chunkerVersion = "chunker-v1"): DocumentChunk {
  const text = `第${index}段正文内容，用于语义索引测试。`;
  return {
    bookFingerprint, chunkId: `chunk-${index}`, chapterPath: `book/chapter-${index % 2}.xhtml`,
    chapterTitle: `第${index % 2 + 1}章`, spineIndex: index % 2, contentType: "body",
    originalText: text, normalizedText: text,
    textAnchor: { start: index * 10, end: index * 10 + text.length, snippet: text.slice(0, 32) },
    parserVersion: "parser-v1", normalizerVersion: "normalizer-v1", chunkerVersion,
    unitStart: index, unitEnd: index + 1,
  };
}

export function sessionWith(embed: SemanticSession["embed"]): SemanticSession {
  return { profile: createPreviewSession().profile, embed, close: vi.fn(async () => {}) };
}

export function previewProfile() {
  return createPreviewSession().profile;
}

export function policy(maxRows = 32): SemanticBatchPolicy {
  return { ...defaultBatchPolicy(previewProfile()), maxRows };
}

export { previewVector };
