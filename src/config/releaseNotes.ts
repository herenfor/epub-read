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
    version: "0.3.2",
    status: "released",
    releasedOn: "2026-10-16",
    items: [
      {
        category: "new",
        text: "书签丝带：有书签的页面会挂一条红色丝带，双页时挂在书签所在的那一页；加书签、删书签有放入和收回动画，从目录跳到书签时丝带会亮一下。删掉的书签可以在提示条里撤销，电脑上也可以按 Ctrl+Z。",
      },
      {
        category: "new",
        text: "手机和平板上点屏幕右上角就能加或删书签；平板双页时，左上角管左页、右上角管右页。",
      },
      {
        category: "new",
        text: "双页阅读时，连续的插图页、书名页、版权页这类只有一页的章节会两两并排显示，不再各占一屏、空着半边。",
      },
      {
        category: "new",
        text: "导出书籍原文件：在书的菜单里选“导出书籍”，单本导出 EPUB，多本打包成 ZIP。",
      },
      {
        category: "new",
        text: "要求从右往左翻页的书，现在按书的方向翻页。",
      },
      {
        category: "new",
        text: "竖排显示（实验性）：竖排的书按竖排显示，一页一页从右往左翻。排版效果还不完善，不理想时可以在 Aa 设置里打开“强制竖排转横排”。",
      },
      {
        category: "improved",
        text: "翻页更跟手：松手后页面接着手指的速度滑到位，结尾不再顿一下；刚打开书的前几秒翻页也不再卡顿。",
      },
      {
        category: "improved",
        text: "大书换章更快：只准备这一章用到的字体，不再每章都解开全书的字体。",
      },
      {
        category: "improved",
        text: "双页时书的整页背景图按页铺，不再横跨两页拉伸。",
      },
      {
        category: "improved",
        text: "提示更清楚：书打不开、设备互传版本不一致时会说明原因；导入时会列出跳过的书；Android 导入保留文件原来的名字。自定义 CSS 输入框里说明了怎样覆盖书本自带的样式。",
      },
      {
        category: "improved",
        text: "Android 系统状态栏的文字颜色跟随阅读主题，深色主题下也看得清。（仅 Android）",
      },
      {
        category: "improved",
        text: "手机上的书架和面板：筛选面板可以下拉关闭，书架滚动条不再贴着屏幕边，滚动到头不再出现拉伸回弹；搜索、更多和书架下拉菜单打开更流畅。",
      },
      {
        category: "fixed",
        text: "滚动阅读模式下，导入的字体和章节里的链接都能正常使用。",
      },
      {
        category: "fixed",
        text: "删书后收藏和文件夹立即刷新；深色主题下“继续阅读”按钮的文字保持白色；快速拖动进度条后马上跳转，不再误报找不到位置。",
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
