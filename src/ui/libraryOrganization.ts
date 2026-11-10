/**
 * 收藏与多层文件夹管理核心模块。
 *
 * 纯逻辑与类型定义：不依赖 Tauri、DOM 或具体存储实现。
 * 书籍身份复用 EPUB 原始字节的 SHA-256（64 位小写十六进制字符串）。
 * 每本书最多归属一个文件夹（folderId 寄存器），收藏（favorite 寄存器）完全独立。
 * 文件夹用带 stamp 的 parentId 寄存器组成最多五层的树；删除使用永久
 * tombstone，显示投影跳过已删节点并把其子女/直属书提升到最近的存活祖先。
 */

export const MAX_SAFE_COUNTER = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const MAX_FOLDER_NAME_CODE_POINTS = 40;
export const ORGANIZATION_SCHEMA_VERSION = 2 as const;
export const ORGANIZATION_LEGACY_SCHEMA_VERSION = 1 as const;
export const MAX_FOLDER_DEPTH = 5;

export const STAMP_COLLISION = "收藏与文件夹数据冲突：同一字段的同一事件出现不同取值";
export const CLOCK_EXHAUSTED = "本机逻辑时钟已达上限，无法继续保存收藏与文件夹";

export interface Stamp {
  readonly counter: number;
  readonly deviceId: string;
}

export interface Register<T> {
  readonly value: T;
  readonly stamp: Stamp;
}

export interface FolderState {
  readonly name: Register<string>;
  /** 父关系；缺失按历史单层数据视为根。根的新事件写明确的 value: null。 */
  readonly parentId?: Register<string | null>;
  /** 永久删除标记：同一 UUID 不允许复活。 */
  readonly deleted?: Stamp;
}

export interface BookOrganization {
  readonly favorite?: Register<boolean>;
  readonly folderId?: Register<string | null>;
}

export interface LibraryOrganization {
  /** 2 supports parentId; 1 is accepted only as legacy input and normalized on read. */
  readonly schemaVersion: 1 | 2;
  readonly folders: Readonly<Record<string, FolderState>>;
  readonly books: Readonly<Record<string, BookOrganization>>;
}

/** 仅本机保存；export 只取 state，不能导入他人的本机时钟身份。 */
export interface OrganizationEnvelope {
  readonly deviceId: string;
  readonly counter: number;
  readonly state: LibraryOrganization;
}

export type OrganizationCommand =
  | { readonly type: "createFolder"; readonly folderId: string; readonly name: string; readonly parentId?: string | null }
  | { readonly type: "moveFolder"; readonly folderId: string; readonly parentId: string | null }
  | { readonly type: "renameFolder"; readonly folderId: string; readonly name: string }
  | { readonly type: "deleteFolder"; readonly folderId: string }
  | { readonly type: "setFavorite"; readonly contentHashes: readonly string[]; readonly value: boolean }
  | { readonly type: "moveBooks"; readonly contentHashes: readonly string[]; readonly folderId: string | null };

export type ShelfScope =
  | { readonly type: "root" }
  | { readonly type: "all" }
  | { readonly type: "favorites" }
  | { readonly type: "folder"; readonly folderId: string };

export function emptyOrganization(): LibraryOrganization {
  return { schemaVersion: ORGANIZATION_SCHEMA_VERSION, folders: {}, books: {} };
}

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export function validCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_RE.test(value);
}

export function validContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH_RE.test(value);
}

/**
 * 计算 Unicode 字符（Code point）数量，与 Rust `chars().count()` 和 TS `[...value].length` 对齐。
 * 严禁使用 UTF-16 code units 的 `value.length`。
 */
export function codePointCount(value: string): number {
  return [...value].length;
}

export function validFolderName(name: string): boolean {
  return name.trim() === name && codePointCount(name) >= 1 && codePointCount(name) <= MAX_FOLDER_NAME_CODE_POINTS;
}

/** 本地创建/改名前先 trim 并校验长度，成功后返回修剪后的名称。 */
export function normalizeFolderName(raw: string): string {
  const trimmed = raw.trim();
  const count = codePointCount(trimmed);
  if (count === 0 || count > MAX_FOLDER_NAME_CODE_POINTS) {
    throw new Error(`文件夹名称需为 1-${MAX_FOLDER_NAME_CODE_POINTS} 个字符`);
  }
  return trimmed;
}

