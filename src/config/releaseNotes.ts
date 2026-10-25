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
    version: "0.3.6",
    status: "released",
    releasedOn: "2026-10-25",
    items: [
      {
        category: "new",
        text: "Windows 导入时可复制到书库：单本、多本和文件夹导入都能选择复制到应用书库，也可以取消勾选继续使用原文件，选择会被记住。",
      },
      {
        category: "new",
        text: "自定义 Windows 书库位置：在设置的存储页面可以更改书库位置、恢复默认位置，或重新连接已有书库。搬迁时显示进度并核对文件，中断后可继续处理。",
      },
      {
        category: "new",
        text: "在文件资源管理器中打开：书籍菜单可直接定位 EPUB 文件，复制导入的书定位到书库副本，链接导入的书定位到原文件。",
      },
      {
        category: "new",
        text: "更容易辨认的书库文件名：新复制导入的 EPUB 使用可读文件名，重名时自动编号，不覆盖已有文件。",
      },
      {
        category: "improved",
        text: "优化文件夹批量导入的任务调度，让文件准备与书架写入衔接更紧密。",
      },
      {
        category: "improved",
        text: "本版会升级本机数据库格式：先自动备份再转换，现有书架和阅读资料保留；升级后请勿让旧版程序打开同一份应用资料。",
      },
      {
        category: "improved",
        text: "改善书库位置不可用、搬迁中断和残留文件的处理与提示。",
      },
      {
        category: "fixed",
        text: "修复书架列表在部分宽度、长书名和滚动位置下出现行高变化、跳动的问题，并改善网格滚动位置的稳定性。",
      },
      {
        category: "fixed",
        text: "修复触摸设备字体列表行高与滚动占位不一致的问题。",
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
