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
    version: "0.3.0",
    status: "released",
    releasedOn: "2026-10-08",
    items: [
      {
        category: "new",
        text: "连续两页图可以当成一个跨页来读：漫画、画册、扫描页常常一章只有一张大图，连续两章都是图时会左右拼成一个跨页；图注留在自己的图旁边，没有配对的图仍然占满整页。",
      },
      {
        category: "new",
        text: "重建搜索索引：“缓存与存储”新增“重置全部索引缓存”。书本、阅读进度和已下载的模型资料保留，只有索引需要重新准备；索引数据库损坏时也有了恢复办法。清除全文索引时也会整理数据库并回收空闲空间。",
      },
      {
        category: "improved",
        text: "书架的数字和标签页对得上：已经开始读的书，即使页数还在统计中也算作“在读”，标签上的数字和点进去看到的书一致。",
      },
      {
        category: "improved",
        text: "“更多在读”只列最近 10 本，完整书架不受影响。",
      },
      {
        category: "improved",
        text: "还没统计出进度的书显示“待统计”，不再显示 0%。",
      },
      {
        category: "improved",
        text: "翻页箭头更安静：静止时完全透明，点按后朝翻页方向淡入，淡出过程中再点可以续上，换章后不会留在页面上。",
      },
      {
        category: "improved",
        text: "桌面端书架列表的操作按钮与手机、平板一致。",
      },
      {
        category: "fixed",
        text: "书里的背景图和共用样式稳定加载：部分书缺失的背景画面恢复正常，关闭书本后会释放占用的文件。",
      },
      {
        category: "fixed",
        text: "Windows 任务栏图标显示为应用图标。",
      },
      {
        category: "fixed",
        text: "全屏时尊重“固定顶栏”设置，顶栏不再压住页面顶部。",
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
