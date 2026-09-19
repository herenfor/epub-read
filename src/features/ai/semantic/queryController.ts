import { throwIfAborted } from "../contracts/provider";
import { searchSnapshot } from "./pipeline";
import { SemanticSessionCoordinator } from "./session";
import type { EmbeddingProfile, SemanticSession } from "./contracts";
import { defaultBatchPolicy, type SemanticJobState, type SemanticSnapshot, type SemanticStore } from "./store";
import { manifestFor, runSemanticIndex, type SemanticIndexProgress } from "./indexer";
import type { DocumentChunk } from "../../../core/chunking";
import { embeddingErrorMessage, openSemanticSession } from "./nativeSession";

export type SemanticQueryState = "idle" | "checking" | "unavailable" | "building" | "ready" | "failed";

export interface SemanticHit {
  chunkId: string;
  score: number;
  generation: number;
  /** Stored chunk identity, reused for navigation and citations. */
  chunk: DocumentChunk;
  citation: { chapterPath: string; chapterTitle: string; textOffset: number; snippet: string; spineIndex: number };
}

export interface SemanticQueryStatus {
  state: SemanticQueryState;
  /** Human-readable reason, always shown next to the state. */
  message: string;
  model: string | null;
  device: string | null;
  generation: number | null;
  publishedRows: number;
  stagedRows: number;
  checkpointBatch: number;
  /** True when a build can resume from a checkpoint instead of restarting. */
  resumable: boolean;
  /** Clear boundary: this session is a preview, not a verified Windows run. */
  preview: boolean;
}

export interface SemanticQueryOptions {
  store: SemanticStore;
  /** One book at a time; called whenever the corpus or book changes. */
  chunks(book: string, signal: AbortSignal, profile: EmbeddingProfile): AsyncIterable<readonly DocumentChunk[]>;
  /** Test seam; production uses the native Windows gateway. */
  openSession?(packageId: string, deviceLuid?: string | null): Promise<{ session: SemanticSession; device: { adapterName: string | null; luid: string | null } }>;
  /** Browser preview session factory, selected by the caller. */
  previewSession?: { packageId: string; session: SemanticSession; device: { adapterName: string | null; luid: string | null } };
  yieldToReader?(): Promise<void>;
  /** Reading takes priority: batches wait while the reader is busy. */
  isReadingBusy?(): boolean;
  onChange?(status: SemanticQueryStatus): void;
}

const INITIAL: SemanticQueryStatus = {
  state: "idle", message: "", model: null, device: null, generation: null,
  publishedRows: 0, stagedRows: 0, checkpointBatch: 0, resumable: false, preview: false,
};

/** One query at a time per panel. Cancellation and book switches are fenced by
 * a request generation, so a late native result can never overwrite newer UI. */
export class SemanticQueryController {
  private status: SemanticQueryStatus = { ...INITIAL };
  private generation = 0;
  private controller: AbortController | null = null;
  private busy = false;
  private readonly sessions = new SemanticSessionCoordinator();

  constructor(private readonly options: SemanticQueryOptions) {}

  get current(): SemanticQueryStatus {
    return { ...this.status };
  }

  /** Version-aware release: only dispose state that belongs to this instance.
   * The generation advances first so a late native result can never overwrite
   * newer UI, and the abort reason stays a cancellation, not a failure. */
  release(): void {
    this.generation++;
    this.controller?.abort(abortReason());
    this.controller = null;
  }

  async refresh(book: string): Promise<SemanticQueryStatus> {
    const token = ++this.generation;
    this.patch({ state: "checking", message: "正在检查此书的语义索引…" });
    try {
      const reply = await this.options.store.request({ action: "status", book });
      if (token !== this.generation) return this.current;
      const job = reply.job;
      const published = reply.published;
      const resumable = Boolean(job && !job.complete && job.nextBatch > 0);
      this.patch({
        state: published ? "ready" : "unavailable",
        message: published
          ? `已发布第 ${published.generation} 代，共 ${published.total} 段`
          : job
            ? "存在未完成的建库检查点"
            : "此书尚未建立语义索引",
        model: published?.manifest.profile.modelId ?? job?.manifest?.profile.modelId ?? this.status.model,
        generation: published?.generation ?? null,
        publishedRows: published?.total ?? 0,
        stagedRows: job?.stagedRows ?? 0,
        checkpointBatch: job?.nextBatch ?? 0,
        resumable,
      });
      return this.current;
    } catch (error) {
      if (token === this.generation) this.fail(error);
      return this.current;
    }
  }

