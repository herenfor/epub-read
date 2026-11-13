// Shelf domain types shared by the shelf facade, entries and stores.

import type { ArchiveClient } from "../../core/selectiveArchive";
import type { MediaReadingAnchor } from "../../render/paginator";
import type { Stamp, Version } from "../../core/portableState/portable-register-core";
import type { ProgressLease } from "../portableState/ownedProgressSessions";
import type { ProgressRuntimeStatus } from "../portableState/progressRuntimeGate";
import type { ConfirmedProgressWrite } from "../checkpointProgressRepair";
import type { ProgressValue } from "../../core/portableState/portable-state-types";
import type { LibraryRecord } from "../libraryArchive";
import type { ThumbnailAsset } from "../thumbnail";
import type { ImportSkippedBook } from "../../platform/saveFileNativeBridge";
import type { AndroidDocumentSelection, AndroidImportBatchResult } from "../../platform/androidNativeBridge";
import type { DirectoryPlacementBatch, DirectoryPlacementBatchResult } from "../folderImport/placementBatch";
import type { ReaderNote } from "../notes";
import type { LibraryOrganization, OrganizationCommand } from "../libraryOrganization";

export interface Bookmark {
  id: string;
  spineIndex: number;
  page: number;
  anchorIndex: number | null;
  anchorRatio: number | null;
  /** Optional on old records; all new writes use null when unavailable. */
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
  /** B-155：纯图片页的媒体身份/比例；旧记录缺省可读。 */
  mediaAnchor?: MediaReadingAnchor | null;
  /** v3 现代定位使用的 EPUB 内部章节路径；旧记录可缺省。 */
  chapterPath?: string | null;
  /** 创建时锚点所在行文字，用于列表展示 */
  text: string;
  createdAtMs: number;
}

/** 书架条目（与 Rust ShelfEntry 字段一致，camelCase 序列化）。 */
export interface ShelfEntry {
  /** Canonical source chapter identity projected by the portable repository. */
  chapterPath?: string | null;
  id: string;
  title: string;
  creator: string;
  /** EPUB dc:language value; old shelf rows may omit it. */
  language?: string;
  fileName: string;
  fileSize: number;
  coverMime: string;
  addedAtMs: number;
  lastReadAtMs: number;
  spineIndex: number;
  page: number;
  progressPct: number;
  anchorIndex: number | null;
  anchorRatio: number | null;
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
  /** B-155：纯图片页的媒体身份/比例；旧记录缺省可读。 */
  mediaAnchor?: MediaReadingAnchor | null;
  /** EPUB 原始字节的 SHA-256；0.1.5 旧条目允许缺失并在判重时懒补。 */
  contentHash?: string;
  /** 新导入且尚未打开过：书架显示“新”标记，第一次打开后清除 */
  isNew: boolean;
  /** 该书签（随书删除；旧条目缺省为空数组） */
  bookmarks?: Bookmark[];
  /** 该书的正文笔记（随书删除；旧条目缺省为空数组） */
  notes?: ReaderNote[];
  /** 链接式书库的源文件当前是否可用；浏览器旧后端缺省视为可用。 */
  available?: boolean;
  /** Android：书留在原位置（本机文档绑定），不在书库里；旧条目缺省为否。 */
  originalLocation?: boolean;
  /** 设备缩略图缓存的实际媒体类型；不进入可移植存档。 */
  thumbnailMime?: string;
}

export interface LinkedImportItemResult {
  inputIndex: number;
  status: "saved" | "duplicate" | "failed";
  contentHash?: string;
  record?: ShelfEntry;
  error?: string;
}

export interface LinkedImportBatchResult {
  results: LinkedImportItemResult[];
}

export type PortableProgressSelection =
  | { readonly kind: "chosen"; readonly stamp: Stamp }
  | { readonly kind: "empty" };

/** Opaque note editor basis: readId + current write basis. */
export interface NoteEditContext {
  readId: string;
  basisId: string;
}

export interface ShelfProgressPatch {
  lastReadAtMs: number;
  spineIndex: number;
  page: number;
  progressPct: number;
  anchorIndex: number | null;
  anchorRatio: number | null;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  /** B-155 可选媒体锚点；旧记录缺省可读，写入时可为 null。 */
  mediaAnchor?: MediaReadingAnchor | null;
  /** R5：当前正文章节的 EPUB 内部路径；无书/旧样本可为 null。 */
  chapterPath?: string | null;
}

export interface ShelfSaveInput {
  entry: Omit<
    ShelfEntry,
    "progressPct" | "lastReadAtMs" | "spineIndex" | "page" | "anchorIndex" | "anchorRatio" | "anchorTextOffset" | "anchorTextSnippet" | "mediaAnchor" | "isNew"
  > & {
    progressPct?: number;
    lastReadAtMs?: number;
    spineIndex?: number;
    page?: number;
    anchorIndex?: number | null;
    anchorRatio?: number | null;
    anchorTextOffset?: number | null;
    anchorTextSnippet?: string | null;
    mediaAnchor?: MediaReadingAnchor | null;
    isNew?: boolean;
  };
  bytes: Uint8Array;
  coverBytes?: Uint8Array;
  coverMime?: string;
}

export interface ShelfSaveResult {
  status: "saved" | "duplicate";
  entry: ShelfEntry;
}

/** Old JSON archive import result. C6: only the native repository skips books this device does not have. */
export interface PortableRecordsImportResult {
  entries: ShelfEntry[];
  skippedBookCount: number;
  skippedBooks: ImportSkippedBook[];
}

