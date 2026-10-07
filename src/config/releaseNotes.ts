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
    version: "0.2.9",
    status: "released",
    releasedOn: "2026-10-07",
    items: [
      {
        category: "new",
        text: "导入文件夹：选一个存书的文件夹，书会按原来的目录自动整理进书架文件夹。导入前先看分类，随时可以停止，已经导入的书会保留；书架上已有的书会被认出来，不会重复添加。",
      },
      {
        category: "new",
        text: "字符显示：繁简转换，或添加自己的替换规则。只改变显示，不动原书；搜索和“复制原文”仍然对应原书文字。",
      },
      {
        category: "new",
        text: "画面滤镜：灰度、反色、暗化、饱和度、锐化。按住按钮可以临时看看原画面。",
      },
      {
        category: "new",
        text: "色弱辅助：红、绿、蓝三种模式，强度可调。",
      },
      {
        category: "new",
        text: "简化动画：新增“界面动画：完整 / 简化”，喜欢干脆利落的可以选简化。",
      },
      {
        category: "improved",
        text: "触屏翻页更跟手：翻到一半可以打断，来回拖动不会丢手势，短章节也有完整的翻页动画。",
      },
      {
        category: "improved",
        text: "书架更清爽：导入图书和导入文件夹合进一个菜单。“正在阅读”卡片收起和展开都有动画，收起后也能看到完整书名和进度。设置抽屉按用途分组。",
      },
      {
        category: "improved",
        text: "“局域网互传”更名为“设备互传”：面板更简洁，发送按钮固定在底部。",
      },
      {
        category: "improved",
        text: "Android 打开大体积 EPUB 更快、更省内存，这些书的全文搜索也恢复正常。",
      },
      {
        category: "improved",
        text: "版本提示更清楚：存档或互传的资料来自较新版本时，会明确告诉你需要升级。",
      },
      {
        category: "improved",
        text: "应用内检查更新：“关于”显示本版说明和发布日期，并可一键打开发布页。",
      },
      {
        category: "fixed",
        text: "书架上的阅读百分比与书内一致；重新打开书时更可靠地回到上次的位置。",
      },
      {
        category: "fixed",
        text: "拖动进度条跨章节时保持章内位置；触屏上脚注可以预览和固定。",
      },
      {
        category: "fixed",
        text: "连续阅读模式下，章节之间的空隙跟着滤镜变化，不再闪白。装饰性行高、窄页背景图和暗色正文的排版问题已修复。",
      },
      {
        category: "fixed",
        text: "书找不到和无法读取会分别提示；重新关联文件后书架会立刻刷新。",
      },
      {
        category: "fixed",
        text: "从系统文件选择器返回后，刚才点的按钮不再一直高亮。",
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
