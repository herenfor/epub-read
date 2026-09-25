import { describe, expect, it } from "vitest";
import {
  applyCommand,
  compareStamp,
  effectiveFolderId,
  emptyOrganization,
  isFavorite,
  mergeIntoEnvelope,
  mergeOrganization,
  nextStamp,
  normalizeFolderName,
  STAMP_COLLISION,
  validateOrganization,
  type BookOrganization,
  type FolderState,
  type LibraryOrganization,
  type OrganizationEnvelope,
  type Stamp,
} from "./libraryOrganization";

const DEVICE_A = "00000000-0000-4000-8000-00000000000a";
const DEVICE_B = "00000000-0000-4000-8000-00000000000b";
const DEVICE_C = "00000000-0000-4000-8000-00000000000c";

const FOLDER_F = "11111111-1111-4111-8111-111111111111";
const FOLDER_G = "22222222-2222-4222-8222-222222222222";

const HASH_H1 = "1111111111111111111111111111111111111111111111111111111111111111";
const HASH_H2 = "2222222222222222222222222222222222222222222222222222222222222222";

function stamp(counter: number, deviceId: string): Stamp {
  return { counter, deviceId };
}

function folder(name: string, counter: number, deviceId: string, deleted?: Stamp): FolderState {
  return {
    name: { value: name, stamp: stamp(counter, deviceId) },
    ...(deleted ? { deleted } : {}),
  };
}

function bookFavorite(value: boolean, counter: number, deviceId: string): BookOrganization {
  return {
    favorite: { value, stamp: stamp(counter, deviceId) },
  };
}

function bookFolder(folderId: string | null, counter: number, deviceId: string): BookOrganization {
  return {
    folderId: { value: folderId, stamp: stamp(counter, deviceId) },
  };
}

function state(
  folders: Array<[string, FolderState]> = [],
  books: Array<[string, BookOrganization]> = [],
): LibraryOrganization {
  return {
    schemaVersion: 1,
    folders: Object.fromEntries(folders),
    books: Object.fromEntries(books),
  };
}

