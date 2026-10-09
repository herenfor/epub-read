// Seed catalog for later UI integration. EPUB and user-authored strings are not message keys.
export const zhCN = {
  "common.cancel": "取消",
  "common.confirm": "确定",
  "common.save": "保存",
  "common.close": "关闭",
  "common.failed": "操作失败",
  "settings.language": "界面语言",
  "language.system": "跟随系统",
  "language.zh-CN": "简体中文",
  "language.en": "English",
  "folder.name.empty": "文件夹名称不能为空",
  "folder.name.too-long": "名称不能超过 {limit} 个字符",
  "folder.name.duplicate": "已存在同名文件夹",
  "folder.name.count": "{count}/{limit}",
  "reader.toc": "目录",
  "reader.bookmarks": "书签",
  "reader.notes": "笔记",
  "reader.hideSystemStatusBar": "阅读时隐藏系统状态栏",
} as const;

export type MessageKey = keyof typeof zhCN;

export const en: Record<MessageKey, string> = {
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.save": "Save",
  "common.close": "Close",
  "common.failed": "Operation failed",
  "settings.language": "Interface language",
  "language.system": "Follow system",
  "language.zh-CN": "简体中文",
  "language.en": "English",
  "folder.name.empty": "Enter a folder name",
  "folder.name.too-long": "Use no more than {limit} characters",
  "folder.name.duplicate": "A folder with this name already exists",
  "folder.name.count": "{count}/{limit}",
  "reader.toc": "Contents",
  "reader.bookmarks": "Bookmarks",
  "reader.notes": "Notes",
  "reader.hideSystemStatusBar": "Hide system status bar while reading",
};