export function validStamp(stamp: unknown): stamp is Stamp {
  if (!stamp || typeof stamp !== "object") return false;
  const s = stamp as Record<string, unknown>;
  return (
    typeof s.counter === "number" &&
    Number.isInteger(s.counter) &&
    s.counter >= 1 &&
    s.counter <= MAX_SAFE_COUNTER &&
    validCanonicalUuid(s.deviceId)
  );
}

/** deviceId 是小写规范 UUID，按 ASCII 字节顺序比较，不能用 localeCompare。 */
export function compareStamp(a: Stamp, b: Stamp): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId === b.deviceId ? 0 : a.deviceId < b.deviceId ? -1 : 1;
}

function mergeRegister<T extends string | boolean | null>(
  a: Register<T> | undefined,
  b: Register<T> | undefined,
): Register<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  const order = compareStamp(a.stamp, b.stamp);
  if (order === 0 && a.value !== b.value) {
    throw new Error(STAMP_COLLISION);
  }
  return order >= 0 ? a : b;
}

function mergeDeletion(a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareStamp(a, b) >= 0 ? a : b;
}

function mergeFolder(a: FolderState, b: FolderState): FolderState {
  const parentId = mergeRegister(a.parentId, b.parentId);
  const deleted = mergeDeletion(a.deleted, b.deleted);
  return {
    name: mergeRegister(a.name, b.name)!,
    ...(parentId ? { parentId } : {}),
    ...(deleted ? { deleted } : {}),
  };
}

function mergeBook(a: BookOrganization, b: BookOrganization): BookOrganization {
  const favorite = mergeRegister(a.favorite, b.favorite);
  const folderId = mergeRegister(a.folderId, b.folderId);
  return {
    ...(favorite ? { favorite } : {}),
    ...(folderId ? { folderId } : {}),
  };
}

function mergeMap<T>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>,
  merge: (left: T, right: T) => T,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const left = a[key];
    const right = b[key];
    if (left !== undefined && right !== undefined) {
      result[key] = merge(left, right);
    } else if (left !== undefined) {
      result[key] = left;
    } else if (right !== undefined) {
      result[key] = right;
    }
  }
  return result;
}

/** 有效事件集合上满足交换律、结合律、幂等律；不改写任何输入。 */
export function mergeOrganization(a: LibraryOrganization, b: LibraryOrganization): LibraryOrganization {
  return {
    schemaVersion: ORGANIZATION_SCHEMA_VERSION,
    folders: mergeMap(a.folders, b.folders, mergeFolder),
    books: mergeMap(a.books, b.books, mergeBook),
  };
}

export function maxObservedCounter(state: LibraryOrganization): number {
  let maximum = 0;
  const observe = (stamp: Stamp | undefined): void => {
    if (stamp) maximum = Math.max(maximum, stamp.counter);
  };
  for (const folder of Object.values(state.folders)) {
    observe(folder.name.stamp);
    observe(folder.parentId?.stamp);
    observe(folder.deleted);
  }
  for (const book of Object.values(state.books)) {
    observe(book.favorite?.stamp);
    observe(book.folderId?.stamp);
  }
  return maximum;
}

/** 必须在本机写事务内，对最新 envelope 调用。 */
export function nextStamp(local: OrganizationEnvelope): Stamp {
  const counter = Math.max(local.counter, maxObservedCounter(local.state)) + 1;
  if (!Number.isSafeInteger(counter) || counter > MAX_SAFE_COUNTER) {
    throw new Error(CLOCK_EXHAUSTED);
  }
  return { counter, deviceId: local.deviceId };
}

/** 导入不制造新事件，不把远端 deviceId 变成本机身份。整体持久化。 */
export function mergeIntoEnvelope(
  local: OrganizationEnvelope,
  incoming: LibraryOrganization,
): OrganizationEnvelope {
  const state = mergeOrganization(local.state, incoming);
  return {
    deviceId: local.deviceId,
    counter: Math.max(local.counter, maxObservedCounter(state)),
    state,
  };
}

