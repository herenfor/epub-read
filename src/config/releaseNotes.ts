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
    version: "0.3.9",
    status: "released",
    releasedOn: "2026-11-01",
    items: [
      {
        category: "new",
        text: "系统打开 EPUB：可在文件管理器的“打开方式”中选择 EPUB Reader，导入并打开电子书。",
      },
      {
        category: "improved",
        text: "统一界面的字号、圆角、图标和菜单样式，调整全屏页面及弹层动效。",
      },
      {
        category: "improved",
        text: "优化目录、设置等面板的预绘制和入场过程，减少首次打开时的卡顿。",
      },
      {
        category: "improved",
        text: "电脑端 Aa 主题行支持鼠标滚轮横向浏览和按住拖动，方便访问更多主题。",
      },
      {
        category: "improved",
        text: "调整手机书架文件夹的布局，将展开和收起入口放到筛选行。",
      },
      {
        category: "fixed",
        text: "修复阅读后返回书架时滚动位置回到顶部、文件夹展开状态丢失的问题。",
      },
      {
        category: "fixed",
        text: "减少返回书架时封面重新加载产生的闪烁。",
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
