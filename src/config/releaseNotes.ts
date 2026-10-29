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
    version: "0.3.8",
    status: "released",
    releasedOn: "2026-10-29",
    items: [
      {
        category: "new",
        text: "多书标签：可在书架选择“在新标签中打开”，在多本书之间切换，最多保留 5 个标签；只打开一本书时，顶栏也会显示“＋”入口，方便直接发现。",
      },
      {
        category: "new",
        text: "自定义阅读主题：自选纸张、文字与强调色，最多保存 6 套主题。",
      },
      {
        category: "new",
        text: "书内音视频播放：可直接在阅读页面播放 EPUB 内嵌的音频和视频，使用系统播放控件。",
      },
      {
        category: "improved",
        text: "统一阅读器、设置和书架菜单的面板、开关与滑块样式，并重新整理 Aa 排版面板与设置分组，让常用设置更集中。",
      },
      {
        category: "improved",
        text: "完善书架文件夹视图中的书名、作者搜索；书架“继续阅读”优先显示目录中的章节名称。",
      },
      {
        category: "fixed",
        text: "修复部分单图 SVG 封面或插图被拉伸的问题。",
      },
      {
        category: "fixed",
        text: "修复标题栏和正文空白区域弹出非预期浏览器右键菜单的问题；恢复顶栏固定按钮，并修复固定侧栏时顶栏遮挡正文。",
      },
      {
        category: "fixed",
        text: "修复手机 Aa 面板中主题行横向滑动容易被拦截的问题。",
      },
      {
        category: "fixed",
        text: "修复保存失败时关闭书本仍可能丢失当前标签的问题。",
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