/**
 * Deterministic view projection shared with Rust.
 *
 * - Missing / deleted parents are skipped and a live node is lifted to the
 *   nearest live ancestor.  Deleted folders themselves stay hidden.
 * - Cycles in the live parent graph are broken at the lexicographically
 *   smallest UUID in each cycle; that node becomes a root.  Raw references are
 *   never rewritten.
 * - Nodes deeper than five are re-parented to their fourth-level ancestor, so
 *   each displayed node occupies a real fifth-level slot.  The effective
 *   parent chain, depth and ancestors always describe the same structure.  A
 *   remotely merged deeper tree is bounded for display; local create/move
 *   commands reject such a result instead of persisting it.
 */
export interface FolderTreeProjection {
  /** Live folder -> effective parent (null is root). */
  readonly parentById: ReadonlyMap<string, string | null>;
  /** Live folder -> effective depth, root = 1. */
  readonly depthById: ReadonlyMap<string, number>;
  /** Live folder -> depth before the five-level display clamp; local writes use it. */
  readonly unclampedDepthById: ReadonlyMap<string, number>;
  /** Effective parent (null is root) -> direct child UUIDs, ASCII sorted. */
  readonly childrenByParent: ReadonlyMap<string | null, readonly string[]>;
}

const projectionCache = new WeakMap<LibraryOrganization, FolderTreeProjection>();

function parentValue(folder: FolderState | undefined): string | null {
  return folder?.parentId?.value ?? null;
}

function liveAncestorOf(state: LibraryOrganization, start: string): string | null {
  const seen = new Set<string>([start]);
  let current = parentValue(state.folders[start]);
  while (current !== null) {
    if (seen.has(current)) return current === start ? start : null;
    seen.add(current);
    const folder = state.folders[current];
    if (!folder) return null;
    if (!folder.deleted) return current;
    current = parentValue(folder);
  }
  return null;
}

/** Cached because ShelfView projects many books from one immutable snapshot. */
export function projectFolderTree(state: LibraryOrganization): FolderTreeProjection {
  const cached = projectionCache.get(state);
  if (cached) return cached;

  const liveIds = Object.keys(state.folders)
    .filter((id) => !state.folders[id].deleted)
    .sort();
  const nextLive = new Map<string, string | null>();
  for (const id of liveIds) nextLive.set(id, liveAncestorOf(state, id));

  // Find every cycle in the functional graph id -> nextLive(id).  The UUID
  // order, not iteration order, chooses the break root.
  const cycleRoots = new Set<string>();
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (inStack.has(id)) {
      const cycle = stack.slice(stack.indexOf(id));
      cycle.sort();
      cycleRoots.add(cycle[0]);
      return;
    }
    inStack.add(id);
    stack.push(id);
    const parent = nextLive.get(id) ?? null;
    if (parent !== null) visit(parent);
    stack.pop();
    inStack.delete(id);
    visited.add(id);
  };
  for (const id of liveIds) visit(id);

  const baseParent = new Map<string, string | null>();
  for (const id of liveIds) {
    baseParent.set(id, cycleRoots.has(id) ? null : nextLive.get(id) ?? null);
  }

  // Compute base depth without recursion over potentially long remote chains.
  const baseDepth = new Map<string, number>();
  for (const id of liveIds) {
    if (baseDepth.has(id)) continue;
    const path: string[] = [];
    let cursor: string | null = id;
    while (cursor !== null && !baseDepth.has(cursor)) {
      path.push(cursor);
      cursor = baseParent.get(cursor) ?? null;
    }
    let depth = cursor === null ? 0 : baseDepth.get(cursor)!;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1;
      baseDepth.set(path[index], depth);
    }
  }

  const parentById = new Map<string, string | null>();
  const depthById = new Map<string, number>();
  for (const id of liveIds) {
    const depth = baseDepth.get(id)!;
    if (depth <= MAX_FOLDER_DEPTH) {
      parentById.set(id, baseParent.get(id) ?? null);
      depthById.set(id, depth);
      continue;
    }
    // Attach the node itself to its fourth-level ancestor: it then occupies a
    // genuine fifth-level slot.  Attaching to the fifth-level ancestor would
    // leave a sixth level in the parent chain while only changing the number.
    let cursor = id;
    while ((baseDepth.get(cursor) ?? 1) > MAX_FOLDER_DEPTH - 1) {
      cursor = baseParent.get(cursor)!;
    }
    parentById.set(id, cursor);
    depthById.set(id, MAX_FOLDER_DEPTH);
  }

  const childrenByParent = new Map<string | null, string[]>();
  for (const id of liveIds) {
    const parent = parentById.get(id) ?? null;
    const children = childrenByParent.get(parent);
    if (children) children.push(id);
    else childrenByParent.set(parent, [id]);
  }
  for (const children of childrenByParent.values()) children.sort();

  const projection: FolderTreeProjection = {
    parentById,
    depthById,
    unclampedDepthById: baseDepth,
    childrenByParent,
  };
  projectionCache.set(state, projection);
  return projection;
}

