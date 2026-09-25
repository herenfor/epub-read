/**
 * 收藏与单层文件夹管理核心模块。
 *
 * 纯逻辑与类型定义：不依赖 Tauri、DOM 或具体存储实现。
 * 书籍身份复用 EPUB 原始字节的 SHA-256（64 位小写十六进制字符串）。
 * 每本书最多归属一个文件夹（folderId 寄存器），收藏（favorite 寄存器）完全独立。
 * 文件夹删除使用永久 tombstone 标记，不批量清空书籍原始引用。
 */

export const MAX_SAFE_COUNTER = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const MAX_FOLDER_NAME_CODE_POINTS = 40;
export const ORGANIZATION_SCHEMA_VERSION = 1 as const;

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
  /** 永久删除标记：同一 UUID 不允许复活。 */
  readonly deleted?: Stamp;
}

export interface BookOrganization {
  readonly favorite?: Register<boolean>;
  readonly folderId?: Register<string | null>;
}

export interface LibraryOrganization {
  readonly schemaVersion: 1;
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
  | { readonly type: "createFolder"; readonly folderId: string; readonly name: string }
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
  return { schemaVersion: 1, folders: {}, books: {} };
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
  const deleted = mergeDeletion(a.deleted, b.deleted);
  return {
    name: mergeRegister(a.name, b.name)!,
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
    schemaVersion: 1,
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

/** 仅视图投影！未知 / 已删文件夹显示在根目录（null），原始引用必须保留。 */
export function effectiveFolderId(state: LibraryOrganization, contentHash: string): string | null {
  const id = state.books[contentHash]?.folderId?.value ?? null;
  if (id === null) return null;
  const folder = state.folders[id];
  return folder && !folder.deleted ? id : null;
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
  if (obj.schemaVersion !== ORGANIZATION_SCHEMA_VERSION) {
    throw new Error(`收藏与文件夹数据版本不受支持：${String(obj.schemaVersion)}`);
  }
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
    const nameReg = f.name as Record<string, unknown>;
    if (typeof nameReg.value !== "string" || !validFolderName(nameReg.value)) {
      throw new Error(`文件夹 ${folderId} 含有无效的名称`);
    }
    if (!validStamp(nameReg.stamp)) {
      throw new Error(`文件夹 ${folderId} 含有无效的逻辑时钟`);
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
    schemaVersion: 1,
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
      const stamp = nextStamp(envelope);
      const nextFolders = {
        ...envelope.state.folders,
        [command.folderId]: {
          name: { value: name, stamp },
        },
      };
      return {
        deviceId: envelope.deviceId,
        counter: stamp.counter,
        state: { ...envelope.state, folders: nextFolders },
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
        state: { ...envelope.state, folders: nextFolders },
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
        state: { ...envelope.state, folders: nextFolders },
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
        state: { ...envelope.state, books: nextBooks },
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
        state: { ...envelope.state, books: nextBooks },
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