  cancel(): void {
    this.generation++;
    this.controller?.abort(abortReason());
    this.controller = null;
  }

  /** Builds or resumes the index for one book. Never runs in the background. */
  async build(book: string, packageId: string, deviceLuid: string | null, force: boolean): Promise<SemanticQueryStatus> {
    if (this.busy) return this.current;
    const token = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    const isPreview = Boolean(this.options.previewSession);
    this.patch({ state: "building", message: force ? "正在重建语义索引…" : "正在建立语义索引…", preview: isPreview });
    try {
      const result = await this.sessions.run(
        () => this.acquire(packageId, deviceLuid, isPreview, controller.signal),
        controller.signal,
        async (session) => {
          this.patch({ model: session.profile.modelId, preview: isPreview });
          return runSemanticIndex({
            store: this.options.store,
            session,
            policy: defaultBatchPolicy(session.profile),
            chunks: (session, signal) => this.options.chunks(book, signal, session.profile),
            force,
            signal: controller.signal,
            yieldToReader: async () => {
              // Yield between batches and let an active reading session run first.
              await this.options.yieldToReader?.();
              for (let waited = 0; this.options.isReadingBusy?.() && waited < 40; waited++) {
                await new Promise((resolve) => setTimeout(resolve, 250));
              }
            },
            onProgress: (progress) => {
              if (token === this.generation) this.patch(progressStatus(progress, isPreview, this.status));
            },
          });
        },
      );
      if (token !== this.generation) return this.current;
      if (!result.interrupted && result.status.completedRows <= 0) {
        // A build that stages nothing must never read as success: without this
        // the panel reported `generation ?? 1` and hid a backend refusal.
        throw new Error("建库没有产生任何段落：正文块为空或存储拒绝了该批次");
      }
      if (result.interrupted) {
        this.patch({
          state: result.status.completedRows > 0 ? "ready" : "unavailable",
          message: "建库已取消，已保留可恢复检查点",
          stagedRows: result.status.stagedRows,
          checkpointBatch: result.status.nextBatch,
          resumable: result.status.stagedRows > 0,
        });
      } else {
        this.patch({
          state: "ready",
          message: `建库完成，已发布第 ${result.status.generation ?? "?"} 代，共 ${result.status.completedRows} 段`,
          generation: result.status.generation,
          publishedRows: result.status.completedRows,
          stagedRows: 0,
          checkpointBatch: result.status.nextBatch,
          resumable: false,
        });
      }
      return this.current;
    } catch (error) {
      if (token === this.generation) this.fail(error);
      return this.current;
    } finally {
      this.busy = false;
      if (this.controller === controller) this.controller = null;
    }
  }

  /** Deletes this book's semantic rows. The backend refuses while a build owns
   * the lease or a query still pins a generation, so the UI must surface that
   * instead of claiming a cleanup that did not happen. */
  async clear(book: string): Promise<SemanticQueryStatus> {
    const token = ++this.generation;
    this.controller?.abort(abortReason());
    this.controller = null;
    this.patch({ state: "checking", message: "正在清理本书语义索引…" });
    try {
      await this.options.store.request({ action: "clear", book, owner: `cleanup-${crypto.randomUUID()}` });
      if (token !== this.generation) return this.current;
      this.patch({
        state: "unavailable",
        message: "本书语义索引已删除；全文搜索、模型文件和书签未受影响。",
        generation: null,
        publishedRows: 0,
        stagedRows: 0,
        checkpointBatch: 0,
        resumable: false,
      });
      return this.current;
    } catch (error) {
      if (token === this.generation) this.fail(error);
      throw error;
    }
  }