export interface ShelfStore {
  list(): Promise<ShelfEntry[]>;
  /** Fresh single-book progress projection, before choosing an open position. */
  readProgressEntryForOpen?(id: string): Promise<ShelfEntry>;
  /**
   * ER-0139: after the reader picks one of several shown progress versions,
   * supersede all of them with that value. Null when the repository changed
   * since it was shown, or the store has no portable progress.
   */
  resolveProgressChoice?(id: string, chosen: Version<ProgressValue>, shown: readonly Stamp[]): Promise<Version<ProgressValue> | null>;
  save(input: ShelfSaveInput): Promise<ShelfSaveResult>;
  /** Tauri 链接式批量导入；浏览器后端不支持本地持久路径。 */
  /** `copyToLibrary` (Windows, A34): copy each book into the app's library instead of linking it. */
  importPaths(paths: string[], copyToLibrary?: boolean): Promise<LinkedImportBatchResult>;
  /** 原生导入结果进入仓储后，返回含进度版本和注释的完整书架投影。 */
  importRecords?(records: ShelfEntry[]): Promise<ShelfEntry[]>;
  readBook(id: string): Promise<Uint8Array>;
  /**
   * Android 链接式路径可选：按需访问原生 ZIP 目录与条目，避免整本 EPUB
   * 经 Java/WebView IPC 堆内分配；未实现的后端继续用 readBook。
   */
  openArchive?(id: string, textEncoding?: string): Promise<ArchiveClient>;
  /** Every format, EPUB included, is read through openArchive (no whole-file readBook). */
  readonly archiveOnly?: boolean;
  /**
   * Android document import into this store instead of the native library
   * command; the hook then publishes the records through importRecords.
   */
  importDocuments?(documents: AndroidDocumentSelection[], onProgress: (completed: number, total: number) => void, signal?: AbortSignal): Promise<AndroidImportBatchResult>;
  readCover(id: string): Promise<Uint8Array | null>;
  /** 只为旧条目补录内容指纹，不得改动阅读进度或其他元数据。 */
  setContentHash(id: string, contentHash: string): Promise<ShelfEntry>;
  updateProgress(id: string, patch: ShelfProgressPatch): Promise<ShelfEntry>;
  /** 第一次从书架打开：清除“新”标记 */
  markOpened(id: string): Promise<ShelfEntry>;
  /** 写入整本书的书签列表（随书删除） */
  setBookmarks(id: string, bookmarks: Bookmark[]): Promise<ShelfEntry>;
  /** 写入整本书的正文笔记（随书删除） */
  setNotes(id: string, notes: ReaderNote[]): Promise<ShelfEntry>;
  /** 重新绑定同一内容指纹的源 EPUB；哈希不一致必须拒绝。 */
  relink(id: string, sourcePath: string): Promise<ShelfEntry>;
  /** 旧 v1/v2 JSON 导入：记录与 organization 必须一并合并；设备绑定不变。 */
  replacePortableRecords(records: LibraryRecord[], organization?: LibraryOrganization): Promise<PortableRecordsImportResult>;
  readThumbnail(contentHash: string, mime?: string): Promise<ThumbnailAsset | null>;
  writeThumbnail(contentHash: string, asset: ThumbnailAsset): Promise<void>;
  deleteThumbnail(contentHash: string): Promise<void>;
  deleteBook(id: string): Promise<void>;
  /** Native batch cleanup shares one index transaction and one metadata write. */
  deleteBooks?(ids: string[]): Promise<void>;
  getOrganization(): Promise<LibraryOrganization>;
  applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization>;
  mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization>;
  /**
   * Web directory import: re-check, create folders and move books in ONE
   * storage transaction, or write nothing. Native directory jobs commit their
   * own placement in the backend and never call this.
   */
  commitDirectoryPlacementBatch?(batch: DirectoryPlacementBatch): Promise<DirectoryPlacementBatchResult>;
  /**
   * CP-I-R single-entity v3 operations. Legacy backends may omit these and the
   * UI keeps its whole-array path for them; the portable facade never rewrites
   * unrelated annotation IDs.
   */
  createBookmark?(id: string, bookmark: Bookmark): Promise<ShelfEntry>;
  deleteBookmark?(id: string, bookmarkId: string): Promise<ShelfEntry>;
  createNote?(id: string, note: ReaderNote): Promise<ShelfEntry>;
  deleteNote?(id: string, noteId: string): Promise<ShelfEntry>;
  /** B2: open a note edit context against the displayed version. */
  beginNoteEdit?(id: string, noteId: string, chosenStamp: Stamp): Promise<NoteEditContext | null>;
  writeNoteEdit?(id: string, note: ReaderNote, context: NoteEditContext): Promise<ShelfEntry>;
  endNoteEdit?(context: NoteEditContext): Promise<void>;
  /** B3 compatibility wrapper around a book-ID-owned progress session. */
  beginProgressSession?(id: string, selection: PortableProgressSelection): Promise<void>;
  closeProgressSession?(id: string): Promise<void>;
  /** Exact-lease progress lifecycle used by the App. */
  prepareProgressSession?(id: string, selection: PortableProgressSelection): Promise<ProgressLease>;
  activateProgressSession?(lease: ProgressLease): void;
  closeProgressLease?(lease: ProgressLease): Promise<void>;
  updateProgressForSession?(lease: ProgressLease, patch: ShelfProgressPatch): Promise<ConfirmedProgressWrite<ShelfEntry>>;
  rebindProgressSession?(lease: ProgressLease): Promise<void>;
  hasProgressSession?(lease: ProgressLease): boolean;
  progressSessionBookHash?(lease: ProgressLease): string | undefined;
  progressSessionChosenStamp?(lease: ProgressLease): Stamp | null | undefined;
  progressSessionRepositoryGeneration?(lease: ProgressLease): string | undefined;
  /** Read-only repository readiness; must not activate or migrate. */
  runtimeStatus?(): Promise<ProgressRuntimeStatus>;
}
