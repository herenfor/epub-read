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
    version: "0.3.5",
    status: "released",
    releasedOn: "2026-10-24",
    items: [
      {
        category: "new",
        text: "阅读资料云同步：支持坚果云及兼容的 WebDAV 服务，在设备之间同步阅读进度、书签、笔记、收藏和文件夹归属。只传阅读资料，不上传 EPUB 原书，请在各设备导入同一份 EPUB。",
      },
      {
        category: "new",
        text: "更清楚的进度选择：多份进度按设备名称和阅读时间展示，由你选择从哪里继续阅读。",
      },
      {
        category: "new",
        text: "更方便的同步操作：新增“立即同步”快捷入口，显示同步状态，需要手动处理的问题显示红点。",
      },
      {
        category: "new",
        text: "局域网互传更省步骤：一次配对后可连续传输多批书籍，也可切换发送方向，发送时显示实际传输进度。",
      },
      {
        category: "improved",
        text: "文件夹内单独排序：可按最近阅读、最近添加、书名或阅读进度排序，不影响主书架顺序。",
      },
      {
        category: "improved",
        text: "改善 Android 文件夹、列表和部分平板书架控件的布局。",
      },
      {
        category: "fixed",
        text: "双页模式下，从右上角添加书签可能错误落到左页的问题。",
      },
      {
        category: "fixed",
        text: "互传打包完成后，发送端未显示实际网络传输进度的问题。",
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
