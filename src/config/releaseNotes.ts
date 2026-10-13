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
    version: "0.3.1",
    status: "released",
    releasedOn: "2026-10-13",
    items: [
      {
        category: "new",
        text: "选择界面语言：设置里新增简体中文、English 和“跟随系统”，切换立即生效、无需重启，每台设备各自记住自己的选择。只改应用界面——书架、阅读器菜单、设置、弹窗和提示；书的内容、笔记、文件夹名和阅读位置都不动。",
      },
      {
        category: "new",
        text: "阅读器返回/前进：从目录、链接、搜索结果、笔记或书签跳转后，可以退回原处，也可以再前进回去。手机和电脑上都有。",
      },
      {
        category: "new",
        text: "自定义点击翻页区域：书架设置里的预览面板会画出左右两侧的点击区域，可以只保留想要的；触屏设备还能开启“点击左侧也进入下一页”。",
      },
      {
        category: "new",
        text: "Android 阅读更舒服：新增“阅读时屏幕常亮”开关，并可在阅读器里隐藏系统状态栏，两项都在书架设置中。（仅 Android）",
      },
      {
        category: "new",
        text: "用自己的字体覆盖原书字体：字体面板新增可选开关，默认关闭。",
      },
      {
        category: "improved",
        text: "换主题不再重载章节：整屏约 200 毫秒淡入到新主题，当前章节原地换色，阅读位置和选区都保留。",
      },
      {
        category: "improved",
        text: "面板打开更快：打开书本时会提前准备阅读设置面板和目录抽屉。超长目录只渲染屏幕上的行，打开关闭都保持位置，嵌套分支可以折叠。",
      },
      {
        category: "improved",
        text: "电脑上的翻页动画和触屏一致：新的一次翻页会打断上一次，快速连点也不再留下旧页面或空白页。",
      },
      {
        category: "improved",
        text: "阅读器搜索只搜当前这本书；电脑端改为停靠在右侧，不再把正文挤来挤去。",
      },
      {
        category: "improved",
        text: "书架有了真正的设置页：常用工具留在书架上——搜索、带数量角标的筛选、排序、视图和密度；其余收进设置页，分为外观、阅读、数据与备份、存储、关于，可以正常滚动。",
      },
      {
        category: "improved",
        text: "手机上的阅读面板：阅读设置改为半屏打开，可上下拖动、左右滑动切换两页；排版面板支持向下拖动关闭；面板不再模糊背后正文，工具按钮只在按住时高亮。",
      },
      {
        category: "fixed",
        text: "图片类书籍：双页图正确配对，一次翻页从图组外侧开始，点整页图的留白处可以呼出菜单，图片页在书签和阅读进度中也能保持正确位置。",
      },
      {
        category: "fixed",
        text: "文字与内容：书里禁用换行的长串不再溢出栏宽，窄栏里保留原书缩进，分隔线不再异常缩短；字符替换规则留空即可删除内容。同一本书缺失的文件每次会话只提示一次，并说明原因。",
      },
      {
        category: "fixed",
        text: "保存与跳转：保存进度失败时可以退出阅读器或关闭窗口，保存过程中反复关窗会被拦截；文件名特殊的书也能正常拖动进度条；快速来回切换章节不再显示错章或旧页面。",
      },
      {
        category: "fixed",
        text: "书架与 Windows 桌面：过长的文件夹名会明确提示，而不是被悄悄截断；长按菜单不再误触发打开它的那个手势。沉浸顶栏在鼠标离开 1 秒后隐藏并保持隐藏；底栏不再因鼠标停留而一直展开，指针静止一会儿后自动隐藏。（仅 Windows）",
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