/**
 * Stored lineage used by export/import selection.  It follows the raw parent
 * register and includes deleted ancestors, because a selected book may need
 * them to retain its projected placement.  Order is [folder, parent, ...].
 */
export function folderStoredLineage(state: LibraryOrganization, folderId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder = state.folders[current];
    if (!folder) break;
    result.push(current);
    current = parentValue(folder);
  }
  return result;
}

/** Live folder ID(s) required to preserve a raw folder reference. */
export function requiredFolderIds(state: LibraryOrganization, folderId: string | null | undefined): string[] {
  if (!folderId) return [];
  const folder = state.folders[folderId];
  if (!folder) return [];
  if (!folder.deleted) return [folderId];
  const promoted = liveAncestorOf(state, folderId);
  return promoted ? [folderId, promoted] : [folderId];
}

/** View projection only: hidden/unknown folders are lifted to their nearest live ancestor. */
export function effectiveFolderId(state: LibraryOrganization, contentHash: string): string | null {
  const id = state.books[contentHash]?.folderId?.value ?? null;
  if (id === null) return null;
  const folder = state.folders[id];
  if (!folder) return null;
  if (!folder.deleted) return id;
  const promoted = liveAncestorOf(state, id);
  const target = promoted ? state.folders[promoted] : undefined;
  return target && !target.deleted ? promoted : null;
}

/** Effective parent for a live folder; deleted/unknown folders have no visible parent. */
export function effectiveFolderParent(state: LibraryOrganization, folderId: string): string | null {
  const folder = state.folders[folderId];
  if (!folder || folder.deleted) return null;
  return projectFolderTree(state).parentById.get(folderId) ?? null;
}

/** 1-based effective depth; null for deleted/unknown folders. */
export function effectiveFolderDepth(state: LibraryOrganization, folderId: string): number | null {
  const folder = state.folders[folderId];
  if (!folder || folder.deleted) return null;
  return projectFolderTree(state).depthById.get(folderId) ?? null;
}

/** Root-first effective ancestors, excluding the folder itself. */
export function effectiveFolderAncestors(state: LibraryOrganization, folderId: string): string[] {
  const depth = effectiveFolderDepth(state, folderId);
  if (depth === null) return [];
  const projection = projectFolderTree(state);
  const result: string[] = [];
  let current = projection.parentById.get(folderId) ?? null;
  while (current !== null) {
    result.push(current);
    current = projection.parentById.get(current) ?? null;
  }
  return result.reverse();
}

/** Effective direct children, ASCII sorted; deleted folders never appear. */
export function effectiveFolderChildren(
  state: LibraryOrganization,
  parentId: string | null,
): string[] {
  const projection = projectFolderTree(state);
  if (parentId !== null) {
    const parent = state.folders[parentId];
    if (!parent || parent.deleted) return [];
  }
  return [...(projection.childrenByParent.get(parentId) ?? [])];
}

/** All effective descendants (not including the folder), ASCII sorted. */
export function effectiveFolderDescendants(state: LibraryOrganization, folderId: string): string[] {
  if (effectiveFolderDepth(state, folderId) === null) return [];
  const result = new Set<string>();
  const pending = [...effectiveFolderChildren(state, folderId)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(...effectiveFolderChildren(state, current));
  }
  return [...result].sort();
}

