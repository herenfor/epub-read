import { describe, expect, it } from "vitest";
import {
  formatImportNotice,
  findDuplicateEntry,
  mergeShelfEntries,
  sha256Hex,
  truncateImportTitle,
} from "./importBooks";
import type { ShelfEntry } from "./shelf";

function entry(id: string, title = id): ShelfEntry {
  return {
    id,
    title,
    creator: "",
    fileName: `${id}.epub`,
    fileSize: 1,
    coverMime: "",
    addedAtMs: 1,
    lastReadAtMs: 1,
    spineIndex: 0,
    page: 0,
    progressPct: 0,
    anchorIndex: null,
    anchorRatio: null,
    isNew: true,
  };
}

describe("sha256Hex", () => {
  it("同内容得到稳定的 SHA-256，不受视图偏移影响", async () => {
    const full = new Uint8Array([9, 1, 2, 3, 8]);
    const expected = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(await sha256Hex(full.subarray(1, 4))).toBe(expected);
    expect(expected).toHaveLength(64);
  });
});

describe("findDuplicateEntry", () => {
  it("旧条目即使文件改名也按相同字节识别，并只补录指纹", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(bytes);
    const legacy = { ...entry("legacy", "旧书"), fileName: "旧名字.epub", fileSize: 3 };
    const patched: Array<[string, string]> = [];
    const duplicate = await findDuplicateEntry({
      incomingHash: hash,
      incomingSize: 3,
      entries: [legacy],
      contentHashById: new Map(),
      entryByContentHash: new Map(),
      readBook: async () => bytes,
      setContentHash: async (id, contentHash) => {
        patched.push([id, contentHash]);
      },
    });
    expect(duplicate).toBe(legacy);
    expect(patched).toEqual([["legacy", hash]]);
    expect(legacy.page).toBe(0);
  });

  it("不同大小的旧书不会被读取", async () => {
    let reads = 0;
    const duplicate = await findDuplicateEntry({
      incomingHash: "a".repeat(64),
      incomingSize: 9,
      entries: [{ ...entry("legacy"), fileSize: 8 }],
      contentHashById: new Map(),
      entryByContentHash: new Map(),
      readBook: async () => {
        reads++;
        return new Uint8Array();
      },
      setContentHash: async () => {},
    });
    expect(duplicate).toBeNull();
    expect(reads).toBe(0);
  });
});

describe("formatImportNotice", () => {
  it("开书保护原生重复导入提示绑定已刷新而非失败", () => {
    expect(formatImportNotice({ sourceCount: 1, importedCount: 0, duplicateTitles: ["旧书"], failed: [], refreshedCount: 1 }))
      .toEqual({ kind: "ok", text: "此书已在书架，已更新本机源文件绑定；原有进度和笔记已保留" });
  });
  it("单本重复使用指定红色文案", () => {
    expect(
      formatImportNotice({
        sourceCount: 1,
        importedCount: 0,
        duplicateTitles: ["重复书"],
        failed: [],
      })
    ).toEqual({ kind: "error", text: "此书已经被导入过了哦" });
  });

  it("批量最多显示两本重复书，长书名截断，超过两本追加等书", () => {
    const notice = formatImportNotice({
      sourceCount: 6,
      importedCount: 3,
      duplicateTitles: ["这是一本特别特别长的测试书名示例", "第二本", "第三本"],
      failed: [],
    });
    expect(notice.kind).toBe("warn");
    expect(notice.text).toBe("已导入 3 本；重复 3 本：《这是一本特别特别长的测试书…》、《第二本》等书");
  });

  it("失败信息排在重复信息后", () => {
    expect(
      formatImportNotice({
        sourceCount: 3,
        importedCount: 1,
        duplicateTitles: ["旧书"],
        failed: ["坏书：无法解压"],
      }).text
    ).toBe("已导入 1 本；重复 1 本：《旧书》；失败 1 本（坏书：无法解压）");
  });
});

describe("truncateImportTitle", () => {
  it("按 Unicode 字符截断且把省略号计入上限", () => {
    expect(Array.from(truncateImportTitle("一二三四五", 4))).toEqual(["一", "二", "三", "…"]);
  });
});

describe("mergeShelfEntries", () => {
  it("只合并一次且不会保留相同 id 的旧条目", () => {
    const oldA = entry("a", "旧 A");
    const oldB = entry("b", "B");
    const newA = entry("a", "新 A");
    const newC = entry("c", "C");
    expect(mergeShelfEntries([oldA, oldB], [newA, newC])).toEqual([newA, newC, oldB]);
    const unchanged = [oldA];
    expect(mergeShelfEntries(unchanged, [])).toBe(unchanged);
  });
});
