export type ReleaseNoteCategory = "new" | "improved" | "fixed";
export type ReleaseNoteStatus = "released" | "development";

export type ReleaseNoteItem = Readonly<{
  category: ReleaseNoteCategory;
  text: string;
}>;

export type ReleaseNote = Readonly<{
  version: string;
  status: ReleaseNoteStatus;
  /** Real public release date only; omitted for unreleased development versions. */
  releasedOn?: string;
  items: readonly ReleaseNoteItem[];
}>;

export const RELEASE_CATEGORY_LABELS: Readonly<Record<ReleaseNoteCategory, string>> = {
  new: "新增",
  improved: "改进",
  fixed: "修复",
};

export const RELEASE_STATUS_LABELS: Readonly<Record<ReleaseNoteStatus, string>> = {
  released: "已发布",
  development: "开发中",
};

/** Where users download new versions; the about panel links here. */
export const RELEASES_PAGE_URL = "https://github.com/herenfor/epub-read/releases";

/**
 * User-facing notes for the version this build ships. Only the current
 * version is kept: older versions live on the GitHub releases page. Do not
 * invent release dates for a version that has not been published.
 */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: "0.3.7",
    status: "released",
    releasedOn: "2026-10-27",
    items: [
      {
        category: "fixed",
        text: "修复 Windows 导入时勾选“复制到书库”后，实际仍链接原文件的问题。",
      },
      {
        category: "fixed",
        text: "修复 Windows 复制导入只读 EPUB 文件时失败的问题。",
      },
      {
        category: "fixed",
        text: "修复清除全文索引后，第一次重建索引失败的问题。",
      },
      {
        category: "fixed",
        text: "修复书架列表“封面”表头换行、封面列空间不足的问题。",
      },
      {
        category: "improved",
        text: "书架列表的横向滚动条调整到更容易操作的位置，长列表中也能方便使用。",
      },
      {
        category: "improved",
        text: "调整全文索引的自动并发策略，减少同时处理多本书时的资源压力；已有的手动并发设置保持不变。",
      },
    ],
  },
];

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Exact version match after allowing an optional leading "v". */
export function findReleaseNote(version: string): ReleaseNote | null {
  const normalized = normalizeVersion(version);
  return RELEASE_NOTES.find((note) => normalizeVersion(note.version) === normalized) ?? null;
}
