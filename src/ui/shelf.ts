import { invoke } from "@tauri-apps/api/core";
import { IS_AI_EDITION } from "../config/edition";
import { sanitizePersistedTextAnchor } from "../render/textAnchor";
import type { LibraryRecord } from "./libraryArchive";
import type { ThumbnailAsset, ThumbnailProvider } from "./thumbnail";
import { hasDuplicateReaderNoteIds, normalizeReaderNotes, type ReaderNote } from "./notes";
import {
  applyCommand,
  emptyOrganization,
  mergeIntoEnvelope,
  validateEnvelope,
  validateOrganization,
  type LibraryOrganization,
  type OrganizationCommand,
  type OrganizationEnvelope,
} from "./libraryOrganization";

// Keep the optional module out of the Core import graph, including dynamic chunks.
const cleanupBrowserPreparation = IS_AI_EDITION
  ? async (book: string) => (await import("../features/ai/preparation/browserStore")).deleteBrowserPreparationForBook(book)
  : null;

/** 书签：记录跳转回阅读进度用。 */
export interface Bookmark {
  id: string;
  spineIndex: number;
  page: number;
  anchorIndex: number | null;
  anchorRatio: number | null;
  /** Optional on old records; all new writes use null when unavailable. */
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
  /** 创建时锚点所在行文字，用于列表展示 */
  text: string;
  createdAtMs: number;
}