export function isFavorite(state: LibraryOrganization, contentHash: string): boolean {
  return state.books[contentHash]?.favorite?.value ?? false;
}

/** 边界数据校验：schema、UUID、hash、值类型、名称、时钟范围与禁止显式 null 掩盖字段 */
export function validateOrganization(raw: unknown): LibraryOrganization {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("收藏与文件夹数据必须为对象");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== ORGANIZATION_LEGACY_SCHEMA_VERSION && obj.schemaVersion !== ORGANIZATION_SCHEMA_VERSION) {
    throw new Error(`收藏与文件夹数据版本不受支持：${String(obj.schemaVersion)}`);
  }
  const legacy = obj.schemaVersion === ORGANIZATION_LEGACY_SCHEMA_VERSION;
  if (!obj.folders || typeof obj.folders !== "object" || Array.isArray(obj.folders)) {
    throw new Error("收藏与文件夹数据缺少有效的 folders 字典");
  }
  if (!obj.books || typeof obj.books !== "object" || Array.isArray(obj.books)) {
    throw new Error("收藏与文件夹数据缺少有效的 books 字典");
  }

  const cleanFolders: Record<string, FolderState> = {};
  for (const [folderId, folderRaw] of Object.entries(obj.folders)) {
    if (!validCanonicalUuid(folderId)) {
      throw new Error(`收藏与文件夹数据含有无效的文件夹 ID: ${folderId}`);
    }
    if (!folderRaw || typeof folderRaw !== "object" || Array.isArray(folderRaw)) {
      throw new Error(`文件夹 ${folderId} 格式无效`);
    }
    const f = folderRaw as Record<string, unknown>;
    // 检查字段是否有非法显式 null（R1 规则）
    if (Object.prototype.hasOwnProperty.call(f, "deleted") && f.deleted === null) {
      throw new Error(`文件夹 ${folderId} 的 deleted 字段不能为 null`);
    }
    if (!f.name || typeof f.name !== "object" || Array.isArray(f.name)) {
      throw new Error(`文件夹 ${folderId} 缺少有效的 name 寄存器`);
    }
    if (legacy && Object.prototype.hasOwnProperty.call(f, "parentId")) {
      throw new Error(`版本 1 的文件夹 ${folderId} 不能包含 parentId`);
    }
    if (Object.prototype.hasOwnProperty.call(f, "parentId") && f.parentId === null) {
      throw new Error(`文件夹 ${folderId} 的 parentId 字段不能为 null`);
    }
    const nameReg = f.name as Record<string, unknown>;
    if (typeof nameReg.value !== "string" || !validFolderName(nameReg.value)) {
      throw new Error(`文件夹 ${folderId} 含有无效的名称`);
    }
    if (!validStamp(nameReg.stamp)) {
      throw new Error(`文件夹 ${folderId} 含有无效的逻辑时钟`);
    }

    let parentReg: Register<string | null> | undefined = undefined;
    if (f.parentId !== undefined) {
      const parent = f.parentId as Record<string, unknown>;
      if (parent.value !== null && !validCanonicalUuid(parent.value)) {
        throw new Error(`文件夹 ${folderId} 的 parentId.value 必须为有效 UUID 或 null`);
      }
      if (!validStamp(parent.stamp)) {
        throw new Error(`文件夹 ${folderId} 的 parentId 含有无效的逻辑时钟`);
      }
      parentReg = {
        value: parent.value as string | null,
        stamp: { counter: (parent.stamp as Stamp).counter, deviceId: (parent.stamp as Stamp).deviceId },
      };
    }

    let deletedStamp: Stamp | undefined = undefined;
    if (f.deleted !== undefined) {
      if (!validStamp(f.deleted)) {
        throw new Error(`文件夹 ${folderId} 含有无效的删除标记时钟`);
      }
      deletedStamp = { counter: f.deleted.counter, deviceId: f.deleted.deviceId };
    }

    cleanFolders[folderId] = {
      name: {
        value: nameReg.value,
        stamp: { counter: (nameReg.stamp as Stamp).counter, deviceId: (nameReg.stamp as Stamp).deviceId },
      },
      ...(parentReg ? { parentId: parentReg } : {}),
      ...(deletedStamp ? { deleted: deletedStamp } : {}),
    };
  }

  const cleanBooks: Record<string, BookOrganization> = {};
  for (const [hash, bookRaw] of Object.entries(obj.books)) {
    if (!validContentHash(hash)) {
      throw new Error(`收藏与文件夹数据含有无效的书籍内容指纹: ${hash}`);
    }
    if (!bookRaw || typeof bookRaw !== "object" || Array.isArray(bookRaw)) {
      throw new Error(`书籍 ${hash} 组织数据格式无效`);
    }
    const b = bookRaw as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(b, "favorite") && b.favorite === null) {
      throw new Error(`书籍 ${hash} 的 favorite 字段不能为 null`);
    }
    if (Object.prototype.hasOwnProperty.call(b, "folderId") && b.folderId === null) {
      throw new Error(`书籍 ${hash} 的 folderId 字段不能为 null`);
    }

    let favReg: Register<boolean> | undefined = undefined;
    if (b.favorite !== undefined) {
      const fr = b.favorite as Record<string, unknown>;
      if (typeof fr.value !== "boolean") {
        throw new Error(`书籍 ${hash} 的 favorite.value 必须为布尔值`);
      }
      if (!validStamp(fr.stamp)) {
        throw new Error(`书籍 ${hash} 的 favorite 含有无效的逻辑时钟`);
      }
      favReg = {
        value: fr.value,
        stamp: { counter: (fr.stamp as Stamp).counter, deviceId: (fr.stamp as Stamp).deviceId },
      };
    }

    let folderReg: Register<string | null> | undefined = undefined;
    if (b.folderId !== undefined) {
      const fld = b.folderId as Record<string, unknown>;
      if (fld.value !== null && !validCanonicalUuid(fld.value)) {
        throw new Error(`书籍 ${hash} 的 folderId.value 必须为有效 UUID 或 null`);
      }
      if (!validStamp(fld.stamp)) {
        throw new Error(`书籍 ${hash} 的 folderId 含有无效的逻辑时钟`);
      }
      folderReg = {
        value: fld.value as string | null,
        stamp: { counter: (fld.stamp as Stamp).counter, deviceId: (fld.stamp as Stamp).deviceId },
      };
    }

    cleanBooks[hash] = {
      ...(favReg ? { favorite: favReg } : {}),
      ...(folderReg ? { folderId: folderReg } : {}),
    };
  }

  return {
    schemaVersion: ORGANIZATION_SCHEMA_VERSION,
    folders: cleanFolders,
    books: cleanBooks,
  };
}

