import type {
  DirectoryImportPort,
  DirectoryImportResult,
  DirectoryProgress,
  FolderTarget,
  ImportCounts,
  ImportIssue,
  InputPage,
  IssuePage,
  ScanResult,
} from "../../core/folderImport/contract";
import {
  decidePlacement,
  planDirectoryImport,
  SuccessfulSources,
  type ImportOptions,
  type ImportRoot,
  type PlacementSnapshot,
  type ScannedEpub,
} from "../../core/folderImport/planner";
import { disposeBook, DrmError, loadBook } from "../../core/book";
import { effectiveFolderId, type LibraryOrganization } from "../libraryOrganization";
import { findDuplicateEntry, sha256Hex } from "../importBooks";
import type { ShelfEntry, ShelfStore } from "../shelf";

/**
 * Existing public ShelfStore methods the Web port composes. FI-I passes the
 * active store (portable IndexedDB facade); no new service method is required
 * for correctness. A single-transaction organization batch can replace the
 * per-command applyOrganization calls later without changing this port.
 */
export type WebDirectoryImportStore = Pick<
  ShelfStore,
  "list" | "save" | "readBook" | "setContentHash" | "getOrganization" | "applyOrganization"
>;

/** A picked directory: the File objects with their webkitRelativePath. */
export type WebDirectoryPicker = () => Promise<readonly File[] | null>;

export interface WebDirectoryImportOptions {
  readonly store: WebDirectoryImportStore;
  /** Defaults to an <input webkitdirectory> picker. */
  readonly pickDirectory?: WebDirectoryPicker;
  /** Defaults to crypto.randomUUID. */
  readonly newId?: () => string;
  /** Minimum interval between progress events. */
  readonly progressIntervalMs?: number;
}

const PAGE_SIZE = 128;
const ISSUE_PAGE_SIZE = 50;
/** Books per organization commit; matches the native short-batch bound. */
const PLACEMENT_BATCH = 64;

/** Modern browsers expose directory selection through webkitdirectory (MDN). */
export function supportsWebDirectoryPicker(): boolean {
  return typeof HTMLInputElement !== "undefined" && "webkitdirectory" in HTMLInputElement.prototype;
}

