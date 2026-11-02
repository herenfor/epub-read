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
    version: "0.3.11",
    status: "released",
    releasedOn: "2026-11-03",
    items: [
      {
        category: "new",
        text: "Aa 阅读设置：行高、字重、字距、词距等滑杆未设置时停在书籍自身的值，改过后可一键恢复跟随书籍或自动；字号行与其他设置对齐。",
      },
      {
        category: "new",
        text: "点击预览：开启“左侧点击也下一页”后，左侧箭头的预览箭头会翻转为朝前，提示与实际翻页方向一致。",
      },
      {
        category: "improved",
        text: "设置中的“界面动画”改为“减少动效”开关，开启后只使用更短的淡入淡出。",
      },
      {
        category: "improved",
        text: "统一书架筛选、搜索范围、字体来源等处的分段选择控件，外观和操作保持一致。",
      },
      {
        category: "improved",
        text: "局域网发送的“附带书籍”改为发送表单中的复选框，位置与生效时机一致。",
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