  /** Query one book. The session is always closed by the caller-facing path.
   * A cancelled request returns no hits; every other failure propagates. */
  async query(book: string, packageId: string, deviceLuid: string | null, question: string, k: number): Promise<readonly SemanticHit[]> {
    if (this.busy) throw new Error("已有任务在进行，请等待或取消");
    const token = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    const cancelled = () => token !== this.generation;
    const isPreview = Boolean(this.options.previewSession);
    try {
      const signal = controller.signal;
      throwIfAborted(signal);
      return await this.sessions.run(
        () => this.acquire(packageId, deviceLuid, isPreview, signal),
        signal,
        async (session) => {
          // The coordinator owns the session even if opening the snapshot fails.
          const snapshot: SemanticSnapshot = await this.options.store.openSnapshot(book);
          const hits = await searchSnapshot(snapshot, session, question, k, signal);
          if (token !== this.generation) return [];
          return hits.map((hit) => ({
            chunkId: hit.chunkId,
            score: hit.score,
            generation: snapshot.generation,
            chunk: chunkFromCitation(hit.chunkId, hit.citation, snapshot),
            citation: hit.citation as SemanticHit["citation"],
          }));
        },
      );
    } catch (error) {
      if (cancelled() || isAbort(error)) return [];
      this.fail(error);
      throw error;
    } finally {
      this.busy = false;
      if (this.controller === controller) this.controller = null;
    }
  }

  private async acquire(packageId: string, deviceLuid: string | null, preview: boolean, signal: AbortSignal): Promise<SemanticSession> {
    if (preview && this.options.previewSession) return this.options.previewSession.session;
    const opener = this.options.openSession ?? (async (id, luid) => openSemanticSession(id, luid));
    const opened = await opener(packageId, deviceLuid);
    if (!signal.aborted) this.patch({ device: opened.device.adapterName ?? opened.device.luid ?? "DirectML" });
    return opened.session;
  }

  private patch(update: Partial<SemanticQueryStatus>): void {
    this.status = { ...this.status, ...update };
    this.options.onChange?.(this.current);
  }

  private fail(error: unknown): void {
    this.patch({ state: "failed", message: embeddingErrorMessage(error) });
  }
}

function progressStatus(progress: SemanticIndexProgress, preview: boolean, previous: SemanticQueryStatus): Partial<SemanticQueryStatus> {
  return {
    state: "building",
    preview,
    model: previous.model,
    stagedRows: progress.stagedRows,
    checkpointBatch: progress.nextBatch,
    resumable: progress.stagedRows > 0 && !progress.complete,
    message: progress.recovered
      ? `正在恢复检查点：第 ${progress.nextBatch} 批，已确认 ${progress.stagedRows} 段`
      : `正在建库：第 ${progress.nextBatch} 批，已暂存 ${progress.stagedRows} 段`,
  };
}

/** Rebuilds the stored chunk identity from the citation the pipeline returned. */
function chunkFromCitation(chunkId: string, citation: SemanticHit["citation"], snapshot: SemanticSnapshot): DocumentChunk {
  return {
    bookFingerprint: snapshot.manifest.bookFingerprint,
    chunkId,
    chapterPath: citation.chapterPath,
    chapterTitle: citation.chapterTitle,
    spineIndex: citation.spineIndex,
    contentType: "mixed",
    originalText: citation.snippet,
    normalizedText: citation.snippet,
    textAnchor: { start: citation.textOffset, end: citation.textOffset + citation.snippet.length, snippet: citation.snippet },
    parserVersion: snapshot.manifest.parserVersion,
    normalizerVersion: snapshot.manifest.normalizerVersion,
    chunkerVersion: snapshot.manifest.chunkerVersion,
    unitStart: 0,
    unitEnd: 0,
  };
}

function abortReason(): Error {
  const error = new Error("查询已取消");
  (error as { code?: string }).code = "aborted";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === "aborted";
}

export function statusFromJob(job: SemanticJobState | null): Partial<SemanticQueryStatus> {
  if (!job) return { checkpointBatch: 0, stagedRows: 0, resumable: false };
  return {
    checkpointBatch: job.nextBatch,
    stagedRows: job.stagedRows,
    resumable: !job.complete && job.nextBatch > 0,
    model: job.manifest?.profile.modelId ?? null,
  };
}

export { manifestFor };