/** One native directory dialog; resolves null when the user dismisses it. */
export function pickWebDirectory(): Promise<readonly File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    let settled = false;
    const finish = (files: readonly File[] | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => {
      const files = input.files ? Array.from(input.files) : [];
      finish(files.length > 0 ? files : null);
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Turn a picked directory listing into scan entries. The first path segment is
 * the selected root and is dropped; the rest are the real parent segments.
 * Only .epub candidates take part; real EPUB validity is decided on import.
 */
export function scanWebDirectoryFiles(
  files: readonly File[],
  rootKey: string,
): { root: ImportRoot; items: ScannedEpub[]; files: Map<string, File> } {
  let rootName = "";
  const items: ScannedEpub[] = [];
  const byInput = new Map<string, File>();
  files.forEach((file, index) => {
    const segments = (file.webkitRelativePath || file.name).split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return;
    if (!rootName && segments.length > 1) rootName = segments[0];
    const fileName = segments[segments.length - 1];
    if (!fileName.toLowerCase().endsWith(".epub")) return;
    const inputId = `w${index}`;
    items.push({
      inputId,
      relativeParentSegments: segments.length > 1 ? segments.slice(1, -1) : [],
      fileName,
      sizeHint: file.size,
    });
    byInput.set(inputId, file);
  });
  // Plain Web has no real absolute root identity: every selection gets a new
  // opaque key, so no cross-session binding is claimed.
  return { root: { sourceRootKey: rootKey, name: rootName || "导入书籍" }, items, files: byInput };
}

interface WebJob {
  readonly root: ImportRoot;
  readonly items: readonly ScannedEpub[];
  /** File references stay in this closure, never in React state or storage. */
  files: Map<string, File> | null;
  readonly issues: ImportIssue[];
  running: Promise<DirectoryImportResult> | null;
  finished: boolean;
  cancelRequested: boolean;
  committing: boolean;
}

function placementSnapshot(state: LibraryOrganization, hash: string): PlacementSnapshot {
  const register = state.books[hash]?.folderId;
  return {
    rawFolderId: register ? register.value : null,
    stamp: register ? { deviceId: register.stamp.deviceId, counter: register.stamp.counter } : null,
    effectiveFolderId: effectiveFolderId(state, hash),
  };
}

function folderAlive(state: LibraryOrganization, folderId: string): boolean {
  const folder = state.folders[folderId];
  return folder !== undefined && !folder.deleted;
}

function errorText(error: unknown): string {
  if (error instanceof DrmError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

interface PendingPlacement {
  readonly inputId: string;
  readonly hash: string;
  readonly isExisting: boolean;
  readonly target: FolderTarget;
  readonly observed: PlacementSnapshot;
}

/**
 * Browser implementation of DirectoryImportPort: one directory dialog, then
 * one book at a time in planner ordinal order, short placement batches with
 * the conditional-placement rule checked against a fresh organization read.
 */
export function createWebDirectoryImportPort(options: WebDirectoryImportOptions): DirectoryImportPort {
  const store = options.store;
  const pick = options.pickDirectory ?? pickWebDirectory;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const interval = options.progressIntervalMs ?? 250;
  const jobs = new Map<string, WebJob>();

  const jobFor = (jobId: string): WebJob => {
    const job = jobs.get(jobId);
    if (!job) throw new Error("导入作业已结束或不存在");
    return job;
  };

  async function run(
    jobId: string,
    job: WebJob,
    importOptions: ImportOptions,
    targets: readonly FolderTarget[],
    onProgress: (event: DirectoryProgress) => void,
  ): Promise<DirectoryImportResult> {
    const plan = planDirectoryImport(job.root, job.items, importOptions);
    const targetByGroup = new Map(targets.map((target) => [target.groupKey, target]));
    if (targets.length !== plan.groups.length || plan.groups.some((group) => !targetByGroup.has(group.groupKey))) {
      throw new Error("导入目标与预览分组不一致，请重新预览");
    }
    const counts = {
      completed: 0, imported: 0, duplicates: 0, failed: 0, placementSkipped: 0, createdFolders: 0,
    };
    const snapshotCounts = (): ImportCounts => ({ ...counts });
    let lastEmit = 0;
    let phase: DirectoryProgress["phase"] = "preparing";
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < interval) return;
      lastEmit = now;
      onProgress({ jobId, phase, scannedInputs: job.items.length, totalInputs: job.items.length, counts: snapshotCounts() });
    };
    const issue = (inputId: string, kind: ImportIssue["kind"], message: string) => {
      job.issues.push({ inputId, kind, message });
    };

    // Same duplicate lookup state as the single-file Web import.
    const entries = await store.list();
    const contentHashById = new Map<string, string>();
    const entryByContentHash = new Map<string, ShelfEntry>();
    for (const entry of entries) {
      if (!entry.contentHash) continue;
      contentHashById.set(entry.id, entry.contentHash);
      entryByContentHash.set(entry.contentHash, entry);
    }
    let organization = await store.getOrganization();
    const successful = new SuccessfulSources();
    const winnerGroup = new Map<string, string | null>();
    const createdTargets = new Set<string>();
    let pending: PendingPlacement[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      phase = "committing";
      job.committing = true;
      emit(true);
      try {
        // Re-read the active data source right before writing: the scan-time
        // snapshot never authorizes a move.
        const current = await store.getOrganization();
        const moves = new Map<string, string[]>();
        const creates = new Map<string, Extract<FolderTarget, { kind: "create" }>>();
        for (const item of batch) {
          const target = item.target;
          const alive = target.kind === "create"
            ? !current.folders[target.folderId]?.deleted
            : folderAlive(current, target.folderId);
          const decision = decidePlacement(
            item.observed,
            placementSnapshot(current, item.hash),
            item.isExisting,
            target.folderId,
            alive,
            importOptions.existingPlacement,
          );
          if (decision.kind === "skipped") {
            counts.placementSkipped++;
            issue(item.inputId, decision.reason, decision.reason === "target-deleted"
              ? "目标文件夹已被删除，书已导入但未归档"
              : "导入期间这本书的分类发生变化，已保留新的分类");
            continue;
          }
          if (decision.kind !== "move") continue;
          if (target.kind === "create" && !current.folders[target.folderId]) creates.set(target.folderId, target);
          const list = moves.get(decision.folderId) ?? [];
          list.push(item.hash);
          moves.set(decision.folderId, list);
        }
        // Folders are created only now, when a successful book really goes in.
        for (const target of creates.values()) {
          await store.applyOrganization({ type: "createFolder", folderId: target.folderId, name: target.name });
          if (!createdTargets.has(target.folderId)) {
            createdTargets.add(target.folderId);
            counts.createdFolders++;
          }
        }
        for (const [folderId, hashes] of moves) {
          organization = await store.applyOrganization({ type: "moveBooks", contentHashes: hashes, folderId });
        }
      } catch (error) {
        // Books stay imported; only the placement is reported as pending.
        for (const item of batch) issue(item.inputId, "placement-changed", `书已导入，归档失败：${errorText(error)}`);
        counts.placementSkipped += batch.length;
      } finally {
        job.committing = false;
        phase = "preparing";
      }
    };

    for (const input of plan.inputs) {
      if (job.cancelRequested) break;
      const file = job.files?.get(input.inputId);
      const target = input.groupKey === null ? null : targetByGroup.get(input.groupKey)!;
      counts.completed++;
      if (!file) {
        counts.failed++;
        issue(input.inputId, "source-failed", "源文件已不可用");
        emit();
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const hash = await sha256Hex(bytes);
        const winner = successful.winner(hash);
        if (winner !== undefined) {
          counts.duplicates++;
          if (winnerGroup.get(hash) !== input.groupKey) {
            issue(input.inputId, "multiple-sources", `同一本书在多个目录出现，已采用排在前面的来源（${file.name}）`);
          }
          emit();
          continue;
        }
        const duplicate = await findDuplicateEntry({
          incomingHash: hash,
          incomingSize: bytes.byteLength,
          entries,
          contentHashById,
          entryByContentHash,
          readBook: (id) => store.readBook(id),
          setContentHash: (id, contentHash) => store.setContentHash(id, contentHash),
        });
        let isExisting = duplicate !== null;
        if (duplicate && duplicate.available !== false) {
          // Existing canonical data is never re-saved: no fabricated 0% record.
          counts.duplicates++;
        } else {
          const book = await loadBook(bytes, { selective: true });
          try {
            if (book.spine.length === 0) throw new Error("书中没有可阅读的内容（spine 为空）");
            const cover = book.coverHref ? book.resources.get(book.coverHref) : undefined;
            const result = await store.save({
              entry: {
                id: hash,
                title: book.metadata.title || file.name.replace(/\.epub$/i, ""),
                creator: book.metadata.creator ?? "",
                language: book.metadata.language || undefined,
                fileName: file.name,
                fileSize: bytes.byteLength,
                coverMime: cover?.mediaType ?? "",
                contentHash: hash,
                addedAtMs: Date.now(),
              },
              bytes,
              coverBytes: cover?.data,
              coverMime: cover?.mediaType,
            });
            contentHashById.set(result.entry.id, hash);
            entryByContentHash.set(hash, result.entry);
            if (result.status === "duplicate") {
              counts.duplicates++;
              isExisting = true;
            } else {
              counts.imported++;
            }
          } finally {
            disposeBook(book);
          }
        }
        successful.recordPublished(hash, input.ordinal);
        winnerGroup.set(hash, input.groupKey);
        if (target) {
          pending.push({
            inputId: input.inputId,
            hash,
            isExisting,
            target,
            // First time this hash is known: observe its current placement.
            observed: placementSnapshot(organization, hash),
          });
          if (pending.length >= PLACEMENT_BATCH) {
            await flush();
            organization = await store.getOrganization();
          }
        }
      } catch (error) {
        counts.failed++;
        issue(input.inputId, "source-failed", `${file.name}：${errorText(error)}`);
      }
      emit();
    }
    // Books already imported are still placed after a cancel; nothing is rolled back.
    await flush();
    phase = "cleaning";
    emit(true);
    return {
      jobId,
      status: job.cancelRequested ? "cancelled" : "completed",
      counts: snapshotCounts(),
      issueCount: job.issues.length,
    };
  }

  return {
    async scan(onProgress): Promise<ScanResult | null> {
      const files = await pick();
      if (!files) return null;
      const jobId = newId();
      const scanned = scanWebDirectoryFiles(files, `web:${newId()}`);
      jobs.set(jobId, {
        root: scanned.root,
        items: scanned.items,
        files: scanned.files,
        issues: [],
        running: null,
        finished: false,
        cancelRequested: false,
        committing: false,
      });
      onProgress({
        jobId,
        phase: "scanning",
        scannedInputs: scanned.items.length,
        totalInputs: scanned.items.length,
        counts: { completed: 0, imported: 0, duplicates: 0, failed: 0, placementSkipped: 0, createdFolders: 0 },
      });
      return {
        jobId,
        root: scanned.root,
        inputCount: scanned.items.length,
        skippedDirectoryCount: 0,
        unreadableDirectoryCount: 0,
      };
    },
    async page(jobId, cursor): Promise<InputPage> {
      const job = jobFor(jobId);
      const start = cursor === undefined ? 0 : Number(cursor);
      const end = Math.min(job.items.length, start + PAGE_SIZE);
      // No persistent root identity on plain Web: no bindings to report.
      return { items: job.items.slice(start, end), bindings: [], nextCursor: end < job.items.length ? String(end) : null };
    },
    start(input): Promise<DirectoryImportResult> {
      const job = jobFor(input.jobId);
      if (job.running || job.finished) return Promise.reject(new Error("导入作业只能启动一次"));
      job.running = run(input.jobId, job, input.options, input.targets, input.onProgress)
        .finally(() => {
          job.finished = true;
          job.files = null;
        });
      return job.running;
    },
    async issues(jobId, cursor): Promise<IssuePage> {
      const job = jobFor(jobId);
      const start = cursor === undefined ? 0 : Number(cursor);
      const end = Math.min(job.issues.length, start + ISSUE_PAGE_SIZE);
      return { items: job.issues.slice(start, end), nextCursor: end < job.issues.length ? String(end) : null };
    },
    async cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job || job.finished || !job.running) return "already-finished";
      job.cancelRequested = true;
      return job.committing ? "settling" : "requested";
    },
    async dispose(jobId): Promise<void> {
      const job = jobs.get(jobId);
      if (!job) return;
      if (job.running && !job.finished) {
        job.cancelRequested = true;
        await job.running.catch(() => undefined);
      }
      job.files = null;
      jobs.delete(jobId);
    },
  };
}
