import type { ShelfEntry } from "./shelf";

export const IMPORT_TITLE_MAX_CHARS = 14;

export interface ImportNotice {
  kind: "ok" | "warn" | "error";
  text: string;
}

export interface ImportSummary {
  sourceCount: number;
  importedCount: number;
  duplicateTitles: string[];
  failed: string[];
  /** Native duplicate imports refresh the local source binding. */
  refreshedCount?: number;
}

export interface DuplicateLookupContext {
  incomingHash: string;
  incomingSize: number;
  entries: ShelfEntry[];
  contentHashById: Map<string, string>;
  entryByContentHash: Map<string, ShelfEntry>;
  readBook(id: string): Promise<Uint8Array>;
  setContentHash(id: string, contentHash: string): Promise<unknown>;
}

/** EPUB 内容指纹；文件名变化不影响重复识别。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input =
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer
      : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 查询精确重复；对 0.1.5 无指纹条目只读取相同大小的候选并懒补指纹。
 * 补录失败不影响本次按原始字节计算出的判重结果。
 */
export async function findDuplicateEntry(
  context: DuplicateLookupContext
): Promise<ShelfEntry | null> {
  const known = context.entryByContentHash.get(context.incomingHash);
  if (known) return known;
  const candidates = context.entries.filter(
    (entry) =>
      !context.contentHashById.has(entry.id) && entry.fileSize === context.incomingSize
  );
  for (const candidate of candidates) {
    const existingHash = await sha256Hex(await context.readBook(candidate.id));
    context.contentHashById.set(candidate.id, existingHash);
    context.entryByContentHash.set(existingHash, candidate);
    try {
      await context.setContentHash(candidate.id, existingHash);
    } catch {
      // 只影响下次启动是否需要再次补录，不改变已比较的原始字节。
    }
    if (existingHash === context.incomingHash) return candidate;
  }
  return null;
}

export function truncateImportTitle(
  title: string,
  maxChars = IMPORT_TITLE_MAX_CHARS
): string {
  const chars = Array.from(title.trim() || "未命名书籍");
  if (chars.length <= maxChars) return chars.join("");
  if (maxChars <= 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function formatImportNotice(summary: ImportSummary): ImportNotice {
  const { sourceCount, importedCount, duplicateTitles, failed } = summary;
  const refreshedCount = summary.refreshedCount ?? 0;
  if (
    sourceCount === 1 &&
    importedCount === 0 &&
    duplicateTitles.length === 1 &&
    failed.length === 0
  ) {
    if (refreshedCount === 1) {
      return { kind: "ok", text: "此书已在书架，已更新本机源文件绑定；原有进度和笔记已保留" };
    }
    return { kind: "error", text: "此书已经被导入过了哦" };
  }

  let text = `已导入 ${importedCount} 本`;
  if (duplicateTitles.length > 0) {
    const names = duplicateTitles
      .slice(0, 2)
      .map((title) => `《${truncateImportTitle(title)}》`)
      .join("、");
    text += `；重复 ${duplicateTitles.length} 本：${names}`;
    if (duplicateTitles.length > 2) text += "等书";
    if (refreshedCount > 0) text += `（已更新 ${refreshedCount} 本源文件绑定，保留原有进度和笔记）`;
  }
  if (failed.length > 0) {
    text += `；失败 ${failed.length} 本（${failed.join("；")}）`;
  }

  const kind: ImportNotice["kind"] =
    failed.length > 0 && importedCount === 0 && duplicateTitles.length === 0
      ? "error"
      : duplicateTitles.length > 0 || failed.length > 0
        ? "warn"
        : "ok";
  return { kind, text };
}

/** 一次性合并导入结果；相同 id 的更新项替换旧条目。 */
export function mergeShelfEntries(
  existing: ShelfEntry[],
  updates: ShelfEntry[]
): ShelfEntry[] {
  if (updates.length === 0) return existing;
  const updateIds = new Set(updates.map((entry) => entry.id));
  return [...updates, ...existing.filter((entry) => !updateIds.has(entry.id))];
}
