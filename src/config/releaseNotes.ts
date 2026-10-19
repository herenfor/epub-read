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
    version: "0.3.3",
    status: "released",
    releasedOn: "2026-10-19",
    items: [
      {
        category: "new",
        text: "章末空着的半页会补上下一章的第一页：同时打开“高性能预读”“章节间连续滑动”、翻页动画设为“滑动”后，普通横排书双页阅读时，章末只剩一页的那屏会补上下一章首页，往后翻直接进入下一章第二屏；拼进来的半页能点自己的链接和脚注、能选中文字，书签与笔记也按它自己所属的章节处理。",
      },
      {
        category: "new",
        text: "章节交界像普通翻页一样滑过去：拖动、点按、按键和滚轮都带着两章一起移动，中途还能往回滑；封面、彩页、目录、制作信息之间同样连续滑动，连续快速点按会一直往后走。",
      },
      {
        category: "new",
        text: "从文件夹导出原书：文件夹菜单新增“导出书籍”，单本导出 EPUB，多本打包成 ZIP。",
      },
      {
        category: "new",
        text: "批量选择可以整夹选中；列表视图里的文件夹有真实的行，显示夹内第一本书的封面、作者和进度，并和书一起排序。",
      },
      {
        category: "improved",
        text: "书自带的字体能生效了：阅读器默认字体不再盖掉书里声明的字体，只写在章内样式里的字体也不会再被丢掉。",
      },
      {
        category: "improved",
        text: "图片和较宽的表格不越出页面：大字号下标题图不再被截掉，较宽的纯文字表格会收窄并让长行换行，同时保留字号和列宽分配；书本身固定住的表格仍保持原样。",
      },
      {
        category: "improved",
        text: "翻页区里的脚注和链接能点了：点一下就打开，不再只是翻页；那里的普通正文仍然翻页。",
      },
      {
        category: "improved",
        text: "Aa 面板的小细节：字号显示成普通数字，不再带一长串小数；当前用不了的开关会变灰。",
      },
      {
        category: "fixed",
        text: "最大化或还原窗口后双页不再错位，右页回到正确位置。",
      },
      {
        category: "fixed",
        text: "宽屏单页在大字号下会留出侧边距，正文不再贴着窗口边。",
      },
      {
        category: "fixed",
        text: "双页的边缘有反应了：空着的那半页中间点按出菜单、边缘点按或滑动翻页；从拼好的图片或彩页双页往回拖时两页一起移动。",
      },
      {
        category: "fixed",
        text: "书架很长时列表不再滚成空白，文件夹很多、书上百本也能一直看到书行，滚到最后一本；自动双页也不再露出旁边一栏的一条边。",
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