describe("libraryOrganization core & acceptance vectors", () => {
  it("compareStamp: 优先比较 counter，相同 counter 按 deviceId ASCII 字节序决胜", () => {
    expect(compareStamp(stamp(1, DEVICE_B), stamp(2, DEVICE_A))).toBe(-1);
    expect(compareStamp(stamp(2, DEVICE_A), stamp(1, DEVICE_B))).toBe(1);
    expect(compareStamp(stamp(5, DEVICE_A), stamp(5, DEVICE_B))).toBe(-1);
    expect(compareStamp(stamp(5, DEVICE_B), stamp(5, DEVICE_A))).toBe(1);
    expect(compareStamp(stamp(5, DEVICE_A), stamp(5, DEVICE_A))).toBe(0);
  });

  it("向量 1: A 对 H 收藏 true@2A；B 对 H 移入 F@2B => 两个字段都保留，合并满足交换律", () => {
    const orgA = state([], [[HASH_H1, bookFavorite(true, 2, DEVICE_A)]]);
    const orgB = state(
      [[FOLDER_F, folder("科幻", 1, DEVICE_B)]],
      [[HASH_H1, bookFolder(FOLDER_F, 2, DEVICE_B)]],
    );

    const mergedForward = mergeOrganization(orgA, orgB);
    const mergedBackward = mergeOrganization(orgB, orgA);

    expect(mergedForward).toEqual(mergedBackward);
    expect(isFavorite(mergedForward, HASH_H1)).toBe(true);
    expect(effectiveFolderId(mergedForward, HASH_H1)).toBe(FOLDER_F);
  });

  it("向量 2: H 收藏 true@5A 与 false@5B => false 胜出；再导入旧 true@4B 不恢复", () => {
    // 5A < 5B 因为 DEVICE_A < DEVICE_B，所以 5B 胜出
    const orgA = state([], [[HASH_H1, bookFavorite(true, 5, DEVICE_A)]]);
    const orgB = state([], [[HASH_H1, bookFavorite(false, 5, DEVICE_B)]]);

    const merged = mergeOrganization(orgA, orgB);
    expect(isFavorite(merged, HASH_H1)).toBe(false);

    const stale = state([], [[HASH_H1, bookFavorite(true, 4, DEVICE_B)]]);
    const mergedAgain = mergeOrganization(merged, stale);
    expect(isFavorite(mergedAgain, HASH_H1)).toBe(false);
  });

  it("向量 3: F 改名@8A 与删除@3B；H 移入 F@10A => F 不显示，H 展示未归类但原始 F 引用保留；再移动 G@11A 正常", () => {
    const renamedF = state([[FOLDER_F, folder("新名字", 8, DEVICE_A)]]);
    const deletedF = state([[FOLDER_F, folder("旧名字", 1, DEVICE_B, stamp(3, DEVICE_B))]]);
    const movedH = state([], [[HASH_H1, bookFolder(FOLDER_F, 10, DEVICE_A)]]);

    const merged = mergeOrganization(mergeOrganization(renamedF, deletedF), movedH);

    // 原始状态中 F 包含最新名字与永久删除标记
    expect(merged.folders[FOLDER_F].name.value).toBe("新名字");
    expect(merged.folders[FOLDER_F].deleted).toEqual(stamp(3, DEVICE_B));
    // 书籍原始保留 FOLDER_F
    expect(merged.books[HASH_H1].folderId?.value).toBe(FOLDER_F);
    // 但视图投影为 null（未归类）
    expect(effectiveFolderId(merged, HASH_H1)).toBeNull();

    // 随后将 H 移至存活文件夹 G
    const folderG = state([[FOLDER_G, folder("奇幻", 1, DEVICE_A)]]);
    const movedG = state([], [[HASH_H1, bookFolder(FOLDER_G, 11, DEVICE_A)]]);
    const mergedG = mergeOrganization(mergeOrganization(merged, folderG), movedG);
    expect(effectiveFolderId(mergedG, HASH_H1)).toBe(FOLDER_G);
  });

  it("向量 4: 先收到 H->F@3A，后收到 F 的创建 => 先展示未归类，收到文件夹后显示 F；先合并再投影与反向顺序一致", () => {
    const movedFirst = state([], [[HASH_H1, bookFolder(FOLDER_F, 3, DEVICE_A)]]);
    expect(effectiveFolderId(movedFirst, HASH_H1)).toBeNull();

    const folderCreated = state([[FOLDER_F, folder("历史", 1, DEVICE_B)]]);
    const merged1 = mergeOrganization(movedFirst, folderCreated);
    const merged2 = mergeOrganization(folderCreated, movedFirst);

    expect(merged1).toEqual(merged2);
    expect(effectiveFolderId(merged1, HASH_H1)).toBe(FOLDER_F);
  });

  it("向量 5: 本机 counter=3，导入某字段@9B => 本机 deviceId 仍 A，counter 至少 9；下一本地操作为 10A", () => {
    const localEnvelope: OrganizationEnvelope = {
      deviceId: DEVICE_A,
      counter: 3,
      state: emptyOrganization(),
    };
    const incoming = state([], [[HASH_H1, bookFavorite(true, 9, DEVICE_B)]]);
    const mergedEnvelope = mergeIntoEnvelope(localEnvelope, incoming);

    expect(mergedEnvelope.deviceId).toBe(DEVICE_A);
    expect(mergedEnvelope.counter).toBe(9);

    const next = nextStamp(mergedEnvelope);
    expect(next).toEqual({ counter: 10, deviceId: DEVICE_A });
  });

  it("向量 6: 对同一字段，同 stamp 不同值 => 报错 STAMP_COLLISION；跨字段共享 stamp 合法", () => {
    const book1 = state([], [[HASH_H1, bookFavorite(true, 5, DEVICE_A)]]);
    const book2 = state([], [[HASH_H1, bookFavorite(false, 5, DEVICE_A)]]);
    expect(() => mergeOrganization(book1, book2)).toThrow(STAMP_COLLISION);

    // 跨字段（favorite 与 folderId）使用同一 stamp 合法
    const multiField: BookOrganization = {
      favorite: { value: true, stamp: stamp(5, DEVICE_A) },
      folderId: { value: FOLDER_F, stamp: stamp(5, DEVICE_A) },
    };
    const validCrossField = state([[FOLDER_F, folder("F", 1, DEVICE_A)]], [[HASH_H1, multiField]]);
    expect(() => mergeOrganization(validCrossField, validCrossField)).not.toThrow();
  });

  it("向量 7: 三份有效快照 a/b/c 满足交换律、结合律与幂等律", () => {
    const snapA = state(
      [[FOLDER_F, folder("A版", 2, DEVICE_A)]],
      [[HASH_H1, bookFavorite(true, 1, DEVICE_A)]],
    );
    const snapB = state(
      [[FOLDER_F, folder("B版", 3, DEVICE_B)]],
      [[HASH_H1, bookFolder(FOLDER_F, 2, DEVICE_B)]],
    );
    const snapC = state(
      [[FOLDER_G, folder("G", 1, DEVICE_C)]],
      [[HASH_H2, bookFavorite(false, 4, DEVICE_C)]],
    );

    // 结合律：(A + B) + C === A + (B + C)
    const ab_c = mergeOrganization(mergeOrganization(snapA, snapB), snapC);
    const a_bc = mergeOrganization(snapA, mergeOrganization(snapB, snapC));
    expect(ab_c).toEqual(a_bc);

    // 幂等律：A + A === A
    expect(mergeOrganization(snapA, snapA)).toEqual(snapA);
  });
});