export function validateEnvelope(raw: unknown): OrganizationEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("组织 envelope 必须为对象");
  }
  const obj = raw as Record<string, unknown>;
  if (!validCanonicalUuid(obj.deviceId)) {
    throw new Error("组织 envelope 包含无效的本机设备 ID");
  }
  if (typeof obj.counter !== "number" || !Number.isInteger(obj.counter) || obj.counter < 0 || obj.counter > MAX_SAFE_COUNTER) {
    throw new Error("组织 envelope 的逻辑时钟超出安全范围");
  }
  const state = validateOrganization(obj.state);
  return {
    deviceId: obj.deviceId,
    counter: obj.counter,
    state,
  };
}

function requireLiveFolder(state: LibraryOrganization, folderId: string, missing: string, deleted: string): FolderState {
  if (!validCanonicalUuid(folderId)) throw new Error("无效的文件夹 ID");
  const folder = state.folders[folderId];
  if (!folder) throw new Error(missing);
  if (folder.deleted) throw new Error(deleted);
  return folder;
}

/** All folders whose stored parent chain reaches `folderId`, including itself. */
function storedSubtreeIds(state: LibraryOrganization, folderId: string): string[] {
  const children = new Map<string, string[]>();
  for (const [id, folder] of Object.entries(state.folders)) {
    const parent = parentValue(folder);
    if (parent === null) continue;
    const list = children.get(parent);
    if (list) list.push(id);
    else children.set(parent, [id]);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  const pending = [folderId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    pending.push(...(children.get(current) ?? []));
  }
  return result;
}

function assertNoStoredCycle(state: LibraryOrganization, folderId: string, parentId: string): void {
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current !== null) {
    if (current === folderId) throw new Error("文件夹层级不能形成环");
    if (seen.has(current)) throw new Error("文件夹层级存在循环");
    seen.add(current);
    const folder = state.folders[current];
    if (!folder) return;
    current = parentValue(folder);
  }
}