/** 书架条目（与 Rust ShelfEntry 字段一致，camelCase 序列化）。 */
export interface ShelfEntry {
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

export interface ShelfProgressPatch {
  lastReadAtMs: number;
  spineIndex: number;
  page: number;
  progressPct: number;
  anchorIndex: number | null;
  anchorRatio: number | null;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
}

export interface ShelfSaveInput {
  entry: Omit<
    ShelfEntry,
    "progressPct" | "lastReadAtMs" | "spineIndex" | "page" | "anchorIndex" | "anchorRatio" | "anchorTextOffset" | "anchorTextSnippet" | "isNew"
  > & {
    progressPct?: number;
    lastReadAtMs?: number;
    spineIndex?: number;
    page?: number;
    anchorIndex?: number | null;
    anchorRatio?: number | null;
    anchorTextOffset?: number | null;
    anchorTextSnippet?: string | null;
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

export interface ShelfStore {
  list(): Promise<ShelfEntry[]>;
  save(input: ShelfSaveInput): Promise<ShelfSaveResult>;
  /** Tauri 链接式批量导入；浏览器后端不支持本地持久路径。 */
  importPaths(paths: string[]): Promise<LinkedImportBatchResult>;
  readBook(id: string): Promise<Uint8Array>;
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
  /** 用已经校验并合并的可移植记录替换状态；设备绑定不变。 */
  replacePortableRecords(records: LibraryRecord[]): Promise<ShelfEntry[]>;
  readThumbnail(contentHash: string, mime?: string): Promise<ThumbnailAsset | null>;
  writeThumbnail(contentHash: string, asset: ThumbnailAsset): Promise<void>;
  deleteThumbnail(contentHash: string): Promise<void>;
  deleteBook(id: string): Promise<void>;
  /** Native batch cleanup shares one index transaction and one metadata write. */
  deleteBooks?(ids: string[]): Promise<void>;
  getOrganization(): Promise<LibraryOrganization>;
  applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization>;
  mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization>;
}

/** Keep failed rows visible; a native batch failure must not trigger expensive retries per book. */
export async function deleteShelfBooks(
  store: Pick<ShelfStore, "deleteBook" | "deleteBooks">,
  ids: string[],
): Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return { deleted: [], failed: [] };
  if (store.deleteBooks) {
    try {
      await store.deleteBooks(uniqueIds);
      return { deleted: uniqueIds, failed: [] };
    } catch (error) {
      return { deleted: [], failed: uniqueIds.map((id) => ({ id, error: String(error) })) };
    }
  }
  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of uniqueIds) {
    try { await store.deleteBook(id); deleted.push(id); }
    catch (error) { failed.push({ id, error: String(error) }); }
  }
  return { deleted, failed };
}

export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 0.1.5 旧版 ID 算法；保留用于兼容与历史测试，新导入使用内容 SHA-256。 */
export function shelfIdFor(identifier: string, fileName: string, fileSize: number): string {
  const text = `${identifier}|${fileName}|${fileSize}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type ShelfSort = "recent" | "added" | "title";

export function sortShelfEntries(entries: ShelfEntry[], sort: ShelfSort): ShelfEntry[] {
  const list = [...entries];
  switch (sort) {
    case "added":
      return list.sort((a, b) => b.addedAtMs - a.addedAtMs);
    case "title":
      return list.sort((a, b) =>
        a.title.localeCompare(b.title, "zh-Hans-CN", { numeric: true })
      );
    case "recent":
      return list.sort((a, b) => {
        const aRecent = a.lastReadAtMs > 0 ? a.lastReadAtMs : a.addedAtMs;
        const bRecent = b.lastReadAtMs > 0 ? b.lastReadAtMs : b.addedAtMs;
        return bRecent - aRecent;
      });
  }
}

export function filterShelfEntries(entries: ShelfEntry[], query: string): ShelfEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.title.toLowerCase().includes(q) || e.creator.toLowerCase().includes(q)
  );
}

/**
 * Normalize the value used for author grouping without changing the OPF value
 * stored in `ShelfEntry.creator`.
 *
 * NFKC handles compatibility forms (including full-width latin letters and
 * digits).  Whitespace and format characters are removed only when they are
 * between Han, Hiragana, or Katakana characters; ordinary spaces in western
 * names therefore remain intact.
 */
export const UNKNOWN_SHELF_AUTHOR = "未知作者";

export function normalizeShelfAuthor(value: string): string {
  const normalized = value.normalize("NFKC");
  const cjk = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
  const compact = normalized.replace(
    new RegExp(`(?<=[${cjk}])[\\p{White_Space}\\p{Cf}]+(?=[${cjk}])`, "gu"),
    "",
  );
  return compact.trim() || UNKNOWN_SHELF_AUTHOR;
}

/** Alias matching the terminology used by the shelf UI. */
export const normalizeShelfCreator = normalizeShelfAuthor;

export const UNKNOWN_SHELF_LANGUAGE = "未知语言";

/** Collapse BCP-47 language tags into stable, user-facing shelf groups. */
export function normalizeShelfLanguage(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) return UNKNOWN_SHELF_LANGUAGE;
  const normalized = raw.replace(/_/g, "-");
  const primary = normalized.split("-", 1)[0].toLowerCase();
  const groups: Record<string, string> = {
    zh: "中文",
    zho: "中文",
    chi: "中文",
    ja: "日语",
    jpn: "日语",
    en: "英语",
    eng: "英语",
    ko: "韩语",
    kor: "韩语",
    fr: "法语",
    fra: "法语",
    fre: "法语",
    de: "德语",
    deu: "德语",
    ger: "德语",
    es: "西班牙语",
    spa: "西班牙语",
    ru: "俄语",
    rus: "俄语",
  };
  return groups[primary] ?? normalized;
}

export type ShelfTimeSegment = "today" | "last7Days" | "last30Days" | "thisYear" | "older";

export const SHELF_TIME_SEGMENTS: readonly ShelfTimeSegment[] = [
  "today",
  "last7Days",
  "last30Days",
  "thisYear",
  "older",
];

export const SHELF_TIME_SEGMENT_LABELS: Readonly<Record<ShelfTimeSegment, string>> = {
  today: "今天",
  last7Days: "最近 7 天",
  last30Days: "最近 30 天",
  thisYear: "今年",
  older: "更早",
};

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Assign a save time to one mutually-exclusive, display-friendly segment. */
export function shelfTimeSegment(addedAtMs: number, nowMs = Date.now()): ShelfTimeSegment {
  if (!Number.isFinite(addedAtMs) || addedAtMs <= 0) return "older";
  const today = startOfLocalDay(nowMs);
  if (addedAtMs >= today) return "today";
  const day = 24 * 60 * 60 * 1000;
  if (addedAtMs >= today - 6 * day) return "last7Days";
  if (addedAtMs >= today - 29 * day) return "last30Days";
  const yearStart = new Date(new Date(nowMs).getFullYear(), 0, 1).getTime();
  if (addedAtMs >= yearStart) return "thisYear";
  return "older";
}

/** Alias using the field name used in some consumers. */
export const getShelfTimeSegment = shelfTimeSegment;

export interface ShelfFilterSelection {
  /** Normalized author values; all values in one facet are OR-ed. */
  authors?: readonly string[];
  titles?: readonly string[];
  timeSegments?: readonly ShelfTimeSegment[];
  languages?: readonly string[];
  /** Optional free-text search, kept here so the menu can use one model. */
  query?: string;
}

export interface ShelfFacetOption {
  value: string;
  label: string;
  count: number;
}

export interface ShelfFacet {
  options: ShelfFacetOption[];
  counts: Record<string, number>;
}

export interface ShelfFilterFacets {
  authors: ShelfFacet;
  titles: ShelfFacet;
  timeSegments: ShelfFacet;
  languages: ShelfFacet;
}

interface IndexedShelfEntry {
  entry: ShelfEntry;
  author: string;
  title: string;
  timeSegment: ShelfTimeSegment;
  language: string;
  searchText: string;
}

export interface ShelfFilterIndex {
  entries: readonly IndexedShelfEntry[];
  nowMs: number;
}

function indexShelfEntries(entries: ShelfEntry[], nowMs: number): IndexedShelfEntry[] {
  return entries.map((entry) => {
    const author = normalizeShelfAuthor(entry.creator);
    const language = normalizeShelfLanguage(entry.language);
    return {
      entry,
      author,
      title: entry.title,
      timeSegment: shelfTimeSegment(entry.addedAtMs, nowMs),
      language,
      searchText: `${entry.title} ${entry.creator}`.toLocaleLowerCase(),
    };
  });
}

/** Build the reusable metadata index in one pass over the shelf entries. */
export function buildShelfFilterIndex(entries: ShelfEntry[], nowMs = Date.now()): ShelfFilterIndex {
  return { entries: indexShelfEntries(entries, nowMs), nowMs };
}

function selectedSet(values: readonly string[] | undefined, normalize?: (value: string) => string): Set<string> {
  return new Set((values ?? []).map((value) => normalize ? normalize(value) : value));
}

interface CompiledShelfFilterSelection {
  authors: Set<string>;
  titles: Set<string>;
  timeSegments: Set<ShelfTimeSegment>;
  languages: Set<string>;
  query: string;
}

function compileSelection(selection: ShelfFilterSelection): CompiledShelfFilterSelection {
  return {
    authors: selectedSet(selection.authors, normalizeShelfAuthor),
    titles: selectedSet(selection.titles),
    timeSegments: new Set(selection.timeSegments ?? []),
    languages: selectedSet(selection.languages, normalizeShelfLanguage),
    query: selection.query?.trim().toLocaleLowerCase() ?? "",
  };
}

function matchesCompiledSelection(
  item: IndexedShelfEntry,
  selection: CompiledShelfFilterSelection,
  skip?: keyof CompiledShelfFilterSelection,
): boolean {
  const query = selection.query;
  if (skip !== "authors" && selection.authors.size > 0 && !selection.authors.has(item.author)) return false;
  if (skip !== "titles" && selection.titles.size > 0 && !selection.titles.has(item.title)) return false;
  if (skip !== "timeSegments" && selection.timeSegments.size > 0 && !selection.timeSegments.has(item.timeSegment)) return false;
  if (skip !== "languages" && selection.languages.size > 0 && !selection.languages.has(item.language)) return false;
  if (skip !== "query" && query && !item.searchText.includes(query)) return false;
  return true;
}

export function matchesShelfFilterSelection(entry: ShelfEntry, selection: ShelfFilterSelection = {}, nowMs = Date.now()): boolean {
  const author = normalizeShelfAuthor(entry.creator);
  const item: IndexedShelfEntry = {
    entry,
    author,
    title: entry.title,
    timeSegment: shelfTimeSegment(entry.addedAtMs, nowMs),
    language: normalizeShelfLanguage(entry.language),
    searchText: `${entry.title} ${entry.creator}`.toLocaleLowerCase(),
  };
  return matchesCompiledSelection(item, compileSelection(selection));
}

function facetFromValues(values: readonly string[], counts: Map<string, number>, label = (value: string): string => value): ShelfFacet {
  const countRecord: Record<string, number> = {};
  const options = values.map((value) => {
    const count = counts.get(value) ?? 0;
    countRecord[value] = count;
    return { value, label: label(value), count };
  });
  return { options, counts: countRecord };
}

/**
 * Build all facet options and cross-filtered counts. Each entry is indexed
 * once, then contributes to the four facet counters at most once. This keeps
 * the operation linear for normal book-sized shelves and makes it suitable
 * for a `useMemo` call.
 */
export function buildShelfFilterFacets(
  entriesOrIndex: ShelfEntry[] | ShelfFilterIndex,
  selection: ShelfFilterSelection = {},
  nowMs = Date.now(),
): ShelfFilterFacets {
  const index = Array.isArray(entriesOrIndex)
    ? buildShelfFilterIndex(entriesOrIndex, nowMs)
    : entriesOrIndex;
  const authorValues = new Set<string>();
  const titleValues = new Set<string>();
  const timeValues = new Set<ShelfTimeSegment>();
  const languageValues = new Set<string>();
  const authorCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const timeCounts = new Map<ShelfTimeSegment, number>();
  const languageCounts = new Map<string, number>();
  const compiled = compileSelection(selection);
  for (const item of index.entries) {
    authorValues.add(item.author);
    titleValues.add(item.title);
    timeValues.add(item.timeSegment);
    languageValues.add(item.language);
    if (matchesCompiledSelection(item, compiled, "authors")) authorCounts.set(item.author, (authorCounts.get(item.author) ?? 0) + 1);
    if (matchesCompiledSelection(item, compiled, "titles")) titleCounts.set(item.title, (titleCounts.get(item.title) ?? 0) + 1);
    if (matchesCompiledSelection(item, compiled, "timeSegments")) timeCounts.set(item.timeSegment, (timeCounts.get(item.timeSegment) ?? 0) + 1);
    if (matchesCompiledSelection(item, compiled, "languages")) languageCounts.set(item.language, (languageCounts.get(item.language) ?? 0) + 1);
  }
  return {
    authors: facetFromValues([...authorValues].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), authorCounts),
    titles: facetFromValues([...titleValues].sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true })), titleCounts),
    timeSegments: facetFromValues(SHELF_TIME_SEGMENTS.filter((value) => timeValues.has(value)), timeCounts, (value) => SHELF_TIME_SEGMENT_LABELS[value as ShelfTimeSegment]),
    languages: facetFromValues([...languageValues].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), languageCounts),
  };
}

export function filterShelfEntriesByFacets(
  entriesOrIndex: ShelfEntry[] | ShelfFilterIndex,
  selection: ShelfFilterSelection = {},
  nowMs = Date.now(),
): ShelfEntry[] {
  const index = Array.isArray(entriesOrIndex)
    ? buildShelfFilterIndex(entriesOrIndex, nowMs)
    : entriesOrIndex;
  const compiled = compileSelection(selection);
  return index.entries.filter((item) => matchesCompiledSelection(item, compiled)).map((item) => item.entry);
}

export interface ShelfFilterModel {
  index: ShelfFilterIndex;
  entries: ShelfEntry[];
  facets: ShelfFilterFacets;
}

/** One-call model for a memoized shelf view. */
export function createShelfFilterModel(
  entries: ShelfEntry[],
  selection: ShelfFilterSelection = {},
  nowMs = Date.now(),
): ShelfFilterModel {
  const index = buildShelfFilterIndex(entries, nowMs);
  return {
    index,
    entries: filterShelfEntriesByFacets(index, selection),
    facets: buildShelfFilterFacets(index, selection),
  };
}

export function applyShelfProgressPatch(
  entries: ShelfEntry[],
  id: string,
  patch: ShelfProgressPatch
): ShelfEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, ...patch, isNew: false } : entry));
}

/** Normalize legacy IndexedDB rows at the storage boundary; new writes use null. */
function normalizeBookmarkTextAnchor(bookmark: Bookmark): Bookmark {
  const text = sanitizePersistedTextAnchor({
    textOffset: bookmark.anchorTextOffset,
    textSnippet: bookmark.anchorTextSnippet,
  });
  return { ...bookmark, anchorTextOffset: text.textOffset, anchorTextSnippet: text.textSnippet };
}

export function normalizeShelfEntryTextAnchors(entry: ShelfEntry): ShelfEntry {
  const text = sanitizePersistedTextAnchor({
    textOffset: entry.anchorTextOffset,
    textSnippet: entry.anchorTextSnippet,
  });
  return {
    ...entry,
    anchorTextOffset: text.textOffset,
    anchorTextSnippet: text.textSnippet,
    bookmarks: entry.bookmarks?.map(normalizeBookmarkTextAnchor),
    notes: normalizeReaderNotes(entry.notes),
  };
}

/** Convert persisted shelf fields to a renderer restore anchor. Never persist -1. */
export function readingAnchorFromShelfEntry(entry: Pick<
  ShelfEntry,
  "anchorIndex" | "anchorRatio" | "anchorTextOffset" | "anchorTextSnippet"
>): {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
} | null {
  const text = sanitizePersistedTextAnchor({
    textOffset: entry.anchorTextOffset,
    textSnippet: entry.anchorTextSnippet,
  });
  const legacy =
    typeof entry.anchorIndex === "number" &&
    Number.isSafeInteger(entry.anchorIndex) &&
    entry.anchorIndex >= 0 &&
    typeof entry.anchorRatio === "number" &&
    Number.isFinite(entry.anchorRatio) &&
    entry.anchorRatio >= 0 &&
    entry.anchorRatio <= 1;
  if (!legacy && text.textOffset === null) return null;
  return {
    index: legacy ? entry.anchorIndex! : -1,
    ratio: legacy ? entry.anchorRatio! : 0,
    anchorTextOffset: text.textOffset,
    anchorTextSnippet: text.textSnippet,
  };
}

/** 只清除新书标记；异步 markOpened 的旧返回值不能覆盖更新后的进度。 */
export function markShelfEntryOpened(entries: ShelfEntry[], id: string): ShelfEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, isNew: false } : entry));
}

export function formatShelfTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

// ---- IndexedDB（浏览器 dev / 非 Tauri 环境回退） ----

const DB_NAME = "epub-reader-shelf";
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("covers")) {
        db.createObjectStore("covers", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("organization")) {
        db.createObjectStore("organization");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("无法打开书架数据库"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("书架数据库事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("书架数据库事务中止"));
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("书架数据库请求失败"));
  });
}

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((b) => new Uint8Array(b));
}

class IndexedDbShelfStore implements ShelfStore {
  async list(): Promise<ShelfEntry[]> {
    const db = await openDb();
    try {
      const all = await reqAsPromise(
        db.transaction("meta", "readonly").objectStore("meta").getAll()
      );
      return (all as ShelfEntry[])
        .filter((e) => e && typeof e.id === "string")
        .map(normalizeShelfEntryTextAnchors);
    } finally {
      db.close();
    }
  }

  async save(input: ShelfSaveInput): Promise<ShelfSaveResult> {
    const db = await openDb();
    try {
      const all = (await reqAsPromise(
        db.transaction("meta", "readonly").objectStore("meta").getAll()
      )) as ShelfEntry[];
      const contentHash = input.entry.contentHash;
      const duplicate = contentHash
        ? all.find((entry) => entry.contentHash === contentHash)
        : undefined;
      if (duplicate && duplicate.available !== false) {
        return { status: "duplicate", entry: duplicate };
      }
      const existing = all.find((entry) => entry.id === input.entry.id);
      if (existing && existing.contentHash !== contentHash) {
        throw new Error("书本 ID 冲突，已拒绝覆盖现有书籍");
      }
      const entry: ShelfEntry = {
        id: input.entry.id,
        title: input.entry.title,
        creator: input.entry.creator,
        language: existing?.language ?? input.entry.language,
        fileName: input.entry.fileName,
        fileSize: input.entry.fileSize,
        coverMime:
          input.coverMime ??
          input.entry.coverMime ??
          existing?.coverMime ??
          "",
        addedAtMs: existing?.addedAtMs ?? input.entry.addedAtMs ?? Date.now(),
        // Import time is not a reading event.  Recent sorting falls back to
        // addedAtMs until the first stable position is written.
        lastReadAtMs: existing?.lastReadAtMs ?? input.entry.lastReadAtMs ?? 0,
        spineIndex: existing?.spineIndex ?? input.entry.spineIndex ?? 0,
        page: existing?.page ?? input.entry.page ?? 0,
        progressPct: existing?.progressPct ?? input.entry.progressPct ?? 0,
        anchorIndex: existing?.anchorIndex ?? input.entry.anchorIndex ?? null,
        anchorRatio: existing?.anchorRatio ?? input.entry.anchorRatio ?? null,
        anchorTextOffset: existing?.anchorTextOffset ?? input.entry.anchorTextOffset ?? null,
        anchorTextSnippet: existing?.anchorTextSnippet ?? input.entry.anchorTextSnippet ?? null,
        contentHash:
          contentHash ??
          (/^[a-f0-9]{64}$/i.test(input.entry.id) ? input.entry.id : undefined),
        isNew: existing?.isNew ?? input.entry.isNew ?? true,
        bookmarks: (existing?.bookmarks ?? input.entry.bookmarks ?? []).map(normalizeBookmarkTextAnchor),
        notes: normalizeReaderNotes(existing?.notes ?? input.entry.notes),
        available: true,
      };
      const tx = db.transaction(["meta", "books", "covers"], "readwrite");
      tx.objectStore("meta").put(entry);
      tx.objectStore("books").put({
        id: entry.id,
        bytes: new Blob([input.bytes.slice().buffer as ArrayBuffer]),
      });
      if (input.coverBytes && input.coverBytes.byteLength > 0) {
        tx.objectStore("covers").put({
          id: entry.id,
          mime: entry.coverMime,
          bytes: new Blob([input.coverBytes.slice().buffer as ArrayBuffer]),
        });
      } else if (!existing) {
        tx.objectStore("covers").delete(entry.id);
      }
      await txDone(tx);
      return { status: "saved", entry };
    } finally {
      db.close();
    }
  }

  async importPaths(): Promise<LinkedImportBatchResult> {
    throw new Error("浏览器预览无法持久引用本地路径，请使用文件选择器导入测试副本");
  }

  async readBook(id: string): Promise<Uint8Array> {
    const db = await openDb();
    try {
      const row = (await reqAsPromise(
        db.transaction("books", "readonly").objectStore("books").get(id)
      )) as { bytes?: Blob } | undefined;
      if (!row?.bytes) throw new Error("书架中没有这本书的数据");
      return await blobToBytes(row.bytes);
    } finally {
      db.close();
    }
  }

  async readCover(id: string): Promise<Uint8Array | null> {
    const db = await openDb();
    try {
      const row = (await reqAsPromise(
        db.transaction("covers", "readonly").objectStore("covers").get(id)
      )) as { bytes?: Blob } | undefined;
      return row?.bytes ? await blobToBytes(row.bytes) : null;
    } finally {
      db.close();
    }
  }

  async setContentHash(id: string, contentHash: string): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, contentHash };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async updateProgress(id: string, patch: ShelfProgressPatch): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      // A successful stable-position write is also a successful open.  Keep
      // this field merge narrow: markOpened remains a separate isNew-only op.
      const next: ShelfEntry = { ...current, ...patch, isNew: false };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, isNew: false };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async setBookmarks(id: string, bookmarks: Bookmark[]): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, bookmarks };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async setNotes(id: string, notes: ReaderNote[]): Promise<ShelfEntry> {
    const normalized = normalizeReaderNotes(notes);
    if (normalized.length !== notes.length || hasDuplicateReaderNoteIds(normalized)) throw new Error("笔记数据无效或包含重复 ID，已拒绝保存");
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, notes: normalized };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async relink(): Promise<ShelfEntry> {
    throw new Error("浏览器预览不支持重新定位本地源文件");
  }

  async replacePortableRecords(records: LibraryRecord[]): Promise<ShelfEntry[]> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.getAll())) as ShelfEntry[];
      const byHash = new Map(
        current
          .filter((entry) => typeof entry.contentHash === "string")
          .map((entry) => [entry.contentHash as string, entry])
      );
      const next = records.map((record): ShelfEntry => {
        const local = byHash.get(record.contentHash);
        return {
          ...record,
          // 浏览器字节对象仍以旧 id 为 key；不能因导入存档改掉本地存储身份。
          id: local?.id ?? record.contentHash,
          fileSize: local?.fileSize ?? 0,
          coverMime: local?.coverMime ?? "",
          available: local ? local.available !== false : false,
          notes: normalizeReaderNotes(record.notes),
        };
      });
      for (const entry of next) store.put(entry);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async readThumbnail(): Promise<ThumbnailAsset | null> {
    return null;
  }

  async writeThumbnail(): Promise<void> {
    // 浏览器测试后端不建立第二份派生缓存；封面仍受视口门控。
  }

  async deleteThumbnail(): Promise<void> {
    // IndexedDB 删除书籍时会一并删除原有封面对象。
  }

  async deleteBook(id: string): Promise<void> {
    const db = await openDb();
    try {
      if (cleanupBrowserPreparation) {
        const entry = await reqAsPromise<ShelfEntry | undefined>(db.transaction("meta").objectStore("meta").get(id));
        await cleanupBrowserPreparation(entry?.contentHash ?? id);
      }
      const tx = db.transaction(["meta", "books", "covers"], "readwrite");
      tx.objectStore("meta").delete(id);
      tx.objectStore("books").delete(id);
      tx.objectStore("covers").delete(id);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async getOrganization(): Promise<LibraryOrganization> {
    const db = await openDb();
    try {
      const tx = db.transaction("organization", "readonly");
      const existing = await reqAsPromise<OrganizationEnvelope | undefined>(
        tx.objectStore("organization").get("current"),
      );
      if (existing) {
        return validateEnvelope(existing).state;
      }
    } finally {
      db.close();
    }
    // 首次读取无数据：在写事务中初始化并落盘本机身份
    const dbWrite = await openDb();
    try {
      const tx = dbWrite.transaction("organization", "readwrite");
      const store = tx.objectStore("organization");
      const existing = await reqAsPromise<OrganizationEnvelope | undefined>(
        store.get("current"),
      );
      if (existing) {
        return validateEnvelope(existing).state;
      }
      const initial: OrganizationEnvelope = {
        deviceId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : "00000000-0000-4000-8000-000000000000",
        counter: 0,
        state: emptyOrganization(),
      };
      store.put(initial, "current");
      await txDone(tx);
      return initial.state;
    } finally {
      dbWrite.close();
    }
  }

  async applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    const db = await openDb();
    try {
      const tx = db.transaction(["meta", "organization"], "readwrite");
      const metaStore = tx.objectStore("meta");
      const orgStore = tx.objectStore("organization");

      let envelope = await reqAsPromise<OrganizationEnvelope | undefined>(
        orgStore.get("current"),
      );
      if (!envelope) {
        envelope = {
          deviceId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "00000000-0000-4000-8000-000000000000",
          counter: 0,
          state: emptyOrganization(),
        };
      } else {
        envelope = validateEnvelope(envelope);
      }

      const allEntries = (await reqAsPromise(metaStore.getAll())) as ShelfEntry[];
      const knownHashes = new Set<string>();
      for (const entry of allEntries) {
        const hash =
          typeof entry.contentHash === "string" && entry.contentHash.length > 0
            ? entry.contentHash
            : typeof entry.id === "string" && /^[a-f0-9]{64}$/i.test(entry.id)
            ? entry.id
            : undefined;
        if (hash) {
          knownHashes.add(hash.toLowerCase());
        }
      }

      const nextEnvelope = applyCommand(envelope, command, knownHashes);
      orgStore.put(nextEnvelope, "current");
      await txDone(tx);
      return nextEnvelope.state;
    } finally {
      db.close();
    }
  }

  async mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization> {
    const validatedIncoming = validateOrganization(incoming);
    const db = await openDb();
    try {
      const tx = db.transaction("organization", "readwrite");
      const orgStore = tx.objectStore("organization");

      let envelope = await reqAsPromise<OrganizationEnvelope | undefined>(
        orgStore.get("current"),
      );
      if (!envelope) {
        envelope = {
          deviceId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "00000000-0000-4000-8000-000000000000",
          counter: 0,
          state: emptyOrganization(),
        };
      } else {
        envelope = validateEnvelope(envelope);
      }

      const nextEnvelope = mergeIntoEnvelope(envelope, validatedIncoming);
      orgStore.put(nextEnvelope, "current");
      await txDone(tx);
      return nextEnvelope.state;
    } finally {
      db.close();
    }
  }
}

// ---- Tauri 链接式实现（仅保存源路径绑定，不复制 EPUB 正文） ----

class TauriShelfStore implements ShelfStore {
  async list(): Promise<ShelfEntry[]> {
    const entries = await invoke<ShelfEntry[]>("linked_library_list_records");
    return entries.map(normalizeShelfEntryTextAnchors);
  }

  async save(): Promise<ShelfSaveResult> {
    throw new Error("桌面版必须通过源文件路径导入，不能复制 EPUB 到应用目录");
  }

  async importPaths(paths: string[]): Promise<LinkedImportBatchResult> {
    return invoke<LinkedImportBatchResult>("linked_library_import_paths", { paths });
  }

  async readBook(id: string): Promise<Uint8Array> {
    const buf = await invoke<ArrayBuffer>("linked_library_read_source_raw", {
      contentHash: id,
    });
    return new Uint8Array(buf);
  }

  async readCover(id: string): Promise<Uint8Array | null> {
    const buf = await invoke<ArrayBuffer>("linked_library_read_cover_raw", {
      contentHash: id,
    });
    return buf.byteLength > 0 ? new Uint8Array(buf) : null;
  }

  async setContentHash(id: string, contentHash: string): Promise<ShelfEntry> {
    if (id !== contentHash) throw new Error("链接式书库的 ID 必须等于内容指纹");
    const entry = (await this.list()).find((item) => item.id === id);
    if (!entry) throw new Error("书架中没有这本书");
    return entry;
  }

  async updateProgress(id: string, patch: ShelfProgressPatch): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_update_progress", {
      contentHash: id,
      lastReadAtMs: patch.lastReadAtMs,
      spineIndex: patch.spineIndex,
      page: patch.page,
      progressPct: patch.progressPct,
      anchorIndex: patch.anchorIndex,
      anchorRatio: patch.anchorRatio,
      anchorTextOffset: patch.anchorTextOffset,
      anchorTextSnippet: patch.anchorTextSnippet,
    });
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_mark_opened", { contentHash: id });
  }

  async setBookmarks(id: string, bookmarks: Bookmark[]): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_update_bookmarks", {
      contentHash: id,
      bookmarks,
    });
  }

  async setNotes(id: string, notes: ReaderNote[]): Promise<ShelfEntry> {
    const normalized = normalizeReaderNotes(notes);
    if (normalized.length !== notes.length || hasDuplicateReaderNoteIds(normalized)) throw new Error("笔记数据无效或包含重复 ID，已拒绝保存");
    return invoke<ShelfEntry>("linked_library_update_notes", {
      contentHash: id,
      notes: normalized,
    });
  }

  async relink(id: string, sourcePath: string): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_relink", {
      contentHash: id,
      sourcePath,
    });
  }

  async replacePortableRecords(records: LibraryRecord[]): Promise<ShelfEntry[]> {
    return invoke<ShelfEntry[]>("linked_library_replace_records", { records });
  }

  async readThumbnail(contentHash: string, mime?: string): Promise<ThumbnailAsset | null> {
    const buf = await invoke<ArrayBuffer>("linked_library_thumbnail_read", { contentHash });
    if (buf.byteLength === 0) return null;
    return { bytes: new Uint8Array(buf), mime: mime || "image/webp" };
  }

  async writeThumbnail(contentHash: string, asset: ThumbnailAsset): Promise<void> {
    await invoke("linked_library_thumbnail_write_raw", asset.bytes, {
      headers: {
        "x-content-hash": contentHash,
        "x-thumbnail-mime": asset.mime,
      },
    });
  }

  async deleteThumbnail(contentHash: string): Promise<void> {
    await invoke("linked_library_thumbnail_delete", { contentHash });
  }

  async deleteBook(id: string): Promise<void> {
    await invoke("linked_library_delete_record", { contentHash: id });
  }

  async deleteBooks(ids: string[]): Promise<void> {
    await invoke("linked_library_delete_records", { contentHashes: ids });
  }

  async getOrganization(): Promise<LibraryOrganization> {
    return invoke<LibraryOrganization>("linked_library_get_organization");
  }

  async applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    return invoke<LibraryOrganization>("linked_library_apply_organization", { command });
  }

  async mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization> {
    return invoke<LibraryOrganization>("linked_library_merge_organization", { incoming });
  }
}

let cachedStore: ShelfStore | null = null;

export function getShelfStore(): ShelfStore {
  if (!cachedStore) {
    cachedStore = isTauriEnv() ? new TauriShelfStore() : new IndexedDbShelfStore();
  }
  return cachedStore;
}

const thumbnailMimeByHash = new Map<string, string>();

/** 视口缩略图桥：所有路径、缓存位置和 ZIP 条目仍由 ShelfStore/Rust 控制。 */
export const shelfThumbnailProvider: ThumbnailProvider = {
  async readCachedThumbnail(descriptor) {
    const hash = descriptor.contentHash ?? descriptor.id;
    return getShelfStore().readThumbnail(
      hash,
      descriptor.thumbnailMime || thumbnailMimeByHash.get(hash)
    );
  },
  async readSourceCover(descriptor) {
    const bytes = await getShelfStore().readCover(descriptor.id);
    return bytes && bytes.byteLength > 0
      ? { bytes, mime: descriptor.coverMime || "image/jpeg" }
      : null;
  },
  async writeDerivedThumbnail(descriptor, asset) {
    const hash = descriptor.contentHash ?? descriptor.id;
    await getShelfStore().writeThumbnail(hash, asset);
    thumbnailMimeByHash.set(hash, asset.mime);
  },
};

/** 测试用：重置缓存的 store。 */
export function resetShelfStoreForTest(): void {
  cachedStore = null;
}