describe("applyCommand reducer behaviors", () => {
  const knownHashes = new Set([HASH_H1, HASH_H2]);

  it("createFolder: 正常创建与重名校验", () => {
    const env: OrganizationEnvelope = {
      deviceId: DEVICE_A,
      counter: 0,
      state: emptyOrganization(),
    };

    const next = applyCommand(
      env,
      { type: "createFolder", folderId: FOLDER_F, name: "  科幻小说  " },
      knownHashes,
    );
    expect(next.counter).toBe(1);
    expect(next.state.folders[FOLDER_F].name.value).toBe("科幻小说");
    expect(next.state.folders[FOLDER_F].name.stamp).toEqual({ counter: 1, deviceId: DEVICE_A });

    // 重复使用同 UUID（即使同名）拒绝
    expect(() =>
      applyCommand(
        next,
        { type: "createFolder", folderId: FOLDER_F, name: "科幻小说" },
        knownHashes,
      ),
    ).toThrow("该文件夹 ID 已被使用");

    // 允许不同 UUID 同名
    const next2 = applyCommand(
      next,
      { type: "createFolder", folderId: FOLDER_G, name: "科幻小说" },
      knownHashes,
    );
    expect(next2.state.folders[FOLDER_G].name.value).toBe("科幻小说");
  });

  it("renameFolder: 存活文件夹可更名，已解散或未知文件夹拒绝", () => {
    let env: OrganizationEnvelope = {
      deviceId: DEVICE_A,
      counter: 0,
      state: emptyOrganization(),
    };
    env = applyCommand(env, { type: "createFolder", folderId: FOLDER_F, name: "旧名" }, knownHashes);

    const renamed = applyCommand(
      env,
      { type: "renameFolder", folderId: FOLDER_F, name: "新名" },
      knownHashes,
    );
    expect(renamed.state.folders[FOLDER_F].name.value).toBe("新名");
    expect(renamed.counter).toBe(2);

    expect(() =>
      applyCommand(renamed, { type: "renameFolder", folderId: FOLDER_G, name: "X" }, knownHashes),
    ).toThrow("文件夹不存在");

    const deleted = applyCommand(renamed, { type: "deleteFolder", folderId: FOLDER_F }, knownHashes);
    expect(() =>
      applyCommand(deleted, { type: "renameFolder", folderId: FOLDER_F, name: "再改名" }, knownHashes),
    ).toThrow("文件夹已解散");
  });

  it("deleteFolder: 解散文件夹写入永久 deleted stamp；重复解散幂等无操作", () => {
    let env: OrganizationEnvelope = {
      deviceId: DEVICE_A,
      counter: 0,
      state: emptyOrganization(),
    };
    env = applyCommand(env, { type: "createFolder", folderId: FOLDER_F, name: "文件夹" }, knownHashes);

    const deleted = applyCommand(env, { type: "deleteFolder", folderId: FOLDER_F }, knownHashes);
    expect(deleted.state.folders[FOLDER_F].deleted).toEqual({ counter: 2, deviceId: DEVICE_A });
    expect(deleted.counter).toBe(2);

    // 再次解散无操作，不增加 counter
    const deletedAgain = applyCommand(deleted, { type: "deleteFolder", folderId: FOLDER_F }, knownHashes);
    expect(deletedAgain).toBe(deleted);
  });

  it("setFavorite: 批量设为 true/false，未知书籍整批拒绝", () => {
    const env: OrganizationEnvelope = {
      deviceId: DEVICE_A,
      counter: 0,
      state: emptyOrganization(),
    };

    const fav = applyCommand(
      env,
      { type: "setFavorite", contentHashes: [HASH_H1, HASH_H2], value: true },
      knownHashes,
    );
    expect(isFavorite(fav.state, HASH_H1)).toBe(true);
    expect(isFavorite(fav.state, HASH_H2)).toBe(true);
    expect(fav.counter).toBe(1);

    // 未知书籍拒绝整批，状态不变
    const unknownHash = "3".repeat(64);
    expect(() =>
      applyCommand(
        fav,
        { type: "setFavorite", contentHashes: [HASH_H1, unknownHash], value: false },
        knownHashes,
      ),
    ).toThrow("书库中没有所选书籍");
    expect(isFavorite(fav.state, HASH_H1)).toBe(true);
  });

  it("moveBooks: 批量移动与移出到未归类 (null)；目标已解散拒绝整批", () => {
    let env: OrganizationEnvelope = {
      deviceId: DEVICE_A,
      counter: 0,
      state: emptyOrganization(),
    };
    env = applyCommand(env, { type: "createFolder", folderId: FOLDER_F, name: "分类F" }, knownHashes);
    env = applyCommand(
      env,
      { type: "moveBooks", contentHashes: [HASH_H1, HASH_H2], folderId: FOLDER_F },
      knownHashes,
    );
    expect(effectiveFolderId(env.state, HASH_H1)).toBe(FOLDER_F);
    expect(effectiveFolderId(env.state, HASH_H2)).toBe(FOLDER_F);

    // 移出到未归类 (null)
    env = applyCommand(
      env,
      { type: "moveBooks", contentHashes: [HASH_H1], folderId: null },
      knownHashes,
    );
    expect(effectiveFolderId(env.state, HASH_H1)).toBeNull();
    expect(env.state.books[HASH_H1].folderId?.value).toBeNull();

    // 解散 F 后，尝试移动到 F 报错
    env = applyCommand(env, { type: "deleteFolder", folderId: FOLDER_F }, knownHashes);
    expect(() =>
      applyCommand(
        env,
        { type: "moveBooks", contentHashes: [HASH_H1], folderId: FOLDER_F },
        knownHashes,
      ),
    ).toThrow("文件夹已解散，无法移入");
  });
});

