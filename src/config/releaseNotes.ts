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
    version: "0.3.4",
    status: "released",
    releasedOn: "2026-10-21",
    items: [
      {
        category: "new",
        text: "应用内更新：设置 › 关于新增更新卡片，说明新版本号和更新内容并可直接下载——Windows 安装版下载校验后重启进入安装，Android 下载校验后交给系统安装器，免安装版提供“前往下载”链接。支持启动时自动检查、跳过此版本，失败时说明原因并可重试或改用浏览器下载。",
      },
      {
        category: "new",
        text: "一层 Aa 面板加实时滑块：行高、边距等排版控制集中在一个页面，拖动滑块时页面随手指实时变化，不用等松手。",
      },
      {
        category: "new",
        text: "书架快捷操作：在已经打开的文件夹里直接导入、从书库其他文件夹添加书籍、拖动文件夹重新整理。",
      },
      {
        category: "improved",
        text: "设置页改为推入/推出切换，并在书架出现后预先画好，打开时停顿更少。",
      },
      {
        category: "improved",
        text: "关于页更清爽：一张应用卡片加一个列表，不再一层套一层。",
      },
      {
        category: "improved",
        text: "可滚动的菜单在边缘渐隐，更容易看出上面或下面还有内容。",
      },
      {
        category: "improved",
        text: "空书架在工具栏下方的空间里居中。",
      },
      {
        category: "fixed",
        text: "书签丝带在翻页和换章后仍留在正确的位置。",
      },
      {
        category: "fixed",
        text: "关闭字体覆盖后恢复书自己的字体，不再继续用阅读器字体。",
      },
      {
        category: "fixed",
        text: "滑块手势更稳：手指划过不会误改数值，中断的拖动干净结束，拖动时边距参考线保持稳定。",
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
