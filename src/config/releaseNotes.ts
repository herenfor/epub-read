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
    version: "0.4.1",
    status: "released",
    releasedOn: "2026-11-11",
    items: [
      {
        category: "improved",
        text: "应用更新已为 GitHub 仓库迁移做好准备。建议先升级到本版，便于仓库改名后继续使用应用内更新。",
      },
      {
        category: "new",
        text: "书架支持多层文件夹，可按目录整理书库并批量移动书籍。",
      },
      {
        category: "new",
        text: "新增 AZW3（KF8）与 FB2 格式，可导入阅读、保存笔记并导出原书。",
      },
      {
        category: "new",
        text: "支持从 Readest 备份导入书籍与阅读记录，也可导入 KOReader 的阅读进度。",
      },
      {
        category: "new",
        text: "连接 WebDAV 后可手动把原书备份到网盘，并逐本重试失败项。",
      },
      {
        category: "new",
        text: "选中文字后可复制、标注，并生成分享长图。",
      },
      {
        category: "new",
        text: "首次提供 Linux 桌面版（deb），支持本地书架与 EPUB/TXT/漫画阅读。",
      },
      {
        category: "fixed",
        text: "修复文件夹导入、阅读恢复与书架搜索/排序状态等一批问题。",
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