/**
 * Validate a local create/move target.  The caller writes a parent register;
 * this checks both the raw graph (no cycle) and the unclamped effective depth
 * of every folder moved with the subtree (maximum five levels).
 */
function assertFolderPlacement(
  state: LibraryOrganization,
  folderId: string,
  parentId: string | null,
  creating: boolean,
): void {
  const candidate: LibraryOrganization = {
    ...state,
    folders: {
      ...state.folders,
      ...(creating
        ? {
            [folderId]: {
              name: { value: "待校验", stamp: { counter: 1, deviceId: "00000000-0000-4000-8000-000000000000" } },
              parentId: { value: parentId, stamp: { counter: 1, deviceId: "00000000-0000-4000-8000-000000000000" } },
            },
          }
        : {
            [folderId]: {
              ...state.folders[folderId],
              parentId: { value: parentId, stamp: { counter: 1, deviceId: "00000000-0000-4000-8000-000000000000" } },
            },
          }),
    },
  };
  if (parentId !== null) assertNoStoredCycle(state, folderId, parentId);
  const projection = projectFolderTree(candidate);
  const affected = creating ? [folderId] : storedSubtreeIds(state, folderId);
  for (const id of affected) {
    const folder = candidate.folders[id];
    if (!folder || folder.deleted) continue;
    const depth = projection.unclampedDepthById.get(id);
    if (depth === undefined || depth > MAX_FOLDER_DEPTH) {
      throw new Error(`文件夹层级不能超过 ${MAX_FOLDER_DEPTH} 层`);
    }
  }
}

