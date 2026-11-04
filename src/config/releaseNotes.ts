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
    version: "0.4.0",
    status: "development",
    items: [
      {
        category: "new",
        text: "隐私书架：书架标题可切换，首次进入设置密码；书目、进度、笔记和收藏单独存放，不参与全库搜索、互传和云同步。书籍菜单可移入或移出，原书文件留在原处。",
      },
      {
        category: "new",
        text: "TXT 与漫画：支持打开 TXT 和 ZIP/CBZ；TXT 识别章节并提供段落缩进开关与两端对齐，漫画支持双指缩放和滚动模式整条缩放。",
      },
      {
        category: "new",
        text: "Android 原文件：关闭“导入时复制到书库”后，可直接读取原位置的文件；文件失效时可重新连接，删除书时提示原文件仍保留。",
      },
      {
        category: "new",
        text: "自动导入文件夹：在设置 > 存储中选择文件夹，应用在前台且书架空闲时自动扫描导入，也可立即扫描或关闭。",
      },
      {
        category: "new",
        text: "SeLis 显示名：应用在系统中的名称改为 SeLis，安装身份、签名、数据目录与更新地址保持不变。",
      },
      {
        category: "improved",
        text: "漫画大目录与大压缩包读取更顺畅，优先读取可见页面并复用缓存；TXT 排版和漫画拼接比例得到修复。",
      },
      {
        category: "improved",
        text: "移动书籍前保存进度；切换标签、目录跳转和阅读手势互不干扰，文件夹扫描失败会明确提示。",
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