describe("validation & serialization boundary", () => {
  it("normalizeFolderName: 严格限制 1-40 个 Unicode 字符", () => {
    expect(normalizeFolderName("  科幻  ")).toBe("科幻");
    expect(() => normalizeFolderName("   ")).toThrow("1-40 个字符");
    const longName = "哈".repeat(41);
    expect(() => normalizeFolderName(longName)).toThrow("1-40 个字符");
    const exact40 = "🚀".repeat(40);
    expect(normalizeFolderName(exact40)).toBe(exact40);
  });

  it("validateOrganization: 拒绝可选字段显式为 null（R1 规则）", () => {
    const nameReg = { value: "科幻", stamp: { counter: 1, deviceId: DEVICE_A } };
    expect(() =>
      validateOrganization({
        schemaVersion: 1,
        folders: { [FOLDER_F]: { name: nameReg, deleted: null } },
        books: {},
      }),
    ).toThrow("deleted 字段不能为 null");

    expect(() =>
      validateOrganization({
        schemaVersion: 1,
        folders: {},
        books: { [HASH_H1]: { favorite: null } },
      }),
    ).toThrow("favorite 字段不能为 null");

    expect(() =>
      validateOrganization({
        schemaVersion: 1,
        folders: {},
        books: { [HASH_H1]: { folderId: null } },
      }),
    ).toThrow("folderId 字段不能为 null");

    // 允许合法缺省与寄存器内层 null
    const valid = validateOrganization({
      schemaVersion: 1,
      folders: { [FOLDER_F]: { name: nameReg } },
      books: {
        [HASH_H1]: {
          favorite: { value: false, stamp: { counter: 2, deviceId: DEVICE_A } },
          folderId: { value: null, stamp: { counter: 3, deviceId: DEVICE_A } },
        },
      },
    });
    expect(valid.books[HASH_H1].favorite?.value).toBe(false);
    expect(valid.books[HASH_H1].folderId?.value).toBeNull();
  });
});