/** 本地命令 Reducer：与 Rust `apply_command` 逻辑完全对齐 */
export function applyCommand(
  envelope: OrganizationEnvelope,
  command: OrganizationCommand,
  knownContentHashes: ReadonlySet<string>,
): OrganizationEnvelope {
  switch (command.type) {
    case "createFolder": {
      if (!validCanonicalUuid(command.folderId)) {
        throw new Error("无效的文件夹 ID");
      }
      if (envelope.state.folders[command.folderId]) {
        throw new Error("该文件夹 ID 已被使用");
      }
      const name = normalizeFolderName(command.name);
      const parentId = command.parentId ?? null;
      if (parentId !== null) {
        requireLiveFolder(envelope.state, parentId, "父文件夹不存在", "父文件夹已解散");
      }
      assertFolderPlacement(envelope.state, command.folderId, parentId, true);
      const stamp = nextStamp(envelope);
      const nextFolders = {
        ...envelope.state.folders,
        [command.folderId]: {
          name: { value: name, stamp },
          parentId: { value: parentId, stamp },
        },
      };
      return {
        deviceId: envelope.deviceId,
        counter: stamp.counter,
        state: { ...envelope.state, schemaVersion: ORGANIZATION_SCHEMA_VERSION, folders: nextFolders },
      };
    }

    case "moveFolder": {
      if (!validCanonicalUuid(command.folderId)) {
        throw new Error("无效的文件夹 ID");
      }
      if (command.parentId !== null && !validCanonicalUuid(command.parentId)) {
        throw new Error("无效的文件夹 ID");
      }
      const existing = requireLiveFolder(envelope.state, command.folderId, "文件夹不存在", "文件夹已解散");
      if (command.parentId === command.folderId) {
        throw new Error("文件夹不能移动到自身");
      }
      if (command.parentId !== null) {
        requireLiveFolder(envelope.state, command.parentId, "目标文件夹不存在", "目标文件夹已解散");
      }
      assertFolderPlacement(envelope.state, command.folderId, command.parentId, false);
      const stamp = nextStamp(envelope);
      const nextFolders = {
        ...envelope.state.folders,
        [command.folderId]: {
          ...existing,
          parentId: { value: command.parentId, stamp },
        },
      };
      return {
        deviceId: envelope.deviceId,
        counter: stamp.counter,
        state: { ...envelope.state, schemaVersion: ORGANIZATION_SCHEMA_VERSION, folders: nextFolders },
      };
    }

    case "renameFolder": {
      if (!validCanonicalUuid(command.folderId)) {
        throw new Error("无效的文件夹 ID");
      }
      const existing = envelope.state.folders[command.folderId];
      if (!existing) {
        throw new Error("文件夹不存在");
      }
      if (existing.deleted) {
        throw new Error("文件夹已解散");
      }
      const name = normalizeFolderName(command.name);
      const stamp = nextStamp(envelope);
      const nextFolders = {
        ...envelope.state.folders,
        [command.folderId]: {
          ...existing,
          name: { value: name, stamp },
        },
      };
      return {
        deviceId: envelope.deviceId,
        counter: stamp.counter,
        state: { ...envelope.state, schemaVersion: ORGANIZATION_SCHEMA_VERSION, folders: nextFolders },
      };
    }

    case "deleteFolder": {
      if (!validCanonicalUuid(command.folderId)) {
        throw new Error("无效的文件夹 ID");
      }
      const existing = envelope.state.folders[command.folderId];
      if (!existing) {
        throw new Error("文件夹不存在");
      }
      // 已经删除：幂等无操作，不产生新事件
      if (existing.deleted) {
        return envelope;
      }
      const stamp = nextStamp(envelope);
      const nextFolders = {
        ...envelope.state.folders,
        [command.folderId]: {
          ...existing,
          deleted: stamp,
        },
      };
      return {
        deviceId: envelope.deviceId,
        counter: stamp.counter,
        state: { ...envelope.state, schemaVersion: ORGANIZATION_SCHEMA_VERSION, folders: nextFolders },
      };
    }

    case "setFavorite": {
      const uniqueHashes = [...new Set(command.contentHashes)];
      for (const hash of uniqueHashes) {
        if (!validContentHash(hash)) throw new Error("无效的书籍内容指纹");
        if (!knownContentHashes.has(hash)) throw new Error("书库中没有所选书籍，请刷新后重试");
      }
      if (uniqueHashes.length === 0) return envelope;

      const stamp = nextStamp(envelope);
      const nextBooks = { ...envelope.state.books };
      for (const hash of uniqueHashes) {
        const book = nextBooks[hash] ?? {};
        nextBooks[hash] = {
          ...book,
          favorite: { value: command.value, stamp },
        };
      }
      return {
        deviceId: envelope.deviceId,
        counter: stamp.counter,
        state: { ...envelope.state, schemaVersion: ORGANIZATION_SCHEMA_VERSION, books: nextBooks },
      };
    }

    case "moveBooks": {
      const uniqueHashes = [...new Set(command.contentHashes)];
      for (const hash of uniqueHashes) {
        if (!validContentHash(hash)) throw new Error("无效的书籍内容指纹");
        if (!knownContentHashes.has(hash)) throw new Error("书库中没有所选书籍，请刷新后重试");
      }
      if (uniqueHashes.length === 0) return envelope;

      if (command.folderId !== null) {
        if (!validCanonicalUuid(command.folderId)) throw new Error("无效的文件夹 ID");
        const folder = envelope.state.folders[command.folderId];
        if (!folder) throw new Error("文件夹不存在");
        if (folder.deleted) throw new Error("文件夹已解散，无法移入");
      }

      const stamp = nextStamp(envelope);
      const nextBooks = { ...envelope.state.books };
      for (const hash of uniqueHashes) {
        const book = nextBooks[hash] ?? {};
        nextBooks[hash] = {
          ...book,
          folderId: { value: command.folderId, stamp },
        };
      }
      return {
        deviceId: envelope.deviceId,
        counter: stamp.counter,
        state: { ...envelope.state, schemaVersion: ORGANIZATION_SCHEMA_VERSION, books: nextBooks },
      };
    }
  }
}

/**
 * 生成规范格式的文件夹 UUID (RFC 4122 v4)。
 */
export function generateFolderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().toLowerCase();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
